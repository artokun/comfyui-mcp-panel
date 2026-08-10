/**
 * #979 — carry PROMOTED widget values into the inner nodes before a subgraph is
 * unpacked, so the value the user set is the value that survives.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, on a subgraph whose promoted `text`
 * widget had been given a different value on the parent than the inner node held:
 *
 *   before unpack:  rail = "RAIL-VALUE-THE-USER-SET"   inner = "ORIGINAL-INNER"
 *   after  unpack:  "ORIGINAL-INNER"
 *
 * `unpackSubgraph` inlines the INNER widget's value and drops the parent rail's. The
 * reporter lost a long custom prompt to a pack's template default and a duration of
 * 15 to a default of 2, exactly this way.
 *
 * WHICH VALUE IS RIGHT: the rail's. #366 established the parent rail widget as the
 * AUTHORITATIVE one for a promoted widget — it is what serializes at queue time, so
 * it is what the workflow would actually have rendered with. Pushing rail → inner
 * before the unpack therefore preserves the behaviour the graph already had.
 *
 * WHY IT MATTERS MORE THAN AN ORDINARY BUG: unpack is DESTRUCTIVE. Once the subgraph
 * is gone the rail is gone with it, and there is nothing left to recover the value
 * from — the reporter's workaround was remembering what it used to be and typing it
 * back. So this runs BEFORE the unpack and reports what it did.
 *
 * NOT a general sync: it only writes an inner widget whose promoted rail holds a
 * DIFFERENT value, and it never invents a promotion the resolver could not confirm.
 * A widget it cannot resolve is left alone and reported as unresolved rather than
 * guessed at — writing the wrong inner widget would be silent corruption of the kind
 * #233 exists to prevent.
 */

/**
 * Materialize every promoted rail value onto its inner widget.
 *
 * `resolvePromoted(subgraphNode, widgetName)` is injected — the caller passes the
 * panel's own promoted-target resolver, so this never carries a second copy of that
 * rule. It must return `{ promoted, target: { node, widget } }`-shaped data; anything
 * else is treated as unresolved.
 *
 * Returns `{ applied: [...], unresolved: [...], skipped: n }` — `applied` naming each
 * value moved, so the caller can disclose a destructive operation's side effects
 * instead of performing them silently.
 *
 * Fully defensive: a throwing resolver, a frozen widget, or a malformed node reduces
 * what is applied, never throws. A failure here must not block the unpack the user
 * asked for — it must only be reported.
 */
export function materializePromotedValues(subgraphNode, resolvePromoted) {
  const applied = [];
  const unresolved = [];
  let skipped = 0;
  if (!subgraphNode || typeof resolvePromoted !== "function") return { applied, unresolved, skipped };
  const rails = Array.isArray(subgraphNode.widgets) ? subgraphNode.widgets : [];
  for (const rail of rails) {
    // PER-RAIL isolation (codex NO-SHIP): a hostile or merely unusual accessor on ONE
    // widget — `rail.name`, `innerNode.id`, `innerWidget.name` are all reads that can
    // throw — used to abort the whole loop. That lost every remaining rail's value AND
    // suppressed the disclosure, on a path that then destroys the subgraph anyway.
    // One bad widget now costs its own entry and nothing else.
    try {
      carryOneRail(rail, subgraphNode, resolvePromoted, applied, unresolved, () => (skipped += 1));
    } catch {
      let label = null;
      try {
        label = typeof rail?.name === "string" ? rail.name : null;
      } catch {
        label = null;
      }
      unresolved.push({ widget: label ?? "(unreadable)", reason: "widget could not be inspected" });
    }
  }
  return { applied, unresolved, skipped };
}

/**
 * One rail's transfer. Extracted so a throw anywhere in it — including while building
 * the report entry — is contained to that rail by the caller.
 *
 * TRANSACTIONAL (codex NO-SHIP): the previous inner value is captured first, and any
 * assignment that throws, coerces, or is silently ignored is ROLLED BACK before being
 * reported. Without that, a setter which mutates and then throws left the inner widget
 * altered and `unpackSubgraph` committed it — silent destructive corruption on exactly
 * the error path this function claims is safe.
 */
function carryOneRail(rail, subgraphNode, resolvePromoted, applied, unresolved, onSkip) {
  {
    const name = typeof rail?.name === "string" ? rail.name : null;
    if (!name) return;
    let resolved = null;
    try {
      resolved = resolvePromoted(subgraphNode, name);
    } catch {
      resolved = null;
    }
    const innerWidget = resolved?.promoted ? (resolved?.target?.widget ?? null) : null;
    const innerNode = resolved?.target?.node ?? null;
    if (!innerWidget) {
      // A rail widget that does not resolve to an inner one is NOT assumed to be a
      // promotion — the subgraph node's own widgets can include non-promoted ones.
      // Reported so a caller can say the coverage was partial rather than complete.
      unresolved.push({ widget: name });
      return;
    }
    let railValue;
    try {
      railValue = rail.value;
    } catch {
      unresolved.push({ widget: name, reason: "rail value could not be read" });
      return;
    }
    let innerValue;
    let innerReadable = true;
    try {
      innerValue = innerWidget.value;
    } catch {
      innerValue = undefined;
      innerReadable = false;
    }
    // Only a genuine DIVERGENCE is written. Writing every promoted widget would fire
    // node callbacks for values that never changed, on a path that is already about
    // to restructure the graph.
    if (innerReadable && Object.is(railValue, innerValue)) {
      onSkip();
      return;
    }
    // Best-effort restore of the value we found. Used on EVERY failure path below —
    // a widget left holding a half-applied value is worse than one left alone, because
    // the unpack that follows makes it permanent.
    const restore = () => {
      if (!innerReadable) return;
      try {
        if (!Object.is(innerWidget.value, innerValue)) innerWidget.value = innerValue;
      } catch {
        /* nothing further can be done; it is reported as unresolved either way */
      }
    };
    try {
      innerWidget.value = railValue;
    } catch {
      restore();
      unresolved.push({ widget: name, reason: "inner widget rejected the write" });
      return;
    }
    let landed;
    try {
      landed = innerWidget.value;
    } catch {
      landed = undefined;
    }
    // Read back: a frozen widget, a setter that ignores the assignment, and a setter
    // that COERCES to something else are all failures to carry the value — and the
    // coercing one is why the restore matters, since it leaves the widget holding a
    // third value that was never in the graph.
    if (!Object.is(landed, railValue)) {
      restore();
      unresolved.push({ widget: name, reason: "inner widget did not retain the value" });
      return;
    }
    // Report metadata is built inside the guarded span too: `innerNode.id` and
    // `innerWidget.name` are reads, and a read that throws must not lose the transfer
    // that already succeeded — the caller's catch turns it into an unresolved entry.
    applied.push({
      widget: name,
      node_id: innerNode?.id != null ? String(innerNode.id) : null,
      inner_widget: typeof innerWidget.name === "string" ? innerWidget.name : name,
    });
  }
}

/**
 * The disclosure for a destructive operation that moved values. Empty when nothing
 * was moved and nothing was left unresolved — an unpack with no promoted divergence
 * has nothing to say and should say nothing.
 */
export function materializedValuesNote(result) {
  const applied = Array.isArray(result?.applied) ? result.applied : [];
  const unresolved = Array.isArray(result?.unresolved) ? result.unresolved : [];
  if (!applied.length && !unresolved.length) return "";
  const parts = [];
  if (applied.length) {
    const which = applied
      .slice(0, 6)
      .map((a) => `${a.widget}${a.node_id ? ` → node ${a.node_id}` : ""}`)
      .join(", ");
    parts.push(
      `Carried ${applied.length} promoted widget value${applied.length === 1 ? "" : "s"} into the ` +
        `inlined node${applied.length === 1 ? "" : "s"} before unpacking (${which}${
          applied.length > 6 ? `, and ${applied.length - 6} more` : ""
        }). The parent's value is the one that serializes at queue time, so it is the one kept; ` +
        `without this it would have been replaced by whatever the inner node was created with (#979).`,
    );
  }
  if (unresolved.length) {
    parts.push(
      `${unresolved.length} widget${unresolved.length === 1 ? "" : "s"} on the subgraph node could ` +
        `not be matched to an inner widget and ${unresolved.length === 1 ? "was" : "were"} left ` +
        `untouched (${unresolved.map((u) => u.widget).slice(0, 6).join(", ")}) — not every widget on a ` +
        `subgraph node is a promotion, so this is usually nothing, but check those values if they ` +
        `matter: unpack cannot be undone from the result.`,
    );
  }
  return parts.join(" ");
}
