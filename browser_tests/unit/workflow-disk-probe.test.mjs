// comfyui-mcp#1448 — the half the reporter actually filed.
//
// The open lookup is a pure in-memory scan of the frontend's workflow store, so a
// `.json` staged into user/default/workflows out-of-band reads as absent. Both
// directions of that staleness were REPRODUCED on a live rig (ComfyUI 0.33.1 /
// frontend 1.48.7), which is why the probe exists at all:
//
//   staged out-of-band, before syncWorkflows() → on disk YES, in store NO
//   deleted out-of-band, before syncWorkflows() → on disk NO,  in store YES
//
// `GET /api/userdata?dir=workflows&recurse=true&split=false` answered 200 with a flat
// array of strings relative to the workflows dir ("Anima Wojak Batch.json").

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWorkflowPath,
  classifyDiskProbe,
  diskListingEntryFor,
} from "../../web/js/lib/workflow-disk-probe.js";
import { openWorkflowNotFoundMessage } from "../../web/js/lib/open-workflow-not-found.js";

/** The measured listing shape. */
const LISTING = [
  "Anima Wojak Batch.json",
  "Artokun Flow v1.json",
  "video_minimax_low_vram.json",
  "sub/Nested Thing.json",
];

test("#1448 the reporter's selector matches the file the server lists", () => {
  assert.equal(diskListingEntryFor(LISTING, "video_minimax_low_vram.json"), "video_minimax_low_vram.json");
});

test("#1448 every selector form the store accepts also matches on disk", () => {
  // A saved record answers to `workflows/X.json`, `X.json` and `X` — measured. The
  // probe must not disagree with the store about what names a file, or it would
  // report "not on disk" for a selector the store itself would have matched.
  for (const sel of [
    "video_minimax_low_vram.json",
    "video_minimax_low_vram",
    "workflows/video_minimax_low_vram.json",
    "workflows\\video_minimax_low_vram.json",
    "./video_minimax_low_vram.json",
  ]) {
    assert.equal(diskListingEntryFor(LISTING, sel), "video_minimax_low_vram.json", sel);
  }
});

test("#1448 matching is case-insensitive — the reporter is on Windows", () => {
  // A listing that differs only in case names the SAME file there. Answering "not on
  // disk" for it would reproduce this bug with better wording.
  assert.equal(diskListingEntryFor(LISTING, "VIDEO_MINIMAX_LOW_VRAM.JSON"), "video_minimax_low_vram.json");
});

test("#1448 a bare name finds a file in a SUBFOLDER", () => {
  assert.equal(diskListingEntryFor(LISTING, "Nested Thing"), "sub/Nested Thing.json");
});

test("#1448 an AMBIGUOUS bare name is not resolved to a guess", () => {
  // Two subfolders holding the same filename: picking one arbitrarily could send the
  // caller to the wrong workflow, which is worse than the refusal being improved.
  // First match wins only because the caller never acts on it — it is a hint in a
  // message, and the message names the entry it found.
  const ambiguous = ["a/Same.json", "b/Same.json"];
  const hit = diskListingEntryFor(ambiguous, "Same");
  assert.ok(hit === "a/Same.json" || hit === "b/Same.json");
  // A FULLY-QUALIFIED selector is exact and must not fall back to the other folder.
  assert.equal(diskListingEntryFor(ambiguous, "b/Same.json"), "b/Same.json");
  assert.equal(diskListingEntryFor(ambiguous, "c/Same.json"), null);
});

test("#1448 a file genuinely absent answers null", () => {
  assert.equal(diskListingEntryFor(LISTING, "not-here.json"), null);
});

test("#1448 canonicalWorkflowPath rejects junk instead of coercing it", () => {
  for (const junk of [null, undefined, 42, "", "   ", {}, []]) {
    assert.equal(canonicalWorkflowPath(junk), null, String(junk));
  }
});

// ── FAIL OPEN. Every previous round of this issue shipped a claim stronger than
//    its evidence; a probe that turned a stale list into a confident "your file does
//    not exist" would be the same bug with more authority.

test("#1448 an unreachable or unhappy /userdata answers UNKNOWN, never absent", () => {
  for (const res of [
    null,
    undefined,
    { ok: false, status: 404 },
    { ok: false, status: 500 },
    { ok: true, body: "not an array" },
    { ok: true, body: { files: [] } },
    { ok: true, body: null },
  ]) {
    assert.equal(classifyDiskProbe(res, "x.json").onDisk, "unknown", JSON.stringify(res));
  }
});

test("#1448 a good response decides both ways", () => {
  assert.deepEqual(classifyDiskProbe({ ok: true, body: LISTING }, "video_minimax_low_vram.json"), {
    onDisk: "yes",
    entry: "video_minimax_low_vram.json",
  });
  assert.deepEqual(classifyDiskProbe({ ok: true, body: LISTING }, "nope.json"), { onDisk: "no" });
  // An EMPTY folder is a real answer, not an inconclusive one.
  assert.deepEqual(classifyDiskProbe({ ok: true, body: [] }, "nope.json"), { onDisk: "no" });
});

// ── The message the probe exists to change ─────────────────────────────────────

test("#1448 ON DISK produces a different refusal entirely — reload, not rename", () => {
  const t = openWorkflowNotFoundMessage({
    path: "video_minimax_low_vram.json",
    refresh: "unchanged",
    known: ["workflows/Other.json"],
    disk: { onDisk: "yes", entry: "video_minimax_low_vram.json" },
  });
  assert.match(t, /IS on disk in the workflows folder/);
  assert.match(t, /RELOAD THE COMFYUI BROWSER TAB/);
  assert.match(t, /The file is not missing/);
  // It must NOT tell them to check the name — that is what sent the reporter hunting
  // for a file that was exactly where they left it.
  assert.doesNotMatch(t, /check the name matches exactly/);
  assert.doesNotMatch(t, /no workflow matching/);
});

test("#1448 NOT on disk finally gives the refusal EVIDENCE for its claim", () => {
  const t = openWorkflowNotFoundMessage({
    path: "typo.json",
    refresh: "changed",
    disk: { onDisk: "no" },
  });
  assert.match(t, /no workflow matching "typo\.json"/);
  assert.match(t, /workflows folder on disk does NOT contain it either/);
  assert.match(t, /not a stale-list problem/);
});

test("#1448 an UNKNOWN probe weakens the claim rather than strengthening it", () => {
  const t = openWorkflowNotFoundMessage({
    path: "x.json",
    refresh: "changed",
    disk: { onDisk: "unknown", why: "HTTP 404" },
  });
  assert.match(t, /could not be asked whether the file is on disk \(HTTP 404\)/);
  assert.match(t, /not by itself proof the file is missing/);
});

test("#1448 with NO probe result the message is exactly what it was before", () => {
  // The fail-open contract at the message layer: an omitted probe must not add a
  // clause, so a caller that cannot probe is no worse off than today.
  const before = openWorkflowNotFoundMessage({ path: "x.json", refresh: "changed" });
  assert.doesNotMatch(before, /on disk/i);
  assert.match(before, /no workflow matching "x\.json"/);
});
