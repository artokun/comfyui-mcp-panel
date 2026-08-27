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
 * matching the live path). `withheld` is the count/keys/types of every other
 * matching bag — never a copy of the refs, so a 768-image dump cannot leak
 * onto the completion frame by accident.
 *
 * @param {object|null|undefined} out
 * @returns {{ deliverable: object[], withheld: ({ count: number, keys: string[], types: string[] }|null) }}
 */
export function collectNodeOutputMedia(out) {
  const deliverable = [];
  if (out == null || typeof out !== "object" || Array.isArray(out)) {
    return { deliverable, withheld: null };
  }

  for (const key of STANDARD_MEDIA_KEYS) {
    const bag = out[key];
    if (!Array.isArray(bag)) continue;
    for (const m of bag) {
      if (!m || !m.filename) continue;
      deliverable.push(m);
    }
  }

  const keys = [];
  const types = [];
  let count = 0;
  for (const [key, bag] of Object.entries(out)) {
    if (STANDARD_MEDIA_KEY_SET.has(key)) continue;
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

  return { deliverable, withheld: count ? { count, keys, types } : null };
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
