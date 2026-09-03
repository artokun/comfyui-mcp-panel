/**
 * #1934 — a node's ComfyUI outputs bag is not only `images` / `gifs` / `videos`.
 *
 * CompareFrames writes hundreds of temp PNGs under `a_images` / `b_images`. The
 * completion path used to read three literal keys, find nothing, and tell the
 * agent the run produced no media. Folding those bags into the completion frame
 * is the other lie: the frame is one turn with a per-still budget, so 768 temps
 * would either blow it or be truncated to a handful that looks complete.
 *
 * The honest split is deliverable vs withheld. Standard keys still attach.
 * Other `*images` / `*gifs` / `*videos` bags whose entries look like ComfyUI
 * media descriptors are counted and named, and none of them ride the frame.
 */

const STANDARD_MEDIA_KEYS = ["images", "gifs", "videos"];
const STANDARD_MEDIA_KEY_SET = new Set(STANDARD_MEDIA_KEYS);
const MEDIA_KEY_SUFFIX = /(?:images|gifs|videos)$/;
// Same extension list the panel's `isVideoOutput` uses when `format` is absent.
// Kept here so collectNodeOutputMedia can admit a custom-key saved video without
// importing the panel bundle, and so the two cannot drift on the NKD recurrence.
const VIDEO_FILENAME = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

/**
 * #2126 — ComfyUI's own AUDIO bag, and a THIRD outcome next to deliverable and
 * withheld.
 *
 * `SaveAudio` / `SaveAudioMP3` / `SaveAudioOpus` / `SaveAudioAdvanced` and
 * `PreviewAudio` all serialise through `SavedAudios.as_dict()` /
 * `PreviewAudio.as_dict()` in `comfy_api/latest/_ui.py`, both of which return
 * `{ audio: [ {filename, subfolder, type} ] }`. One key covers every core audio
 * output node, and its entries are the same `/view` descriptors as the rest.
 *
 * It is NOT folded into `deliverable`, deliberately. `deliverable` is what rides
 * the completion frame as inline image blocks; an audio file handed over as an
 * inline IMAGE is a broken picture plus a claim of a perception nobody had —
 * the #710 defect. It is not folded into `withheld` either, because that note
 * says the outputs "exceed the completion frame's media budget", which is not
 * why audio is held back. Audio has its own reason, so it gets its own channel
 * and its own note.
 */
const AUDIO_MEDIA_KEY = "audio";

// How many filenames one audio note spells out before it summarises the rest.
// A batched SaveAudio can emit one file per waveform in the batch.
const AUDIO_NOTE_NAME_LIMIT = 6;

/**
 * #2128 — ComfyUI's 3D outputs, which arrive in TWO unrelated shapes.
 *
 * 1. `SaveGLB` (`comfy_extras/nodes_save_3d.py`) returns
 *    `ui={"3d": [{filename, subfolder, type:"output"}]}` — ordinary `/view`
 *    descriptors, just under a key nothing read.
 *
 * 2. `Save3DAdvanced`, `SaveGaussianSplat` and `SavePointCloud` all delegate to
 *    `execute_save_3d_advanced`, which serialises through
 *    `UI.PreviewUI3DAdvanced.as_dict()` (`comfy_api/latest/_ui.py`) and returns
 *    `{"result": [model_file, camera_info, model_3d_info]}` — where `model_file`
 *    is a bare PATH STRING (`"3D/PROP_crate_00001.glb"`), not a descriptor.
 *    `Preview3D` / `Preview3DAdvanced` use the sibling `PreviewUI3D.as_dict()`,
 *    the same `{"result": [...]}` shape.
 *
 * Neither key matches the three literal media keys nor the widened
 * `/(?:images|gifs|videos)$/` scan, so a 16 MB `.glb` was invisible to the whole
 * completion path — the #2128 defect, and the #2126 defect with a different file
 * extension.
 *
 * `result` is a GENERIC key, so admission is deliberately narrow: a STRING entry
 * whose extension is a 3D model format. The camera dict and the model-info list
 * that sit beside `model_file` are not strings; `PreviewUI3D`'s third element IS
 * a string (`"temp/bg_<hex>.png"`) and is excluded by the same extension test.
 *
 * Held back from `deliverable` for the #710 reason audio is: a mesh handed to the
 * agent as an inline image block is a broken picture plus a claim of a perception
 * nobody had.
 */
const MODEL_3D_MEDIA_KEY = "3d";
const MODEL_3D_RESULT_KEY = "result";

/**
 * Extensions admitted from a bare `result` path string.
 *
 * Exactly the formats the three Save-3D nodes accept on their `model_3d` socket
 * (`IO.File3DGLB/GLTF/FBX/OBJ/STL/USDZ`, `File3DPLY/SPLAT/SPZ/KSPLAT`), which is
 * what `_save_file3d_to_output` then names the file with (`model_3d.format`).
 *
 * NOT the same list as `input-asset.js`'s `file_upload` set, and the difference is
 * intentional rather than an oversight: that set gates what the panel may put INTO
 * a `Load3D` combo, so it tracks ComfyUI's own input LISTING and deliberately omits
 * `usdz`. This set reads what ComfyUI reported it just WROTE, and `Save3DAdvanced`
 * declares `IO.File3DUSDZ` on its input, so a `.usdz` output is producible and must
 * be reported.
 *
 * A `File3DAny` carrying some format outside this list is under-reported, which
 * degrades to today's behaviour. That direction is chosen on purpose: a missed 3D
 * output is the status quo, whereas a false positive would invent an output node.
 */
const MODEL_3D_EXTENSIONS = new Set([
  "glb", "gltf", "obj", "fbx", "stl", "usdz", "ply", "splat", "spz", "ksplat",
]);

// How many filenames one 3D note spells out before it summarises the rest.
const MODEL_3D_NOTE_NAME_LIMIT = 6;

/**
 * A SAVED 3D output's filename, as `get_save_image_path` names it.
 *
 * `_save_file3d_to_output` builds `f"{filename}_{counter:05}.{ext}"`, so a genuinely
 * saved file ALWAYS ends in an underscore, at least five digits, and the extension.
 * That is the whole discriminator, and it has to exist because the `result` bag is
 * shared by nodes that save and nodes that only preview:
 *
 *   Save3DAdvanced / SaveGaussianSplat / SavePointCloud
 *     → `PROP_crate_00001.glb`, in output/           ← a real saved result
 *   Preview3DAdvanced      → `preview3d_advanced_<32 hex>.glb`, in TEMP/
 *   PreviewGaussianSplat   → `preview_splat_<32 hex>.ply`,      in TEMP/
 *   PreviewPointCloud      → `preview_pointcloud_<32 hex>.ply`, in TEMP/
 *   Preview3D              → `preview3d_<32 hex>.glb` in output/, or, when handed a
 *                            literal path string, that string passed through unchanged
 *
 * Reporting any of those five as the run's saved result would be the very defect this
 * change exists to remove, one node over: `Preview3DAdvanced` is documented as
 * previewing "without saving it to the ComfyUI output directory", its file is swept
 * with temp/, and a `/view?type=output` for it 404s. A 32-hex uuid cannot end in
 * `_<5+ digits>.<ext>` (the hex is one unbroken run with no underscore), and a
 * user-supplied passthrough path does not carry a save counter either, so all five are
 * excluded by the same test — and a saved output can never be missed by it, because
 * ComfyUI has no other way to name one.
 *
 * `type` is then `"output"` unconditionally, which is now sound rather than a
 * near-certainty: every node that produces this naming writes to
 * `folder_paths.get_output_directory()`.
 *
 * Splits on BOTH separators. `get_save_image_path` derives the subfolder with
 * `os.path.dirname(os.path.normpath(prefix))`, and on Windows `normpath` rewrites `/`
 * to `\` — so a nested prefix like `3D/props/PROP` yields `"3D\\props"`, which the node
 * then joins to the filename with a forward slash. One emitted string can carry both.
 */
const SAVED_3D_FILENAME = /_\d{5,}\.[A-Za-z0-9]+$/;

function model3dRefFromResultEntry(entry) {
  if (typeof entry !== "string") return null;
  const path = entry.trim();
  if (!path) return null;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const filename = segments.pop();
  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  if (!MODEL_3D_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase())) return null;
  if (!SAVED_3D_FILENAME.test(filename)) return null;
  // `typeInferred` marks this ref as one whose ROOT was reasoned about rather than read.
  // The note uses it to decide what fetch advice it is entitled to give: a `3d`-key
  // descriptor states its own `type`, so get_image arguments built from it are facts;
  // these are a conclusion, and a `Preview3D` passthrough of an input-rooted path is the
  // shape the conclusion is wrong for. Spelling out arguments that embed the guess could
  // silently fetch a DIFFERENT, same-named file under output/, so those refs are pointed
  // at the run's history entry — which carries the reference verbatim — instead.
  return { filename, subfolder: segments.join("/"), type: "output", typeInferred: true };
}

/**
 * A ComfyUI /view descriptor: `{ filename, type, subfolder }`.
 *
 * Required for WIDENED keys so an arbitrary array on a node's UI result cannot
 * be mistaken for media. `subfolder` may be omitted (ComfyUI often drops the
 * empty string); if present it must be a string.
 */
export function isMediaDescriptor(entry) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.filename !== "string" || !entry.filename) return false;
  if (typeof entry.type !== "string") return false;
  if (entry.subfolder != null && typeof entry.subfolder !== "string") return false;
  return true;
}

/**
 * A ComfyUI `/view` descriptor that is a VIDEO rather than a still.
 *
 * Mirrors the panel's `isVideoOutput`: honour `format` first (`video/*` vs
 * `image/*`, so an animated gif stays an image), then fall back to the
 * filename extension. Used to lift a saved MP4 off an unrecognised key
 * (NKDVideoViewer's `nkd_video`) onto the existing video path (#2128).
 */
export function isVideoMediaDescriptor(entry) {
  if (!isMediaDescriptor(entry)) return false;
  const fmt = String(entry.format || "").toLowerCase();
  if (fmt.startsWith("video/")) return true;
  if (fmt.startsWith("image/")) return false;
  return VIDEO_FILENAME.test(entry.filename);
}

/**
 * Split one node's `executed` / `/history` outputs bag.
 *
 * `deliverable` is the existing three-key harvest (filename present is enough,
 * matching the live path). `audio` is ComfyUI's `audio` bag, harvested with the
 * SAME laxness and kept separate (#2126) — played in chat, named on the
 * completion frame, never attached to it. `models3d` is the same arrangement for
 * ComfyUI's two 3D output shapes (#2128). `withheld` is the count/keys/types of
 * every other matching bag — never a copy of the refs, so a 768-image dump
 * cannot leak onto the completion frame by accident.
 *
 * @param {object|null|undefined} out
 * @returns {{ deliverable: object[], audio: object[], models3d: object[], withheld: ({ count: number, keys: string[], types: string[] }|null) }}
 */
export function collectNodeOutputMedia(out) {
  const deliverable = [];
  const audio = [];
  const models3d = [];
  if (out == null || typeof out !== "object" || Array.isArray(out)) {
    return { deliverable, audio, models3d, withheld: null };
  }

  for (const key of STANDARD_MEDIA_KEYS) {
    const bag = out[key];
    if (!Array.isArray(bag)) continue;
    for (const m of bag) {
      if (!m || !m.filename) continue;
      deliverable.push(m);
    }
  }

  // Same admission test as `deliverable` above — a filename is enough. A stricter
  // `isMediaDescriptor` here would silently drop a real SaveAudio result from a
  // build that omits `type`, and dropping it is exactly the reported defect.
  if (Array.isArray(out[AUDIO_MEDIA_KEY])) {
    for (const m of out[AUDIO_MEDIA_KEY]) {
      if (!m || !m.filename) continue;
      audio.push(m);
    }
  }

  // #2128 — SaveGLB's descriptors. Same laxness as `deliverable` and `audio`: a
  // filename is enough, so a build that omits `type` is still reported.
  if (Array.isArray(out[MODEL_3D_MEDIA_KEY])) {
    for (const m of out[MODEL_3D_MEDIA_KEY]) {
      if (!m || !m.filename) continue;
      models3d.push(m);
    }
  }

  // #2128 — Save3DAdvanced / SaveGaussianSplat / SavePointCloud / Preview3D*,
  // whose `model_file` is a bare path STRING sharing an array with a camera dict
  // and a model-info list. Only 3D-extension strings are admitted, so the
  // siblings — and PreviewUI3D's `"temp/bg_<hex>.png"` — are passed over.
  if (Array.isArray(out[MODEL_3D_RESULT_KEY])) {
    for (const entry of out[MODEL_3D_RESULT_KEY]) {
      const ref = model3dRefFromResultEntry(entry);
      if (ref) models3d.push(ref);
    }
  }

  const keys = [];
  const types = [];
  let count = 0;
  let outputCount = 0;
  for (const [key, bag] of Object.entries(out)) {
    // Every key harvested above onto its own channel, so a single output cannot be
    // reported once as content and again as withheld. Only the standard three can
    // actually reach this test today — `audio`, `3d` and `result` do not match
    // MEDIA_KEY_SUFFIX — so those three are a guard against a future widening of
    // that regex, not live filtering.
    if (STANDARD_MEDIA_KEY_SET.has(key)) continue;
    if (key === AUDIO_MEDIA_KEY || key === MODEL_3D_MEDIA_KEY || key === MODEL_3D_RESULT_KEY) {
      continue;
    }
    if (!Array.isArray(bag)) continue;
    const suffixKey = MEDIA_KEY_SUFFIX.test(key);
    let keyCount = 0;
    for (const m of bag) {
      if (!isMediaDescriptor(m)) continue;
      // #2128 recurrence — NKDVideoViewer (and similar custom save nodes) put a
      // real `{filename, subfolder, type:"output"}` descriptor under a key that
      // does not end in images/gifs/videos (`nkd_video`). The suffix scan missed
      // it, so a saved MP4 was invisible and the completion claimed no saved
      // output node ran. Saved videos on those keys join `deliverable` so the
      // existing storyboard path names them. Temps on unknown keys stay ignored
      // so a random bag cannot invent a CompareFrames-scale dump. Other saved
      // descriptors on unknown keys are counted as withheld so the stills note
      // can see that a saved output ran without attaching unknown media.
      if (!suffixKey) {
        if (m.type === "output" && isVideoMediaDescriptor(m)) {
          deliverable.push(m);
          continue;
        }
        if (m.type !== "output") continue;
      }
      keyCount += 1;
      if (m.type === "output") outputCount += 1;
      if (m.type && !types.includes(m.type)) types.push(m.type);
    }
    if (keyCount) {
      keys.push(key);
      count += keyCount;
    }
  }

  return {
    deliverable,
    audio,
    models3d,
    withheld: count ? { count, keys, types, ...(outputCount > 0 ? { outputCount } : {}) } : null,
  };
}

/**
 * Combine the audio refs of several nodes of the same prompt, de-duplicated on
 * the `/view` identity so a replayed `executed` cannot announce one file twice.
 *
 * @param {object[]|null|undefined} a
 * @param {object[]|null|undefined} b
 * @returns {object[]}
 */
export function mergeAudioMedia(a, b) {
  return mergeMediaRefs(a, b);
}

/**
 * #2128 — the 3D twin of `mergeAudioMedia`, and it matters more here: a single
 * Save3DAdvanced emits its `result` bag on `executed` AND again in `/history`, and
 * a `SaveGLB` + `Save3DAdvanced` pair on one prompt merges across two nodes.
 *
 * @param {object[]|null|undefined} a
 * @param {object[]|null|undefined} b
 * @returns {object[]}
 */
export function mergeModel3dMedia(a, b) {
  return mergeMediaRefs(a, b);
}

// De-duplicate on the `/view` identity — the tuple that decides which file the
// server hands back. Shared so the audio and 3D channels cannot drift apart.
function mergeMediaRefs(a, b) {
  const seen = new Set();
  const out = [];
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || !m.filename) continue;
      const id = `${m.type ?? ""}|${m.subfolder ?? ""}|${m.filename}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(m);
    }
  }
  return out;
}

/**
 * Combine withheld summaries from several nodes of the same prompt.
 *
 * @param {({ count: number, keys: string[], types: string[] }|null|undefined)} a
 * @param {({ count: number, keys: string[], types: string[] }|null|undefined)} b
 */
export function mergeWithheldMedia(a, b) {
  const left = a?.count > 0 ? a : null;
  const right = b?.count > 0 ? b : null;
  if (!left) return right ? cloneWithheld(right) : null;
  if (!right) return cloneWithheld(left);
  const keys = [...left.keys];
  for (const key of right.keys) if (!keys.includes(key)) keys.push(key);
  const types = [...left.types];
  for (const type of right.types) if (!types.includes(type)) types.push(type);
  const outputCount = (left.outputCount ?? 0) + (right.outputCount ?? 0);
  return {
    count: left.count + right.count,
    keys,
    types,
    ...(outputCount > 0 ? { outputCount } : {}),
  };
}

function cloneWithheld(summary) {
  return {
    count: summary.count,
    keys: [...summary.keys],
    types: [...summary.types],
    ...(summary.outputCount > 0 ? { outputCount: summary.outputCount } : {}),
  };
}

function formatKeyList(keys) {
  const quoted = keys.map((key) => `\`${key}\``);
  if (!quoted.length) return "unrecognised media keys";
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

/**
 * Agent-facing note for withheld media. Count and name them; attach none.
 *
 * @param {object} opts
 * @param {{ count: number, keys: string[], types: string[] }} opts.withheld
 * @param {string|null} [opts.promptId]
 * @param {string} [opts.durationSuffix]  e.g. ` in 3.0s` (leading space included)
 * @param {boolean} [opts.attached]  true when standard stills/videos already ride the frame
 */
export function formatWithheldMediaNote({
  withheld,
  promptId = null,
  durationSuffix = "",
  attached = false,
} = {}) {
  const count = withheld?.count ?? 0;
  const keys = Array.isArray(withheld?.keys) ? withheld.keys : [];
  const types = Array.isArray(withheld?.types) ? withheld.types.filter(Boolean) : [];
  const typeSuffix = types.length ? ` (${types.join(", ")})` : "";
  const outputWord = count === 1 ? "output" : "outputs";
  const promptClause =
    promptId != null && String(promptId) !== ""
      ? `get_history for prompt ${promptId}`
      : "get_history";
  if (attached) {
    return (
      `Also produced ${count} ${outputWord} across ${formatKeyList(keys)}${typeSuffix}. ` +
      `Those were not attached — they exceed the completion frame's media budget. ` +
      `Read them with ${promptClause}, or fetch individually with get_image.`
    );
  }
  return (
    `The run you queued finished successfully${durationSuffix} and produced ${count} ` +
    `${outputWord} across ${formatKeyList(keys)}${typeSuffix}. None were attached — ` +
    `this run exceeds the completion frame's media budget. Read them with ${promptClause}, ` +
    `or fetch individually with get_image. This IS the completion you were told to wait ` +
    `for — nothing further is coming, so do not keep waiting for media.`
  );
}

/**
 * Agent-facing note for a run's AUDIO outputs. Name them; attach none.
 *
 * The note deliberately claims NOTHING about the chat. Whether a player was
 * painted depends on the chat-media setting (#2034) and on which surface this
 * completion came from — a /history reconcile paints nothing at all — so a flat
 * "its player is in the chat" would be false on paths this same note serves.
 * What IS true everywhere: the file exists, the agent was not sent it, and
 * get_image is how a local tool gets at it.
 *
 * @param {object} opts
 * @param {object[]} opts.audio  ComfyUI `/view` descriptors from the `audio` bag.
 * @param {string|null} [opts.promptId]
 * @param {string} [opts.durationSuffix]  e.g. ` in 3.0s` (leading space included)
 * @param {boolean} [opts.attached]  true when stills/videos already ride the frame
 * @returns {string|null}  null when there is no audio to report.
 */
export function formatAudioMediaNote({
  audio,
  promptId = null,
  durationSuffix = "",
  attached = false,
} = {}) {
  const files = (Array.isArray(audio) ? audio : []).filter((m) => m && m.filename);
  const count = files.length;
  if (!count) return null;
  const outputWord = count === 1 ? "output" : "outputs";
  const shown = files.slice(0, AUDIO_NOTE_NAME_LIMIT);
  const named = shown.map((m) => `\`${String(m.filename)}\``).join(", ");
  const rest = count - shown.length;
  const more = rest > 0 ? `, and ${rest} more` : "";
  const lead = attached
    ? `Also produced ${count} audio ${outputWord}: ${named}${more}.`
    : `The run you queued finished successfully${durationSuffix} and produced ${count} audio ` +
      `${outputWord}: ${named}${more}.`;
  const promptClause =
    promptId != null && String(promptId) !== ""
      ? `get_history for prompt ${promptId}`
      : "get_history";
  const restClause = rest > 0 ? ` The rest are listed in ${promptClause}.` : "";
  // Same remedy the panel_show_media audio disclosure gives (#710/#648): audio is
  // saved to disk, so what get_image hands back is a path, not a perception.
  const fetchClause =
    ` To get ${count === 1 ? "the file itself" : "the first of them"}, call get_image with ` +
    `${getImageRefClause(shown[0])} — audio is SAVED TO DISK rather than returned to you inline, ` +
    `so what you get is a path a local tool can open (you still cannot hear it).`;
  const tail = attached
    ? ""
    : ` This IS the completion you were told to wait for — nothing further is coming, so do not ` +
      `keep waiting for media.`;
  return (
    `\u{1F50A} ${lead} Audio is NOT attached to this frame and there is no way for you to hear it, ` +
    `so do not describe how it sounds, how long it is, or what is said in it.` +
    fetchClause +
    restClause +
    tail
  );
}

// A get_image argument list for one audio descriptor, matching the wording the
// panel_show_media disclosure uses so both surfaces ask for the file the same way.
function getImageRefClause(ref) {
  const parts = [
    `filename "${String(ref?.filename ?? "")}"`,
    `type "${String(ref?.type || "output")}"`,
  ];
  const subfolder = ref?.subfolder == null ? "" : String(ref.subfolder);
  if (subfolder) parts.push(`subfolder "${subfolder}"`);
  return parts.join(", ");
}

/**
 * Agent-facing note for a run's 3D MODEL outputs (#2128). Name them; attach none.
 *
 * Retires the three claims the reported message made, and asserts nothing beyond
 * them: an output node DID run, it produced a file that is named here, and a
 * `SaveImage` node could not have persisted it because the payload is a mesh.
 *
 * It does NOT say the file was saved BY THIS RUN. `Preview3D` handed a literal path
 * passes it through without writing anything, and the outputs bag cannot tell that
 * apart from a `Save3DAdvanced` write — so a provenance claim would be a new false
 * statement of exactly the class this note exists to remove.
 *
 * Like the audio note it claims nothing about the chat — a `/history` reconcile
 * paints no card at all — and it states plainly that the agent has not seen the
 * geometry, because a 3D file reaches it as neither pixels nor text. That last
 * sentence is the #710 guard: named, but not perceived.
 *
 * @param {object} opts
 * @param {object[]} opts.models3d  `/view` descriptors from the `3d` / `result` bags.
 * @param {string|null} [opts.promptId]
 * @param {string} [opts.durationSuffix]  e.g. ` in 3.0s` (leading space included)
 * @param {boolean} [opts.attached]  true when stills/videos already ride the frame
 * @returns {string|null}  null when there is no 3D output to report.
 */
export function formatModel3dMediaNote({
  models3d,
  promptId = null,
  durationSuffix = "",
  attached = false,
} = {}) {
  const files = (Array.isArray(models3d) ? models3d : []).filter((m) => m && m.filename);
  const count = files.length;
  if (!count) return null;
  const outputWord = count === 1 ? "output" : "outputs";
  const shown = files.slice(0, MODEL_3D_NOTE_NAME_LIMIT);
  const named = shown.map((m) => `\`${String(m.filename)}\``).join(", ");
  const rest = count - shown.length;
  const more = rest > 0 ? `, and ${rest} more` : "";
  const lead = attached
    ? `Also produced ${count} 3D model ${outputWord}: ${named}${more}.`
    : `The run you queued finished successfully${durationSuffix} and produced ${count} 3D ` +
      `model ${outputWord}: ${named}${more}.`;
  const promptClause =
    promptId != null && String(promptId) !== ""
      ? `get_history for prompt ${promptId}`
      : "get_history";
  const restClause = rest > 0 ? ` The rest are listed in ${promptClause}.` : "";
  // The advice each ref is ENTITLED to give, decided by the evidence it carries.
  //
  // A `3d`-key descriptor (SaveGLB) states its own `type`, so get_image arguments built
  // from it are facts. A `result`-derived ref's root was concluded, not read, and the
  // shape that conclusion is wrong for — a `Preview3D` passthrough of an input-rooted
  // path — would not merely 404: a same-named file under output/ would be fetched
  // INSTEAD, silently handing over the wrong mesh. So those are pointed at the run's
  // history entry, which carries ComfyUI's own reference verbatim, and no guessed
  // argument list is put in the agent's hands at all.
  const inferred = files.some((m) => m && m.typeInferred);
  const fetchClause = inferred
    ? ` A 3D model is SAVED TO DISK rather than returned to you inline, so what you can get is a ` +
      `path a local tool can open. Read the exact file reference from ${promptClause} and fetch ` +
      `it with get_image — do not assume the directory from the name above, because a node that ` +
      `only PREVIEWED a model reports it the same way one that saved it does.`
    : ` To get ${count === 1 ? "the file itself" : "the first of them"}, call get_image with ` +
      `${getImageRefClause(shown[0])} — a 3D model is SAVED TO DISK rather than returned to you ` +
      `inline, so what you get is a path a local tool can open.`;
  const tail = attached
    ? ""
    : ` This IS the completion you were told to wait for — nothing further is coming, so do not ` +
      `keep waiting for media.`;
  return (
    `\u{1F9CA} ${lead} The model is NOT attached to this frame ` +
    `and you have not seen it, so do not describe its shape, topology, materials or quality. ` +
    `Adding a SaveImage node would NOT persist it — the payload is a mesh, not an image.` +
    fetchClause +
    restClause +
    tail
  );
}
