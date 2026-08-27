// #1709 — retain a node definition that graph_add_node already verified and used.
//
// This is deliberately narrower than the whole /object_info cache: it stores one detached
// class definition, and only for the exact backend epoch and graph/workflow binding that
// performed the verified add. A reconnect, an authoritative whole-schema answer, a tab
// switch, or a graph switch can therefore never authorize an add from an old entry.
//
// A same-connection refresh that NEVER ANSWERS is not one of those events. Destroying the
// proofs at refresh start turned a busy /object_info (panel_refresh_nodes returning
// refreshed:false) into a #458 refusal of a class this session already added on this
// connection. beginReplacement fences reuse while the replacement is unresolved;
// retainAfterReplacementFailure restores it when the live routes were silent;
// acceptReplacement drops the proofs only once a current whole map actually landed.

function usableContext(context) {
  return !!(
    context &&
    context.app &&
    context.graph &&
    context.rootGraph &&
    context.workflow
  );
}

function sameContext(a, b) {
  return (
    a.app === b.app &&
    a.graph === b.graph &&
    a.rootGraph === b.rootGraph &&
    a.workflow === b.workflow
  );
}

function usableEpoch(epoch) {
  return Number.isFinite(epoch);
}

export function createVerifiedNodeDefCache() {
  const entries = new Map();
  let generation = 0;
  let replacementPending = false;

  function dropEntries() {
    entries.clear();
    replacementPending = false;
  }

  return {
    generation() {
      return generation;
    },

    isReplacementPending() {
      return replacementPending;
    },

    get(classType, { epoch, context, generation: expectedGeneration } = {}) {
      if (
        replacementPending ||
        typeof classType !== "string" ||
        !usableEpoch(epoch) ||
        !usableContext(context) ||
        expectedGeneration !== generation
      ) {
        return undefined;
      }
      const entry = entries.get(classType);
      if (!entry || entry.epoch !== epoch || !sameContext(entry.context, context)) return undefined;
      return entry.def;
    },

    set(classType, def, { epoch, context, generation: expectedGeneration } = {}) {
      if (
        replacementPending ||
        typeof classType !== "string" ||
        !classType ||
        !def ||
        typeof def !== "object" ||
        Array.isArray(def) ||
        !usableEpoch(epoch) ||
        !usableContext(context) ||
        expectedGeneration !== generation
      ) {
        return false;
      }
      entries.set(classType, {
        def,
        epoch,
        context: {
          app: context.app,
          graph: context.graph,
          rootGraph: context.rootGraph,
          workflow: context.workflow,
        },
      });
      return true;
    },

    // Fence reuse without destroying proofs. Generation advances so an in-flight probe
    // issued before this refresh cannot file or reuse under the new generation; the
    // entries stay so a silent replacement can restore them.
    beginReplacement() {
      generation += 1;
      replacementPending = true;
    },

    // An authoritative current whole map landed. Proofs are superseded; do not bump
    // generation again — the refresh that observed this answer is still current.
    acceptReplacement() {
      dropEntries();
    },

    // The replacement never answered. Re-enable remaining proofs whose epoch still
    // matches. A down socket or unreadable epoch discards them instead.
    retainAfterReplacementFailure({ epoch: currentEpoch, socketDown = false } = {}) {
      replacementPending = false;
      if (socketDown || !usableEpoch(currentEpoch)) {
        entries.clear();
        return false;
      }
      for (const [classType, entry] of entries) {
        if (entry.epoch !== currentEpoch) entries.delete(classType);
      }
      return entries.size > 0;
    },

    // An authoritative absence or any schema/backend invalidation drops the type. The
    // class key is global because an observed backend absence is not workflow-specific.
    // Advance the generation even when the requested entry is already absent: an in-flight
    // writer must not repopulate proof after this invalidation.
    invalidate(classType) {
      generation += 1;
      if (typeof classType === "string" && classType) entries.delete(classType);
      else entries.clear();
    },

    clear() {
      generation += 1;
      dropEntries();
    },
  };
}
