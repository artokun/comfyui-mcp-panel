/**
 * Non-quota-limited cross-workflow node clipboard (panel#500).
 *
 * LiteGraph's `copyToClipboard` / `pasteFromClipboard` persist the copied nodes
 * in `localStorage["litegrapheditor_clipboard"]`. localStorage has a 5–10 MB
 * quota and throws `QuotaExceededError` ("The quota has been exceeded.") the
 * moment a write overflows it. Copying a handful of nodes that carry large
 * widget payloads (long prompts, embedded/base64 values) can exceed that quota,
 * so `graph_copy_nodes` threw immediately and the clipboard was never written —
 * the following `graph_paste_nodes` then read stale/empty localStorage and
 * pasted ZERO nodes.
 *
 * The clipboard only needs to survive a workflow SWITCH within the same browser
 * session (not a full page reload), so we back it with an in-memory,
 * module-level variable that has NO quota and NO serialization-size limit. The
 * real localStorage is still mirrored to on a best-effort basis (so a native
 * Ctrl+V keeps working when the payload is small) but the in-memory copy is
 * authoritative when a quota overflow prevented the mirror write.
 *
 * `withInMemoryClipboard(storage, fn)` runs a synchronous LiteGraph copy/paste
 * call with the clipboard key of `storage` transparently backed by this store:
 * writes to the key are captured in-memory (mirror errors, including quota,
 * swallowed), reads of the key return the EFFECTIVE payload (see
 * `resolveClipboardPayload`). All other keys pass through untouched.
 */

export const CLIPBOARD_KEY = "litegrapheditor_clipboard";

// Small, valid-but-empty clipboard payload written to the localStorage key when
// the real (oversized) payload can't fit. It PARSES as an empty clipboard (so a
// native Ctrl+V after an overflow copy is a harmless no-op rather than a JSON
// throw) and carries a distinctive marker field, so no genuine LiteGraph copy —
// which always serializes a non-empty `nodes` array and never this marker — can
// ever produce a byte-identical string. That is what makes a later native
// Ctrl+C reliably detectable by value even if it happens to reproduce the bytes
// that were in localStorage BEFORE the overflow copy (panel#500 review finding).
export const OVERFLOW_SENTINEL = '{"nodes":[],"links":[],"__cmcp_overflow":1}';

// The last payload written through the clipboard key (authoritative copy).
let _payload = null;
// The localStorage value observed for the key right after our last write
// attempt. If the mirror write SUCCEEDED this equals `_payload`; on overflow it
// is the OVERFLOW_SENTINEL we wrote in place of the payload. Lets a later paste
// tell "localStorage still holds our marker → nothing replaced it, use the
// in-memory copy" apart from "a native Ctrl+C replaced localStorage since →
// trust localStorage".
let _lsAtCopy = null;

/** The raw in-memory clipboard payload string (or null if nothing copied). */
export function getInMemoryClipboard() {
  return _payload;
}

/** Reset the store (test hook / explicit clear). */
export function clearInMemoryClipboard() {
  _payload = null;
  _lsAtCopy = null;
}

/**
 * Decide which payload a paste should consume, given the CURRENT real
 * localStorage value for the clipboard key.
 *
 *  - No in-memory copy captured → whatever localStorage holds.
 *  - localStorage already equals our payload (mirror succeeded) → our payload.
 *  - localStorage still holds the marker we left on overflow (`_lsAtCopy`, the
 *    OVERFLOW_SENTINEL) → nothing replaced it; our in-memory copy is the only
 *    good version; use it.
 *  - localStorage changed since our copy → a native Ctrl+C replaced it with
 *    something newer; trust localStorage. Because overflow leaves the distinctive
 *    sentinel (never a real serialized clipboard), this branch is reached for
 *    ANY genuine native write, even one whose bytes match the pre-copy value.
 */
export function resolveClipboardPayload(currentLocalStorageValue) {
  if (_payload == null) return currentLocalStorageValue;
  if (currentLocalStorageValue === _payload) return _payload;
  if (currentLocalStorageValue === _lsAtCopy) return _payload;
  return currentLocalStorageValue;
}

/** The effective clipboard payload for `storage`, resolving in-memory vs.
 *  localStorage exactly as a paste through {@link withInMemoryClipboard} would. */
export function getEffectiveClipboard(storage) {
  let real = null;
  try {
    real = storage && typeof storage.getItem === "function" ? storage.getItem(CLIPBOARD_KEY) : null;
  } catch {
    real = null;
  }
  return resolveClipboardPayload(real ?? null);
}

// Walk the prototype chain to the object that actually OWNS `name`. For real
// localStorage the methods live on Storage.prototype (assigning to the instance
// is unreliable — Storage treats instance property sets as named-item writes),
// so we patch the owner; for a plain mock object the owner is the mock itself.
function methodOwner(obj, name) {
  let o = obj;
  while (o) {
    if (Object.prototype.hasOwnProperty.call(o, name)) return o;
    o = Object.getPrototypeOf(o);
  }
  return null;
}

// A content fingerprint cannot distinguish a native copy that happens to
// produce the same bytes. Keep provenance on the copy method itself instead:
// panel copies run under _panelCopyDepth, while any later unmarked copy clears
// the caller's panel-owned snapshot through onNativeCopy.
const _copyGuards = new WeakMap();
let _panelCopyDepth = 0;

/**
 * Run a panel-owned copy and arm the canvas method to invalidate panel-owned
 * clipboard metadata when a later native copy uses the same canvas/prototype.
 * The wrapper deliberately stays installed for the clipboard's lifetime so a
 * byte-identical native rewrite cannot be mistaken for the old panel copy.
 */
export function withClipboardCopyProvenance(canvas, onNativeCopy, fn) {
  if (!canvas || typeof canvas.copyToClipboard !== "function") return fn();
  const owner = methodOwner(canvas, "copyToClipboard");
  if (!owner || typeof owner.copyToClipboard !== "function") return fn();

  const existing = _copyGuards.get(owner);
  if (!existing || existing.wrapper !== owner.copyToClipboard) {
    const original = owner.copyToClipboard;
    const wrapper = function (...args) {
      if (_panelCopyDepth === 0) {
        try {
          onNativeCopy?.();
        } catch {
          // Snapshot invalidation is advisory; never break native copy.
        }
      }
      return original.apply(this, args);
    };
    owner.copyToClipboard = wrapper;
    _copyGuards.set(owner, { wrapper });
  }

  _panelCopyDepth++;
  try {
    return fn();
  } finally {
    _panelCopyDepth--;
  }
}

/**
 * Run `fn` (a synchronous LiteGraph copy or paste) with the clipboard key of
 * `storage` backed by the in-memory store. Returns `fn()`'s result. If
 * `storage` has no usable setItem the call runs unchanged. Original methods are
 * always restored in a finally.
 */
export function withInMemoryClipboard(storage, fn) {
  if (!storage || typeof storage.setItem !== "function") return fn();

  const setOwner = methodOwner(storage, "setItem");
  const getOwner = methodOwner(storage, "getItem");
  const removeOwner = methodOwner(storage, "removeItem");
  const origSet = setOwner ? setOwner.setItem : null;
  const origGet = getOwner ? getOwner.getItem : null;
  const origRemove = removeOwner ? removeOwner.removeItem : null;

  if (setOwner) {
    setOwner.setItem = function (k, v) {
      if (k === CLIPBOARD_KEY) {
        _payload = v == null ? null : String(v);
        try {
          origSet.call(this, k, v);
          _lsAtCopy = _payload; // mirror succeeded — localStorage now holds it
        } catch {
          // Quota (or storage) failure: the real payload can't be mirrored. The
          // in-memory copy is authoritative. Replace the now-stale localStorage
          // value with the small OVERFLOW_SENTINEL so any later native Ctrl+C is
          // detectable purely by value (it can never reproduce the sentinel).
          try {
            origSet.call(this, k, OVERFLOW_SENTINEL);
            _lsAtCopy = OVERFLOW_SENTINEL;
          } catch {
            // Even the tiny sentinel won't fit — localStorage is ENTIRELY full.
            // This is not the panel#500 case (there the overflow is a multi-MB
            // payload against a 5–10 MB quota, so the 43-byte sentinel always
            // fits); it needs a localStorage already packed to the byte. We
            // still can't persist the payload anywhere, but the in-memory copy
            // is authoritative, so record whatever localStorage still holds:
            // a paste with no intervening write then resolves to the in-memory
            // payload (current === _lsAtCopy), preserving the just-copied nodes.
            // Value comparison genuinely cannot ALSO tell a later byte-identical
            // native re-copy apart from "unchanged" once no marker can be
            // written; preserving the tool copy is the right trade for that
            // pathological, otherwise-unreachable state, and it is no worse than
            // the pre-fix behavior (which threw and pasted nothing).
            try {
              _lsAtCopy = origGet ? origGet.call(this, k) : null;
            } catch {
              _lsAtCopy = null;
            }
          }
        }
        return undefined;
      }
      return origSet.call(this, k, v);
    };
  }
  if (getOwner) {
    getOwner.getItem = function (k) {
      if (k === CLIPBOARD_KEY) {
        let real = null;
        try {
          real = origGet.call(this, k);
        } catch {
          real = null;
        }
        return resolveClipboardPayload(real ?? null);
      }
      return origGet.call(this, k);
    };
  }
  if (removeOwner) {
    removeOwner.removeItem = function (k) {
      if (k === CLIPBOARD_KEY) {
        _payload = null;
        _lsAtCopy = null;
      }
      return origRemove.call(this, k);
    };
  }

  try {
    return fn();
  } finally {
    if (setOwner) setOwner.setItem = origSet;
    if (getOwner) getOwner.getItem = origGet;
    if (removeOwner) removeOwner.removeItem = origRemove;
  }
}
