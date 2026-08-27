// #236 — the panel advertises WHICH tool vocabulary it vendored, at connect.
//
// The panel calls MCP tool names as bare string literals and validates them against
// vendor/tool-vocabulary.json. That proves the literals match the vendored copy; it
// cannot prove the copy matches the SERVER. When they disagree, the failure surfaced
// at CALL time as "unknown tool" — which reads as a broken panel and gives an agent
// nothing to act on. The orchestrator half of this landed in comfyui-mcp; without
// this half it has nothing to compare and every panel reads "unverified".

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildHelloPayload } from "../../web/js/lib/session-rebind.js";
import { VENDORED_VOCABULARY_HASH } from "../../web/js/lib/vocabulary-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(ROOT, "scripts/check-tool-vocabulary.mjs");
// 37 core / 94 panel — no published comfyui-mcp produces this. Panel 0.15.59–0.15.110
// advertised it, so every hello warned and "update BOTH" was impossible (#1927).
const STALE_37_94_HASH = "23ca43f48ed05fe2e611d6ba1a6c522ca93410667d8e09ad90bf5c79d0f6c6ec";
// Published comfyui-mcp 0.52.56–0.52.139 (and current @latest): 38/96/160.
// Update this pin when re-vendoring; it is the hash a real build produces, not a
// forever-constant.
const PUBLISHED_MCP_HASH = "184e53142944516b15294367c7fefcd8869aeb451d0de4744cee96a8764b7693";

test("#236 the hello carries the vendored vocabulary hash", () => {
  const hello = buildHelloPayload({
    tabId: "wf:x",
    title: "t",
    panelVersion: "0.14.13",
    vocabularyHash: VENDORED_VOCABULARY_HASH,
  });
  assert.equal(hello.vocabulary_hash, VENDORED_VOCABULARY_HASH);
  assert.match(hello.vocabulary_hash, /^[0-9a-f]{64}$/);
});

test("#236 an omitted hash is ABSENT, not an empty string", () => {
  // The orchestrator reads a non-empty string as the panel's claim and anything else
  // as "unverified". An empty string would be a claim of nothing — it must not look
  // like one, and it must never read as disagreement.
  const hello = buildHelloPayload({ tabId: "wf:x", title: "t", panelVersion: "0.14.13" });
  assert.equal(hello.vocabulary_hash, undefined);
});

test("#236 the baked constant matches the artefact it claims to identify", () => {
  // The constant is a deliberate DUPLICATE: vendor/ is not served to the browser
  // (WEB_DIRECTORY is ./web), so the panel cannot read the artefact at runtime. A
  // duplicate is only honest with a check on it — a stale one would make the
  // orchestrator report a mismatch that is not real, which is worse than no handshake
  // and indistinguishable from a genuine skew.
  //
  // scripts/check-tool-vocabulary.mjs enforces this in CI too; this asserts it here so
  // the failure names the cause instead of arriving as a mystery skew on a live rig.
  const vocab = JSON.parse(readFileSync(join(ROOT, "vendor/tool-vocabulary.json"), "utf8"));
  assert.equal(VENDORED_VOCABULARY_HASH, vocab.vocabularyHash);
});

test("#236 WIRING: the panel actually passes the constant to the hello", () => {
  // buildHelloPayload takes the hash as a PARAMETER, so a correct constant and a
  // correct builder still advertise nothing if the call site omits it — and no
  // behavioural test above can see that.
  const panel = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(panel, /import \{ VENDORED_VOCABULARY_HASH \} from "\.\/lib\/vocabulary-hash\.js";/);
  assert.match(panel, /vocabularyHash: VENDORED_VOCABULARY_HASH,/);
});

test("#1927 hello advertises a hash a published comfyui-mcp produces, not the 37/94 ghost", () => {
  // Existing tests only check self-consistency: baked constant === artefact hash.
  // Both were 23ca43f4 together for weeks, so those tests stayed green while every
  // connect warned. This drives the shipped hello path and pins the published hash.
  const hello = buildHelloPayload({
    tabId: "wf:x",
    title: "t",
    panelVersion: "0.15.113",
    vocabularyHash: VENDORED_VOCABULARY_HASH,
  });
  assert.equal(hello.vocabulary_hash, PUBLISHED_MCP_HASH);
  assert.notEqual(hello.vocabulary_hash, STALE_37_94_HASH);
  assert.equal(VENDORED_VOCABULARY_HASH, PUBLISHED_MCP_HASH);
});

test("#1927 the vendored artefact recomputes to the published hash and carries the added names", () => {
  const vocab = JSON.parse(readFileSync(join(ROOT, "vendor/tool-vocabulary.json"), "utf8"));
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        core: vocab.core,
        panel: vocab.panel,
        dead: vocab.dead.map((d) => d.name),
      }),
    )
    .digest("hex");
  assert.equal(expected, PUBLISHED_MCP_HASH);
  assert.equal(vocab.vocabularyHash, PUBLISHED_MCP_HASH);
  assert.equal(vocab.counts.core, 38);
  assert.equal(vocab.counts.panel, 96);
  assert.equal(vocab.counts.dead, 160);
  assert.ok(vocab.core.includes("kitchen"));
  assert.ok(vocab.panel.includes("panel_kitchen"));
  assert.ok(vocab.panel.includes("panel_configure_app_mode"));
});

test("#1927 check-tool-vocabulary passes on the re-vendored artefact", () => {
  const result = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /184e53142944/);
  assert.match(result.stderr, /38 core \/ 96 panel/);
});

test("#1927 check-tool-vocabulary fails when the advertised hash is the 37/94 ghost", () => {
  // Same shape as i18n-gate: run the shipped checker against a fixture that must
  // be rejected. VOCABULARY_ROOT lets the first two hash checks run without a git
  // tree; they exit before git ls-files.
  const dir = mkdtempSync(join(tmpdir(), "cmcp-vocab-"));
  try {
    mkdirSync(join(dir, "vendor"), { recursive: true });
    mkdirSync(join(dir, "web", "js", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "vendor", "tool-vocabulary.json"),
      readFileSync(join(ROOT, "vendor", "tool-vocabulary.json")),
    );
    const baked = readFileSync(join(ROOT, "web", "js", "lib", "vocabulary-hash.js"), "utf8").replace(
      PUBLISHED_MCP_HASH,
      STALE_37_94_HASH,
    );
    assert.match(baked, new RegExp(STALE_37_94_HASH));
    writeFileSync(join(dir, "web", "js", "lib", "vocabulary-hash.js"), baked);
    const result = spawnSync(process.execPath, [CHECK], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, VOCABULARY_ROOT: dir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /vocabulary hash the panel ADVERTISES is stale/);
    assert.match(result.stderr, new RegExp(STALE_37_94_HASH));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
