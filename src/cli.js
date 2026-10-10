#!/usr/bin/env node
import { inspect, format } from "./service.js";
import { inputSchema } from "./schema.js";
const args = process.argv.slice(2),
  input = {};
let json = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg === "--help") {
    console.log(
      "ci-errors [--run-url URL | --repository owner/repo --run-id ID | --repo-path PATH] [--attempt N] [--cursor CURSOR] [--max-chars N] [--json]",
    );
    process.exit(0);
  }
  const key = {
    "--run-url": "run_url",
    "--repository": "repository",
    "--run-id": "run_id",
    "--attempt": "attempt",
    "--repo-path": "repo_path",
    "--cursor": "cursor",
    "--max-chars": "max_chars",
  }[arg];
  if (!key || !args[i + 1]) {
    console.error("Unknown or incomplete argument: " + arg);
    process.exit(2);
  }
  input[key] = ["run_id", "attempt", "max_chars"].includes(key)
    ? Number(args[++i])
    : args[++i];
}
try {
  const result = await inspect(inputSchema.parse(input));
  console.log(json ? JSON.stringify(result, null, 2) : format(result));
  if (
    ![
      "success",
      "failed",
      "running",
      "cancelled",
      "not_found",
      "completed_without_error_log",
    ].includes(result.status)
  )
    process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
