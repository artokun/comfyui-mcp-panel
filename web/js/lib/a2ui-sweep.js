/**
 * Which records a no-`card_id` `ui_dismiss` sweeps (#2183).
 *
 * A dismissal that carries no `card_id` cannot say which card it meant, so the
 * recovery clears every UNRESOLVED A2UI record in the thread on screen. That
 * selection is the whole contract — "a2ui only, unresolved only" — and it decides
 * how much a destructive recovery destroys.
 *
 * Split out as a PURE function so it can be driven directly. The sweep it feeds
 * mutates records, touches the history store, removes DOM nodes and persists, and
 * lives inside `onUiDismiss`, which no harness rebuilds; before this, every
 * assertion about it matched the source TEXT of that handler, so a reorder or a
 * rename that kept the text passed while the behaviour went unchecked.
 *
 * Takes the message list rather than the thread so a test needs no thread, no
 * store, no DOM and no bridge.
 *
 * @param {ReadonlyArray<{kind?: unknown, resolved?: unknown}> | null | undefined} msgs
 * @returns {Array<object>} the records to sweep, in thread order
 */
export function unresolvedA2UICards(msgs) {
  const out = [];
  for (const rec of msgs || []) {
    // `resolved === true` and not merely truthy: a record carrying a non-boolean
    // (a timestamp, say) must not read as already-dismissed and be skipped, which
    // would silently leave a live card behind on the one path that exists to
    // remove it.
    if (rec?.kind !== "a2ui" || rec.resolved === true) continue;
    out.push(rec);
  }
  return out;
}
