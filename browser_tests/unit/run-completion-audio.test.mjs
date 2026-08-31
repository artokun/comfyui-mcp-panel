// panel#2126 — "The audio recording completed successfully; no media notifications
// were received."
//
// THE MECHANISM. ComfyUI groups a node's outputs by kind, and every core audio
// output node (SaveAudio / SaveAudioMP3 / SaveAudioOpus / SaveAudioAdvanced /
// PreviewAudio) serialises through `SavedAudios.as_dict()` in
// `comfy_api/latest/_ui.py`, which returns `{ audio: [ {filename, subfolder, type} ] }`.
// The completion path collected `images` / `gifs` / `videos` and nothing else, so:
//
//   1. collectNodeOutputMedia    — returned `{deliverable: [], withheld: null}`; `audio`
//                                  matched neither the three literal keys nor the
//                                  widened `/(?:images|gifs|videos)$/` scan;
//   2. onExecuted                — `if (!media.length && !withheld) return;` fired, so
//                                  no player was painted AND the tracker never heard
//                                  about the run;
//   3. onExecutionSuccess        — with nothing buffered, a panel-queued run took the
//                                  media-less branch and flushed `noMedia: true`;
//   4. composeRunCompletionFrame — which reports "produced no image or video output …
//                                  if this workflow was meant to save a file, NO OUTPUT
//                                  NODE PRODUCED ONE", plus `metadata:[{outputs:"none",
//                                  reason:"no_media"}]`.
//
// Step 4 is why this is a defect and not a gap: a SaveAudio node DID produce a file.
// The panel told the agent otherwise, in a sentence the agent has every reason to
// believe. That is the #710 honesty class, on the run-completion surface.
//
// THE SHAPE OF THE FIX, and what these tests pin. Audio gets its own channel, modelled
// on the #1934 `withheld` channel: PAINTED in chat (the panel can play it), NAMED on the
// completion frame, and NEVER attached to it. Not attached because the frame's `images`
// are inline image blocks — handing audio over as one is a broken picture plus a claim
// of a perception nobody had (#710). Not folded into `withheld` because that note says
// the outputs "exceed the completion frame's media budget", which is not why audio is
// held back.
//
// Delete any single wire below and one of these fails: the collection (1), the panel
// call site (2), the tracker's buffer/flush (3), or the composer's note (4).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectNodeOutputMedia,
  formatAudioMediaNote,
  mergeAudioMedia,
} from "../../web/js/lib/node-output-media.js";
import { parseHistoryEntry } from "../../web/js/lib/history-reconcile.js";
import { createRunCompletionTracker, NO_PROMPT_KEY } from "../../web/js/lib/run-completion.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";
import { createRunCompletionFlushHandler } from "../../web/js/lib/run-completion-delivery.js";
import { chatMediaEnabled } from "../../web/js/lib/chat-media-inflow.js";
import {
  appendImageCacheBust,
  appendStoryboardCacheBust,
  createStoryboardIdentity,
} from "../../web/js/lib/storyboard-cache-identity.js";

// The exact `executed` payload a ComfyUI SaveAudio node emits. `type:"output"`,
// no `format` key — the descriptor carries nothing that says "audio" except the
// bag it arrived in and, incidentally, the extension.
const SAVE_AUDIO_OUTPUT = {
  audio: [{ filename: "ComfyUI_00007_.flac", subfolder: "", type: "output" }],
};

// ---------------------------------------------------------------------------
// 1. Collection — the `audio` bag is harvested, and kept off `deliverable`.
// ---------------------------------------------------------------------------

test("#2126 collectNodeOutputMedia harvests ComfyUI's audio bag", () => {
  const got = collectNodeOutputMedia(SAVE_AUDIO_OUTPUT);
  assert.equal(got.audio.length, 1, "the audio bag must be collected");
  assert.equal(got.audio[0].filename, "ComfyUI_00007_.flac");
  assert.deepEqual(got.deliverable, [], "audio must never join the deliverable harvest");
  assert.equal(got.withheld, null, "audio is not a budget-withheld bag either");
});

test("#2126 audio does not disturb the stills/withheld split it sits beside", () => {
  const got = collectNodeOutputMedia({
    images: [{ filename: "still.png", type: "output" }],
    audio: [{ filename: "track.mp3", type: "output" }],
    a_images: [{ filename: "cmp.png", type: "temp", subfolder: "" }],
  });
  assert.deepEqual(
    got.deliverable.map((m) => m.filename),
    ["still.png"],
  );
  assert.deepEqual(
    got.audio.map((m) => m.filename),
    ["track.mp3"],
  );
  assert.equal(got.withheld.count, 1, "#1934 CompareFrames bags still count as withheld");
  assert.deepEqual(got.withheld.keys, ["a_images"], "`audio` must not be named as withheld");
});

test("#2126 a malformed audio bag contributes nothing", () => {
  assert.deepEqual(collectNodeOutputMedia({ audio: "nope" }).audio, []);
  assert.deepEqual(collectNodeOutputMedia({ audio: [null, {}, { filename: "" }] }).audio, []);
  assert.deepEqual(collectNodeOutputMedia(null).audio, []);
});

test("#2126 mergeAudioMedia de-duplicates on the /view identity", () => {
  const a = { filename: "x.flac", subfolder: "", type: "output" };
  const b = { filename: "x.flac", subfolder: "", type: "output" };
  const c = { filename: "x.flac", subfolder: "sub", type: "output" };
  assert.equal(mergeAudioMedia([a], [b]).length, 1, "a replayed executed must not double-announce");
  assert.equal(mergeAudioMedia([a], [c]).length, 2, "a different subfolder is a different file");
});

// ---------------------------------------------------------------------------
// 2. The panel call site — the shipped onExecuted, not a helper.
//
// A helper that works is invisible proof: the reported failure was that production
// never CALLED it. This instantiates the real closure out of the shipped bundle,
// exactly as the #2034 gate tests do.
// ---------------------------------------------------------------------------

const panelSrc = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function productionOnExecuted({ chatMediaSetting = undefined, isAudioOutput = () => false } = {}) {
  const start = panelSrc.indexOf("  function onExecuted(ev) {");
  const end = panelSrc.indexOf("\n  function onExecError(ev)", start);
  assert.ok(start >= 0 && end > start, "could not isolate production onExecuted");
  const painted = { image: [], video: [], audio: [] };
  const buffered = [];
  const onExecuted = new Function(
    "imageViewUrl",
    "isVideoOutput",
    "isAudioOutput",
    "paintVideo",
    "paintAudio",
    "paintImage",
    "runCompletion",
    "stripMisattachedExecutionPreviews",
    "app",
    "createStoryboardIdentity",
    "appendStoryboardCacheBust",
    "appendImageCacheBust",
    "NO_PROMPT_KEY",
    "collectNodeOutputMedia",
    "chatMediaEnabled",
    "getSetting",
    "SETTING_CHAT_MEDIA",
    `return (${panelSrc.slice(start, end).trim()});`,
  )(
    (m) => `/view?filename=${m.filename}&subfolder=${m.subfolder ?? ""}&type=${m.type || "output"}`,
    () => false,
    isAudioOutput,
    (url, name) => painted.video.push({ url, name }),
    (url, name) => painted.audio.push({ url, name }),
    (url, name) => painted.image.push({ url, name }),
    { onExecuted: (promptId, output) => buffered.push({ promptId, output }) },
    () => {},
    {},
    createStoryboardIdentity,
    appendStoryboardCacheBust,
    appendImageCacheBust,
    NO_PROMPT_KEY,
    collectNodeOutputMedia,
    chatMediaEnabled,
    () => chatMediaSetting,
    "Comfy.MCPPanel.ChatMedia",
  );
  return { onExecuted, painted, buffered };
}

test("#2126 the shipped onExecuted paints a player and tells the tracker about audio", () => {
  // isAudioOutput deliberately answers FALSE for everything: an entry from the
  // `audio` BAG is audio by provenance. If the call site asked the extension regex
  // instead, a file type that regex does not list would land in paintImage — #710 again.
  const h = productionOnExecuted({ isAudioOutput: () => false });
  h.onExecuted({ detail: { prompt_id: "aud", node: "9", output: SAVE_AUDIO_OUTPUT } });

  assert.equal(h.painted.audio.length, 1, "the audio player must reach the chat");
  assert.match(h.painted.audio[0].url, /ComfyUI_00007_\.flac/);
  assert.equal(h.painted.image.length, 0, "and must never be painted as an image");

  assert.equal(h.buffered.length, 1, "the tracker must hear about the run at all");
  assert.deepEqual(h.buffered[0].output.images, [], "audio never rides the inline-image list");
  assert.equal(h.buffered[0].output.audio.length, 1);
  assert.equal(h.buffered[0].output.audio[0].filename, "ComfyUI_00007_.flac");
});

test("#2126 chat-media OFF still reports the audio to the agent", () => {
  const h = productionOnExecuted({ chatMediaSetting: false });
  h.onExecuted({ detail: { prompt_id: "aud", output: SAVE_AUDIO_OUTPUT } });
  assert.equal(h.painted.audio.length, 0, "#2034 — no card when the setting is off");
  assert.equal(h.buffered[0].output.audio.length, 1, "the agent is told regardless");
});

// ---------------------------------------------------------------------------
// 3. The tracker — an audio-only run reaches the flush carrying its refs.
// ---------------------------------------------------------------------------

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

test("#2126 a panel-queued audio-only run flushes ONE completion carrying the audio", () => {
  const h = makeTracker();
  const P = "prompt-audio";
  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: [], videos: [], audio: SAVE_AUDIO_OUTPUT.audio });
  h.advance(3200);
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1, "exactly one completion for the prompt");
  const payload = h.flushes[0];
  assert.equal(payload.promptId, P);
  assert.equal(payload.audio?.length, 1, "the audio refs must survive to the flush");
  assert.equal(payload.audio[0].filename, "ComfyUI_00007_.flac");
  assert.deepEqual(payload.images, [], "and must not have been smuggled into images");
});

test("#2126 audio alone does not arm the orphan timer", () => {
  // Same rule as #1934's withheld: flush() drops an images/videos-empty buffer, so
  // an early orphan flush would delete the audio refs before execution_success can
  // report them. The audio must still be there when the authoritative end arrives.
  const h = makeTracker();
  const P = "prompt-audio-orphan";
  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { audio: SAVE_AUDIO_OUTPUT.audio });
  assert.equal(h.flushes.length, 0, "nothing is delivered before the run is terminal");
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes[0].audio?.length, 1);
});

test("#2126 a run with stills AND audio delivers both on one flush payload", () => {
  const h = makeTracker();
  const P = "prompt-mixed";
  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, {
    images: [{ filename: "still.png", type: "output" }],
    audio: SAVE_AUDIO_OUTPUT.audio,
  });
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 1);
  assert.equal(h.flushes[0].audio.length, 1);
});

// ---------------------------------------------------------------------------
// 4. The composer — the sentence that was false is gone, and the file is named.
// ---------------------------------------------------------------------------

const frameDeps = (sent) => ({
  sendFrame: (f) => (sent.push(f), true),
  coerceMessageText: (s) => String(s ?? ""),
  formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`,
  formatClock: () => "12:00:00",
  agentReceivesImages: () => true,
  warn: () => {},
});

test("#2126 an audio-only completion no longer claims no output node produced a file", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "prompt-audio",
      images: [],
      videos: [],
      audio: SAVE_AUDIO_OUTPUT.audio,
      durationMs: 3200,
      noMedia: true,
    },
    frameDeps(sent),
  );

  assert.ok(frame, "a frame must be sent — silence is the stall this fixes");
  assert.equal(sent.length, 1, "exactly one frame");
  // THE REGRESSION. Both halves of the old sentence were wrong for an audio run.
  assert.doesNotMatch(frame.note, /produced no image or video output/);
  assert.doesNotMatch(frame.note, /no output node produced one/);
  // What it says instead: the file, by name, and that the agent cannot hear it.
  assert.match(frame.note, /ComfyUI_00007_\.flac/);
  assert.match(frame.note, /no way for you to hear it/);
  assert.match(frame.note, /get_image/);
  // Still not attached, and still terminal.
  assert.deepEqual(frame.images, [], "audio must never ride the frame as an image block");
  assert.match(frame.note, /nothing further is coming/);
  assert.equal(frame.metadata[0].outputs, "audio");
  assert.equal(frame.metadata[0].reason, "not_audible");
  assert.deepEqual(frame.metadata[0].files, ["ComfyUI_00007_.flac"]);
});

test("#2126 a genuinely empty run still gets the media-less report", async () => {
  // The #356 Bug 2 branch must survive: a run that really produced nothing is
  // still told so. Narrowing it to "no audio either" is the point.
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p-empty", images: [], videos: [], audio: [], durationMs: 500, noMedia: true },
    frameDeps(sent),
  );
  assert.match(frame.note, /produced no image or video output/);
  assert.equal(frame.metadata[0].reason, "no_media");
});

test("#2126 stills plus audio: the stills attach and the audio is named alongside", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-mixed",
      images: [{ filename: "still.png", type: "output", subfolder: "" }],
      videos: [],
      audio: SAVE_AUDIO_OUTPUT.audio,
      durationMs: 4000,
    },
    frameDeps(sent),
  );
  assert.equal(frame.images.length, 1, "the still is still delivered inline");
  assert.match(frame.note, /Also produced 1 audio output/);
  assert.match(frame.note, /ComfyUI_00007_\.flac/);
});

test("#2126 the audio note names a bounded number of files and points at get_history", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    filename: `take_${i}.mp3`,
    subfolder: "",
    type: "output",
  }));
  const note = formatAudioMediaNote({ audio: many, promptId: "p9" });
  assert.match(note, /produced 9 audio outputs/);
  assert.match(note, /and 3 more/, "the tail is summarised, not spelled out");
  assert.match(note, /get_history for prompt p9/);
  assert.equal(formatAudioMediaNote({ audio: [] }), null);
});

// ---------------------------------------------------------------------------
// 5. Recovery — a completion rebuilt from /history is honest too.
// ---------------------------------------------------------------------------

test("#2126 parseHistoryEntry returns audio on its own channel, never as an image", () => {
  const parsed = parseHistoryEntry(
    {
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { 9: SAVE_AUDIO_OUTPUT },
    },
    { isVideo: () => false },
  );
  assert.equal(parsed.status, "success");
  assert.deepEqual(parsed.images, [], "a recovered audio run must not be handed over as an image");
  assert.equal(parsed.audio.length, 1);
  assert.equal(parsed.audio[0].filename, "ComfyUI_00007_.flac");
});

test("#2126 a reconciled panel-queued audio run carries its refs to the flush", async () => {
  const h = makeTracker();
  const P = "prompt-recovered";
  h.tracker.onQueued(P);
  // `fetchHistory` resolves to the ENTRY itself, as the tracker's other reconcile
  // tests do — the /history map lookup happens in the caller, not here.
  await h.tracker.reconcile({
    fetchHistory: async () => ({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { 9: SAVE_AUDIO_OUTPUT },
    }),
    fetchQueued: async () => false,
    isVideo: () => false,
  });
  assert.equal(h.flushes.length, 1, "the /history safety net must recover an audio run");
  assert.equal(h.flushes[0].audio?.length, 1);
  assert.deepEqual(h.flushes[0].images, []);
});

// ---------------------------------------------------------------------------
// 6. End to end through the SHIPPED wiring — tracker + delivery handler.
//
// Sections 3 and 4 test the two halves separately, and each would still pass if
// the handler between them dropped `audio` on the floor: a one-line pass-through
// is invisible to a helper-level test. This drives the same composition the panel
// installs at comfyui-mcp-panel.js's `onFlush: createRunCompletionFlushHandler({…})`
// and asserts on the frame that actually reaches the transport.
// ---------------------------------------------------------------------------

async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("#2126 the frame that reaches the transport names the audio", async () => {
  const sent = [];
  let tracker;
  const onFlush = createRunCompletionFlushHandler({
    sendFrame: (frame) => (sent.push(frame), true),
    markDelivered: (promptId, completionKey) => tracker.markDelivered(promptId, completionKey),
    markUndelivered: (promptId, completionKey) => tracker.markUndelivered(promptId, completionKey),
    pruneRebootMarker: () => {},
    coerceMessageText: (v) => (v == null ? "" : String(v)),
    formatDuration: (ms) => (ms == null ? null : `${Math.round(ms / 1000)}s`),
    formatClock: () => "12:00:00",
    imageViewUrl: (m) => `view://${m?.filename ?? "x"}`,
    fetchImageBytes: async () => 2048,
    fetchImageDimensions: async () => ({ w: 512, h: 512 }),
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async () => null,
    uploadBlobToInput: async (_blob, name, opts) => ({ filename: name, type: opts?.type || "input" }),
    storyboardFrameCount: () => 20,
    paintImage: () => {},
    applyVideoPoster: () => {},
    videoStoryboardEnabled: false,
    agentReceivesImages: () => true,
    isAgentMuted: () => false,
    warn: () => {},
  });
  tracker = createRunCompletionTracker({ onFlush, setTimer: () => 0, clearTimer: () => {} });

  const P = "prompt-wired";
  tracker.onQueued(P);
  tracker.onExecutionStart(P);
  tracker.onExecuted(P, { audio: SAVE_AUDIO_OUTPUT.audio });
  tracker.onExecutionSuccess(P);
  await settle();

  assert.equal(sent.length, 1, "one completion frame reaches the transport");
  assert.match(sent[0].note, /ComfyUI_00007_\.flac/, "the audio must survive the delivery handler");
  assert.doesNotMatch(sent[0].note, /no output node produced one/);
  assert.deepEqual(sent[0].images, []);
});

// ---------------------------------------------------------------------------
// 7. Two states the codex merge gate found on the first round of this change.
//
// Both are the SAME defect the issue reports, re-entered through a lifecycle path
// the first fix did not cover. Both were reproduced by execution before being
// fixed; the first was confirmed by the gate independently.
// ---------------------------------------------------------------------------

function makeTimerTracker(onFlush = () => {}) {
  const timers = new Set();
  const clock = { t: 1_000_000 };
  const tracker = createRunCompletionTracker({
    onFlush,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  tracker._fireTimers = (ms) => {
    for (const t of [...timers]) {
      if (t.ms !== ms) continue;
      timers.delete(t);
      t.fn();
    }
  };
  return tracker;
}

test("#2126 queue-idle before execution_success must not destroy the audio refs", () => {
  // The run's `execution_start` and `executing(node)` frames were dropped, so the
  // prompt is not `active` and onExecutingNull sweeps it. flush() of an
  // images/videos-empty batch emits nothing and DELETES the buffer, which is where
  // onExecutionSuccess reads the audio from — so the agent got `noMedia` and the
  // "no output node produced one" report for a run that wrote a .flac.
  const h = makeTracker();
  const P = "prompt-queue-idle";
  h.tracker.onQueued(P);
  h.tracker.onExecuted(P, { audio: SAVE_AUDIO_OUTPUT.audio });
  h.tracker.onExecutingNull();
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].audio?.length, 1, "the refs must survive a queue-idle sweep");
  assert.equal(h.flushes[0].audio[0].filename, "ComfyUI_00007_.flac");
});

test("#2126 queue-idle still flushes a buffer that HAS something to attach", () => {
  // The guard must not disarm the sweep it narrows: a still/video batch stranded by
  // a missed end signal is exactly what onExecutingNull exists to deliver.
  const h = makeTracker();
  const P = "prompt-stranded-still";
  h.tracker.onQueued(P);
  h.tracker.onExecuted(P, { images: [{ filename: "stranded.png", type: "output" }] });
  h.tracker.onExecutingNull();
  assert.equal(h.flushes.length, 1, "an image batch is still salvaged at queue idle");
  assert.equal(h.flushes[0].images[0].filename, "stranded.png");
});

test("#2126 a held completion's persistence round-trip keeps the audio", async () => {
  // A panel_run whose /prompt response is delayed past the dispatch hold has its
  // batch RETAINED for replay. Persisting that record without `audio` restores the
  // image and silently loses the file the same run produced.
  const first = makeTimerTracker(() => {});
  const dispatchToken = first.beginPanelRun();
  const P = "P-held-audio";
  first.onExecutionStart(P);
  first.onExecuted(P, {
    images: [{ filename: "held.png", type: "output" }],
    audio: SAVE_AUDIO_OUTPUT.audio,
  });
  first.onExecutionSuccess(P);
  first._fireTimers(30000);

  const state = first.terminalCompletionMetadata();
  assert.equal(state.length, 1);
  assert.equal(state[0].payload.audio?.length, 1, "the snapshot must carry the audio");
  first.dispose();

  const replayed = [];
  const fresh = makeTimerTracker((payload) => replayed.push(payload));
  assert.equal(fresh.restoreTerminalCompletion(state[0]), true);
  fresh.onQueued(P, { routeId: "r", sessionId: "s", dispatchToken });
  assert.equal(replayed.length, 1, "the delayed prompt binds and replays after restart");
  assert.equal(replayed[0].images[0].filename, "held.png");
  assert.equal(replayed[0].audio?.length, 1, "and the replay still names the audio");
});

test("#2126 a persisted record from a build without audio restores unchanged", () => {
  // No `audio` key must stay no `audio` key — not an empty array the composer then
  // has to reason about.
  const fresh = makeTimerTracker();
  assert.equal(
    fresh.restoreTerminalCompletion({
      promptId: "P-legacy",
      payload: {
        promptId: "P-legacy",
        images: [{ filename: "legacy.png", type: "output" }],
        videos: [],
        durationMs: 0,
        finishedAt: 1_000_000,
      },
      unkeyedFlushed: true,
    }),
    true,
  );
  const restored = fresh.terminalCompletionMetadata()[0].payload;
  assert.equal("audio" in restored, false, "no audio key is invented on restore");
});
