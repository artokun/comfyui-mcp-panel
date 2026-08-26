// A storyboard is a derived media artifact, so its identity must change when
// the source is sampled again. ComfyUI's temp refs are filename-based and the
// browser may cache /view by URL; a stable `storyboard_<source>.png` therefore
// lets a later render reuse pixels from an earlier one (#1718).
//
// #1834 — SAVED STILLS HAVE THE SAME PROBLEM, and it is not hypothetical: it is
// ComfyUI's documented behaviour. server.py's own /view handler comments that
// "nothing sets Cache-Control on /view, which makes it heuristically cacheable",
// and it attaches `Cache-Control: no-store` ONLY on the dangerous-content-type
// branch — a PNG gets a bare FileResponse. A SaveImage `filename_prefix` using
// `%date%` + `%counter%` can therefore re-emit a name a previous day's run
// already used, and the browser paints the OLD bytes under the NEW name. The
// person is then judging a render they never made, which is why this is a
// correctness bug and not a rendering nit.
//
// So the append helpers live together here. Both stamp a per-run key onto the
// /view URL; only the key differs (a sampling attempt for a storyboard, the
// prompt id for a still).

let identitySequence = 0;

/** Create a short, safe identity unique to this panel session and attempt. */
export function createStoryboardIdentity() {
  identitySequence += 1;
  let entropy = "";
  try {
    entropy = (globalThis.crypto?.randomUUID?.() || "").replaceAll("-", "").slice(0, 10);
  } catch {
    // Date + sequence below still makes attempts unique within this session.
  }
  return `${Date.now().toString(36)}-${identitySequence.toString(36)}${entropy ? `-${entropy}` : ""}`;
}

/** Append `name=value` to a URL's query without disturbing its fragment. */
function appendCacheBustParam(url, name, value) {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const separator = beforeHash.includes("?") ? (/[?&]$/.test(beforeHash) ? "" : "&") : "?";
  return `${beforeHash}${separator}${name}=${encodeURIComponent(value)}${hash}`;
}

/** Append an attempt-specific query key without disturbing a URL fragment. */
export function appendStoryboardCacheBust(url, identity) {
  if (typeof url !== "string" || !url || typeof identity !== "string" || !identity) return url;
  return appendCacheBustParam(url, "cmcp_storyboard", identity);
}

/**
 * Append a run-unique query key to a still image's /view URL (#1834).
 *
 * Keyed on the PROMPT ID rather than a fresh identity per call, so that every
 * surface addressing the same run's output — the chat card painted from
 * `executed`, and the completion frame's size/dimension probes — lands on ONE
 * URL. Two keys would mean two downloads of the same bytes and, worse, would let
 * the probe report the size of a file the card never showed.
 *
 * A run with NO prompt id is real here (#224 covers back-to-back id-less runs),
 * and that is precisely the case where filenames are most likely to repeat. It
 * gets a minted identity instead of being handed back unbusted, because leaving
 * one path stale is how this class of bug survives its own fix. The generator is
 * media-kind agnostic despite its name — it mints "this session, this attempt".
 */
export function appendImageCacheBust(url, promptId) {
  if (typeof url !== "string" || !url) return url;
  const key = typeof promptId === "string" && promptId ? promptId : createStoryboardIdentity();
  return appendCacheBustParam(url, "cmcp_prompt", key);
}

/** Name a generated contact sheet with the identity of the sampling attempt. */
export function storyboardUploadName(base, identity) {
  return `storyboard_${String(base || "video")}_${identity}.png`;
}

/** Name the optional poster with the same identity, avoiding stale card art too. */
export function storyboardPosterUploadName(base, identity) {
  return `poster_${String(base || "video")}_${identity}.png`;
}
