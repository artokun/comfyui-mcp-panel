/**
 * #1934 — CompareFrames temp images are not "no media", and they are not attached.
 *
 * THE REPORTED FAILURE. `panel_run({to_node_id:147})` finished successfully and
 * the completion said "produced no image or video output." `get_history` for the
 * same prompt showed node 147 had 384 `a_images` and 384 `b_images` temp PNGs.
 * The extraction only read `images` / `gifs` / `videos`, so CompareFrames
 * contributed nothing.
 *
 * THE HARMFUL FIX, as the owner named it: folding those bags into the completion
 * frame. 768 temps would either blow the one-frame bound or be silently truncated
 * to a handful that looks complete — a worse lie than "none".
 *
 * THE SHIPPED FIX is count-not-deliver. Unrecognised `*images` keys with ComfyUI
 * `{filename, type, subfolder}` descriptors are counted and named; none of them
 * ride the frame; a node with those keys is never reported as producing nothing.
 *
 * These tests drive the shipped functions (`collectNodeOutputMedia`,
 * `parseHistoryEntry`, `composeRunCompletionFrame`, the tracker) so a revert of
 * either property — "claim none" or "attach them all" — fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  collectNodeOutputMedia,
  formatWithheldMediaNote,
} from "../../web/js/lib/node-output-media.js";
import { parseHistoryEntry } from "../../web/js/lib/history-reconcile.js";
import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

const A_COUNT = 384;
const B_COUNT = 384;
const TOTAL = A_COUNT + B_COUNT;

function tempRef(filename) {
  return { filename, subfolder: "", type: "temp" };
}

function bag(prefix, count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(tempRef(`${prefix}_${String(i).padStart(5, "0")}.png`));
  }
  return out;
}

function compareFramesOutput(aCount = A_COUNT, bCount = B_COUNT) {
  return {
    a_images: bag("a", aCount),
    b_images: bag("b", bCount),
  };
}

function makeTracker() {
  const flushes = [];
  let clock = 1000;
  const timers = new Set();
  const tracker = createRunCompletionTracker({
    onFlush: (payload) => flushes.push(payload),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  return {
    tracker,
    flushes,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const frameDeps = (sent) => ({
  sendFrame: (f) => (sent.push(f), true),
  coerceMessageText: (s) => String(s ?? ""),
  formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`,
  formatClock: () => "12:00:00",
  agentReceivesImages: () => true,
  warn: () => {},
});

// ---------------------------------------------------------------------------
// 1. The collector — shipped function the live + history paths both call.
// ---------------------------------------------------------------------------

test("#1934 CompareFrames a_images/b_images are counted and not deliverable", () => {
  const { deliverable, withheld } = collectNodeOutputMedia(compareFramesOutput());
  assert.equal(deliverable.length, 0, "none of the 768 temps may ride the frame");
  assert.equal(withheld.count, TOTAL);
  assert.deepEqual(withheld.keys, ["a_images", "b_images"]);
  assert.deepEqual(withheld.types, ["temp"]);
});

test("#1934 a standard images bag is still deliverable — attached count unchanged", () => {
  const { deliverable, withheld } = collectNodeOutputMedia({
    images: [{ filename: "final.png", type: "output", subfolder: "" }],
  });
  assert.equal(deliverable.length, 1);
  assert.equal(deliverable[0].filename, "final.png");
  assert.equal(withheld, null);
});

test("#1934 mixed SaveImage + CompareFrames attaches only the standard bag", () => {
  const { deliverable, withheld } = collectNodeOutputMedia({
    images: [{ filename: "final.png", type: "output", subfolder: "" }],
    a_images: bag("a", A_COUNT),
    b_images: bag("b", B_COUNT),
  });
  assert.equal(deliverable.length, 1, "the number attached does not change");
  assert.equal(deliverable[0].filename, "final.png");
  assert.equal(withheld.count, TOTAL);
});

test("#1934 an arbitrary array on a *images key is not mistaken for media", () => {
  const { deliverable, withheld } = collectNodeOutputMedia({
    foo_images: ["not", "media"],
    notes_images: [{ text: "hello" }, { filename: "no-type.png" }],
    text: ["a caption"],
  });
  assert.equal(deliverable.length, 0);
  assert.equal(withheld, null);
});

test("#1934 gifs/videos standard keys stay deliverable, preview_gifs are withheld", () => {
  const { deliverable, withheld } = collectNodeOutputMedia({
    gifs: [{ filename: "clip.mp4", type: "output" }],
    preview_gifs: [tempRef("preview.gif")],
  });
  assert.equal(deliverable.length, 1);
  assert.equal(deliverable[0].filename, "clip.mp4");
  assert.equal(withheld.count, 1);
  assert.deepEqual(withheld.keys, ["preview_gifs"]);
});

// ---------------------------------------------------------------------------
// 2. History parse — the /history recovery path uses the same split.
// ---------------------------------------------------------------------------

test("#1934 parseHistoryEntry does not copy CompareFrames temps into images", () => {
  const parsed = parseHistoryEntry({
    outputs: { 147: compareFramesOutput() },
    status: { status_str: "success", completed: true },
  });
  assert.equal(parsed.images.length, 0, "attached count stays zero");
  assert.equal(parsed.videos.length, 0);
  assert.equal(parsed.withheld.count, TOTAL);
  assert.deepEqual(parsed.withheld.keys, ["a_images", "b_images"]);
});

test("#1934 parseHistoryEntry still delivers a SaveImage images bag unchanged", () => {
  const parsed = parseHistoryEntry({
    outputs: { 9: { images: [{ filename: "final.png", type: "output" }] } },
    status: { status_str: "success", completed: true },
  });
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.withheld, null);
});

// ---------------------------------------------------------------------------
// 3. The completion frame — never "produced no media", never attaches the dump.
// ---------------------------------------------------------------------------

test("#1934 withheld-only completion names the count and attaches none", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "prompt-cf",
      images: [],
      videos: [],
      durationMs: 3000,
      noMedia: true,
      withheld: { count: TOTAL, keys: ["a_images", "b_images"], types: ["temp"] },
    },
    frameDeps(sent),
  );

  assert.ok(frame, "a frame is produced — silence is the original defect");
  assert.equal(sent.length, 1);
  assert.equal(frame.images.length, 0, "the number attached does not change");
  assert.match(frame.note, /768 outputs/);
  assert.match(frame.note, /`a_images` and `b_images`/);
  assert.match(frame.note, /\(temp\)/);
  assert.match(frame.note, /None were attached/);
  assert.match(frame.note, /media budget/);
  assert.match(frame.note, /get_history for prompt prompt-cf/);
  assert.match(frame.note, /get_image/);
  assert.match(frame.note, /This IS the completion you were told to wait for/i);
  assert.doesNotMatch(
    frame.note,
    /produced no image or video output/,
    "a node with unrecognised media keys is never reported as producing nothing",
  );
  assert.equal(frame.metadata[0].reason, "media_budget");
  assert.equal(frame.metadata[0].count, TOTAL);
});

test("#1934 mixed stills + withheld keeps the still attached and names the rest", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "prompt-mixed",
      images: [{ filename: "final.png", type: "output" }],
      videos: [],
      durationMs: 1200,
      withheld: { count: TOTAL, keys: ["a_images", "b_images"], types: ["temp"] },
    },
    frameDeps(sent),
  );

  assert.equal(frame.images.length, 1, "the number attached does not change");
  assert.equal(frame.images[0].filename, "final.png");
  assert.match(frame.note, /768 outputs/);
  assert.match(frame.note, /were not attached/);
  assert.doesNotMatch(frame.note, /produced no image or video output/);
});

test("#1934 formatWithheldMediaNote is the wording the frame ships", () => {
  const note = formatWithheldMediaNote({
    withheld: { count: TOTAL, keys: ["a_images", "b_images"], types: ["temp"] },
    promptId: "abc",
    durationSuffix: " in 3.0s",
  });
  assert.match(note, /finished successfully in 3\.0s and produced 768 outputs/);
  assert.match(note, /get_history for prompt abc/);
});

// ---------------------------------------------------------------------------
// 4. Tracker — live + reconcile, the shipped completion path.
// ---------------------------------------------------------------------------

test("#1934 live panel_run of CompareFrames flushes a count, not a dump", () => {
  const h = makeTracker();
  const P = "prompt-live-cf";
  const { deliverable, withheld } = collectNodeOutputMedia(compareFramesOutput());

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: deliverable, withheld });
  h.advance(2500);
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 0, "attached count stays zero");
  assert.equal(h.flushes[0].noMedia, true);
  assert.equal(h.flushes[0].withheld.count, TOTAL);
  assert.deepEqual(h.flushes[0].withheld.keys, ["a_images", "b_images"]);
});

test("#1934 /history reconcile of CompareFrames recovers the count, not the dump", async () => {
  const h = makeTracker();
  const P = "prompt-hist-cf";
  h.tracker.onQueued(P);
  await h.tracker.reconcile({
    fetchHistory: async () => ({
      status: { status_str: "success", completed: true },
      outputs: { 147: compareFramesOutput() },
    }),
    fetchQueued: async () => false,
  });

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 0);
  assert.equal(h.flushes[0].noMedia, true);
  assert.equal(h.flushes[0].reconciled, true);
  assert.equal(h.flushes[0].withheld.count, TOTAL);
});

test("#1934 live SaveImage + CompareFrames still attaches only the SaveImage", () => {
  const h = makeTracker();
  const P = "prompt-mixed-live";
  const collected = collectNodeOutputMedia({
    images: [{ filename: "final.png", type: "output", subfolder: "" }],
    a_images: bag("a", A_COUNT),
  });

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: collected.deliverable, withheld: collected.withheld });
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 1);
  assert.equal(h.flushes[0].images[0].filename, "final.png");
  assert.notEqual(h.flushes[0].noMedia, true);
  assert.equal(h.flushes[0].withheld.count, A_COUNT);
});

test("#1934 the live executed path in the panel uses collectNodeOutputMedia", () => {
  const src = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");
  assert.match(src, /collectNodeOutputMedia/, "the live harvest must call the shipped splitter");
  assert.doesNotMatch(
    src,
    /\[\s*\.\.\.\(out\.images \|\| \[\]\),\s*\.\.\.\(out\.gifs \|\| \[\]\),\s*\.\.\.\(out\.videos \|\| \[\]\)\s*\]/,
    "the three-literal-key harvest is what missed CompareFrames",
  );
});
