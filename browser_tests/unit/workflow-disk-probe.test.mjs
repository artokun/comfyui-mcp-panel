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

test("#1448 an AMBIGUOUS bare name is REPORTED, never resolved to a guess", () => {
  // Review, P1 — and this test previously blessed the defect. Returning the first
  // base-name hit made the refusal say the requested file "IS on disk" while naming a
  // file the caller may not have meant, and prescribing a reload that would not help.
  // The comment claimed it was "deliberately not resolved to a guess" while the code
  // did exactly that.
  const ambiguous = ["a/Same.json", "b/Same.json"];
  assert.equal(diskListingEntryFor(ambiguous, "Same"), null, "no single answer exists");
  const verdict = classifyDiskProbe({ ok: true, body: ambiguous }, "Same");
  assert.equal(verdict.onDisk, "ambiguous");
  assert.deepEqual(verdict.candidates, ["a/Same.json", "b/Same.json"]);

  // A FULLY-QUALIFIED selector names one file even when the bare name fans out.
  assert.equal(diskListingEntryFor(ambiguous, "b/Same.json"), "b/Same.json");
  assert.equal(classifyDiskProbe({ ok: true, body: ambiguous }, "b/Same.json").onDisk, "yes");
  assert.equal(diskListingEntryFor(ambiguous, "c/Same.json"), null);
  assert.equal(classifyDiskProbe({ ok: true, body: ambiguous }, "c/Same.json").onDisk, "no");
});

test("#1448 the ambiguous refusal lists the candidates and how to disambiguate", () => {
  const t = openWorkflowNotFoundMessage({
    path: "Same",
    refresh: "changed",
    disk: { onDisk: "ambiguous", candidates: ["a/Same.json", "b/Same.json"] },
  });
  assert.match(t, /is ambiguous/);
  assert.match(t, /"a\/Same\.json", "b\/Same\.json"/);
  assert.match(t, /Qualify it with the subfolder/);
  // It must not tell them to reload — the list is not the problem here.
  assert.doesNotMatch(t, /RELOAD THE COMFYUI BROWSER TAB/);
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

// ── WIRING. The lib can be perfect and never called (mutation found exactly that:
//    replacing the fetch with `undefined` killed nothing, because every failure mode
//    fails open to the same "unknown" the absent call produces).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PANEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
  "utf8",
).replace(/\r\n/g, "\n");

test("#1448 wiring: the refusal path actually ASKS the server", () => {
  assert.match(
    PANEL,
    /api\.fetchApi\("\/userdata\?dir=workflows&recurse=true&split=false",/,
    "the probe must call the listing endpoint — a fail-open probe that never runs is invisible",
  );
  assert.match(PANEL, /classifyDiskProbe\(/, "and classify its answer");
});

test("#1448 wiring: the probe is BOUNDED, so a hung /userdata cannot eat the refusal", () => {
  // Review, P1: fetchApi + .json() had no deadline. A server that accepts the request
  // and never answers would hang panel_open_workflow forever — a wrong message
  // replaced by no message.
  const site = PANEL.slice(PANEL.indexOf("ASK THE SERVER before asserting"));
  assert.match(site.slice(0, 2400), /withTimeout\(/, "the probe runs under a wall-clock bound");
  assert.match(PANEL, /const WORKFLOW_DISK_PROBE_MS = \d+;/, "with a named bound");
  assert.match(site.slice(0, 3000), /onDisk: "unknown", why: `no answer within/, "timeout fails OPEN");
});

test("#1448 wiring: the timed-out request is ABORTED, not merely abandoned", () => {
  // Review r2: withTimeout stops us WAITING but cannot cancel the request. A server
  // that accepts and never answers would leave one live fetch per failed open, which
  // accumulates until the browser's connection pool is exhausted.
  //
  // These two assertions were written once and SILENTLY DID NOT LAND — a scripted
  // edit no-op'd, and both abort mutations then survived, which is the only reason
  // the gap was visible at all. Re-added deliberately.
  const site = PANEL.slice(PANEL.indexOf("ASK THE SERVER before asserting"), PANEL.length);
  assert.match(site.slice(0, 2400), /probeCtrl\.abort\(\)/, "the pending request is cancelled");
  assert.match(site.slice(0, 2400), /signal: probeCtrl\.signal/, "and the fetch honours the signal");
  // The timer must be cleared on the happy path, or every refusal leaks one.
  assert.match(site.slice(0, 3200), /clearTimeout\(probeTimer\)/, "the abort timer is cleared");
});

test("#1448 wiring: a target that appears WHILE the probe runs is opened, not refused", () => {
  // Review, P2: the probe added an await to a path that had none, widening the window
  // for another sync to land the target in the store. Refusing after that would be a
  // verdict that went stale while it was being proven.
  const site = PANEL.slice(PANEL.indexOf("ASK THE SERVER before asserting"));
  assert.match(site.slice(0, 3400), /const late = find\(\);/);
  assert.match(site.slice(0, 3400), /if \(late\) \{\s*\n\s*target = late;/);
});
