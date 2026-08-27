// Lifecycle inverses for resident panel UI (#1952, #1960).
//
// Open-only surfaces (the unified Training/CivitAI side panel, live A2UI cards,
// painted show_media cards) accumulate in the renderer with no agent path to
// shed them. The user-facing ✕ already calls handle.close() / card resolve(null);
// these functions ARE that same path, callable from the bridge.

/**
 * Close the unified side panel (Training / CivitAI / Apps / RunPod).
 *
 * Idempotent: a missing or already-closed handle is success with `closed:false`
 * — shedding already-shed state is the goal, not an error. The user-facing ✕
 * is the same `handle.close()`.
 */
export function closeSidePanelHandle(handle) {
  if (!handle || typeof handle.close !== "function") {
    return { ok: true, closed: false, tab: null };
  }
  const open = typeof handle.isOpen === "function" ? !!handle.isOpen() : true;
  if (!open) return { ok: true, closed: false, tab: null };
  const tab = typeof handle.activeTab === "function" ? handle.activeTab() ?? null : null;
  handle.close();
  return { ok: true, closed: true, tab };
}

const NO_LIVE_CARD = (id) =>
  `no live card "${id}" (already resolved, dismissed, or from a previous view)`;

/**
 * Dismiss one live A2UI card the same way the user ✕ does: resolve(null)
 * (inert, no agent message), drop it from the live registry, and detach the
 * DOM node so the renderer can drop the card's pixels.
 *
 * Throws the same "no live card" error `ui_update` uses when the id is gone,
 * so a stale id is a retryable tool error rather than a silent no-op.
 */
export function dismissLiveA2uiCard(liveMap, cardId, { removeEl = true } = {}) {
  const id = cardId == null ? "" : String(cardId);
  if (!id) throw new Error(NO_LIVE_CARD(cardId));
  const entry = liveMap && typeof liveMap.get === "function" ? liveMap.get(id) : undefined;
  if (!entry) throw new Error(NO_LIVE_CARD(id));
  const handle = entry.handle;
  if (!(handle && typeof handle.isResolved === "function" && handle.isResolved())) {
    try { handle?.resolve?.(null); } catch { /* already resolved */ }
  }
  if (entry.rec) entry.rec.resolved = true;
  if (typeof liveMap.delete === "function") liveMap.delete(id);
  if (removeEl) {
    try { handle?.el?.remove?.(); } catch { /* already gone */ }
  }
  return { ok: true, dismissed: true, card_id: id, rec: entry.rec };
}

/** Dismiss every live A2UI card. Never throws — an empty registry is success. */
export function dismissAllLiveA2uiCards(liveMap, opts) {
  const ids = liveMap && typeof liveMap.keys === "function" ? [...liveMap.keys()] : [];
  const card_ids = [];
  const recs = [];
  for (const id of ids) {
    const r = dismissLiveA2uiCard(liveMap, id, opts);
    if (r.dismissed) card_ids.push(r.card_id);
    if (r.rec) recs.push(r.rec);
  }
  return { ok: true, dismissed: card_ids.length, card_ids, recs };
}

/**
 * Unload painted chat media so the renderer can drop decoded bitmaps.
 *
 * Clears img/video src (revoking blob: URLs) and detaches `.cmcp-imgcard`
 * nodes. Does not rewrite history — a thread switch may replay persisted
 * media. That is enough to shed the live session's decoder footprint.
 */
export function unloadChatMediaCards(logEl, { revokeObjectURL } = {}) {
  if (!logEl || typeof logEl.querySelectorAll !== "function") {
    return { ok: true, unloaded: 0 };
  }
  const revoke =
    typeof revokeObjectURL === "function"
      ? revokeObjectURL
      : typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function"
        ? (u) => URL.revokeObjectURL(u)
        : null;
  const cards = [...logEl.querySelectorAll(".cmcp-imgcard")];
  let unloaded = 0;
  for (const card of cards) {
    const media = typeof card.querySelectorAll === "function"
      ? card.querySelectorAll("img, video, source")
      : [];
    for (const el of media) {
      const src = el.currentSrc || el.src || "";
      if (typeof src === "string" && src.startsWith("blob:") && revoke) {
        try { revoke(src); } catch { /* already revoked */ }
      }
      try { el.removeAttribute?.("src"); } catch { /* ignore */ }
      try { el.src = ""; } catch { /* ignore */ }
      if (el.tagName === "VIDEO" && typeof el.load === "function") {
        try { el.load(); } catch { /* ignore */ }
      }
    }
    try { card.remove(); } catch { /* already gone */ }
    unloaded += 1;
  }
  return { ok: true, unloaded };
}
