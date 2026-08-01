// #442 defect 3 — panel_save_workflow must not 409 when saving IN PLACE over the
// workflow's OWN name, but MUST NOT turn that fix into a destructive overwrite.
//
// ComfyUI's UserFile.save() writes with `overwrite: isPersisted`, and isPersisted
// derives from `size` (isTemporary = size === -1). After a panel_open_workflow
// open-ack race the loaded workflow's `size` drifts to -1 → overwrite:false → the
// server 409s on the existing own file. The fix forces overwrite:true for the drifted
// tab — but ONLY when the on-disk bytes STILL MATCH what the tab loaded
// (wf.originalContent). If the file changed under us (another tab/agent/process wrote
// B), forcing the overwrite would CLOBBER B — the 409 was protective there — so the
// classifier returns "conflict" and the caller refuses (codex P0 data-loss guard).
//
// classifyInPlaceOverwrite is a PURE async probe (no mutation); markPersistedForOverwrite
// is the synchronous coercion the caller applies only on "authorize", after re-asserting
// the tab (codex P2 TOCTOU).
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyInPlaceOverwrite,
  markPersistedForOverwrite,
} from "../../web/js/lib/workflow-save.js";

const A = JSON.stringify({ nodes: [{ id: 1, pos: [0, 0] }] }); // what the tab loaded
const B = JSON.stringify({ nodes: [{ id: 1, pos: [500, 300] }] }); // changed on disk
const enc = new TextEncoder();
const bytes = (text) => enc.encode(text); // canonical UTF-8, no BOM (how ComfyUI writes)
const withBom = (text) => {
  const body = enc.encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0); // UTF-8 BOM
  out.set(body, 3);
  return out;
};

/** A workflow object mirroring ComfyUI's real UserFile: isPersisted/isTemporary are
 *  GETTERS over `size` (a plain, settable field); `originalContent` is the text the tab
 *  loaded from disk (the baseline the overwrite gate compares against). */
function makeWorkflow({ path = "workflows/Krea2 Studio v3.json", size = -1, originalContent = A } = {}) {
  return {
    path,
    size,
    originalContent,
    get isTemporary() {
      return this.size === -1;
    },
    get isPersisted() {
      return this.size !== -1;
    },
    // What ComfyUI's save() would send as the /userdata `overwrite` query param.
    get overwriteParam() {
      return this.isPersisted;
    },
  };
}

const readsDisk = (content) => async () => (content == null ? null : bytes(content)); // bytes oracle
const readsRaw = (u8) => async () => u8; // oracle returning a raw Uint8Array (or null) verbatim
const THROWS = async () => {
  throw new Error("read failed");
};

test("drifted own file + disk STILL MATCHES the loaded baseline ⇒ authorize + overwrite becomes true", async () => {
  const wf = makeWorkflow({ size: -1, originalContent: A });
  assert.equal(wf.overwriteParam, false, "precondition: drift makes overwrite false (the 409 cause)");
  const decision = await classifyInPlaceOverwrite(wf, wf.path, readsDisk(A));
  assert.equal(decision, "authorize");
  assert.equal(wf.overwriteParam, false, "PROBE must not mutate");
  markPersistedForOverwrite(wf);
  assert.equal(wf.overwriteParam, true, "in-place save now overwrites the own unchanged file — no 409");
});

test("P0 REGRESSION — drifted own file + disk CHANGED (A loaded, B on disk) ⇒ CONFLICT, never a forced overwrite", async () => {
  const wf = makeWorkflow({ size: -1, originalContent: A });
  const decision = await classifyInPlaceOverwrite(wf, wf.path, readsDisk(B));
  assert.equal(decision, "conflict", "must refuse — forcing overwrite would clobber the newer on-disk content");
  assert.equal(wf.overwriteParam, false, "workflow left untouched (the caller throws a surfaced conflict)");
});

test("P0 REGRESSION (BOM) — loaded A (no BOM) + disk changed to BOM+A ⇒ CONFLICT, not authorize", async () => {
  // Response.text() strips a UTF-8 BOM, so a decoded-string compare would treat A and
  // BOM+A as equal and clobber the external BOM-bearing change. The RAW-BYTE gate must
  // see the extra 3 BOM bytes and refuse.
  const wf = makeWorkflow({ size: -1, originalContent: A });
  assert.equal(await classifyInPlaceOverwrite(wf, wf.path, readsRaw(withBom(A))), "conflict");
  assert.equal(wf.overwriteParam, false, "untouched — the BOM-bearing on-disk change is not overwritten");
});

test("already-persisted workflow ⇒ skip (ComfyUI's own overwrite:true path runs, unchanged)", async () => {
  const wf = makeWorkflow({ size: 4096, originalContent: A });
  assert.equal(await classifyInPlaceOverwrite(wf, wf.path, readsDisk(B)), "skip");
});

test("disk ABSENT (read returns null) ⇒ skip — overwrite:false safely CREATES the file", async () => {
  const wf = makeWorkflow({ size: -1, originalContent: A });
  assert.equal(await classifyInPlaceOverwrite(wf, wf.path, readsDisk(null)), "skip");
});

test("read THROWS / no oracle / no path / no baseline / non-bytes result ⇒ skip (leave overwrite:false)", async () => {
  assert.equal(await classifyInPlaceOverwrite(makeWorkflow(), "workflows/x.json", THROWS), "skip");
  assert.equal(await classifyInPlaceOverwrite(makeWorkflow(), "workflows/x.json", undefined), "skip");
  assert.equal(await classifyInPlaceOverwrite(makeWorkflow(), "", readsDisk(A)), "skip");
  assert.equal(
    await classifyInPlaceOverwrite(makeWorkflow({ originalContent: null }), "workflows/x.json", readsDisk(A)),
    "skip",
    "no loaded baseline ⇒ cannot prove safe ⇒ skip",
  );
  assert.equal(
    await classifyInPlaceOverwrite(makeWorkflow(), "workflows/x.json", readsRaw("A")),
    "skip",
    "a non-bytes (string) result is not trusted ⇒ skip, never a forced overwrite",
  );
});

test("byte-exact: a reformat on disk is a CONFLICT, not authorize (safe — never a false-equal overwrite)", async () => {
  // Byte comparison (not JSON round-trip, which could collapse distinct large-int seeds
  // and authorize a destructive overwrite — codex P0). A formatting-only change reads as
  // changed ⇒ conflict: the caller refuses, the user reloads. Over-cautious, never lossy.
  const pretty = JSON.stringify(JSON.parse(A), null, 2); // identical data, different bytes
  assert.equal(
    await classifyInPlaceOverwrite(makeWorkflow({ originalContent: A }), "workflows/x.json", readsDisk(pretty)),
    "conflict",
  );
});

test("byte-exact: an IDENTICAL-bytes disk file authorizes (the real defect-3 unchanged-file case)", async () => {
  assert.equal(
    await classifyInPlaceOverwrite(makeWorkflow({ originalContent: A }), "workflows/x.json", readsDisk(A)),
    "authorize",
  );
});

test("markPersistedForOverwrite corrects plain-object doubles (no getters) too", () => {
  const wf = { path: "workflows/Foo.json", size: -1, isTemporary: true, isPersisted: false };
  markPersistedForOverwrite(wf);
  assert.equal(wf.isPersisted, true);
  assert.equal(wf.isTemporary, false);
  assert.notEqual(wf.size, -1);
});
