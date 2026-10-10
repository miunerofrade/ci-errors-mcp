import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI query failures exit 1 while retrieved CI failure reports exit 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-errors-cli-"));
  await writeFile(
    join(dir, "gh"),
    `#!/usr/bin/env node
const path = process.argv.at(-1), mode = process.env.CI_ERRORS_FIXTURE;
if (['404', '410', '403', 'network'].includes(mode)) {
  console.error(mode === 'network' ? 'connection refused' : 'HTTP ' + mode);
  process.exit(1);
}
if(path.includes('/jobs/')) {
  if(mode === 'log-expired') {console.error('HTTP 410'); process.exit(1);}
  console.log('Error: fixture failure');
} else if(path.includes('/jobs?')) {
  console.log(JSON.stringify({jobs: mode === 'success' ? [] : [{id:5,name:'test',conclusion:'failure',steps:[]}]}));
} else {
  console.log(JSON.stringify({id:123,run_attempt:1,head_sha:'abc',status:'completed',conclusion:mode === 'success' ? 'success' : 'failure'}));
}
`,
    { mode: 0o755 },
  );
  try {
    for (const [mode, code, status] of [
      ["404", 1, "unavailable"],
      ["410", 1, "unavailable"],
      ["403", 1, "permission_denied"],
      ["network", 1, "query_failed"],
      ["log-expired", 1, "incomplete"],
      ["success", 0, "success"],
      ["failure", 0, "failed"],
    ]) {
      let result;
      try {
        result = await promisify(execFile)(
          process.execPath,
          [
            resolve("src/cli.js"),
            "--repository",
            "a/b",
            "--run-id",
            "123",
            "--json",
          ],
          {
            env: {
              ...process.env,
              PATH: dir + ":" + process.env.PATH,
              CI_ERRORS_FIXTURE: mode,
            },
          },
        );
        result.code = 0;
      } catch (error) {
        result = error;
      }
      assert.equal(result.code, code, mode);
      assert.equal(JSON.parse(result.stdout).status, status, mode);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
