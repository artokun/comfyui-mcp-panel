// Per-item collapse state for chat-transcript media cards (#818).
//
// THE REQUEST. A run that produces a 4K still or a 15-second clip renders at
// full card width in the log, forever. The only existing media affordance goes
// the OTHER way — `.cmcp-media-expand` (`⛶`) opens the lightbox — so a user with
// a tall transcript has no way to make a card take less room.
//
// WHY THIS IS A MODULE AND NOT FOUR LINES IN THE PAINTER. Two things here are
// easy to get subtly wrong and impossible to test from the DOM closure:
//
//  1. WHAT IDENTIFIES A CARD ACROSS A RELOAD. The transcript is repainted from
//     stored role:"media" records, so a card's identity has to survive that trip.
//     The url is the only stable thing a replayed card carries — but a url can
//     also be a multi-megabyte `data:` URI, and putting one of those in
//     sessionStorage is how you take the whole thread's storage down with it. So
//     ids are HASHED to a fixed width; a url too long to hash exactly gets NO id
//     rather than an approximate one (see MAX_KEYABLE_URL_LENGTH).
//
//  2. STORAGE IS NOT GUARANTEED. sessionStorage throws outright in some browser
//     privacy modes and on quota. A collapse toggle that throws while the user
//     is clicking it is worse than one that forgets — so every read and write is
//     guarded, and a store that cannot persist still answers correctly for the
//     life of the page from its in-memory copy.
//
// WHY sessionStorage AND NOT localStorage. Decided on the issue: collapse state
// should last "for the session". sessionStorage is exactly that — tab-scoped,
// survives a reload and a thread switch, gone when the tab closes — and it is
// already the panel's per-tab persistence layer (the tab id, the agent session
// id, the currently-shown thread all live there). A collapse decision from last
// week should not follow someone into a new browser session.
//
// Kept standalone (no browser globals) so it is unit-testable under
// `node --test`; the panel injects sessionStorage's getItem/setItem.

/** sessionStorage key holding the collapsed-media id list. Namespaced like every
 *  other panel key ("comfyui-mcp.panel.*"). */
export const MEDIA_COLLAPSE_KEY = "comfyui-mcp.panel.collapsedMedia";

/** Upper bound on remembered ids. A long session can paint hundreds of cards,
 *  and an unbounded list would grow for the whole tab's life. Oldest-first
 *  eviction: the worst case for a user who blows past the cap is that a card
 *  they collapsed a very long time ago comes back expanded. */
export const MAX_COLLAPSED_ENTRIES = 300;

/**
 * The longest url this module will key on. Above it, there IS no id (see
 * mediaCollapseId) — the url is read in full or not at all.
 *
 * The alternative was a sampling hash: fixed windows at the head, the tail and a
 * few interior fractions. It was written, and it was wrong. A sampler has gaps by
 * construction, so two same-length urls differing only inside a gap key
 * IDENTICALLY — and current-code admission rules are not a defence, because a
 * persisted role:"media" message replays through paintImage/paintVideo without
 * being re-validated (codex round 3), so an imported or legacy history can carry a
 * url no live code path would write. Guessing which of two media items the user
 * hid is exactly the kind of confident wrong answer this codebase refuses
 * elsewhere, and it is not worth buying with anything.
 *
 * Set well above the panel’s own ceiling on a persistable media url
 * (MAX_MEDIA_URL_LENGTH, 4096 — lib/chat-media.js), so every url whose collapse
 * CAN outlive the page is keyed exactly. Past it lie only `data:` and `blob:`
 * sources, which are never written to a media record and so never come back after
 * a reload anyway — losing their persistence costs nothing, and the toggle still
 * works for the life of the page because the panel drives the DOM from the DOM.
 */
export const MAX_KEYABLE_URL_LENGTH = 8192;

/** FNV-1a, 32-bit, as an unsigned integer. */
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime (16777619) via shifts — Math.imul keeps it exact.
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * The stable id for a media url, or null when there is nothing to key on —
 * including a url too long to key EXACTLY (MAX_KEYABLE_URL_LENGTH). Null is a
 * decision, not a failure: the store no-ops, the card still toggles for the life
 * of the page, and no other item can inherit its state.
 *
 * Two independently-seeded FNV-1a passes over the whole url, concatenated → 16
 * hex chars, i.e. a 64-bit space — over the WHOLE url, so any difference at any
 * offset shows up. A collision at this width
 * would only mean one card starts collapsed when its neighbour was the one
 * collapsed, which is why a cryptographic digest (async, and unavailable in a
 * non-secure context) would be the wrong tool here.
 */
export function mediaCollapseId(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_KEYABLE_URL_LENGTH) return null;
  const a = fnv1a(trimmed, 0x811c9dc5);
  const b = fnv1a(trimmed, 0x01000193);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Parse a persisted payload into a clean, capped id list. Anything that is not
 *  an array of non-empty strings is discarded rather than repaired — a corrupt
 *  value is not evidence about what the user collapsed. */
function parseIds(raw, limit) {
  if (typeof raw !== "string" || !raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const out = [];
  for (const v of parsed) {
    if (typeof v !== "string" || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  // Keep the MOST RECENT when a stored list is over the cap — same end that
  // eviction drops from, so a shrunk limit behaves like repeated eviction.
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/**
 * The collapse-state store the panel actually uses.
 *
 * `getItem`/`setItem` are injected (the panel passes sessionStorage's, already
 * wrapped by ssGet/ssSet) so the whole decision path is testable off-browser.
 * Neither is required: with no storage at all the store still works for the
 * life of the page, which is the correct degradation for a view preference.
 *
 * Ids are held in memory after the first read, so a card paint never re-parses
 * the JSON — a thread switch repaints the entire transcript at once.
 */
export function createMediaCollapseStore({
  getItem,
  setItem,
  key = MEDIA_COLLAPSE_KEY,
  limit = MAX_COLLAPSED_ENTRIES,
} = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_COLLAPSED_ENTRIES;
  /** Insertion-ordered, most-recently-collapsed LAST. */
  let ids = null;

  function load() {
    if (ids) return ids;
    let raw = null;
    if (typeof getItem === "function") {
      try {
        raw = getItem(key);
      } catch {
        raw = null; // storage disabled mid-session — start empty, keep working
      }
    }
    ids = parseIds(raw, cap);
    return ids;
  }

  function flush() {
    if (typeof setItem !== "function") return false;
    try {
      setItem(key, JSON.stringify(ids));
      return true;
    } catch {
      // Quota or a privacy mode. The in-memory list stays authoritative for this
      // page, so the toggle the user just clicked still holds — it simply will
      // not survive the next reload.
      return false;
    }
  }

  return {
    /** Is the media at `url` currently collapsed? False for anything unkeyable. */
    isCollapsed(url) {
      const id = mediaCollapseId(url);
      if (!id) return false;
      return load().includes(id);
    },

    /** Record (or clear) the collapsed state for `url`. Returns the state that is
     *  now in effect — always `collapsed`, so a caller can drive the DOM from the
     *  return value whether or not anything could be persisted. */
    setCollapsed(url, collapsed) {
      const id = mediaCollapseId(url);
      if (!id) return !!collapsed;
      const list = load();
      const at = list.indexOf(id);
      if (collapsed) {
        if (at >= 0) return true; // already recorded; don't churn storage
        list.push(id);
        // Evict from the OLD end so the newest decisions are the ones kept.
        if (list.length > cap) list.splice(0, list.length - cap);
      } else {
        if (at < 0) return false;
        list.splice(at, 1);
      }
      flush();
      return !!collapsed;
    },

    /** Flip the state for `url` and return the new one. */
    toggle(url) {
      return this.setCollapsed(url, !this.isCollapsed(url));
    },

    /** The remembered ids, oldest first. For tests and diagnostics. */
    ids() {
      return [...load()];
    },
  };
}
