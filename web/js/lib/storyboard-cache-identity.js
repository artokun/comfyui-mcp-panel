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
 * `key` must identify the RUN, not the call. Two surfaces address the same
 * output — the chat card painted from `executed`, and the completion frame's
 * size/dimension probes — and they have to agree: sharing one URL is what makes
 * the reported size and pixel dimensions describe the bytes the person is
 * actually looking at, and costs one download instead of two. The prompt id is
 * that identity, which is why it is passed in rather than minted here.
 *
 * DELIBERATELY STRICT: an absent key returns the URL untouched rather than
 * minting one. Minting here looks like extra safety and is the opposite — the
 * two call sites mint INDEPENDENTLY, so the card and the probe would land on
 * different URLs and could describe different bytes. That is the #1718 failure
 * (metadata right, picture wrong) reintroduced by the fix for its sibling.
 *
 * The cost is that id-less runs (#224 — legacy, and not something a current
 * ComfyUI `executed` produces) keep the stale-card exposure. Closing that needs
 * a per-run identity threaded through the completion tracker's buffer, flush and
 * delivery so both surfaces read ONE value; it is not something a caller can
 * fake locally. A caller that owns both the probe and the paint — as
 * `composeShowMediaReply` does, where one `url` local feeds both — can pass its
 * own minted identity safely, and does.
 */
export function appendImageCacheBust(url, key) {
  if (typeof url !== "string" || !url || typeof key !== "string" || !key) return url;
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
