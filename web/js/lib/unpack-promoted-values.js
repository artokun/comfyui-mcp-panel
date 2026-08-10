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
  // #979 (codex round 2): failures whose ROLLBACK could not be proven. These are not
  // an annotation — they mean the graph holds a value that was in neither the rail
  // nor the inner, and the caller must refuse to unpack over that.
  const unrecoverable = [];
  let skipped = 0;
  // Set when the ITERATION itself failed — an indexed getter on the widgets array, a
  // poisoned iterator (codex final). Per-rail isolation does not cover that: earlier
  // rails may already have been carried, and without this the caller saw only a thrown
  // function, discarded the whole record, and unpacked anyway — destroying exactly the
  // divergent values this exists to protect.
  let aborted = false;
  if (!subgraphNode || typeof resolvePromoted !== "function")
    return { applied, unresolved, unrecoverable, skipped, aborted };
  let rails = [];
  try {
    rails = Array.isArray(subgraphNode.widgets) ? subgraphNode.widgets : [];
  } catch {
    return { applied, unresolved, unrecoverable, skipped, aborted: true };
  }
  try {
    for (const rail of rails) {
    // PER-RAIL isolation (codex NO-SHIP): a hostile or merely unusual accessor on ONE
    // widget — `rail.name`, `innerNode.id`, `innerWidget.name` are all reads that can
    // throw — used to abort the whole loop. That lost every remaining rail's value AND
    // suppressed the disclosure, on a path that then destroys the subgraph anyway.
    // One bad widget now costs its own entry and nothing else.
    // LATCHED before the assignment (codex round 4). If a read-back, a metadata read,
    // or any accessor throws AFTER the write was attempted, the widget may already
    // have been mutated — so that must land in `unrecoverable` and stop the unpack,
    // never be swallowed as a benign "could not inspect".
    const state = { attempted: false };
    try {
      carryOneRail(rail, subgraphNode, resolvePromoted, applied, unresolved, unrecoverable, () => (skipped += 1), state);
    } catch {
      let label = null;
      try {
        label = typeof rail?.name === "string" ? rail.name : null;
      } catch {
        label = null;
      }
      // ANY throw here is unrecoverable, not just a post-write one (codex final).
      // The latch proves a write happened; its absence proves nothing — the resolver
      // and the value getters all run before it, and this module's own threat model
      // is accessors that misbehave. One that MUTATES and then throws would otherwise
      // be filed as benign and unpacked over. On a destructive path an exception
      // means the state cannot be proven, and unprovable is the same as unsafe.
      unrecoverable.push({
        widget: label ?? "(unreadable)",
        reason: state.attempted
          ? "the write was attempted and then something threw — the widget may hold a value from neither side"
          : "inspecting this widget threw, so its state before the unpack cannot be established",
        value_restored: false,
      });
    }
    }
  } catch {
    // The loop itself came apart. Whatever was carried before that point stands,
    // which is precisely why this must reach the caller as a refusal rather than as
    // a thrown function whose partial work is invisible.
    aborted = true;
  }
  return { applied, unresolved, unrecoverable, skipped, aborted };
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
function carryOneRail(rail, subgraphNode, resolvePromoted, applied, unresolved, unrecoverable, onSkip, state) {
  {
    const name = typeof rail?.name === "string" ? rail.name : null;
    if (!name) return;
    let resolved = null;
    try {
      resolved = resolvePromoted(subgraphNode, name);
    } catch {
      // NOT swallowed into `unresolved` (codex final): the resolver is injected code
      // that ran against the live graph, and one that mutates and then throws would
      // otherwise let the unpack proceed over state nothing can prove. An exception
      // here is an unknown, and unknown is unsafe on a destructive path.
      unrecoverable.push({
        widget: name,
        reason: "resolving its promotion threw, so its state before the unpack cannot be established",
        value_restored: true, // nothing was written by us
      });
      return;
    }
    // A usable target needs BOTH a node and a widget (codex final). A target carrying
    // a widget but no node was accepted, so a malformed resolver could steer the carry
    // into a widget nothing owns: the write lands there, is reported as a success, and
    // the unpack still inlines the REAL inner widget's old value — the original data
    // loss, now with a success message on top of it.
    const innerNode = resolved?.target?.node ?? null;
    const innerWidget = resolved?.promoted && innerNode ? (resolved?.target?.widget ?? null) : null;
    if (!innerWidget) {
      // Two DIFFERENT outcomes, and collapsing them was the last hole (codex final).
      //
      //   promoted === false  -> definitively NOT a promotion. The subgraph node's own
      //                          widgets can include ordinary ones, and refusing over
      //                          those would block healthy unpacks. Merely disclosed.
      //   promoted === true, no usable target -> a promotion we could not resolve.
      //                          That is UNKNOWN, not "not a promotion", and an unknown
      //                          on a destructive path must refuse: its value may be
      //                          diverged and would be destroyed with nothing to
      //                          recover from.
      if (resolved?.promoted !== false) {
        unrecoverable.push({
          widget: name,
          reason: "resolves as promoted but its inner widget could not be identified, so it cannot be carried",
          value_restored: true, // nothing was written; the graph is as it was found
        });
      } else {
        unresolved.push({ widget: name });
      }
      return;
    }
    let railValue;
    try {
      railValue = rail.value;
    } catch {
      // Same reasoning as the resolver: a getter that mutates and then throws.
      unrecoverable.push({
        widget: name,
        reason: "reading the parent's value threw, so its state before the unpack cannot be established",
        value_restored: true,
      });
      return;
    }
    let innerValue;
    let innerReadable = true;
    try {
      innerValue = innerWidget.value;
    } catch {
      // An inner value we cannot read is one we cannot restore either, so there is no
      // safe way to attempt the carry — and no way to show the widget is unchanged.
      unrecoverable.push({
        widget: name,
        reason: "reading the inner widget's value threw, so it could not be compared or restored",
        value_restored: false,
      });
      return;
    }
    // Only a genuine DIVERGENCE is written. Writing every promoted widget would fire
    // node callbacks for values that never changed, on a path that is already about
    // to restructure the graph.
    if (Object.is(railValue, innerValue)) {
      onSkip();
      return;
    }
    // Best-effort restore of the value we found. Used on EVERY failure path below —
    // a widget left holding a half-applied value is worse than one left alone, because
    // the unpack that follows makes it permanent.
    // Returns TRUE only when the widget is PROVABLY back to what we found. A restore
    // that throws, that cannot be read back, or that itself normalizes to a third
    // value leaves the graph holding something that was in NEITHER the rail nor the
    // inner — and the caller must not destroy the subgraph over that (codex round 2).
    const restore = () => {
      try {
        if (Object.is(innerWidget.value, innerValue)) return true;
        innerWidget.value = innerValue;
      } catch {
        /* fall through to the read-back — a setter that applies and THEN throws has
           still restored the value, and refusing the unpack over that would be a
           false alarm on a graph that is actually intact */
      }
      // The verdict comes from the OBSERVED value, never from whether the assignment
      // reported success. Both directions matter: a throw that restored is recovered,
      // and a silent success that normalized is not.
      try {
        return Object.is(innerWidget.value, innerValue);
      } catch {
        return false; // cannot even confirm — treat as unrecoverable
      }
    };
    // ANY attempted transfer that did not cleanly land goes here, whether or not the
    // scalar could be put back (codex round 3). Restoring the value is not proof the
    // widget is recovered: a setter is free to mutate node properties, sibling
    // widgets, options or a callback-owned cache on its way, and both the carry and
    // the restore ran. The scalar being right again says nothing about those, and
    // nothing observable can. So the caller reloads its pre-carry snapshot — the only
    // generic way to erase effects that cannot be inspected — rather than unpacking
    // over a state that is neither the rail's nor the inner's.
    const failed = (reason) => {
      const scalarBack = restore();
      unrecoverable.push({
        widget: name,
        reason: scalarBack
          ? `${reason} (its previous value was put back, but a setter that ran twice may have changed more than the value)`
          : `${reason}, and the previous value could not be restored`,
        value_restored: scalarBack,
      });
    };
    try {
      state.attempted = true;
      innerWidget.value = railValue;
    } catch {
      failed("inner widget rejected the write");
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
      failed("inner widget did not retain the value");
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
 * #979 (codex round 4) — READ-ONLY: which promoted rails hold a value their inner
 * widget does not. Writes nothing, so it is safe when there is no rollback snapshot
 * to undo a failed write with.
 *
 * The caller uses this exactly there: snapshot capture failing must not re-authorize
 * the data loss this whole change exists to stop. Skipping the carry "because it is
 * only the old behaviour" is not recoverable-by-hand — after the unpack the rail is
 * gone and a long prompt may exist nowhere at all. So a divergence found here refuses
 * the unpack instead, and an unpack with no divergence proceeds untouched.
 *
 * An unreadable value counts as divergent: it cannot be shown to be safe, and the
 * conservative direction on a destructive path is to refuse.
 */
export function findDivergentPromotedValues(subgraphNode, resolvePromoted) {
  const divergent = [];
  if (!subgraphNode || typeof resolvePromoted !== "function") return divergent;
  const rails = Array.isArray(subgraphNode.widgets) ? subgraphNode.widgets : [];
  for (const rail of rails) {
    try {
      const name = typeof rail?.name === "string" ? rail.name : null;
      if (!name) continue;
      let resolved = null;
      try {
        resolved = resolvePromoted(subgraphNode, name);
      } catch {
        // NOT "not a promotion" (codex final): a resolver that throws leaves this
        // widget's promotion status unknown, and with no snapshot to undo with, an
        // unknown is exactly what must stop the unpack. Skipping here would let a
        // divergent-but-unresolvable value be destroyed with nothing to recover from.
        divergent.push({ widget: name, reason: "its promotion could not be resolved" });
        continue;
      }
      // Same both-or-neither requirement as the carry, so the two modes cannot
      // disagree about what counts as a resolvable promotion.
      const innerWidget =
        resolved?.promoted && resolved?.target?.node ? (resolved?.target?.widget ?? null) : null;
      if (!innerWidget) {
        // Only a definitive `promoted: false` is safe to skip (codex final). A rail
        // that resolves as promoted but yields no usable target is an UNKNOWN — its
        // value may be diverged, and with no snapshot there would be nothing to
        // recover it from once the unpack destroys the rail.
        if (resolved?.promoted !== false) divergent.push({ widget: name, reason: "its inner widget could not be identified" });
        continue;
      }
      if (!Object.is(rail.value, innerWidget.value)) divergent.push({ widget: name });
    } catch {
      // A widget that cannot be read cannot be shown safe. On a destructive path that
      // is a reason to stop, not to shrug.
      let label = null;
      try {
        label = typeof rail?.name === "string" ? rail.name : null;
      } catch {
        label = null;
      }
      divergent.push({ widget: label ?? "(unreadable)", reason: "could not be compared" });
    }
  }
  return divergent;
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
