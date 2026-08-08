// panel#771 — ComfyUI answers a userdata write with HTTP 400 for ANY OSError and
// then blames the filename, so a save that failed because the disk was full (or
// the directory was missing, or read-only) reads as "invalid filename".
//
// The reporter's name was `wan22_flf_seg1_alone_to_reaching` — no special
// characters anywhere — on a remote box, where a full volume is common.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { explainUserDataStoreFailure } from "../../web/js/lib/workflow-save.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVE_JS = join(HERE, "../../web/js/lib/workflow-save.js");

const REPORTED =
  "Error storing user data file 'workflows/wan22_flf_seg1_alone_to_reaching.json': 400";

test("#771 a userdata 400 gains the explanation and keeps the original text", () => {
  const out = explainUserDataStoreFailure(REPORTED);
  assert.ok(out.startsWith(REPORTED), "the original message is preserved verbatim, then extended");
  assert.match(out, /ANY filesystem error/);
  assert.match(out, /Error saving file/, "names the exact log line that reveals the true cause");
  assert.match(out, /server log/);
});

test("#771 it names NO single cause — that would be the same defect one level up", () => {
  // Picking "your disk is full" would be an inference presented as a finding,
  // which is exactly what ComfyUI's own "Invalid filename" reason does wrong.
  const out = explainUserDataStoreFailure(REPORTED);
  assert.doesNotMatch(out, /your disk is full|the disk is full\b/i);
  // …but the possibilities ARE enumerated, so the reader has somewhere to look.
  for (const cause of [/full disk/i, /read-only/i, /missing\s+parent/i, /fd limit/i]) {
    assert.match(out, cause);
  }
});

test("#771 it reassures about the workflow, because nothing was written", () => {
  // The graph stays live and unsaved. Saying so stops a user reaching for a
  // recovery action they do not need.
  assert.match(explainUserDataStoreFailure(REPORTED), /nothing was written or overwritten/i);
});

test("#771 a 409 is left ALONE — it has its own accurate handling", () => {
  // 409 is a genuine name collision (#309/#442). Burying that under a filesystem
  // lecture would replace an accurate message with an irrelevant one.
  const conflict = "Error storing user data file 'workflows/a.json': 409 Conflict";
  assert.equal(explainUserDataStoreFailure(conflict), conflict);
});

test("#771 unrelated errors pass through byte-identical", () => {
  for (const other of [
    "refusing to save: the active workflow's path changed during the save",
    "workflow save API unavailable on this frontend",
    "Error storing user data file 'workflows/a.json': 500",
    "",
  ]) {
    assert.equal(explainUserDataStoreFailure(other), other);
  }
  // Non-strings must not throw or stringify into a fake message.
  for (const junk of [undefined, null, 42, {}]) {
    assert.equal(explainUserDataStoreFailure(junk), "");
  }
});

test("#771 WIRING: saveInPlace augments the thrown error, and only that shape", () => {
  const src = readFileSync(SAVE_JS, "utf8");
  // the wrap exists around the real save calls…
  assert.match(src, /const augmented = explainUserDataStoreFailure\(/);
  // …and rethrows the SAME error object, so nothing downstream that matches on
  // error identity or other fields is disturbed.
  assert.match(src, /if \(err instanceof Error && augmented !== err\.message\) err\.message = augmented;/);
  assert.match(src, /\n\s*throw err;/);
});
