// #442 defect 3 — panel_save_workflow must not 409 when saving IN PLACE over the
// workflow's OWN name. ComfyUI's UserFile.save() writes with `overwrite: isPersisted`,
// and `isPersisted`/`isTemporary` are getters derived from `size` (isTemporary =
// size === -1). After a panel_open_workflow open-ack race the loaded workflow's `size`
// drifts to -1, so `isPersisted` reads false → overwrite:false → the server 409s on the
// existing own file.
//
// The fix splits the async PROBE (inPlaceOverwriteAuthorized — no mutation) from the
// synchronous MUTATION (markPersistedForOverwrite), so the coercion runs only AFTER the
// caller re-asserts the expected tab (codex P2: a probe-then-mutate that mutated before
// the second assertExpect leaked overwrite authorization onto an aborted tab).
import test from "node:test";
import assert from "node:assert/strict";
import {
  inPlaceOverwriteAuthorized,
  markPersistedForOverwrite,
} from "../../web/js/lib/workflow-save.js";

/** A workflow object mirroring ComfyUI's real UserFile: isPersisted/isTemporary are
 *  GETTERS over `size` (a plain, settable field), so the only way to flip persistence
 *  is to change `size` — exactly what the fix must do. */
function makeWorkflow({ path = "workflows/Krea2 Studio v3.json", size = -1 } = {}) {
  return {
    path,
    size,
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

const CONFIRM = async () => true; // disk oracle: file exists (200)
const ABSENT = async () => false; // disk oracle: 404
const UNKNOWN = async () => null; // disk oracle: inconclusive
const THROWS = async () => {
  throw new Error("probe failed");
};

test("drifted-persisted own file (size -1) + disk-confirmed ⇒ authorized, and coercion enables overwrite", async () => {
  const wf = makeWorkflow({ size: -1 });
  assert.equal(wf.overwriteParam, false, "precondition: drift makes overwrite false (the 409 cause)");
  const allow = await inPlaceOverwriteAuthorized(wf, wf.path, CONFIRM);
  assert.equal(allow, true);
  assert.equal(wf.overwriteParam, false, "PROBE must not mutate (still false until the sync coercion)");
  markPersistedForOverwrite(wf);
  assert.equal(wf.isPersisted, true);
  assert.equal(wf.overwriteParam, true, "in-place save now overwrites the own file — no 409");
  assert.notEqual(wf.size, -1);
});

test("already-persisted workflow ⇒ not authorized (overwrite already true)", async () => {
  const wf = makeWorkflow({ size: 4096 });
  assert.equal(await inPlaceOverwriteAuthorized(wf, wf.path, CONFIRM), false);
  assert.equal(wf.overwriteParam, true);
});

test("disk says ABSENT (404) ⇒ not authorized — a genuine first save keeps overwrite:false", async () => {
  const wf = makeWorkflow({ size: -1 });
  assert.equal(await inPlaceOverwriteAuthorized(wf, wf.path, ABSENT), false);
});

test("disk UNKNOWN ⇒ not authorized (fail safe — a real collision still 409s honestly)", async () => {
  const wf = makeWorkflow({ size: -1 });
  assert.equal(await inPlaceOverwriteAuthorized(wf, wf.path, UNKNOWN), false);
});

test("oracle THROWS ⇒ not authorized", async () => {
  const wf = makeWorkflow({ size: -1 });
  assert.equal(await inPlaceOverwriteAuthorized(wf, wf.path, THROWS), false);
});

test("no oracle / no path ⇒ not authorized", async () => {
  const wf1 = makeWorkflow({ size: -1 });
  assert.equal(await inPlaceOverwriteAuthorized(wf1, wf1.path, undefined), false);
  const wf2 = makeWorkflow({ size: -1 });
  assert.equal(await inPlaceOverwriteAuthorized(wf2, "", CONFIRM), false);
});

test("PROBE never mutates (P2): a positive probe leaves the workflow untouched until coercion", async () => {
  const wf = makeWorkflow({ size: -1 });
  await inPlaceOverwriteAuthorized(wf, wf.path, CONFIRM);
  // The caller aborts here (e.g. assertExpect throws because the tab switched) and
  // MUST NOT call markPersistedForOverwrite — the tab is left exactly as it was.
  assert.equal(wf.size, -1);
  assert.equal(wf.isPersisted, false);
  assert.equal(wf.overwriteParam, false);
});

test("markPersistedForOverwrite corrects plain-object doubles (no getters) too", () => {
  const wf = { path: "workflows/Foo.json", size: -1, isTemporary: true, isPersisted: false };
  markPersistedForOverwrite(wf);
  assert.equal(wf.isPersisted, true);
  assert.equal(wf.isTemporary, false);
  assert.notEqual(wf.size, -1);
});
