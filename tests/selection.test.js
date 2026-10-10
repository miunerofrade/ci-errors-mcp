import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectRuns } from "../src/github.js";
import { inspect } from "../src/service.js";
import { inputSchema } from "../src/schema.js";
const exec = promisify(execFile);
test("HEAD selection never falls back to an older commit and pins latest run per workflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-errors-selection-"));
  try {
    await exec("git", ["init", dir]);
    await exec("git", [
      "-C",
      dir,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const sha = (
      await exec("git", ["-C", dir, "rev-parse", "HEAD"])
    ).stdout.trim();
    const empty = await inspect(
      { repo_path: dir, repository: "a/b" },
      async (p) => {
        assert.ok(p.includes("head_sha=" + sha));
        return { workflow_runs: [] };
      },
    );
    assert.equal(empty.status, "not_found");
    const result = await selectRuns(
      { repo_path: dir, repository: "a/b" },
      async () => ({
        workflow_runs: [
          { id: 2, workflow_id: 1, head_sha: sha },
          { id: 1, workflow_id: 1, head_sha: sha },
          { id: 3, workflow_id: 2, head_sha: "old" },
        ],
      }),
    );
    assert.deepEqual(
      result.runs.map((r) => r.id),
      [2],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("run URL parsing is strict and resolves an explicit run", async () => {
  let path;
  const result = await selectRuns(
    { run_url: "https://github.com/a/b/actions/runs/123" },
    async (p) => {
      path = p;
      return { id: 123 };
    },
  );
  assert.equal(result.repository, "a/b");
  assert.ok(path.endsWith("/123"));
  await assert.rejects(
    () => selectRuns({ run_url: "https://example.com/a/b/actions/runs/123" }),
    /Expected/,
  );
});
test("network and malformed continuation errors do not pretend CI passed", async () => {
  const result = await inspect({ repository: "a/b", run_id: 1 }, async () => {
    throw Error("TLS handshake timeout");
  });
  assert.equal(result.status, "query_failed");
  await assert.rejects(
    () => inspect({ cursor: "bad" }),
    /Invalid continuation/,
  );
});

test("explicit attempts use the attempt endpoint and reject conflicts before querying", async () => {
  for (const input of [
    { repository: "a/b", run_id: 123, attempt: 2 },
    { run_url: "https://github.com/a/b/actions/runs/123/attempts/2" },
    {
      run_url: "https://github.com/a/b/actions/runs/123/attempts/2",
      attempt: 2,
    },
    { run_url: "https://github.com/a/b/actions/runs/123", attempt: 2 },
  ]) {
    const selected = await selectRuns(input, async (path) => {
      assert.equal(path, "repos/a/b/actions/runs/123/attempts/2");
      return { id: 123, run_attempt: 2 };
    });
    assert.equal(selected.runs[0].run_attempt, 2);
  }
  const noQuery = async () => {
    assert.fail("invalid input must not query GitHub");
  };
  await assert.rejects(
    () =>
      selectRuns(
        {
          run_url: "https://github.com/a/b/actions/runs/123/attempts/2",
          attempt: 1,
        },
        noQuery,
      ),
    /conflicts/,
  );
  for (const suffix of ["/attempts/0", "/attempts/abc", "/attempts/2/extra"])
    await assert.rejects(() =>
      selectRuns(
        { run_url: "https://github.com/a/b/actions/runs/123" + suffix },
        noQuery,
      ),
    );
  for (const attempt of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      inputSchema.safeParse({ repository: "a/b", run_id: 123, attempt })
        .success,
      false,
    );
  assert.equal(
    inputSchema.safeParse({ repo_path: "/repo", attempt: 2 }).success,
    false,
  );
  assert.equal(
    inputSchema.safeParse({ cursor: "cursor", attempt: 2 }).success,
    false,
  );
});

test("old attempt metadata, jobs, logs and uncached continuation stay pinned after rerun", async () => {
  const paths = [];
  const raw = "Error: old attempt\n" + "expected old actual old\n".repeat(150);
  const api = async (path) => {
    paths.push(path);
    if (path === "repos/a/b/actions/runs/123/attempts/1")
      return {
        id: 123,
        run_attempt: 1,
        head_sha: "old-sha",
        status: "completed",
        conclusion: "failure",
      };
    if (path === "repos/a/b/actions/runs/123")
      return {
        id: 123,
        run_attempt: 3,
        head_sha: "old-sha",
        status: "completed",
        conclusion: "success",
      };
    if (
      path === "repos/a/b/actions/runs/123/attempts/1/jobs?per_page=100&page=1"
    )
      return {
        jobs: [
          {
            id: 10,
            name: "old test",
            conclusion: "failure",
            steps: [{ number: 1, name: "test", conclusion: "failure" }],
          },
        ],
      };
    if (
      path === "repos/a/b/actions/runs/123/attempts/3/jobs?per_page=100&page=1"
    )
      return { jobs: [] };
    if (path === "repos/a/b/actions/jobs/10/logs") return raw;
    assert.fail("unexpected endpoint: " + path);
  };
  let report = await inspect(
    {
      run_url: "https://github.com/a/b/actions/runs/123/attempts/1",
      max_chars: 1000,
    },
    api,
  );
  assert.equal(report.status, "failed");
  assert.equal(report.runs[0].attempt, 1);
  assert.equal(report.commit, "old-sha");
  const chunks = [];
  do {
    assert.equal(report.errors[0].attempt, 1);
    assert.equal(report.errors[0].jobId, 10);
    chunks.push(report.errors[0].raw);
    if (!report.hasMore) break;
    report = await inspect({ cursor: report.cursor, max_chars: 1000 }, api);
  } while (true);
  assert.equal(chunks.join(""), raw);
  assert.ok(!paths.includes("repos/a/b/actions/runs/123"));
  const latest = await inspect({ repository: "a/b", run_id: 123 }, api);
  assert.equal(latest.status, "success");
  assert.equal(latest.runs[0].attempt, 3);
});
