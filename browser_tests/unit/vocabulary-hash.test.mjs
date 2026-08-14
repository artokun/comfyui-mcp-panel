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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildHelloPayload } from "../../web/js/lib/session-rebind.js";
import { VENDORED_VOCABULARY_HASH } from "../../web/js/lib/vocabulary-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
