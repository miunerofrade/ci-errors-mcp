const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export const clean = (line) =>
  line
    .replace(ansi, "")
    .replace(/^\d{4}-\d\d-\d\dT\S+\s/, "")
    .replace(/^# ?/, "");
export function locations(text, workspace) {
  const result = [],
    seen = new Set();
  let firstFrame = true;
  for (const raw of text.split("\n")) {
    const line = clean(raw);
    let role = "diagnostic";
    if (/location:|test at |^\s*[✖❌].*\(.+:\d+/.test(line))
      role = "test_definition";
    else if (/^\s*at |^\s*(?:async )?[\w.<]+.*\(.+:\d+|File "/.test(line))
      role = firstFrame ? "throw_site" : "stack";
    const patterns = [
      /File "([^"]+)", line (\d+)/g,
      /((?:[A-Za-z]:[\\/]|file:\/\/\/|\/)[^'"()<>]*?\.[a-zA-Z\d]+|(?:[\w.@-]+[\\/])*[\w.@-]+\.[a-zA-Z\d]+)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))/g,
    ];
    for (const pattern of patterns)
      for (const m of line.matchAll(pattern)) {
        const path = m[1].replace(/\\\\/g, "\\");
        const number = Number(m[2] || m[4]);
        if (!number) continue;
        let normalized = path.replace(/^file:\/\//, "").replace(/\\/g, "/");
        normalized = normalized.replace(/^\/([A-Za-z]:\/)/, "$1");
        const root = workspace?.replace(/\\/g, "/").replace(/\/$/, "");
        let relative =
          root && normalized.startsWith(root + "/")
            ? normalized.slice(root.length + 1)
            : undefined;
        if (!relative && !/^([A-Za-z]:|\/)/.test(normalized))
          relative = normalized;
        const entry = {
          path,
          line: number,
          ...(m[3] || m[5] ? { column: Number(m[3] || m[5]) } : {}),
          role,
          ...(relative ? { relativePath: relative } : {}),
        };
        const key = JSON.stringify(entry);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(entry);
        }
        if (role === "throw_site" || role === "stack") firstFrame = false;
      }
  }
  // Python traceback lists callers first; its final frame is the exception site.
  const python = result.filter((x) => text.includes(`File "${x.path}"`));
  if (python.length) {
    for (const x of python) x.role = "stack";
    python.at(-1).role = "throw_site";
  }
  return result;
}
export function extractErrors(raw, workspace) {
  const lines = raw.split("\n"),
    normalized = lines.map(clean),
    spans = [];
  const specSummary = normalized.findIndex((x) => /✖ failing tests:/.test(x));
  const starts =
    /(?:^\s*not ok\b|Traceback \(most recent call last\)|^\s*(?:# )?✖ |^\s*❌ |(?:^|\s)(?:[A-Za-z]*Error|Exception):|\berror TS\d+:|\.[\w]+\(\d+,\d+\): error|^\s*FAILED\b|^\s*E\s+\w+Error|##\[error\])/;
  for (let i = 0; i < lines.length; i++) {
    if (spans.some(([a, b]) => i >= a && i < b)) continue;
    if (/^\s*test at /.test(normalized[i])) {
      let end = i + 1;
      while (
        end < lines.length &&
        !/^\s*test at |##\[(?:group|error)\]/.test(normalized[end])
      )
        end++;
      spans.push([i, end]);
      continue;
    }
    if (
      /✖ failing tests:/.test(normalized[i]) ||
      (specSummary >= 0 && i < specSummary && /✖ /.test(normalized[i]))
    )
      continue;
    if (
      !starts.test(normalized[i]) ||
      /Process completed with exit code/.test(normalized[i])
    )
      continue;
    let start = i,
      end = i + 1;
    if (/not ok\b/.test(normalized[i])) {
      if (i > 0 && /Subtest:/.test(normalized[i - 1])) start = i - 1;
      while (
        end < lines.length &&
        !/^\s*\.\.\.\s*$/.test(normalized[end]) &&
        !/^\s*(?:ok |not ok |##\[group\])/.test(normalized[end])
      )
        end++;
      if (/^\s*\.\.\./.test(normalized[end] || "")) end++;
    } else {
      while (
        start > 0 &&
        start > i - 3 &&
        !/^\s*$|##\[(?:group|endgroup)\]|^\s*(?:ok |not ok )/.test(
          normalized[start - 1],
        )
      )
        start--;
      while (
        end < lines.length &&
        !/##\[(?:group|endgroup)\]|^\s*(?:ok |not ok )|^\s*✔ |^\s*test at |✖ failing tests:/.test(
          normalized[end],
        )
      )
        end++;
    }
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const prev = merged.at(-1);
    if (prev && span[0] < prev[1]) prev[1] = Math.max(prev[1], span[1]);
    else merged.push(span);
  }
  const blocks = merged.length ? merged : [[0, lines.length]];
  return blocks.map(([start, end]) => {
    const text = lines.slice(start, end).join("\n");
    const positions = locations(text, workspace);
    return {
      kind: merged.length ? "error" : "step_log",
      raw: text,
      logStartLine: start + 1,
      locations: positions,
      locationNote: positions.length ? undefined : "日志未提供文件与行号",
    };
  });
}
export function failingSections(raw) {
  const lines = raw.split("\n");
  let group = 0;
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (clean(lines[i]).startsWith("##[group]Run ")) group = i;
    if (
      /##\[error\]Process completed|##\[error\].*(?:timed out|timeout)/i.test(
        lines[i],
      )
    )
      sections.push(lines.slice(group, i + 1).join("\n"));
  }
  return sections.length ? sections : [raw];
}
export function workspaceFromLog(raw) {
  // The command is present on all checkout runners; do not infer roots from arbitrary stack paths.
  const command = raw
    .split("\n")
    .find((x) => /git.*config --global --add safe\.directory /.test(x));
  return command
    ? clean(command)
        .split("safe.directory ")
        .at(-1)
        .trim()
        .replace(/^['"]|['"]$/g, "")
    : undefined;
}
