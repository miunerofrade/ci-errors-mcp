import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractErrors, locations, failingSections } from "../src/parser.js";
import { inspect } from "../src/service.js";
const fixture = async (name) =>
  readFile(new URL("fixtures/" + name, import.meta.url), "utf8");
test("Windows TAP keeps raw assertion and distinguishes definition and throwing frame", async () => {
  const raw = await fixture("node-windows.txt"),
    blocks = extractErrors(raw, "D:/a/SEUdaily/SEUdaily");
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].raw.includes("expected: true"));
  assert.ok(blocks[0].raw.includes("actual: false"));
  assert.ok(!blocks[0].raw.includes("next passing"));
  assert.deepEqual(
    blocks[0].locations.map((x) => [x.line, x.role]),
    [
      [21, "test_definition"],
      [53, "throw_site"],
    ],
  );
  assert.equal(
    blocks[0].locations[1].relativePath,
    "tests/test_agent_http.mjs",
  );
});
test("Python retains traceback and identifies last frame", async () => {
  const blocks = extractErrors(
    await fixture("python.txt"),
    "/Users/runner/work/SEUdaily/SEUdaily",
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].locations.at(-1).line, 121);
  assert.equal(blocks[0].locations.at(-1).role, "throw_site");
  assert.equal(blocks[0].locations[0].role, "stack");
});
test("hash mismatch retains full expected and actual without classifying cause", () => {
  const raw =
    "not ok 88 - document hash\n  ---\n  error: |-\n    Expected values to be strictly equal:\n    + actual - expected\n    + hash-a\n    - hash-b\n  expected: hash-b\n  actual: hash-a\n  stack: |-\n    <anonymous> (/repo/tests/test_knowledge.mjs:238:62)\n  ...";
  const b = extractErrors(raw, "/repo")[0];
  assert.equal(b.raw, raw);
  assert.equal(b.locations[0].line, 238);
});
test("startup exception preceding file-level TAP failure is preserved", () => {
  const raw =
    '# Error: Cannot find tsconfig\n#     at load (/repo/tests/test_web_message.mjs:16:9)\n# Subtest: tests/test_web_message.mjs\nnot ok 1 - tests/test_web_message.mjs\n  ---\n  location: "/repo/tests/test_web_message.mjs:1:1"\n  error: test failed\n  ...';
  const blocks = extractErrors(raw, "/repo");
  assert.ok(blocks.some((x) => x.raw.includes("Cannot find tsconfig")));
  assert.ok(blocks.flatMap((x) => x.locations).some((x) => x.line === 16));
  assert.ok(
    blocks
      .flatMap((x) => x.locations)
      .some((x) => x.line === 1 && x.role === "test_definition"),
  );
});
test("compiler locations, no positions, exit-only fallback and multiple errors", () => {
  assert.equal(
    locations("src/a.ts(12,7): error TS2322: wrong type")[0].line,
    12,
  );
  assert.equal(
    extractErrors(
      "command output\n##[error]Process completed with exit code 1.",
    )[0].kind,
    "step_log",
  );
  assert.equal(
    extractErrors("Error: network disconnected")[0].locationNote,
    "日志未提供文件与行号",
  );
  assert.equal(
    extractErrors("not ok 1 - one\n ...\nnot ok 2 - two\n ...").length,
    2,
  );
  assert.deepEqual(
    failingSections(
      "##[group]Run test\n##[endgroup]\nError: bad\n##[error]Process completed with exit code 1.\n##[group]Upload\nnoise",
    ),
    [
      "##[group]Run test\n##[endgroup]\nError: bad\n##[error]Process completed with exit code 1.",
    ],
  );
});
const run = {
  id: 123,
  workflow_id: 1,
  head_sha: "abc",
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
};
function apiFor(raw, options = {}) {
  return async (path, text) => {
    if (path.includes("/jobs/")) {
      if (options.logError)
        throw Object.assign(Error(options.logError), {
          category: "unavailable",
        });
      return raw;
    }
    if (path.endsWith("/jobs?per_page=100&page=1"))
      return {
        jobs: [
          {
            id: 5,
            name: "windows",
            conclusion: options.timeout ? "timed_out" : "failure",
            steps: [{ number: 2, name: "test", conclusion: "failure" }],
          },
        ],
      };
    return { ...run, ...options.run };
  };
}
test("pagination preserves every original character, pins attempt, detects changed logs", async () => {
  const raw = "Error: bad\n" + "expected actual long\n".repeat(150);
  let r = await inspect(
    { repository: "owner/repo", run_id: 123, max_chars: 1000 },
    apiFor(raw),
  );
  const parts = [r.errors[0].raw];
  let n = 0;
  assert.ok(r.hasMore);
  assert.ok(r.errors[0].partial);
  const changed = await inspect(
    { cursor: r.cursor, max_chars: 1000 },
    apiFor(raw + "changed"),
  );
  assert.equal(changed.status, "changed");
  while (r.hasMore) {
    r = await inspect({ cursor: r.cursor, max_chars: 1000 }, apiFor(raw));
    parts.push(r.errors[0].raw);
    assert.ok(++n < 10);
  }
  assert.equal(parts.join(""), raw);
});
test("unavailable logs, timeout, query permissions and run states are explicit", async () => {
  assert.equal(
    (
      await inspect(
        { repository: "a/b", run_id: 123 },
        apiFor("", { logError: "HTTP 410" }),
      )
    ).status,
    "incomplete",
  );
  assert.equal(
    (
      await inspect(
        { repository: "a/b", run_id: 123 },
        apiFor("timeout output", { timeout: true }),
      )
    ).status,
    "failed",
  );
  const noJobs = async (p) =>
    p.includes("/jobs?")
      ? { jobs: [] }
      : { ...run, status: "in_progress", conclusion: null };
  assert.equal(
    (await inspect({ repository: "a/b", run_id: 123 }, noJobs)).status,
    "running",
  );
  for (const conclusion of ["success", "cancelled"]) {
    const api = async (p) =>
      p.includes("/jobs?") ? { jobs: [] } : { ...run, conclusion };
    assert.equal(
      (await inspect({ repository: "a/b", run_id: 123 }, api)).status,
      conclusion,
    );
  }
  const denied = async () => {
    throw Object.assign(Error("HTTP 403"), { category: "permission_denied" });
  };
  assert.equal(
    (await inspect({ repository: "a/b", run_id: 123 }, denied)).status,
    "permission_denied",
  );
});
test("actual Node 24 spec errors have separate complete blocks and repository positions", async () => {
  const raw = await fixture("real-node24.txt"),
    blocks = extractErrors(raw, "D:/a/ExampleProject/ExampleProject");
  assert.equal(blocks.length, 5);
  const assertion = blocks.find((b) =>
    b.raw.includes("test at tests\\test_agent_http.mjs"),
  );
  assert.ok(assertion.raw.includes("expected: true"));
  assert.ok(assertion.raw.includes("actual: false"));
  assert.ok(
    assertion.locations.some(
      (x) =>
        x.role === "throw_site" &&
        x.line === 53 &&
        x.relativePath === "tests/test_agent_http.mjs",
    ),
  );
  assert.ok(
    assertion.locations.some(
      (x) => x.role === "test_definition" && x.line === 21,
    ),
  );
  const hash = blocks.find((b) =>
    b.raw.includes("test at tests\\test_knowledge.mjs"),
  );
  assert.ok(hash.raw.includes("expected:"));
  assert.ok(
    hash.locations.some((x) => x.role === "throw_site" && x.line === 238),
  );
  assert.ok(
    blocks[0].locations.some(
      (x) => x.relativePath === "tests/test_web_message.mjs" && x.line === 7,
    ),
  );
});
test("bare compiler filenames and stack paths containing spaces remain accurate", () => {
  assert.equal(
    locations("index.ts(12,7): error TS2322: wrong type")[0].path,
    "index.ts",
  );
  const entry = locations(
    "    at main (/repo/My Project/src/a.ts:14:3)",
    "/repo/My Project",
  )[0];
  assert.equal(entry.path, "/repo/My Project/src/a.ts");
  assert.equal(entry.relativePath, "src/a.ts");
});
test("actual timestamped Python exception keeps the precise assertion frame", async () => {
  const blocks = extractErrors(
    await fixture("real-python.txt"),
    "/Users/runner/work/ExampleProject/ExampleProject",
  );
  assert.equal(blocks.length, 1);
  const entry = blocks[0].locations.at(-1);
  assert.equal(entry.line, 121);
  assert.equal(entry.role, "throw_site");
  assert.equal(entry.relativePath, "scripts/validate-terminal.py");
  assert.ok(blocks[0].raw.includes("session picker must delete"));
});
