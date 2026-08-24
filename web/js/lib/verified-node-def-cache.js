// #1709 — retain a node definition that graph_add_node already verified and used.
//
// This is deliberately narrower than the whole /object_info cache: it stores one detached
// class definition, and only for the exact backend epoch and graph/workflow binding that
// performed the verified add. A reconnect, schema refresh, tab switch, or graph switch can
// therefore never authorize an add from an old entry. Callers still clear it when a schema
// refresh or backend outage is observed; the identity checks are the last line of defense.

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

  return {
    generation() {
      return generation;
    },

    get(classType, { epoch, context, generation: expectedGeneration } = {}) {
      if (
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
      entries.clear();
    },
  };
}
