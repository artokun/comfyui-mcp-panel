// A storyboard is a derived media artifact, so its identity must change when
// the source is sampled again. ComfyUI's temp refs are filename-based and the
// browser may cache /view by URL; a stable `storyboard_<source>.png` therefore
// lets a later render reuse pixels from an earlier one (#1718).

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

/** Append an attempt-specific query key without disturbing a URL fragment. */
export function appendStoryboardCacheBust(url, identity) {
  if (typeof url !== "string" || !url || typeof identity !== "string" || !identity) return url;
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const separator = beforeHash.includes("?") ? (/[?&]$/.test(beforeHash) ? "" : "&") : "?";
  return `${beforeHash}${separator}cmcp_storyboard=${encodeURIComponent(identity)}${hash}`;
}

/** Name a generated contact sheet with the identity of the sampling attempt. */
export function storyboardUploadName(base, identity) {
  return `storyboard_${String(base || "video")}_${identity}.png`;
}

/** Name the optional poster with the same identity, avoiding stale card art too. */
export function storyboardPosterUploadName(base, identity) {
  return `poster_${String(base || "video")}_${identity}.png`;
}
