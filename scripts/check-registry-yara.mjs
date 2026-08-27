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

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const JSON_OUT = process.argv.includes("--json");
const allowIdx = process.argv.indexOf("--allow");
const ALLOW = allowIdx >= 0 ? Number(process.argv[allowIdx + 1]) : 0;

const RULES = [
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

// Blank comments while PRESERVING offsets so line numbers stay true. String literals
// are skipped rather than scanned, so a URL's `//` is never read as a comment start.
function stripComments(text, path) {
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

// Published archive = tracked files minus .comfyignore. `--no-index` is REQUIRED:
// without it git reports a TRACKED file as not-ignored regardless of the pattern,
// which silently included scripts/, registry/ and browser_tests/ and made this
// over-report by a factor of eight.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean);

const shipped = tracked.filter((p) => {
  try {
    execFileSync("git", ["-c", "core.excludesFile=.comfyignore", "check-ignore", "--no-index", "-q", p],
      { cwd: ROOT, stdio: "ignore" });
    return false;
  } catch { return true; }
});

const findings = [];
for (const path of shipped) {
  let text;
  try { text = readFileSync(resolve(ROOT, path), "utf8"); } catch { continue; }
  const scanned = stripComments(text, path);
  for (const rule of RULES) {
    const m = rule.re.exec(scanned);
    if (!m) continue;
    findings.push({ file: path, rule: rule.id, line: scanned.slice(0, m.index).split("\n").length, match: m[0].trim() });
  }
}

const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ files: [...byFile.keys()].sort(), findings }, null, 2));
} else {
  console.log(`scanned ${shipped.length} shipped file(s)\n`);
  for (const file of [...byFile.keys()].sort()) {
    console.log(`  ${file}`);
    for (const f of byFile.get(file)) console.log(`      ${f.rule} @${f.line}  ${f.match}`);
  }
  console.log(`\n${byFile.size} file(s) would be flagged python_network_operations` + (ALLOW ? ` (allowance ${ALLOW})` : ""));
}

process.exit(byFile.size > ALLOW ? 1 : 0);
