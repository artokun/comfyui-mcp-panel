/**
 * Unit tests for #1199 — a completion recovered from /history must report when it
 * RENDERED, not when the recovery happened.
 *
 * The reported failure: a reconcile edge (tab wake / reconnect) swept SEVEN prompt
 * ids that had been sitting in the pending ledger since two nights earlier. The
 * long-running ComfyUI still had all seven in `/history`, so all seven were
 * delivered in one burst — each stamped `finishedAt: now()`, i.e. the delivery
 * time. Every one announced "finished 7:45:29 AM" (the same second), and the agent
 * told the user seven videos were ready whose files the user had moved out of the
 * output directory days before.
 *
 * The replay itself is by design ("never lose a completion"). What was wrong is
 * that a replay was indistinguishable from a fresh render. Three seams:
 *
 *   1. history-reconcile.js — the entry's own `execution_success` timestamp was
 *      never read, so the real finish time was unavailable to anyone downstream.
 *   2. run-completion.js — the reconciled flush stamped `now()`, and computed
 *      `durationMs` as `now() - startTs`, which measures the RECONCILE GAP ("2
 *      days") rather than the render.
 *   3. comfyui-mcp-panel.js / run-completion-frame.js — the call site dropped
 *      `finishedAt` and `reconciled` on the floor and the composer stamped its own
 *      clock, so fixing (1) and (2) alone would have changed nothing observable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { parseHistoryEntry } from "../../web/js/lib/history-reconcile.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

const isVideo = (m) => /\.(mp4|webm|mov)$/i.test(String(m?.filename || ""));

// A realistic wall clock. The tracker's real `now` is Date.now(), and the
// future-skew rejection compares history timestamps against it — so a harness
// pinned at 0 (the pattern in run-reconcile.test.mjs) would read every real epoch
// as "impossibly far in the future". These tests are about wall-clock ages, so
// they run on a wall-clock-shaped fake.
const NOW = Date.parse("2026-08-14T07:45:29Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Tracker harness on a wall-clock-shaped fake clock. */
function makeHarness(opts = {}) {
  let clock = NOW;
  const timers = new Map();
  let seq = 0;
  const flushes = [];
  const tracker = createRunCompletionTracker({
    onFlush: (p) => flushes.push(p),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    debounceMs: 1500,
    ...opts,
  });
  return {
    tracker,
    flushes,
    setClock: (t) => {
      clock = t;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * A terminal-success history entry carrying ComfyUI's real lifecycle messages.
 * `[name, data]` with `data.timestamp` is exactly the shape ComfyUI records in
 * `status.messages`.
 */
const entryWithTimes = (outputs, { startedAt, finishedAt, unit = "ms" } = {}) => {
  const stamp = (ms) => (unit === "s" ? Math.floor(ms / 1000) : ms);
  const messages = [];
  if (startedAt != null) messages.push(["execution_start", { prompt_id: "p", timestamp: stamp(startedAt) }]);
  if (finishedAt != null) messages.push(["execution_success", { prompt_id: "p", timestamp: stamp(finishedAt) }]);
  return { outputs, status: { status_str: "success", completed: true, messages } };
};

const videoOutput = (filename) => ({ 10: { gifs: [{ filename, type: "output" }] } });

// ─────────────────────────────────────────────────────────────────────────────
// 1. The parse recovers the run's own times
// ─────────────────────────────────────────────────────────────────────────────

test("#1199 parse: execution_success supplies the real finish time (epoch ms)", () => {
  const finishedAt = NOW - 2 * DAY;
  const startedAt = finishedAt - 134_000;
  const parsed = parseHistoryEntry(
    entryWithTimes(videoOutput("MiniMax_H3_00184_.mp4"), { startedAt, finishedAt }),
    { isVideo, now: () => NOW },
  );
  assert.equal(parsed.finishedAt, finishedAt, "finish time comes from the entry, not the clock");
  assert.equal(parsed.startedAt, startedAt, "start time comes from the entry too");
});

test("#1199 parse: epoch SECONDS are normalized to ms (ComfyUI builds differ)", () => {
  const finishedAt = NOW - 6 * HOUR;
  const parsed = parseHistoryEntry(
    entryWithTimes(videoOutput("a.mp4"), { finishedAt, unit: "s" }),
    { isVideo, now: () => NOW },
  );
  // Second-resolution round trip, so compare at second granularity.
  assert.equal(parsed.finishedAt, Math.floor(finishedAt / 1000) * 1000);
});

test("#1199 parse: an entry with no lifecycle timestamps reports the finish time as UNKNOWN", () => {
  const parsed = parseHistoryEntry(
    { outputs: videoOutput("a.mp4"), status: { status_str: "success", completed: true, messages: [] } },
    { isVideo, now: () => NOW },
  );
  assert.equal(parsed.finishedAt, null, "unknown, never guessed");
  assert.equal(parsed.startedAt, null);
});

test("#1199 parse: a garbage or future timestamp is rejected rather than trusted", () => {
  // A relative counter (not an epoch) and a stamp far ahead of our clock both
  // yield null: a future finish time would compute to a NEGATIVE age and present
  // an ancient render as one that just landed.
  const counter = parseHistoryEntry(
    entryWithTimes(videoOutput("a.mp4"), { finishedAt: 1500 }),
    { isVideo, now: () => NOW },
  );
  assert.equal(counter.finishedAt, null, "a small relative counter is not an epoch");

  const future = parseHistoryEntry(
    entryWithTimes(videoOutput("a.mp4"), { finishedAt: NOW + 10 * DAY }),
    { isVideo, now: () => NOW },
  );
  assert.equal(future.finishedAt, null, "a stamp far in the future is clock skew, not a finish");
});

test("#1199 parse: a malformed duplicate message does not shadow the well-formed one", () => {
  const finishedAt = NOW - 3 * HOUR;
  const parsed = parseHistoryEntry(
    {
      outputs: videoOutput("a.mp4"),
      status: {
        status_str: "success",
        completed: true,
        messages: [
          ["execution_success", null],
          ["execution_success", { timestamp: "not-a-number" }],
          ["execution_success", { prompt_id: "p", timestamp: finishedAt }],
        ],
      },
    },
    { isVideo, now: () => NOW },
  );
  assert.equal(parsed.finishedAt, finishedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The tracker's reconciled flush carries the real time, not the delivery time
// ─────────────────────────────────────────────────────────────────────────────

test("#1199 tracker: a two-day-old reconciled completion reports when it RENDERED", async () => {
  const h = makeHarness();
  const finishedAt = NOW - 2 * DAY;
  const startedAt = finishedAt - 134_000;

  // The prompt was queued and started two days ago, then the terminal event was
  // missed — the id sat in the pending ledger ever since.
  h.setClock(startedAt);
  h.tracker.onExecutionStart("d24e79b9");
  h.setClock(NOW); // …tab wakes two days later, reconcile sweeps

  const history = {
    d24e79b9: entryWithTimes(videoOutput("MiniMax_H3_00184_.mp4"), { startedAt, finishedAt }),
  };
  await h.tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });

  assert.equal(h.flushes.length, 1, "the completion is still delivered — replay is by design");
  const f = h.flushes[0];
  assert.equal(f.reconciled, true);
  assert.equal(
    f.finishedAt,
    finishedAt,
    "finishedAt is the run's execution_success time, NOT the moment of delivery",
  );
  assert.notEqual(f.finishedAt, NOW, "the delivery clock must not masquerade as the finish time");
  assert.equal(
    f.durationMs,
    134_000,
    "duration is the render span from history, not the two-day reconcile gap",
  );
});

test("#1199 tracker: with no history timestamps the finish time is null, not the delivery clock", async () => {
  const h = makeHarness();
  h.setClock(NOW - 2 * DAY);
  h.tracker.onExecutionStart("p-nots");
  h.setClock(NOW);

  const history = {
    "p-nots": {
      outputs: videoOutput("a.mp4"),
      status: { status_str: "success", completed: true, messages: [] },
    },
  };
  await h.tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].finishedAt, null, "unknown is reported as unknown");
  assert.equal(
    h.flushes[0].durationMs,
    null,
    "and the duration is NOT the reconcile gap — a made-up duration is not evidence (#986)",
  );
});

test("#1199 tracker: the LIVE completion path is unchanged — it still stamps its own clock", () => {
  const h = makeHarness();
  h.tracker.onExecutionStart("live-1");
  h.tracker.onExecuted("live-1", { images: [{ filename: "final.png", type: "output" }] });
  h.advance(20_000);
  h.tracker.onExecutionSuccess("live-1");

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].reconciled, undefined, "a live completion is not a recovery");
  assert.equal(h.flushes[0].finishedAt, NOW + 20_000, "live runs still stamp the observed finish");
  assert.equal(h.flushes[0].durationMs, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Presentation — the agent is TOLD this is a recovery
// ─────────────────────────────────────────────────────────────────────────────

function makeFrameDeps(overrides = {}) {
  const frames = [];
  const deps = {
    sendFrame: (f) => frames.push(f),
    coerceMessageText: (v) => (v == null ? "" : typeof v === "string" ? v : String(v)),
    formatDuration: (ms) => (ms == null ? null : `${Math.round(ms / 1000)}s`),
    // The REAL formatClock is time-of-day only; this stub returns a fixed string
    // so a test can prove which clock the composer read.
    formatClock: () => "DELIVERY-CLOCK",
    imageViewUrl: (m) => `view://${m?.filename ?? "x"}`,
    fetchImageBytes: async () => 2048,
    fetchImageDimensions: async () => ({ w: 512, h: 512 }),
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async () => null, // note-only fallback: the reported shape
    uploadBlobToInput: async () => null,
    storyboardFrameCount: () => 20,
    paintImage: () => {},
    videoStoryboardEnabled: true,
    now: () => new Date(NOW),
    warn: () => {},
    ...overrides,
  };
  return { deps, frames };
}

test("#1199 presentation: a recovered video completion leads with the recovery and its real age", async () => {
  const { deps, frames } = makeFrameDeps();
  const finishedAt = NOW - 2 * DAY;
  const frame = await composeRunCompletionFrame(
    {
      promptId: "d24e79b9",
      images: [],
      videos: [{ m: { filename: "MiniMax_H3_00184_.mp4", type: "output" }, nodeId: "10" }],
      durationMs: 134_000,
      finishedAt,
      reconciled: true,
    },
    deps,
  );

  assert.equal(frames.length, 1, "still exactly one completion frame");
  // The banner comes FIRST — it reframes the "tell the user it's ready" text below.
  assert.match(frame.note, /^⏳ RECOVERED FROM HISTORY/, "the recovery leads the note");
  assert.match(frame.note, /did NOT just finish/i);
  assert.match(frame.note, /2 days ago/, "the real age is stated");
  assert.match(
    frame.note,
    /moved, renamed, or overwritten/i,
    "the agent is warned the named file may no longer exist",
  );
  // Machine-readable twin, at the TOP level: a video-only run has no per-output
  // metadata entries, and video-only is the shape #1199 was reported from.
  assert.equal(frame.reconciled, true);
  assert.equal(frame.finishedAt, new Date(finishedAt).toISOString());
  assert.equal(frame.recoveredAgeMs, 2 * DAY);
  // The bullet must NOT read as a bare time-of-day from this morning.
  assert.doesNotMatch(frame.note, /DELIVERY-CLOCK/, "the composer must not stamp its own clock");
});

test("#1199 presentation: a LIVE completion is untouched — no banner, no recovery fields", async () => {
  const { deps, frames } = makeFrameDeps();
  const frame = await composeRunCompletionFrame(
    {
      promptId: "live-1",
      images: [],
      videos: [{ m: { filename: "fresh.mp4", type: "output" }, nodeId: "10" }],
      durationMs: 5000,
    },
    deps,
  );
  assert.equal(frames.length, 1);
  assert.doesNotMatch(frame.note, /RECOVERED FROM HISTORY/);
  assert.equal(frame.reconciled, undefined, "no recovery marker on a fresh render");
  assert.match(frame.note, /DELIVERY-CLOCK/, "a live run still reports the composed clock");
});

test("#1199 presentation: an unknown finish time says so rather than implying 'just now'", async () => {
  const { deps, frames } = makeFrameDeps();
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-nots",
      images: [],
      videos: [{ m: { filename: "a.mp4", type: "output" }, nodeId: "10" }],
      durationMs: null,
      finishedAt: null,
      reconciled: true,
    },
    deps,
  );
  assert.equal(frames.length, 1);
  assert.match(frame.note, /RECOVERED FROM HISTORY/);
  assert.match(frame.note, /age as unknown/i, "an unknown age is stated, never computed as zero");
  assert.doesNotMatch(frame.note, /under a minute ago/, "unknown must not read as brand new");
  assert.equal(frame.recoveredAgeMs, null);
});

test("#1199 presentation: a recovered MEDIA-LESS run still reports the no-media completion", async () => {
  // Regression guard: the recovery banner is framing, not content. If it counted
  // as "something to say", it would swallow the #356 no-media report — and the
  // reconcile path sets `noMedia` and `reconciled` on the SAME payload, so this
  // combination is reachable in production, not hypothetical.
  const { deps, frames } = makeFrameDeps();
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-empty",
      images: [],
      videos: [],
      durationMs: null,
      noMedia: true,
      finishedAt: NOW - 3 * HOUR,
      reconciled: true,
    },
    deps,
  );
  assert.equal(frames.length, 1, "the media-less completion is still delivered");
  assert.match(frame.note, /RECOVERED FROM HISTORY/, "and it is still marked as a recovery");
  assert.match(frame.note, /3 hours ago/);
  assert.match(
    frame.note,
    /produced no image or video output/,
    "the #356 no-media report survives the banner",
  );
  assert.equal(frame.metadata[0].reason, "no_media");
  assert.equal(frame.metadata[0].reconciled, true);
});

test("#1199 presentation: a recovered STILLS run stamps the real finish in per-output metadata", async () => {
  // The per-output metadata block is a SECOND consumer of the finish time,
  // independent of the note. Without this, `finishedAt ?? composedAt` could
  // decay to the compose clock on the stills path with the whole suite still
  // green — the machine-readable record would then disagree with the banner
  // sitting directly above it.
  const { deps } = makeFrameDeps();
  const finishedAt = NOW - 2 * DAY;
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-stills",
      images: [{ filename: "final.png", type: "output" }],
      videos: [],
      durationMs: 20_000,
      finishedAt,
      reconciled: true,
    },
    deps,
  );
  assert.equal(
    frame.metadata[0].finishedAt,
    new Date(finishedAt).toISOString(),
    "per-output metadata carries the REAL finish, not the compose clock",
  );
  // …and the human-readable bullet carries the full date, not a bare clock time.
  assert.doesNotMatch(frame.note, /DELIVERY-CLOCK/);
  assert.match(frame.note, /2 days ago/);
});

test("#1199 presentation: ages read at the right magnitude", async () => {
  const cases = [
    [30_000, /under a minute ago/],
    [5 * MINUTE, /5 minutes ago/],
    [1 * HOUR, /1 hour ago/],
    [26 * HOUR, /1 day ago/],
    [7 * DAY, /7 days ago/],
  ];
  for (const [ageMs, expected] of cases) {
    const { deps } = makeFrameDeps();
    const frame = await composeRunCompletionFrame(
      {
        promptId: `p-${ageMs}`,
        images: [],
        videos: [{ m: { filename: "a.mp4", type: "output" }, nodeId: "10" }],
        durationMs: null,
        finishedAt: NOW - ageMs,
        reconciled: true,
      },
      deps,
    );
    assert.match(frame.note, expected, `age ${ageMs}ms should read as ${expected}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Wiring — the seam that made the reported fix inert
// ─────────────────────────────────────────────────────────────────────────────

test("#1199 wiring: the panel call site forwards finishedAt AND reconciled to the composer", () => {
  // The tracker has ALWAYS passed a finishedAt; this closure dropped it, so the
  // composer stamped its own clock. Every behavioural test above hands the
  // composer a payload by hand and therefore cannot see the real call site
  // omitting the field — the same source-inspection pattern #609 uses.
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

  const flushStart = src.indexOf("onFlush: ({");
  assert.notEqual(flushStart, -1, "could not locate the tracker's onFlush handler");
  const composeStart = src.indexOf("composeRunCompletionFrame(", flushStart);
  assert.notEqual(composeStart, -1, "could not locate the composeRunCompletionFrame call site");
  const composeEnd = src.indexOf(".then((frame)", composeStart);
  assert.notEqual(composeEnd, -1, "could not locate the end of the call site");

  // The handler must DESTRUCTURE both fields off the flush payload…
  const handlerSignature = src.slice(flushStart, composeStart);
  assert.match(handlerSignature, /\bfinishedAt\b/, "onFlush must destructure finishedAt");
  assert.match(handlerSignature, /\breconciled\b/, "onFlush must destructure reconciled");

  // …and PASS both into the composer's payload. Destructuring without forwarding
  // is the exact half-fix that leaves the defect intact.
  const payload = src.slice(composeStart, composeEnd);
  assert.match(payload, /\bfinishedAt\b/, "the composer payload must carry finishedAt");
  assert.match(payload, /\breconciled\b/, "the composer payload must carry reconciled");
});
