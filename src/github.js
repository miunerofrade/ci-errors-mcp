import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function gh(path, text = false) {
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      const { stdout } = await exec(
        "gh",
        ["api", ...(text ? ["--allow-escape-sequences"] : []), path],
        { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
      );
      return text ? stdout : JSON.parse(stdout);
    } catch (error) {
      const message = error.stderr || error.message;
      const transient =
        /EOF|TLS handshake|timeout|timed out|ECONN|HTTP 50[234]|HTTP 429/i.test(
          message,
        );
      if (!transient || attempt === 2) {
        const e = new Error(
          message.replace(
            /https:\/\/[^\s]*\?[^\s]*/g,
            "[temporary download URL]",
          ),
        );
        e.category = /HTTP 40[13]|authentication|not logged/i.test(message)
          ? "permission_denied"
          : /HTTP 404|HTTP 410/i.test(message)
            ? "unavailable"
            : "query_failed";
        throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
}
async function git(path, args) {
  return (
    await exec("git", ["-C", path, ...args], { timeout: 10000 })
  ).stdout.trim();
}
export async function selectRuns(input, api = gh) {
  let repository = input.repository,
    runId = input.run_id,
    attempt = input.attempt,
    sha;
  if (input.run_url) {
    const u = new URL(input.run_url);
    const m = u.pathname.match(
      /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(?:\/job\/\d+)?\/?$/,
    );
    if (u.hostname !== "github.com" || !m)
      throw new Error("Expected a github.com Actions run URL");
    repository = m[1];
    runId = Number(m[2]);
    const urlAttempt = m[3] === undefined ? undefined : Number(m[3]);
    if (
      urlAttempt !== undefined &&
      attempt !== undefined &&
      urlAttempt !== attempt
    )
      throw new Error("attempt conflicts with the run URL attempt");
    attempt = urlAttempt ?? attempt;
  }
  if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1))
    throw new Error("attempt must be a positive safe integer");
  if (attempt !== undefined && !runId)
    throw new Error("attempt requires run_url or repository+run_id");
  if (input.repo_path) {
    sha = await git(input.repo_path, ["rev-parse", "HEAD"]);
    if (!repository) {
      const remote = await git(input.repo_path, [
        "remote",
        "get-url",
        "origin",
      ]);
      repository = remote.match(
        /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
      )?.[1];
    }
  }
  if (!repository || !/^[-\w.]+\/[-\w.]+$/.test(repository))
    throw new Error(
      "Provide repository owner/name or a local repository with a GitHub origin",
    );
  if (runId)
    return {
      repository,
      runs: [
        await api(
          `repos/${repository}/actions/runs/${runId}${attempt === undefined ? "" : `/attempts/${attempt}`}`,
        ),
      ],
    };
  if (!sha)
    throw new Error("Provide run_id, run_url or repo_path (current HEAD)");
  const runs = [];
  for (let page = 1; ; page++) {
    const response = await api(
      `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`,
    );
    runs.push(...response.workflow_runs.filter((r) => r.head_sha === sha));
    if (response.workflow_runs.length < 100) break;
  }
  const latest = new Map();
  for (const run of runs)
    if (!latest.has(run.workflow_id) || run.id > latest.get(run.workflow_id).id)
      latest.set(run.workflow_id, run);
  return { repository, sha, runs: [...latest.values()] };
}
export async function jobsFor(repository, run, api = gh) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const r = await api(
      `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(...r.jobs);
    if (r.jobs.length < 100) break;
  }
  return jobs;
}
