
// #1854 — the intrinsic captured ONCE at module load. Invoking through a
// per-call property lookup on the function object would read an overrideable
// own property, so a shadowed one could throw before the original ran; this
// reads nothing off the target at call time.
const rawApply = Reflect.apply;
// Null-widget serialization guard for graph_run (#445).
//
// A workflow can carry nodes whose serialized widget values are `null` — most
// commonly VHS_VideoCombine (VideoHelperSuite) nodes left in the graph with
// `frame_rate:null`, `filename_prefix:null`, `pingpong:null`, `save_output:null`.
// When such a graph is queued, ComfyUI's `graphToPrompt` serializes EVERY node's
// widgets (even unused branches, even under "run to node") — for VHS it calls the
// node's own `serializeValue`, which does string ops like `.replace()` on the
// value and throws `Cannot read properties of null (reading 'replace')` DURING
// serialization, killing the run before it queues.
//
// The panel installs no serialize hook, so the fix is a SERIALIZER-LEVEL
// temporary normalization: we wrap `app.graphToPrompt` (the exact function inside
// which every prompt build — and the crash — happens). Around each serialize it
// coerces null/undefined widget values to a safe default, delegates to the
// original, then RESTORES the prior values.
//
// Design constraints learned in review:
//   • Wrap the SERIALIZER, not `app.queuePrompt`: queuePrompt PUSHES the request
//     and returns early (`return false`) when its processor is already busy — the
//     real `graphToPrompt` for that item runs LATER inside the active loop, so a
//     coerce/restore scoped to our own queuePrompt call would restore the nulls
//     before that deferred serialization ran.
//   • RE-ENTRANCY: graphToPrompt is async and can overlap (e.g. a "Save (API
//     format)" export while a queue serialize is in flight). A refless restore
//     could revert nulls while another serialize is mid-flight → the crash
//     returns. So a per-widget REFERENCE COUNT keeps the coercion alive until the
//     LAST overlapping serialization finishes.
//   • NEVER PERMANENTLY MUTATE / never clobber a concurrent edit: `null` may be a
//     meaningful "unset/auto" on an executed or third-party widget. We restore
//     only when the value is still exactly the one we set — an edit made during
//     the serialization window is left untouched — and always via `finally`, so
//     the live workflow is left as the user had it.

/**
 * A safe, non-null default for a widget whose value is null/undefined. Prefers
 * the widget's own declared default (from the node def), then falls back by
 * widget type so downstream string ops (`.replace`, `.trim`, …) can't throw.
 * Never INVOKES a dynamic combo `values()` provider — those can be context-
 * dependent or side-effecting (the panel avoids calling them mid-queue); an
 * empty string is a safe, string-op-friendly fallback for that case.
 */
export function safeWidgetDefault(widget) {
  const def = widget?.options?.default;
  if (def !== null && def !== undefined) return def;
  const type = typeof widget?.type === "string" ? widget.type.toLowerCase() : "";
  if (type === "toggle" || type === "boolean") return false;
  if (type === "number" || type === "slider" || type === "int" || type === "float") {
    const min = widget?.options?.min;
    return typeof min === "number" ? min : 0;
  }
  if (type === "combo") {
    const vals = widget?.options?.values;
    if (Array.isArray(vals) && vals.length) return vals[0];
    // A function provider is NOT invoked (side-effect/context risk) — "" is safe.
    return "";
  }
  // text / customtext / string / unknown → empty string keeps string ops safe.
  return "";
}

// Per-widget coercion registry: widget object → { original, coerced, count }.
// A WeakMap so a discarded widget can be GC'd. The count makes overlapping
// serializations of the same widget safe (restore only when the last one exits).
const REG = new WeakMap();

/**
 * Walk `rootGraph` and every nested subgraph, coercing any null/undefined widget
 * value to `safeWidgetDefault(widget)` IN PLACE (reference-counted). Returns the
 * list of records touched by THIS pass — `{ ref, original, coerced, nodeId,
 * nodeType, widget }[]` — to be handed to restoreWidgetValues(). A widget already
 * coerced by an overlapping pass is joined (its refcount incremented) rather than
 * re-read, so an in-flight serialization never sees it revert. `button`-type
 * widgets (no serializable value) are skipped. Idempotent per pass.
 */
export function sanitizeNullWidgetValues(rootGraph) {
  const touched = [];
  if (!rootGraph) return touched;
  const stack = [...(rootGraph._nodes ?? rootGraph.nodes ?? [])];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const widgets = Array.isArray(node.widgets) ? node.widgets : [];
    for (const w of widgets) {
      if (!w) continue;
      const type = typeof w.type === "string" ? w.type.toLowerCase() : "";
      if (type === "button") continue; // no serializable value to repair
      const active = REG.get(w);
      const record = (entry) => ({
        ref: w,
        original: entry.original,
        coerced: entry.coerced,
        nodeId: node.id ?? null,
        nodeType: typeof node.type === "string" ? node.type : null,
        widget: typeof w.name === "string" ? w.name : null,
      });
      if (active) {
        // Already coerced by an overlapping pass — join its refcount so it can't
        // be restored out from under the in-flight serialization. Re-assert the
        // coercion if the value has since drifted BACK to null (a concurrent
        // write between the first coercion and this pass), so this pass's
        // serialization can never see null either.
        active.count++;
        if (w.value === null || w.value === undefined) w.value = active.coerced;
        touched.push(record(active));
      } else if (w.value === null || w.value === undefined) {
        const entry = { original: w.value, coerced: safeWidgetDefault(w), count: 1 };
        w.value = entry.coerced;
        REG.set(w, entry);
        touched.push(record(entry));
      }
    }
    const sub = node.subgraph?._nodes ?? node.subgraph?.nodes;
    if (Array.isArray(sub) && sub.length) stack.push(...sub);
  }
  return touched;
}

/**
 * Undo a sanitizeNullWidgetValues() pass. Decrements each widget's refcount and,
 * once it reaches zero (the last overlapping pass), restores the ORIGINAL value —
 * but ONLY if the widget still holds exactly the value we coerced it to, so an
 * edit made during the serialization window is never clobbered.
 */
export function restoreWidgetValues(touched) {
  if (!Array.isArray(touched)) return;
  for (const r of touched) {
    const w = r?.ref;
    if (!w) continue;
    const entry = REG.get(w);
    if (!entry) continue;
    if (--entry.count <= 0) {
      if (w.value === entry.coerced) w.value = entry.original; // don't clobber edits
      REG.delete(w);
    }
  }
}

// Marker so the wrap is installed at most once per app instance.
const INSTALLED = Symbol.for("comfyui-mcp.graphToPromptNullSafety");

/**
 * Idempotently wrap `app.graphToPrompt` so EVERY prompt build is null-safe:
 * before delegating to the original, coerce null/undefined widget values on the
 * graph being serialized; after it settles (resolve OR throw), restore the prior
 * values. Because the wrap is on the serializer itself, it protects the deferred
 * serialization that runs inside an already-active queue loop, and — via the
 * reference-counted registry — overlapping serializations of the same graph.
 * Returns true if the wrap is (now or already) installed, false if `app` has no
 * graphToPrompt to wrap.
 */
export function installGraphToPromptNullSafety(app) {
  if (!app || typeof app.graphToPrompt !== "function") return false;
  if (app[INSTALLED]) return true;
  // #1854 — early binding is load-bearing: app.graphToPrompt is replaced
  // below, so a call-time lookup would re-enter this wrapper and recurse.
  const graphToPromptFn = app.graphToPrompt;
  const orig = (...a) => rawApply(graphToPromptFn, app, a);
  app.graphToPrompt = async function nullSafeGraphToPrompt(graph, ...rest) {
    // graphToPrompt defaults its graph arg to the app's root graph; mirror that
    // so we sanitize exactly what the original is about to serialize.
    const target = graph ?? app.rootGraph ?? app.graph ?? null;
    const touched = sanitizeNullWidgetValues(target);
    if (touched.length) {
      console.warn(
        `[comfyui-mcp] null-safed ${touched.length} widget value(s) for prompt ` +
          `serialization, then restored them (VHS null-widget crash guard, #445)`,
      );
    }
    try {
      return await orig(graph, ...rest);
    } finally {
      restoreWidgetValues(touched);
    }
  };
  app[INSTALLED] = true;
  return true;
}
