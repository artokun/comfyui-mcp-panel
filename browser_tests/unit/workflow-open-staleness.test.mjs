// #442 defect 2 — panel_open_workflow must not silently serve a stale cached tab.
// decideOpenStaleness is the pure staleness decision behind workflow_open: given an
// already-open tab's on-disk bytes vs its loaded baseline and its unsaved-edits state,
// it decides whether to flag `stale` and whether a lossless re-read is safe. Detection
// is CONTENT-based so it survives the frontend's mtime-only listing sync.
import test from "node:test";
import assert from "node:assert/strict";
import { decideOpenStaleness } from "../../web/js/lib/workflow-open-staleness.js";

const A = JSON.stringify({ nodes: [{ id: 1, pos: [0, 0] }] });
const B = JSON.stringify({ nodes: [{ id: 1, pos: [500, 300] }] }); // edited on disk

test("not-open tab is never stale (openWorkflow reads it fresh from disk)", () => {
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: false, isModified: false, onDiskContent: B, baselineContent: A }),
    { stale: false, reload: false },
  );
});

test("already-open + disk differs + no unsaved edits ⇒ stale and safe to reload", () => {
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent: B, baselineContent: A }),
    { stale: true, reload: true },
  );
});

test("already-open + disk differs + UNSAVED edits ⇒ stale but NOT reloaded (no clobber)", () => {
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: true, onDiskContent: B, baselineContent: A }),
    { stale: true, reload: false },
  );
});

test("identical on-disk content ⇒ not stale", () => {
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent: A, baselineContent: A }),
    { stale: false, reload: false },
  );
});

test("pure reformat (whitespace/indent only) is NOT reported as stale", () => {
  const pretty = JSON.stringify(JSON.parse(A), null, 2); // same data, indented
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent: pretty, baselineContent: A }),
    { stale: false, reload: false },
  );
});

test("non-JSON content falls back to a raw compare (differs ⇒ stale, same ⇒ fresh)", () => {
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent: "not json v2", baselineContent: "not json v1" }),
    { stale: true, reload: true },
  );
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent: "same", baselineContent: "same" }),
    { stale: false, reload: false },
  );
});

test("unreadable disk / missing baseline fail safe (no false staleness)", () => {
  for (const [onDiskContent, baselineContent] of [
    [null, A],
    [B, null],
    [undefined, undefined],
    [123, A],
  ]) {
    assert.deepEqual(
      decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent, baselineContent }),
      { stale: false, reload: false },
    );
  }
});

test("no-arg / missing fields do not throw and default to not-stale", () => {
  assert.deepEqual(decideOpenStaleness(), { stale: false, reload: false });
  assert.deepEqual(decideOpenStaleness({}), { stale: false, reload: false });
});
