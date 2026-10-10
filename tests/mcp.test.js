import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("stdio discovers one tool, validates inputs and continues the original error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-errors-protocol-"));
  const fake = `#!/usr/bin/env node
const path=process.argv.at(-1);
if(path.includes('/jobs/')) console.log('Error: fixture\\n'+('expected: abc actual: xyz\\n'.repeat(150)));
else if(path.includes('/jobs?'))console.log(JSON.stringify({jobs:[{id:5,name:'fixture',conclusion:'failure',steps:[{number:1,name:'test',conclusion:'failure'}]}]}));
else console.log(JSON.stringify({id:123,run_attempt:Number(path.match(/attempts\\/(\\d+)/)?.[1] || 3),head_sha:'abc',status:'completed',conclusion:'failure'}));
`;
  await writeFile(join(dir, "gh"), fake, { mode: 0o755 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/server.js")],
    env: { ...process.env, PATH: dir + ":" + process.env.PATH },
    stderr: "pipe",
  });
  const client = new Client({ name: "protocol-test", version: "1" });
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        resolve("src/cli.js"),
        "--repository",
        "owner/repo",
        "--run-id",
        "123",
        "--attempt",
        "2",
        "--json",
      ],
      { env: { ...process.env, PATH: dir + ":" + process.env.PATH } },
    );
    assert.equal(JSON.parse(stdout).runs[0].attempt, 2);
    await client.connect(transport);
    const list = await client.listTools();
    assert.deepEqual(
      list.tools.map((t) => t.name),
      ["ci_errors"],
    );
    assert.equal(list.tools[0].annotations.readOnlyHint, true);
    assert.ok(list.tools[0].inputSchema.properties.attempt);
    const invalid = await client.callTool({
      name: "ci_errors",
      arguments: { run_id: -1 },
    });
    assert.equal(invalid.isError, true);
    let response = await client.callTool({
      name: "ci_errors",
      arguments: {
        repository: "owner/repo",
        run_id: 123,
        attempt: 1,
        max_chars: 1000,
      },
    });
    assert.equal(response.structuredContent, undefined);
    assert.equal(response.content.length, 1);
    let report = JSON.parse(response.content[0].text);
    assert.equal(report.status, "failed");
    assert.equal(report.runs[0].attempt, 1);
    assert.ok(report.hasMore);
    assert.ok(report.errors[0].partial);
    const chunks = [report.errors[0].raw];
    let n = 0;
    while (report.hasMore) {
      response = await client.callTool({
        name: "ci_errors",
        arguments: { cursor: report.cursor, max_chars: 1000 },
      });
      assert.equal(response.structuredContent, undefined);
      report = JSON.parse(response.content[0].text);
      assert.equal(report.runs[0].attempt, 1);
      chunks.push(report.errors[0].raw);
      assert.ok(++n < 10);
    }
    assert.equal(
      chunks.join(""),
      "Error: fixture\n" + "expected: abc actual: xyz\n".repeat(150) + "\n",
    );
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
