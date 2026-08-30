/**
 * #1886 — the pre-publish "Comfy Registry parity" gate stayed green through ten
 * consecutive Flagged releases because it predicted from the repo, not from the
 * packaged archive the registry actually scans.
 *
 * Two facts that cost real time there, locked here:
 *
 *   1. Predict from the archive, never the repo. browser_tests/ and scripts/
 *      still contain every python_network_operations trigger; the published
 *      pack does not. A repo-wide scan would have called the clean 0.15.113
 *      dirty, and a scan that only knew SVG + process-spawn stayed green
 *      through 0.15.112 (Flagged, 1 Python trigger in the zip).
 *   2. Pending is a queue position, not a pass. An unscanned version is
 *      neither passing nor failing; reading it as "clean" invents a verdict.
 *
 * These exercise the production scanner (scripts/check-registry-yara.mjs) and
 * the production workflow wiring, not a copy of either.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyRegistryVersion,
  exceedsAllowance,
  isRegistryClean,
  listShippedPaths,
  loadArchiveDir,
  parseStatusReason,
  scanArchive,
} from "../../scripts/check-registry-yara.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-registry-yara.mjs");
const CI = join(ROOT, ".github", "workflows", "ci.yml");
const PUBLISH = join(ROOT, ".github", "workflows", "publish_action.yml");

const RECV = 'chunk = probe.recv(4096)\n';
const BIND = "handler.bind(this)\n";
const SEND = "socket.send(payload)\n";
const CONNECT = "subgraphInput.connect(slot, node)\n";
const HTTP = "session = aiohttp.ClientSession()\n";
const CLEAN = "print('no network tokens')\n";

function flags(files) {
  return scanArchive(files);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// the 0.15.112 → 0.15.113 boundary the registry actually scored
// ---------------------------------------------------------------------------

test("#1886 a 0.15.112-shaped pack is dirty: one shipped .recv( is enough", () => {
  // The last Flagged release. Registry findings=1 on __init__.py, matched_patterns
  // [$socket_stage_recv], snippet `chunk = probe.recv(4096)`. The replica as it
  // stood then modelled send-only and reported 0 on this file.
  const result = flags([{ file: "__init__.py", text: RECV }]);
  assert.equal(result.byFile.size, 1);
  assert.equal(result.findings[0].rule, "$socket_stage_recv");
  assert.equal(result.findings[0].match, ".recv(");
  assert.equal(exceedsAllowance(result, 0), true);
});

test("#1886 a 0.15.113-shaped pack is clean: zero triggers in the archive", () => {
  const result = flags([
    { file: "__init__.py", text: CLEAN },
    { file: "web/js/comfyui-mcp-panel.js", text: "const x = 1;\n" },
  ]);
  assert.equal(result.byFile.size, 0);
  assert.equal(exceedsAllowance(result, 0), false);
});

// ---------------------------------------------------------------------------
// archive vs repo — the remaining #1886 gap
// ---------------------------------------------------------------------------

test("#1886 a dirty repo with a clean pack must not fail: unshipped triggers do not count", () => {
  // These paths are .comfyignore'd. They still live in git. A repo-wide grep
  // of the working tree finds them; the registry never sees them.
  const repo = [
    { file: "browser_tests/unit/test_bridge_identity.py", text: BIND + RECV + SEND },
    { file: "scripts/check-tool-vocabulary.mjs", text: BIND },
    { file: "registry/src/worker.js", text: "stmt.bind(id)\n" },
    { file: "__init__.py", text: CLEAN },
  ];
  const naive = flags(repo);
  assert.ok(naive.byFile.size >= 3, "a repo-wide scan would have called 0.15.113 dirty");

  const pack = flags(repo.filter((f) => f.file === "__init__.py"));
  assert.equal(pack.byFile.size, 0, "the published archive of that same tree is clean");
});

test("#1886 git-tracked minus .comfyignore is the pack, so tests/scripts never reach the scan", () => {
  const cwd = mkdtempSync(join(tmpdir(), "panel-registry-yara-pack-"));
  try {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.email", "yara-parity@example.invalid");
    git(cwd, "config", "user.name", "yara-parity");
    writeFileSync(
      join(cwd, ".comfyignore"),
      ["browser_tests/", "scripts/", "CHANGELOG.md"].join("\n") + "\n",
    );
    mkdirSync(join(cwd, "browser_tests", "unit"), { recursive: true });
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    writeFileSync(join(cwd, "browser_tests", "unit", "test_bridge_identity.py"), BIND + RECV);
    writeFileSync(join(cwd, "scripts", "helper.mjs"), BIND);
    writeFileSync(join(cwd, "CHANGELOG.md"), "the replica missed .recv(\n");
    writeFileSync(join(cwd, "__init__.py"), CLEAN);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "fixture pack");

    const shipped = listShippedPaths(cwd);
    assert.ok(shipped.includes("__init__.py"));
    assert.ok(!shipped.some((p) => p.startsWith("browser_tests/")));
    assert.ok(!shipped.some((p) => p.startsWith("scripts/")));
    assert.ok(!shipped.includes("CHANGELOG.md"));

    const result = flags(
      shipped.map((file) => ({ file, text: readFileSync(join(cwd, file), "utf8") })),
    );
    assert.equal(result.byFile.size, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("#1886 --archive scans the packed tree as-is, including a trigger that would be ignored in the repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-registry-yara-zip-"));
  try {
    writeFileSync(join(dir, "__init__.py"), RECV);
    const packed = loadArchiveDir(dir);
    const result = flags(packed);
    assert.equal(result.byFile.size, 1);
    assert.equal(result.findings[0].file, "__init__.py");

    const cli = spawnSync(process.execPath, [SCRIPT, "--archive", dir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 1);
    const payload = JSON.parse(cli.stdout);
    assert.deepEqual(payload.files, ["__init__.py"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// rule fidelity — the misses that made the gate green
// ---------------------------------------------------------------------------

test("#1886 $socket_stage_recv matches reads, not just writes", () => {
  for (const [text, match] of [
    [RECV, ".recv("],
    ["probe.sendall(request)\n", ".sendall("],
    ["sock.send(payload)\n", ".send("],
  ]) {
    const result = flags([{ file: "__init__.py", text }]);
    assert.equal(result.findings[0].rule, "$socket_stage_recv", text);
    assert.equal(result.findings[0].match, match, text);
  }
});

test("#1886 whitespace before the paren is a match — changelog 0.15.103", () => {
  const result = flags([
    { file: "web/changelog.json", text: "Function.prototype.bind (#1867)\n" },
  ]);
  assert.equal(result.byFile.size, 1);
  assert.equal(result.findings[0].rule, "$socket4");
});

test("#1886 comments are stripped in code files, not in data files", () => {
  const jsComment = flags([{ file: "web/js/lib/connect-verify.js", text: "// LGraphNode.connect(outIdx, target)\nconst x = 1;\n" }]);
  const pyComment = flags([{ file: "__init__.py", text: "# chunk = probe.recv(4096)\nvalue = 1\n" }]);
  const jsonProse = flags([{ file: "web/changelog.json", text: "LGraphNode.connect(outIdx, target)\n" }]);
  assert.equal(jsComment.byFile.size, 0);
  assert.equal(pyComment.byFile.size, 0);
  assert.equal(jsonProse.byFile.size, 1);
  assert.equal(jsonProse.findings[0].rule, "$socket3");
});

test("#1886 one finding per (rule, file); line numbers are not the identity", () => {
  const result = flags([{ file: "web/js/x.js", text: CONNECT + CONNECT + BIND + SEND }]);
  const rules = result.findings.map((f) => f.rule).sort();
  assert.deepEqual(rules, ["$socket3", "$socket4", "$socket_stage_recv"]);
  assert.equal(result.byFile.size, 1);
});

test("#1886 a bare-name aiohttp import is not $http5; the dotted form is", () => {
  const bare = flags([{ file: "py/civitai_proxy.py", text: "from aiohttp import ClientSession\n" }]);
  const dotted = flags([{ file: "py/civitai_proxy.py", text: HTTP }]);
  assert.equal(bare.byFile.size, 0);
  assert.equal(dotted.findings[0].rule, "$http5");
});

// ---------------------------------------------------------------------------
// Pending is a queue position, not a pass
// ---------------------------------------------------------------------------

test("#1886 Pending with no findings is queued, not clean", () => {
  const pending = {
    version: "0.15.125",
    status: "NodeVersionStatusPending",
    status_reason: "",
  };
  assert.equal(classifyRegistryVersion(pending).verdict, "queued");
  assert.equal(isRegistryClean(pending), false);
});

test("#1886 Active with 'Passed automated checks' is the only pass", () => {
  const active = {
    version: "0.15.124",
    status: "NodeVersionStatusActive",
    status_reason: "Passed automated checks",
  };
  assert.equal(classifyRegistryVersion(active).verdict, "pass");
  assert.equal(isRegistryClean(active), true);
  assert.deepEqual(parseStatusReason(active.status_reason), []);
});

test("#1886 Flagged with parsed findings is fail, even if someone reads findings=0 from Pending later", () => {
  const flagged = {
    version: "0.15.112",
    status: "NodeVersionStatusFlagged",
    status_reason: JSON.stringify([
      {
        file_path: "__init__.py",
        issue_type: "python_network_operations",
        metadata: { matched_patterns: ["$socket_stage_recv"] },
      },
    ]),
  };
  const classified = classifyRegistryVersion(flagged);
  assert.equal(classified.verdict, "fail");
  assert.equal(isRegistryClean(flagged), false);
  assert.equal(classified.findings.length, 1);
  assert.equal(classified.findings[0].file_path, "__init__.py");
});

test("#1886 treating anything but pass as green is the bug: Pending must not satisfy isRegistryClean", () => {
  for (const status of [
    "NodeVersionStatusPending",
    "NodeVersionStatusFlagged",
    "NodeVersionStatusBanned",
    "",
  ]) {
    assert.equal(
      isRegistryClean({ status, status_reason: "" }),
      false,
      `${status || "(empty)"} must not count as a pass`,
    );
  }
});

// ---------------------------------------------------------------------------
// wiring — a correct replica nobody invokes from the publish job is the bug
// ---------------------------------------------------------------------------

test("#1886 both CI and the publish job run the archive replica before anything ships", () => {
  const ci = readFileSync(CI, "utf8");
  const publish = readFileSync(PUBLISH, "utf8");
  for (const [name, wf] of [["ci.yml", ci], ["publish_action.yml", publish]]) {
    assert.match(
      wf,
      /node scripts\/check-registry-yara\.mjs --allow 0/,
      `${name} must invoke the replica at allowance 0`,
    );
    assert.match(
      wf,
      /Security scan \(Comfy Registry parity — network rules\)/,
      `${name} must name the network-family step so a deletion is a diff, not a silence`,
    );
  }
  const publishStep = publish.indexOf("- name: Publish custom node");
  const networkStep = publish.indexOf("scripts/check-registry-yara.mjs --allow 0");
  assert.notEqual(publishStep, -1);
  assert.notEqual(networkStep, -1);
  assert.ok(
    networkStep < publishStep,
    "a network scan after publish cannot un-publish a flagged archive",
  );
});

test("#1886 this repo's own .comfyignore keeps the known dirty trees out of the pack listing", () => {
  const shipped = new Set(listShippedPaths(ROOT));
  assert.ok(shipped.has("__init__.py"), "the pack always ships the extension entry");
  assert.ok(!shipped.has("browser_tests/unit/test_bridge_identity.py"));
  assert.ok(!shipped.has("scripts/check-registry-yara.mjs"));
  assert.ok(!shipped.has("CHANGELOG.md"));
});
