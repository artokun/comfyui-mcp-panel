// #442 defect 2 — panel_open_workflow must not silently serve a stale cached tab.
// decideOpenStaleness is the pure staleness decision behind workflow_open: given an
// already-open tab's on-disk bytes vs its loaded baseline and its unsaved-edits state,
// it decides whether to flag `stale` and whether a lossless re-read is safe. Detection
// is CONTENT-based so it survives the frontend's mtime-only listing sync.
import test from "node:test";
import assert from "node:assert/strict";
import { decideOpenStaleness, diskBytesEqualText } from "../../web/js/lib/workflow-open-staleness.js";

const enc = new TextEncoder();
const withBom = (text) => {
  const body = enc.encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
};

test("diskBytesEqualText: canonical UTF-8 (no BOM) of the baseline ⇒ equal (the ComfyUI-written case)", () => {
  assert.equal(diskBytesEqualText(enc.encode("hello"), "hello"), true);
  // Accepts a raw ArrayBuffer too.
  assert.equal(diskBytesEqualText(enc.encode("hello").buffer, "hello"), true);
});

test("diskBytesEqualText: a UTF-8 BOM on disk is NOT equal to the (BOM-stripped) baseline text (codex P0)", () => {
  assert.equal(diskBytesEqualText(withBom("hello"), "hello"), false);
});

test("diskBytesEqualText: any byte difference ⇒ false; non-bytes / non-string ⇒ false (fail closed)", () => {
  assert.equal(diskBytesEqualText(enc.encode("hello!"), "hello"), false);
  assert.equal(diskBytesEqualText(null, "hello"), false);
  assert.equal(diskBytesEqualText(enc.encode("hello"), null), false);
  assert.equal(diskBytesEqualText("hello", "hello"), false); // a string is not raw bytes
});

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

test("byte-exact: a reformat (or any byte change) is treated as stale (safe over-caution, never false-fresh)", () => {
  // Comparison is byte-exact (a JSON round-trip could collapse distinct large-int seeds
  // and falsely report fresh — codex P0). A pure reformat therefore reads as changed:
  // an over-cautious stale flag, never a missed change.
  const pretty = JSON.stringify(JSON.parse(A), null, 2); // same data, different bytes
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent: pretty, baselineContent: A }),
    { stale: true, reload: true },
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

test("unreadable disk / missing baseline on an OPEN tab ⇒ stale:'unknown' (never false-fresh)", () => {
  for (const [onDiskContent, baselineContent] of [
    [null, A],
    [B, null],
    [undefined, undefined],
    [123, A],
  ]) {
    assert.deepEqual(
      decideOpenStaleness({ wasOpen: true, isModified: false, onDiskContent, baselineContent }),
      { stale: "unknown", reload: false },
    );
  }
});

test("not-open tab is never 'unknown' — it's read fresh regardless", () => {
  assert.deepEqual(
    decideOpenStaleness({ wasOpen: false, isModified: false, onDiskContent: null, baselineContent: null }),
    { stale: false, reload: false },
  );
});

test("no-arg / missing fields do not throw and default to not-stale (not open)", () => {
  assert.deepEqual(decideOpenStaleness(), { stale: false, reload: false });
  assert.deepEqual(decideOpenStaleness({}), { stale: false, reload: false });
});
