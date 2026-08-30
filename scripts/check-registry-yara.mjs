#!/usr/bin/env node
// Local replica of the Comfy Registry's `python_network_operations` YARA rule.
//
// WHY THIS EXISTS. ci.yml already has a "registry parity" step, but it covers only
// SUSP_SVG_Onload_Onerror and the process-spawn literals. The registry added a
// network-operations rule family, and because nothing here knew about it, CI stayed
// green through EIGHT consecutive flagged releases (0.15.96 - 0.15.103). A parity
// gate that does not track the ruleset is not a parity gate.
//
// The patterns are NOT guessed. The registry publishes the matched pattern name per
// finding at GET /nodes/<id>/versions?include_status_reason=true (metadata.matched_patterns):
//
//   $socket3            .connect(            litegraph slot wiring
//   $socket4            .bind(               JavaScript Function.prototype.bind
//   $socket_stage_recv  .send( / .sendall( / .recv(   socket traffic, EITHER DIRECTION
//   $http5              aiohttp.ClientSession
//
// WHITESPACE IS ALLOWED BEFORE THE PAREN: web/changelog.json was flagged on the prose
// "Function.prototype.bind (#1867)", where the changelog generator's own " (#N)" suffix
// supplied the paren.
//
// COMMENTS ARE STRIPPED IN CODE FILES, NOT DATA FILES. Calibrated on v0.15.103:
//   flagged  rehello-gate.js:573         entry.send();                      (code)
//   flagged  restart-tab-identity.js:150 socket.send(...)                   (code)
//   NOT      completion-delivery-diagnostics.js:4   // ... WebSocket.send() ...
//   NOT      connect-verify.js:3                    // ... LGraphNode.connect(...) ...
//   flagged  web/changelog.json:1        prose - JSON has no comments to strip
//
// One finding per (rule, file), as the registry reports. Line numbers are not part of
// the identity: the registry's own anchor drifts as a file grows.
//
// SCAN THE PACKAGED ARCHIVE, NEVER THE REPO (#1886). The registry reads node.zip.
// The working tree still contains every trigger in tests and scripts; the published
// pack does not. A repo-wide grep would have called the clean 0.15.113 dirty, and
// a scan that only knew about the rules it already modelled stayed green through
// ten flagged releases. Default CLI path = git-tracked minus .comfyignore, which
// is what `comfy node publish` packs. `--archive DIR` scans a packed tree as-is.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  { id: "$socket3", re: /\.connect\s*\(/ },
  { id: "$socket4", re: /\.bind\s*\(/ },
  // READS COUNT TOO. v0.15.111 flagged __init__.py on this rule anchored at
  // `chunk = probe.recv(4096)` — after the only .sendall( calls in that file had been
  // refactored away. The rule's own NAME says recv; we all read it as "send" and the
  // replica under-reported for it. `send`/`sendall`/`recv` are evidenced by real
  // verdicts; `sendto`/`recvfrom`/`recv_into` are included as the conservative
  // superset, because this gate must fail CLOSED — a miss ships a flagged release.
  { id: "$socket_stage_recv", re: /\.(?:send(?:all|to)?|recv(?:from|_into)?)\s*\(/ },
  { id: "$http5", re: /aiohttp\s*\.\s*ClientSession/ },
];

function posix(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

// Blank comments while PRESERVING offsets so line numbers stay true. String literals
// are skipped rather than scanned, so a URL's `//` is never read as a comment start.
export function stripComments(text, path) {
  const js = /\.(?:js|mjs|cjs|ts|mts|cts)$/i.test(path);
  const py = /\.py$/i.test(path);
  if (!js && !py) return text;
  const keep = (ch) => (ch === "\n" ? "\n" : " ");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"' || c === "'" || (js && c === "`")) {
      const quote = c;
      out += keep(c);
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") { out += keep(text[i]) + keep(text[i + 1] || ""); i += 2; continue; }
        out += keep(text[i]);
        i += 1;
      }
      if (i < text.length) out += keep(text[i]);
      i += 1;
      continue;
    }
    if (js && c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") { out += " "; i += 1; } continue; }
    if (js && c === "/" && n === "*") {
      out += "  "; i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { out += keep(text[i]); i += 1; }
      out += "  "; i += 2;
      continue;
    }
    if (py && c === "#") { while (i < text.length && text[i] !== "\n") { out += " "; i += 1; } continue; }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Scan a packaged archive. `files` is the pack itself — every entry is a file the
 * registry would see. Callers that still have a repo must already have dropped
 * .comfyignore'd paths; this function does not second-guess that.
 */
export function scanArchive(files) {
  const findings = [];
  for (const entry of files) {
    const file = posix(entry.file);
    const text = String(entry.text ?? "");
    const scanned = stripComments(text, file);
    for (const rule of RULES) {
      const m = rule.re.exec(scanned);
      if (!m) continue;
      findings.push({
        file,
        rule: rule.id,
        line: scanned.slice(0, m.index).split("\n").length,
        match: m[0].trim(),
      });
    }
  }
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  return { findings, byFile, files: [...byFile.keys()].sort() };
}

export function flaggedFileCount(result) {
  return result.byFile.size;
}

export function exceedsAllowance(result, allow = 0) {
  return flaggedFileCount(result) > Number(allow);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isComfyignored(root, path) {
  try {
    execFileSync(
      "git",
      ["-c", "core.excludesFile=.comfyignore", "check-ignore", "--no-index", "-q", path],
      { cwd: root, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Published archive = tracked files minus .comfyignore. `--no-index` is REQUIRED:
 * without it git reports a TRACKED file as not-ignored regardless of the pattern,
 * which silently included scripts/, registry/ and browser_tests/ and made this
 * over-report by a factor of eight.
 */
export function listShippedPaths(root) {
  const tracked = git(root, "ls-files", "-z").split("\0").filter(Boolean);
  return tracked.filter((p) => !isComfyignored(root, p));
}

export function loadShippedArchive(root) {
  return listShippedPaths(root).flatMap((file) => {
    try {
      return [{ file, text: readFileSync(resolve(root, file), "utf8") }];
    } catch {
      return [];
    }
  });
}

function walkFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

export function loadArchiveDir(dir) {
  return walkFiles(dir).flatMap((file) => {
    try {
      return [{ file: posix(file), text: readFileSync(join(dir, ...file.split("/")), "utf8") }];
    } catch {
      return [];
    }
  });
}

/**
 * Registry status_reason is a JSON array of findings when Flagged, the prose
 * "Passed automated checks" when Active, and empty while the version is still
 * in the scan queue.
 */
export function parseStatusReason(statusReason) {
  if (statusReason == null || statusReason === "") return [];
  if (Array.isArray(statusReason)) return statusReason;
  if (typeof statusReason === "object") {
    return Array.isArray(statusReason.findings) ? statusReason.findings : [statusReason];
  }
  const raw = String(statusReason).trim();
  if (!raw || raw === "Passed automated checks") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Pending is a queue position, not a pass (#1886). An unscanned version is
 * neither passing nor failing; reading it as "clean" invents a verdict.
 *
 *   fail    — Flagged / Banned, or any parsed findings
 *   queued  — Pending with no findings yet
 *   pass    — Active with no findings
 *   unknown — any other status
 */
export function classifyRegistryVersion(record) {
  const status = String(record?.status ?? "");
  const findings = parseStatusReason(record?.status_reason);
  if (findings.length > 0 || /Flagged|Banned/i.test(status)) {
    return { verdict: "fail", status, findings };
  }
  if (/Pending/i.test(status)) {
    return { verdict: "queued", status, findings };
  }
  if (/Active/i.test(status)) {
    return { verdict: "pass", status, findings };
  }
  return { verdict: "unknown", status, findings };
}

export function isRegistryClean(record) {
  return classifyRegistryVersion(record).verdict === "pass";
}

function printReport(result, { json, allow, scanned }) {
  if (json) {
    console.log(JSON.stringify({ files: result.files, findings: result.findings }, null, 2));
    return;
  }
  console.log(`scanned ${scanned} shipped file(s)\n`);
  for (const file of result.files) {
    console.log(`  ${file}`);
    for (const f of result.byFile.get(file)) console.log(`      ${f.rule} @${f.line}  ${f.match}`);
  }
  console.log(
    `\n${result.byFile.size} file(s) would be flagged python_network_operations` +
      (allow ? ` (allowance ${allow})` : ""),
  );
}

export function main(argv = process.argv.slice(2), { cwd } = {}) {
  const JSON_OUT = argv.includes("--json");
  const allowIdx = argv.indexOf("--allow");
  const ALLOW = allowIdx >= 0 ? Number(argv[allowIdx + 1]) : 0;
  const archiveIdx = argv.indexOf("--archive");
  const archiveDir = archiveIdx >= 0 ? argv[archiveIdx + 1] : null;

  const root = cwd
    || (archiveDir ? resolve(archiveDir) : git(".", "rev-parse", "--show-toplevel").trim());
  const files = archiveDir ? loadArchiveDir(resolve(archiveDir)) : loadShippedArchive(root);
  const result = scanArchive(files);
  printReport(result, { json: JSON_OUT, allow: ALLOW, scanned: files.length });
  return exceedsAllowance(result, ALLOW) ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());
