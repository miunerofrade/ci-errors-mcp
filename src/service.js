import { createHash } from "node:crypto";
import { gh, selectRuns, jobsFor } from "./github.js";
import { extractErrors, failingSections, workspaceFromLog } from "./parser.js";
const reports = new Map();
export async function inspect(input, api = gh) {
  let target = input,
    cursor;
  if (input.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      if (
        cursor.version !== 1 ||
        !/^[-\w.]+\/[-\w.]+$/.test(cursor.repository) ||
        !Array.isArray(cursor.runs) ||
        !cursor.runs.every(
          (r) =>
            Number.isSafeInteger(r.id) &&
            r.id > 0 &&
            Number.isSafeInteger(r.attempt) &&
            r.attempt > 0,
        ) ||
        !Number.isSafeInteger(cursor.index) ||
        !Number.isSafeInteger(cursor.offset)
      )
        throw Error();
      target = { repository: cursor.repository };
    } catch {
      throw new Error("Invalid continuation cursor");
    }
  }
  const cached = cursor && api === gh ? reports.get(cursor.digest) : undefined;
  if (cached && cached.expires > Date.now())
    return paginate(cached.report, input, cursor, cursor.digest);
  let selected;
  try {
    selected = cursor
      ? {
          repository: cursor.repository,
          runs: await Promise.all(
            cursor.runs.map((r) =>
              api(
                `repos/${cursor.repository}/actions/runs/${r.id}/attempts/${r.attempt}`,
              ),
            ),
          ),
        }
      : await selectRuns(target, api);
  } catch (e) {
    return {
      status: e.category || "query_failed",
      message: e.message,
      errors: [],
    };
  }
  const report = {
    repository: selected.repository,
    commit: selected.sha || selected.runs[0]?.head_sha,
    runs: [],
    errors: [],
  };
  for (const run of selected.runs) {
    report.runs.push({
      runId: run.id,
      attempt: run.run_attempt,
      commit: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    });
    let jobs;
    try {
      jobs = await jobsFor(selected.repository, run, api);
    } catch (e) {
      report.errors.push({
        runId: run.id,
        kind: "query_error",
        message: e.message,
      });
      continue;
    }
    for (const job of jobs.filter((j) =>
      ["failure", "timed_out", "action_required", "startup_failure"].includes(
        j.conclusion,
      ),
    )) {
      const meta = {
        runId: run.id,
        attempt: run.run_attempt,
        jobId: job.id,
        job: job.name,
        steps: (job.steps || [])
          .filter((s) => ["failure", "timed_out"].includes(s.conclusion))
          .map((s) => ({
            number: s.number,
            name: s.name,
            conclusion: s.conclusion,
          })),
      };
      try {
        const raw = await api(
            `repos/${selected.repository}/actions/jobs/${job.id}/logs`,
            true,
          ),
          workspace = workspaceFromLog(raw);
        const sections = failingSections(raw);
        for (const section of sections)
          for (const error of extractErrors(section, workspace))
            report.errors.push({
              ...meta,
              ...error,
              logStartLine:
                raw.slice(0, raw.indexOf(section)).split("\n").length +
                error.logStartLine -
                1,
            });
      } catch (e) {
        report.errors.push({
          ...meta,
          kind: "log_unavailable",
          message: e.message,
        });
      }
    }
  }
  report.status = !report.runs.length
    ? "not_found"
    : report.errors.some(
          (e) => e.kind === "query_error" || e.kind === "log_unavailable",
        )
      ? "incomplete"
      : report.errors.length
        ? "failed"
        : report.runs.some((r) => r.status !== "completed")
          ? "running"
          : report.runs.some((r) => r.conclusion === "cancelled")
            ? "cancelled"
            : report.runs.every((r) => r.conclusion === "success")
              ? "success"
              : "completed_without_error_log";
  const digest = createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");
  if (cursor && cursor.digest !== digest)
    return {
      status: "changed",
      message: "Logs or run state changed; start a new query.",
      errors: [],
    };
  if (
    api === gh &&
    report.runs.every((r) => r.status === "completed") &&
    JSON.stringify(report).length <= 4 * 1024 * 1024
  ) {
    if (reports.size >= 4) reports.delete(reports.keys().next().value);
    reports.set(digest, { report, expires: Date.now() + 5 * 60 * 1000 });
  }
  return paginate(report, input, cursor, digest);
}
function paginate(report, input, cursor, digest) {
  const max = input.max_chars || 16000;
  let index = cursor?.index || 0,
    offset = cursor?.offset || 0,
    remaining = max;
  const errors = [];
  if (
    index < 0 ||
    index > report.errors.length ||
    offset < 0 ||
    (index < report.errors.length &&
      offset > (report.errors[index].raw || "").length)
  )
    throw Error("Invalid continuation position");
  while (index < report.errors.length && remaining > 0) {
    const entry = report.errors[index],
      text = entry.raw || "";
    if (!text) {
      errors.push(entry);
      index++;
      remaining -= JSON.stringify(entry).length;
      continue;
    }
    if (!offset && text.length > remaining && errors.length) break;
    const chunk = text.slice(offset, offset + remaining);
    errors.push({
      ...entry,
      raw: chunk,
      partial: offset > 0 || chunk.length < text.length,
      offset,
      totalChars: text.length,
    });
    remaining -= chunk.length;
    offset += chunk.length;
    if (offset >= text.length) {
      index++;
      offset = 0;
    } else break;
  }
  const more = index < report.errors.length;
  return {
    ...report,
    errors,
    totalErrors: report.errors.length,
    hasMore: more,
    ...(more
      ? {
          cursor: Buffer.from(
            JSON.stringify({
              version: 1,
              repository: report.repository,
              runs: report.runs.map((r) => ({
                id: r.runId,
                attempt: r.attempt,
              })),
              digest,
              index,
              offset,
            }),
          ).toString("base64url"),
        }
      : {}),
  };
}
export function format(report) {
  return [
    JSON.stringify({ ...report, errors: undefined }, null, 2),
    ...report.errors.map(
      (e) =>
        `${e.job || ""} / ${(e.steps || []).map((s) => s.name).join(", ")}\n${e.raw || e.message}\n${JSON.stringify(e.locations || [], null, 2)}${e.locationNote ? "\n" + e.locationNote : ""}`,
    ),
  ].join("\n\n");
}
