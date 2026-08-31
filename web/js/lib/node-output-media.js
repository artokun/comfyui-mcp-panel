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
 * Split one node's `executed` / `/history` outputs bag.
 *
 * `deliverable` is the existing three-key harvest (filename present is enough,
 * matching the live path). `audio` is ComfyUI's `audio` bag, harvested with the
 * SAME laxness and kept separate (#2126) — played in chat, named on the
 * completion frame, never attached to it. `withheld` is the count/keys/types of
 * every other matching bag — never a copy of the refs, so a 768-image dump
 * cannot leak onto the completion frame by accident.
 *
 * @param {object|null|undefined} out
 * @returns {{ deliverable: object[], audio: object[], withheld: ({ count: number, keys: string[], types: string[] }|null) }}
 */
export function collectNodeOutputMedia(out) {
  const deliverable = [];
  const audio = [];
  if (out == null || typeof out !== "object" || Array.isArray(out)) {
    return { deliverable, audio, withheld: null };
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

  const keys = [];
  const types = [];
  let count = 0;
  for (const [key, bag] of Object.entries(out)) {
    if (STANDARD_MEDIA_KEY_SET.has(key) || key === AUDIO_MEDIA_KEY) continue;
    if (!Array.isArray(bag) || !MEDIA_KEY_SUFFIX.test(key)) continue;
    let keyCount = 0;
    for (const m of bag) {
      if (!isMediaDescriptor(m)) continue;
      keyCount += 1;
      if (m.type && !types.includes(m.type)) types.push(m.type);
    }
    if (keyCount) {
      keys.push(key);
      count += keyCount;
    }
  }

  return { deliverable, audio, withheld: count ? { count, keys, types } : null };
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
  return { count: left.count + right.count, keys, types };
}

function cloneWithheld(summary) {
  return { count: summary.count, keys: [...summary.keys], types: [...summary.types] };
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
    `${audioRefClause(shown[0])} — audio is SAVED TO DISK rather than returned to you inline, ` +
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
function audioRefClause(ref) {
  const parts = [
    `filename "${String(ref?.filename ?? "")}"`,
    `type "${String(ref?.type || "output")}"`,
  ];
  const subfolder = ref?.subfolder == null ? "" : String(ref.subfolder);
  if (subfolder) parts.push(`subfolder "${subfolder}"`);
  return parts.join(", ");
}
