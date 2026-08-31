// panel#2128 — "Run finished, but no saved output node ran — these 7 images are
// previews (temporary, not a final file). Add a SaveImage node to persist the result."
//
// Reported against a Pixal3D/Trellis2 image-to-3D workflow ending in `Save3DAdvanced`
// that ran for 9m28s and wrote a real 15,659,544-byte `PROP_crate_00001.glb` to
// `output/3D/`. All three claims in that sentence were false, and the remedy it named
// cannot work: SaveImage takes an IMAGE, and the payload is a `FILE_3D_GLB`.
//
// THE MECHANISM, from ComfyUI's own source. 3D outputs arrive in TWO shapes:
//
//   SaveGLB                         `ui={"3d":[{filename,subfolder,type:"output"}]}`
//     (comfy_extras/nodes_save_3d.py)   — ordinary /view descriptors, unread key
//
//   Save3DAdvanced                  `{"result":["3D/PROP_crate_00001.glb", camera, info]}`
//   SaveGaussianSplat                 — all three delegate to execute_save_3d_advanced,
//   SavePointCloud                      which serialises through
//   Preview3D / Preview3DAdvanced       UI.PreviewUI3D{,Advanced}.as_dict()
//                                       (comfy_api/latest/_ui.py). `model_file` is a
//                                       bare PATH STRING, not a descriptor.
//
// Neither key matches the three literal media keys nor the widened
// `/(?:images|gifs|videos)$/` scan, so `collectNodeOutputMedia` returned nothing at all
// and the `.glb` was invisible to the entire completion path. Two symptoms follow from
// that one hole:
//
//   with PreviewImage taps upstream — `bufImages` holds the 7 `type:"temp"` frames, so
//     buildStillsSegment takes its no-finals branch and emits the reported sentence;
//   without them — the batch is empty, so the run lands in the media-less branch and
//     reports "produced no image or video output", which is #2126 with a different
//     file extension.
//
// THE SHAPE OF THE FIX. 3D gets its own channel, modelled on the #2126 audio channel:
// NAMED on the completion frame, NEVER attached (a mesh delivered as an inline image
// block is a broken picture plus a claim of a perception nobody had — #710), and never
// folded into `withheld` (that note says the outputs exceed the media budget, which is
// not why a mesh is held back).
//
// And buildStillsSegment stops inferring a claim about the whole RUN from a strict
// subset of its outputs. It is now told which non-image outputs the run produced, which
// fixes the #2126 sibling too: audio + preview taps produced the same false sentence
// after that fix landed, because #2126 only covered the media-less path.
//
// What it deliberately does NOT say is that THIS RUN saved the file. `Preview3D` handed
// a literal path passes it through without writing anything, and the bag cannot tell
// that apart from a `Save3DAdvanced` write — so the note names the output and refuses
// the SaveImage advice, and asserts no provenance beyond that.
//
// Delete any single wire below and one of these fails: the collection (1), the panel
// call site (2), the tracker's buffer/flush (3), the composer's two notes (4), the
// /history recovery (5), the delivery handler (6), or the reload persistence (7).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectNodeOutputMedia,
  formatModel3dMediaNote,
  mergeModel3dMedia,
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

// The exact `executed` payload the REPORTED node emits. The camera dict and the
// model-info list share the array with the path string; only the string is a file.
const SAVE_3D_ADVANCED = {
  result: ["3D/PROP_crate_00001.glb", { position: [0, 1.2, 5] }, { faces: 120000 }],
};

// The other core shape: SaveGLB's real /view descriptors, under a key nothing read.
const SAVE_GLB = {
  "3d": [{ filename: "ComfyUI_00001_.glb", subfolder: "3d", type: "output" }],
};

// The 7 PreviewImage taps the reported workflow carries (base colour, normal, AO,
// roughness, metallic, UV atlas). Genuinely `type:"temp"` — the image classification
// was never the bug.
const PREVIEW_TAPS = Array.from({ length: 7 }, (_, i) => ({
  filename: `preview_${i}.png`,
  subfolder: "",
  type: "temp",
}));

// ---------------------------------------------------------------------------
// 1. Collection — both shapes are harvested, and neither becomes an image.
// ---------------------------------------------------------------------------

test("#2128 collectNodeOutputMedia reads Save3DAdvanced's bare result path", () => {
  const got = collectNodeOutputMedia(SAVE_3D_ADVANCED);
  assert.equal(got.models3d.length, 1, "the .glb must be collected");
  assert.deepEqual(got.models3d[0], {
    filename: "PROP_crate_00001.glb",
    subfolder: "3D",
    type: "output",
  });
  assert.deepEqual(got.deliverable, [], "a mesh must never join the inline-image harvest");
  assert.deepEqual(got.audio, [], "nor the audio channel");
  assert.equal(got.withheld, null, "nor be counted as budget-withheld");
});

test("#2128 collectNodeOutputMedia reads SaveGLB's 3d descriptors", () => {
  const got = collectNodeOutputMedia(SAVE_GLB);
  assert.equal(got.models3d.length, 1);
  assert.equal(got.models3d[0].filename, "ComfyUI_00001_.glb");
  assert.equal(got.models3d[0].subfolder, "3d");
  assert.deepEqual(got.deliverable, []);
});

test("#2128 the result siblings are not mistaken for files", () => {
  // Only a STRING with a 3D extension is admitted. `result` is a generic key, so a
  // camera dict, a model-info list, a number, or PreviewUI3D's `"temp/bg_<hex>.png"`
  // must all be passed over — otherwise the fix invents an output node.
  assert.deepEqual(
    collectNodeOutputMedia({
      result: [{ position: [0, 0, 5] }, [1, 2, 3], 42, null, "", "temp/bg_9f3a.png"],
    }).models3d,
    [],
  );
  assert.deepEqual(collectNodeOutputMedia({ result: "nope" }).models3d, []);
  assert.deepEqual(collectNodeOutputMedia({ result: ["notes.txt", "readme"] }).models3d, []);
  assert.deepEqual(collectNodeOutputMedia(null).models3d, []);
  // The extension allowlist carries its own weight, independently of the save-counter
  // test: a file that IS saved output-shaped but is not a mesh must not be announced
  // as a 3D model. Without the allowlist this PNG would be.
  assert.deepEqual(
    collectNodeOutputMedia({ result: ["3D/render_00001.png"] }).models3d,
    [],
    "a save-counter name with a non-3D extension is not a mesh",
  );
  assert.deepEqual(collectNodeOutputMedia({ result: ["out/clip_00001.mp4"] }).models3d, []);
});

test("#2128 every core 3D save format is admitted", () => {
  // The formats the three Save-3D nodes declare on their `model_3d` socket, which is
  // what `_save_file3d_to_output` names the file with (`model_3d.format`). Names are
  // production-shaped — `f"{filename}_{counter:05}.{ext}"`.
  for (const ext of ["glb", "gltf", "obj", "fbx", "stl", "usdz", "ply", "splat", "spz", "ksplat"]) {
    const got = collectNodeOutputMedia({ result: [`3d/mesh_00001.${ext}`] });
    assert.equal(got.models3d.length, 1, `.${ext} must be reported`);
  }
  assert.equal(collectNodeOutputMedia({ result: ["3d/MESH_00001.GLB"] }).models3d.length, 1);
  // A counter past 99999 widens rather than wraps.
  assert.equal(collectNodeOutputMedia({ result: ["3d/mesh_123456.glb"] }).models3d.length, 1);
});

test("#2128 a TEMP 3D preview is never reported as the run's saved result", () => {
  // The `result` bag is shared by nodes that SAVE and nodes that only PREVIEW.
  // Preview3DAdvanced, PreviewGaussianSplat and PreviewPointCloud all write to
  // folder_paths.get_temp_directory() and emit the identical {"result":[...]} shape.
  // Reporting one as a saved final would be this very defect one node over — the file
  // is swept with temp/ and a /view?type=output for it 404s.
  //
  // The discriminator is the save counter: `_save_file3d_to_output` names every saved
  // file `_{counter:05}.{ext}`, which a 32-hex uuid cannot produce.
  for (const name of [
    "preview3d_advanced_9f3ab27c4d1e4f8ab0c5d6e7f8a9b0c1.glb", // Preview3DAdvanced → temp/
    "preview_splat_9f3ab27c4d1e4f8ab0c5d6e7f8a9b0c1.ply", // PreviewGaussianSplat → temp/
    "preview_pointcloud_9f3ab27c4d1e4f8ab0c5d6e7f8a9b0c1.ply", // PreviewPointCloud → temp/
    "preview3d_9f3ab27c4d1e4f8ab0c5d6e7f8a9b0c1.glb", // Preview3D → output/, still a preview
  ]) {
    assert.deepEqual(
      collectNodeOutputMedia({ result: [name] }).models3d,
      [],
      `${name} is a preview, not a saved output`,
    );
  }
  // Preview3D handed a LITERAL path passes it through unchanged and saves nothing;
  // it carries no save counter either, so the same test excludes it.
  assert.deepEqual(collectNodeOutputMedia({ result: ["3d/my_model.glb"] }).models3d, []);
  assert.deepEqual(collectNodeOutputMedia({ result: ["C:/assets/crate.glb"] }).models3d, []);
});

test("#2128 a Windows subfolder separator is split correctly", () => {
  // `get_save_image_path` derives the subfolder with
  // `os.path.dirname(os.path.normpath(prefix))`, and on Windows normpath rewrites `/`
  // to `\` — so a NESTED prefix emits a backslash, which the node then joins to the
  // filename with a forward slash. One string can carry both. Splitting on `/` alone
  // would hand `get_image` a filename of `3D\props\PROP_crate_00001.glb`.
  const got = collectNodeOutputMedia({ result: ["3D\\props/PROP_crate_00001.glb"] });
  assert.equal(got.models3d[0].filename, "PROP_crate_00001.glb");
  assert.equal(got.models3d[0].subfolder, "3D/props");
});

test("#2128 3D does not disturb the splits it sits beside", () => {
  const got = collectNodeOutputMedia({
    images: [{ filename: "still.png", type: "output" }],
    audio: [{ filename: "track.mp3", type: "output" }],
    "3d": [{ filename: "mesh.glb", subfolder: "", type: "output" }],
    a_images: [{ filename: "cmp.png", type: "temp", subfolder: "" }],
  });
  assert.deepEqual(got.deliverable.map((m) => m.filename), ["still.png"]);
  assert.deepEqual(got.audio.map((m) => m.filename), ["track.mp3"]);
  assert.deepEqual(got.models3d.map((m) => m.filename), ["mesh.glb"]);
  assert.equal(got.withheld.count, 1, "#1934 CompareFrames bags still count as withheld");
  assert.deepEqual(
    got.withheld.keys,
    ["a_images"],
    "neither `3d` nor `result` may be named as withheld — that would double-count",
  );
});

test("#2128 mergeModel3dMedia de-duplicates on the /view identity", () => {
  // A SaveGLB and a Save3DAdvanced on one prompt can name the same file, and a
  // replayed `executed` re-delivers the same bag.
  const a = { filename: "m.glb", subfolder: "3d", type: "output" };
  const b = { filename: "m.glb", subfolder: "3d", type: "output" };
  const c = { filename: "m.glb", subfolder: "other", type: "output" };
  assert.equal(mergeModel3dMedia([a], [b]).length, 1);
  assert.equal(mergeModel3dMedia([a], [c]).length, 2, "a different subfolder is a different file");
});

// ---------------------------------------------------------------------------
// 2. The panel call site — the shipped onExecuted, not a helper.
//
// A helper that works is invisible proof: the reported failure was that production
// never CALLED it. This instantiates the real closure out of the shipped bundle.
// ---------------------------------------------------------------------------

const panelSrc = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function productionOnExecuted({ chatMediaSetting = undefined } = {}) {
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
    () => false,
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

test("#2128 the shipped onExecuted tells the tracker about a 3D-only run", () => {
  // Before the fix this returned at `if (!media.length && !audioBag.length && !withheld)`,
  // so the tracker never heard about the run at all.
  const h = productionOnExecuted();
  h.onExecuted({ detail: { prompt_id: "p3d", node: "12", output: SAVE_3D_ADVANCED } });

  assert.equal(h.buffered.length, 1, "the tracker must hear about the run at all");
  assert.deepEqual(h.buffered[0].output.images, [], "a mesh never rides the inline-image list");
  assert.equal(h.buffered[0].output.models3d.length, 1);
  assert.equal(h.buffered[0].output.models3d[0].filename, "PROP_crate_00001.glb");
  assert.equal(h.painted.image.length, 0, "and is never painted as an image (#710)");
});

test("#2128 chat-media OFF still reports the 3D output to the agent", () => {
  const h = productionOnExecuted({ chatMediaSetting: false });
  h.onExecuted({ detail: { prompt_id: "p3d", output: SAVE_GLB } });
  assert.equal(h.buffered[0].output.models3d.length, 1, "the agent is told regardless of #2034");
});

test("#2128 the reported run — previews attach, the mesh is reported beside them", () => {
  const h = productionOnExecuted();
  h.onExecuted({ detail: { prompt_id: "p", node: "9", output: { images: PREVIEW_TAPS } } });
  h.onExecuted({ detail: { prompt_id: "p", node: "12", output: SAVE_3D_ADVANCED } });
  assert.equal(h.buffered.length, 2);
  assert.equal(h.buffered[0].output.images.length, 7, "the taps still reach the agent for vision");
  assert.equal(h.buffered[1].output.models3d.length, 1);
});

// ---------------------------------------------------------------------------
// 3. The tracker — a 3D-only run reaches the flush carrying its refs.
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

test("#2128 a panel-queued 3D-only run flushes ONE completion carrying the mesh", () => {
  const h = makeTracker();
  const P = "bf7873d8-a7b1-4c06-be50-45463604ec2f";
  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { models3d: collectNodeOutputMedia(SAVE_3D_ADVANCED).models3d });
  h.advance(568_000);
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1, "exactly one completion for the prompt");
  assert.equal(h.flushes[0].promptId, P);
  assert.equal(h.flushes[0].models3d?.length, 1, "the refs must survive to the flush");
  assert.equal(h.flushes[0].models3d[0].filename, "PROP_crate_00001.glb");
  assert.deepEqual(h.flushes[0].images, [], "and must not have been smuggled into images");
});

test("#2128 a 3D output alone does not arm the orphan timer", () => {
  // flush() DELETES an images/videos-empty buffer without emitting, so an early
  // orphan flush would destroy the refs before execution_success can report them.
  const h = makeTracker();
  const P = "p-orphan";
  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { models3d: collectNodeOutputMedia(SAVE_GLB).models3d });
  assert.equal(h.flushes.length, 0, "nothing is delivered before the run is terminal");
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes[0].models3d?.length, 1);
});

test("#2128 the reported run reaches one flush with BOTH the taps and the mesh", () => {
  const h = makeTracker();
  const P = "p-reported";
  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: PREVIEW_TAPS });
  h.tracker.onExecuted(P, { models3d: collectNodeOutputMedia(SAVE_3D_ADVANCED).models3d });
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 7);
  assert.equal(h.flushes[0].models3d.length, 1);
});

// ---------------------------------------------------------------------------
// 4. The composer — the reported sentence, verbatim, is gone.
// ---------------------------------------------------------------------------

const frameDeps = (sent) => ({
  sendFrame: (f) => (sent.push(f), true),
  coerceMessageText: (s) => String(s ?? ""),
  formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`,
  formatClock: () => "12:00:00",
  imageViewUrl: (m) => `view://${m?.filename ?? "x"}`,
  agentReceivesImages: () => true,
  warn: () => {},
});

test("#2128 THE REPORTED FRAME — previews plus a .glb no longer claims nothing was saved", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "bf7873d8-a7b1-4c06-be50-45463604ec2f",
      images: PREVIEW_TAPS,
      videos: [],
      models3d: collectNodeOutputMedia(SAVE_3D_ADVANCED).models3d,
      durationMs: 568_000,
    },
    frameDeps(sent),
  );

  // THE REGRESSION, quoted from the issue. Every clause of it was false.
  assert.doesNotMatch(frame.note, /no saved output node ran/);
  assert.doesNotMatch(
    frame.note,
    /Add a SaveImage node to persist the result/,
    "the advice cannot work — the payload is a FILE_3D_GLB, not an image",
  );
  // What it says instead: the previews ARE previews, but a final result was saved.
  assert.match(frame.note, /previews \(temporary, not a final file\)/);
  assert.match(frame.note, /also produced 1 3D model output/);
  assert.match(frame.note, /PROP_crate_00001\.glb/);
  assert.match(frame.note, /Do NOT add a SaveImage node/);
  // Named, never attached — and the 7 taps still go for vision.
  assert.equal(frame.images.length, 7, "the preview taps are still delivered");
  assert.ok(
    frame.images.every((m) => !String(m.filename).endsWith(".glb")),
    "the mesh must never ride the frame as an inline image block (#710)",
  );
  // And it points at the file with arguments that actually address it.
  assert.match(frame.note, /get_image with filename "PROP_crate_00001\.glb"/);
  assert.match(frame.note, /subfolder "3D"/);
});

test("#2128 a 3D-only run is not reported as producing nothing", async () => {
  // The no-taps half of the same hole: this is #2126 with a different extension.
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-3d-only",
      images: [],
      videos: [],
      models3d: collectNodeOutputMedia(SAVE_GLB).models3d,
      durationMs: 4000,
      noMedia: true,
    },
    frameDeps(sent),
  );
  assert.ok(frame, "a frame must be sent — silence is the stall this fixes");
  assert.doesNotMatch(frame.note, /produced no image or video output/);
  assert.doesNotMatch(frame.note, /no output node produced one/);
  assert.match(frame.note, /ComfyUI_00001_\.glb/);
  assert.match(frame.note, /nothing further is coming/, "still terminal");
  assert.deepEqual(frame.images, []);
  assert.equal(frame.metadata[0].outputs, "model_3d");
  assert.equal(frame.metadata[0].reason, "not_viewable");
  assert.deepEqual(frame.metadata[0].files, ["ComfyUI_00001_.glb"]);
});

test("#2128 the note never claims THIS RUN saved the file", async () => {
  // Codex merge-gate P1, round 2. `Preview3D` handed a literal path string passes it
  // through and writes nothing, and the outputs bag cannot tell that apart from a
  // Save3DAdvanced write. So the completion may say the run PRODUCED a 3D output and
  // name it — both true of every shape — but must not assert provenance it cannot
  // have, or the fix reintroduces its own defect class one node over.
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-provenance",
      images: PREVIEW_TAPS,
      videos: [],
      models3d: collectNodeOutputMedia(SAVE_3D_ADVANCED).models3d,
      durationMs: 1000,
    },
    frameDeps(sent),
  );
  assert.doesNotMatch(frame.note, /DID save/i);
  assert.doesNotMatch(frame.note, /run's saved result/i);
  assert.doesNotMatch(frame.note, /saved a final/i);
  // What it still does say — the part that retires the reported claims.
  assert.match(frame.note, /also produced 1 3D model output/);
  assert.match(frame.note, /PROP_crate_00001\.glb/);
  assert.match(frame.note, /Do NOT add a SaveImage node/);
});

test("#2128 a genuinely preview-only run keeps the original advice", async () => {
  // The narrowing must not become a blanket suppression: a run that really saved
  // nothing is still told to add a SaveImage node. This is the branch the issue
  // says a local edit could only have broken.
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p-previews", images: PREVIEW_TAPS, videos: [], durationMs: 1000 },
    frameDeps(sent),
  );
  assert.match(frame.note, /no saved output node ran/);
  assert.match(frame.note, /Add a SaveImage node to persist the result/);
});

test("#2128 a genuinely empty run still gets the media-less report", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p-empty", images: [], videos: [], models3d: [], durationMs: 500, noMedia: true },
    frameDeps(sent),
  );
  assert.match(frame.note, /produced no image or video output/);
  assert.equal(frame.metadata[0].reason, "no_media");
});

test("#2128 a SaveImage final plus a mesh keeps the FINAL-output wording", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-both",
      images: [{ filename: "render.png", subfolder: "", type: "output" }],
      videos: [],
      models3d: collectNodeOutputMedia(SAVE_GLB).models3d,
      durationMs: 2000,
    },
    frameDeps(sent),
  );
  assert.match(frame.note, /FINAL output: render\.png/);
  assert.match(frame.note, /Also produced 1 3D model output/);
  assert.equal(frame.images.length, 1);
});

test("#2128 the SIBLING defect — audio plus preview taps stopped claiming nothing ran", async () => {
  // #2126 gave audio its own channel but only covered the media-less path. With
  // PreviewImage taps upstream a SaveAudio run still produced the reported sentence,
  // because buildStillsSegment inferred it from the image set alone.
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-audio-taps",
      images: PREVIEW_TAPS,
      videos: [],
      audio: [{ filename: "ComfyUI_00007_.flac", subfolder: "", type: "output" }],
      durationMs: 3000,
    },
    frameDeps(sent),
  );
  assert.doesNotMatch(frame.note, /no saved output node ran/);
  assert.match(frame.note, /also produced 1 audio output/);
});

test("#2128 a run saving BOTH a mesh and audio names both kinds", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-both-kinds",
      images: PREVIEW_TAPS,
      videos: [],
      audio: [{ filename: "amb.flac", subfolder: "", type: "output" }],
      models3d: [{ filename: "m.glb", subfolder: "", type: "output" }],
      durationMs: 1000,
    },
    frameDeps(sent),
  );
  assert.match(frame.note, /1 3D model output and 1 audio output/);
});

test("#2128 the 3D note names a bounded number of files and points at get_history", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    filename: `part_${i}.glb`,
    subfolder: "3d",
    type: "output",
  }));
  const note = formatModel3dMediaNote({ models3d: many, promptId: "p9" });
  assert.match(note, /produced 9 3D model outputs/);
  assert.match(note, /and 3 more/, "the tail is summarised, not spelled out");
  assert.match(note, /get_history for prompt p9/);
  assert.match(note, /do not describe its shape/, "#710 — the agent has not seen it");
  assert.equal(formatModel3dMediaNote({ models3d: [] }), null);
});

test("#2128 the fetch advice names the root it assumes, and the retry", () => {
  // Codex merge-gate P1, round 3. A `result` ref's `type` is INFERRED (every node that
  // produces the save-counter naming writes to output/), not read off the bag — and a
  // `Preview3D` passthrough of an input-rooted path is the shape that inference is
  // wrong for. Presenting the get_image arguments as certain would make the completion
  // point at nothing; naming the assumed root plus the one retry keeps it recoverable.
  const note = formatModel3dMediaNote({
    models3d: [{ filename: "PROP_crate_00001.glb", subfolder: "3D", type: "output" }],
    promptId: "p1",
  });
  assert.match(note, /assume ComfyUI's output directory/);
  assert.match(note, /retry with type "input"/);
});

// ---------------------------------------------------------------------------
// 5. Recovery — a completion rebuilt from /history is honest too.
// ---------------------------------------------------------------------------

test("#2128 parseHistoryEntry returns 3D on its own channel, never as an image", () => {
  const parsed = parseHistoryEntry({
    status: { status_str: "success", completed: true, messages: [] },
    outputs: { 12: SAVE_3D_ADVANCED, 9: { images: PREVIEW_TAPS } },
  });
  assert.equal(parsed.terminal, true);
  assert.equal(parsed.models3d.length, 1);
  assert.equal(parsed.models3d[0].filename, "PROP_crate_00001.glb");
  assert.equal(parsed.images.length, 7, "the taps come back as images");
  assert.ok(
    parsed.images.every((m) => !String(m.filename).endsWith(".glb")),
    "a recovered mesh must not reach the agent as an inline image",
  );
});

test("#2128 one prompt naming the same file from two nodes reports it once", () => {
  // Both bags normalise to the identical /view identity, so the merge must collapse
  // them. Guarded against going vacuous: each bag ALONE yields one ref, and a
  // genuinely different file yields two — so a `1` here is the merge, not an
  // admission rule quietly rejecting one side.
  const glbKey = { "3d": [{ filename: "PROP_crate_00001.glb", subfolder: "3D", type: "output" }] };
  const resultKey = { result: ["3D/PROP_crate_00001.glb"] };
  assert.equal(collectNodeOutputMedia(glbKey).models3d.length, 1, "the 3d bag alone admits one");
  assert.equal(collectNodeOutputMedia(resultKey).models3d.length, 1, "the result bag alone admits one");

  const status = { status_str: "success", messages: [] };
  const same = parseHistoryEntry({ status, outputs: { 1: glbKey, 2: resultKey } });
  assert.equal(same.models3d.length, 1, "merged on the /view identity");

  const different = parseHistoryEntry({
    status,
    outputs: { 1: glbKey, 2: { result: ["3D/PROP_crate_00002.glb"] } },
  });
  assert.equal(different.models3d.length, 2, "two distinct files stay two");
});

test("#2128 a reconciled panel-queued 3D run carries its refs to the flush", async () => {
  // A run whose terminal WS event was missed is replayed from /history. `fetchHistory`
  // resolves to the ENTRY itself, as the tracker's other reconcile tests do — the
  // /history map lookup happens in the caller, not here.
  const h = makeTracker();
  h.tracker.onQueued("p-recon");
  await h.tracker.reconcile({
    fetchHistory: async () => ({
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { 12: SAVE_3D_ADVANCED },
    }),
    fetchQueued: async () => false,
    isVideo: () => false,
  });
  assert.equal(h.flushes.length, 1, "the /history safety net must recover a 3D run");
  assert.equal(h.flushes[0].models3d?.length, 1, "and it carries the mesh");
  assert.equal(h.flushes[0].models3d[0].filename, "PROP_crate_00001.glb");
  assert.deepEqual(h.flushes[0].images, []);
});

// ---------------------------------------------------------------------------
// 6. The delivery handler — the frame that actually reaches the transport.
//
// Sections 3 and 4 exercise the tracker and the composer separately, and both would
// still pass if createRunCompletionFlushHandler dropped `models3d` between them.
// ---------------------------------------------------------------------------

async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("#2128 the frame that reaches the transport names the mesh", async () => {
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
    uploadBlobToInput: async (_b, name, opts) => ({ filename: name, type: opts?.type || "input" }),
    storyboardFrameCount: () => 20,
    paintImage: () => {},
    applyVideoPoster: () => {},
    videoStoryboardEnabled: false,
    agentReceivesImages: () => true,
    isAgentMuted: () => false,
    warn: () => {},
  });
  tracker = createRunCompletionTracker({ onFlush, setTimer: () => 0, clearTimer: () => {} });

  const P = "prompt-wired-3d";
  tracker.onQueued(P);
  tracker.onExecutionStart(P);
  tracker.onExecuted(P, { images: PREVIEW_TAPS });
  tracker.onExecuted(P, { models3d: collectNodeOutputMedia(SAVE_3D_ADVANCED).models3d });
  tracker.onExecutionSuccess(P);
  await settle();

  assert.equal(sent.length, 1, "one completion frame reaches the transport");
  assert.match(sent[0].note, /PROP_crate_00001\.glb/, "the mesh must survive the delivery handler");
  assert.doesNotMatch(sent[0].note, /no saved output node ran/);
});

// ---------------------------------------------------------------------------
// 7. The lifecycle paths #2126's merge gate found — 3D re-enters through each.
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

test("#2128 queue-idle before execution_success must not destroy the 3D refs", () => {
  // The run's execution_start and executing(node) frames were dropped, so the prompt
  // is not `active` and onExecutingNull sweeps it. flush() of an images/videos-empty
  // batch emits nothing and DELETES the buffer — which is where onExecutionSuccess
  // reads the mesh from.
  const flushes = [];
  const tracker = makeTimerTracker((p) => flushes.push(p));
  const P = "P-idle-3d";
  tracker.onQueued(P);
  tracker.onExecuted(P, { models3d: collectNodeOutputMedia(SAVE_GLB).models3d });
  tracker.onExecutingNull();
  tracker.onExecutionSuccess(P);

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].models3d?.length, 1, "queue-idle must not have thrown the mesh away");
  assert.notEqual(flushes[0].noMedia && !flushes[0].models3d, true);
});

test("#2128 a held completion's persistence round-trip keeps the 3D refs", () => {
  const first = makeTimerTracker(() => {});
  const dispatchToken = first.beginPanelRun();
  const P = "P-held-3d";
  first.onExecutionStart(P);
  first.onExecuted(P, {
    images: [{ filename: "held.png", type: "output" }],
    models3d: collectNodeOutputMedia(SAVE_GLB).models3d,
  });
  first.onExecutionSuccess(P);
  first._fireTimers(30000);

  const state = first.terminalCompletionMetadata();
  assert.equal(state.length, 1);
  assert.equal(state[0].payload.models3d?.length, 1, "the snapshot must carry the mesh");
  first.dispose();

  const replayed = [];
  const fresh = makeTimerTracker((payload) => replayed.push(payload));
  assert.equal(fresh.restoreTerminalCompletion(state[0]), true);
  fresh.onQueued(P, { routeId: "r", sessionId: "s", dispatchToken });
  assert.equal(replayed.length, 1, "the delayed prompt binds and replays after a reload");
  assert.equal(replayed[0].models3d?.length, 1, "and the replay still names the mesh");
});

test("#2128 a persisted record from a build without models3d restores unchanged", () => {
  const fresh = makeTimerTracker();
  assert.equal(
    fresh.restoreTerminalCompletion({
      promptId: "P-legacy-3d",
      payload: {
        promptId: "P-legacy-3d",
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
  assert.equal("models3d" in restored, false, "no models3d key is invented on restore");
});
