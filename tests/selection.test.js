import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectRuns } from "../src/github.js";
import { inspect } from "../src/service.js";
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
