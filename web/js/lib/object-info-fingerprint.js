/**
 * #1006 — a stable identity for a served `/object_info`, so a consumer can cache it and a
 * later call can say "unchanged" instead of shipping the payload again.
 *
 * WHY A FINGERPRINT AND NOT A VERSION. There is no version to read: `/object_info` carries
 * no generation counter, and the panel cannot see when a pack was installed on the machine
 * it is talking to. What it CAN do is describe the answer it just got, cheaply and
 * deterministically, so two answers can be compared.
 *
 * WHAT IT COVERS: the set of TYPE NAMES. A fingerprint is a HASH, not a proof (codex) —
 * two different type sets of the same size can in principle produce the same value, so
 * this is a cache key and is described as one. Two payloads that agree on it are
 * overwhelmingly likely to have the same types; they may still differ INSIDE a definition — a
 * changed combo list, a renamed widget, a new input on an existing node. A caller that
 * needs those must re-read rather than trust the fingerprint, and the reply says so rather
 * than leaving it implied. Hashing the whole 5MB payload would answer that question too and
 * costs far more than the fetch it saves; the type set is what a conversion keys on.
 */

/** FNV-1a over a string, with a caller-chosen offset basis. Small, dependency-free and
 *  stable across runs — a cache key, never a security primitive. Two independent bases
 *  are combined below: a single 32-bit value collides far too readily to describe a
 *  4000-type schema, and the reply built on it would then say 'unchanged' about a
 *  genuinely different set (codex). */
function fnv1a(text, basis) {
  let hash = basis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // The classic 32-bit multiply, kept in range without BigInt.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A fingerprint of the TYPE NAMES in an `/object_info` payload.
 *
 * Returns null for anything that is not a usable schema map — a caller must not be handed a
 * fingerprint for a payload it cannot use, because that is exactly the value it would then
 * compare against later and wrongly believe nothing had changed.
 */
export function objectInfoFingerprint(defs) {
  try {
    if (!defs || typeof defs !== "object" || Array.isArray(defs)) return null;
    const names = Object.keys(defs);
    if (!names.length) return null;
    // SORTED, because key order is not part of the answer: the same install can serve the
    // same types in a different order and that must not read as a change.
    names.sort();
    // JSON-ENCODED, not joined on a delimiter. A join is not injective — any separator can
    // occur inside a node type name, and two different type sets hashing alike is exactly
    // the collision a cache key must not have. (An earlier cut used a NUL separator, which
    // the repo's own control-character guard rejected from shipped source, correctly.)
    const encoded = JSON.stringify(names);
    // TWO bases, so a collision needs the same type COUNT and agreement under both.
    //
    // SEPARATED, and this is the same lesson one level down (codex): base-36 strings are
    // variable length, so `${a}${b}` is not injective — "1"+"23" and "12"+"3" both read as
    // "123". Concatenating two hashes without a boundary throws away exactly the agreement
    // the second one was added to establish. The base-36 alphabet cannot contain "-", so a
    // hyphen is an unambiguous boundary.
    const a = fnv1a(encoded, 0x811c9dc5).toString(36);
    const b = fnv1a(encoded, 0x01000193).toString(36);
    return `t${names.length}-${a}-${b}`;
  } catch {
    return null;
  }
}

/**
 * Does a caller's cached fingerprint still describe this payload?
 *
 * Both must be present and equal. An absent or unreadable fingerprint on either side is
 * NOT a match — the point of this is to skip sending a payload, and skipping it on a
 * comparison that never happened would hand the caller a stale schema while telling it
 * nothing changed.
 */
export function objectInfoUnchanged(previousFingerprint, currentFingerprint) {
  // THE TWO GUARDS COVER FOR EACH OTHER, and neither can be killed alone by mutation:
  // with one removed, the equality still rejects an absent value against a real one.
  // What they catch TOGETHER is two absent values, which are equal to each other —
  // `objectInfoUnchanged("", "")` would answer true and a caller would skip re-reading a
  // schema it never had. Kept as two because they state a rule about each side.
  if (typeof previousFingerprint !== "string" || !previousFingerprint) return false;
  if (typeof currentFingerprint !== "string" || !currentFingerprint) return false;
  return previousFingerprint === currentFingerprint;
}
