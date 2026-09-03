import {
  describeTypedPrimitiveWidgets,
  registerLivePrimitiveWidgets,
  resyncLivePrimitiveWidgets,
} from "./primitive-dynamic-widgets.js";

const DYNAMIC_COMBO_V3 = "COMFY_DYNAMICCOMBO_V3";
const DYNAMIC_WIDGET_MISSING_RE = /Dynamic widget doesn't exist on node/i;
const GRAPH_TO_PROMPT_RECONCILE = Symbol.for("comfyui-mcp.graphToPromptDynamicReconcile");
const DYNAMIC_COMBO_PRESERVE_CHILDREN = Symbol.for("comfyui-mcp.dynamicComboPreserveChildren");
const rawApply = Reflect.apply;
// A DynamicCombo option tree is a handful of levels deep (SaveVideo: format → codec →
// encoding → crf). The bound exists so a self-referential definition cannot spin.
const DYNAMIC_COMBO_MAX_DEPTH = 8;

function hasValueSetter(widget) {
  try {
    let proto = widget;
    while (proto && proto !== Object.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc) return typeof desc.set === "function";
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  } catch {
    return false;
  }
}

function graphNodes(graph) {
  if (Array.isArray(graph?._nodes) && graph._nodes.length) return graph._nodes;
  if (Array.isArray(graph?.nodes)) return graph.nodes;
  return [];
}

function nodeDef(node) {
  return node?.constructor?.nodeData ?? node?.nodeData ?? null;
}

function readWidgetId(widget) {
  try {
    const widgetId = widget?.widgetId;
    return typeof widgetId === "string" && widgetId ? widgetId : null;
  } catch {
    return null;
  }
}

function storeCleanupAlias(dynamicRoot, widgetId, index) {
  return {
    name: `${dynamicRoot}.__cmcp_store_cleanup_${index}`,
    widgetId,
    onRemove() {},
  };
}

function isDynamicComboSpec(spec) {
  return Array.isArray(spec) && spec[0] === DYNAMIC_COMBO_V3;
}

function walkDynamicComboChildren(spec, visit) {
  if (!isDynamicComboSpec(spec)) return;
  const options = spec[1]?.options;
  if (!Array.isArray(options)) return;
  for (const option of options) {
    const inputs = option?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const group of ["required", "optional"]) {
      const groupInputs = inputs[group];
      if (!groupInputs || typeof groupInputs !== "object") continue;
      for (const [childName, childSpec] of Object.entries(groupInputs)) {
        if (typeof childName !== "string" || !childName) continue;
        visit(childName, childSpec);
        walkDynamicComboChildren(childSpec, visit);
      }
    }
  }
}

function nestedChildNamesByRoot(required) {
  const byRoot = new Map();
  if (!required || typeof required !== "object") return byRoot;
  for (const [name, spec] of Object.entries(required)) {
    if (!isDynamicComboSpec(spec)) continue;
    const children = new Set();
    walkDynamicComboChildren(spec, (childName) => children.add(childName));
    if (children.size) byRoot.set(name, children);
  }
  return byRoot;
}

/**
 * Bare names that exist only as children of a required DynamicCombo.
 *
 * SaveVideo's `codec` is declared under a chosen `format` option, not as its own
 * top-level input. A flattened optional/hidden copy of that child is not a
 * backend-declared row for remove_widget (#1931).
 *
 * @param {object} def
 * @returns {Set<string>}
 */
export function nestedDynamicComboChildNames(def) {
  const nested = new Set();
  const required = def?.input?.required;
  if (!required || typeof required !== "object") return nested;
  for (const children of nestedChildNamesByRoot(required).values()) {
    for (const name of children) nested.add(name);
  }
  return nested;
}

function isInternalRelocationName(name) {
  return typeof name === "string" && name.includes("__cmcp_");
}

function staleDynamicGroup(name, required, dynamicNames) {
  if (typeof name !== "string" || isInternalRelocationName(name)) return null;
  const parts = name.split(".");
  if (parts.length < 2) return null;

  // This is the one schema migration that needs cleanup here: an ordinary current
  // input can retain a dotted child whose path contains a CURRENT dynamic root (the
  // SaveVideo `format.codec` residue when `codec` itself is the required DynamicCombo).
  // The current definition proves both sides of that decision. Do not infer a root
  // from an arbitrary dotted accessor parent.
  const parent = parts[0];
  if (!Object.prototype.hasOwnProperty.call(required, parent) || dynamicNames.has(parent)) {
    return null;
  }
  const dynamicPart = parts.slice(1).find((part) => dynamicNames.has(part));
  return dynamicPart ?? null;
}

function orphanParentRoot(name, nestedByRoot, widgets) {
  if (typeof name !== "string" || isInternalRelocationName(name)) return null;
  const matches = [];
  for (const [root, children] of nestedByRoot) {
    if (name === root || name.startsWith(`${root}.`)) continue;
    const first = name.split(".")[0];
    if (children.has(first)) matches.push(root);
  }
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const first = name.split(".")[0];
  const withDotted = matches.find((root) =>
    widgets.some((widget) => widget?.name === `${root}.${first}`),
  );
  return withDotted ?? matches[0];
}

function isNestedChildName(name, nestedByRoot) {
  if (typeof name !== "string") return false;
  for (const children of nestedByRoot.values()) {
    if (children.has(name)) return true;
  }
  return false;
}

function capturePrefixedValues(node, rootName) {
  const values = new Map();
  for (const widget of node.widgets ?? []) {
    const name = widget?.name;
    if (typeof name !== "string" || isInternalRelocationName(name)) continue;
    if (!name.startsWith(`${rootName}.`)) continue;
    values.set(name, widget.value);
  }
  return values;
}

function liveWidgetByName(node, name) {
  let found = null;
  for (const widget of node?.widgets ?? []) {
    if (widget?.name === name) found = widget;
  }
  return found;
}

function restorePrefixedValues(node, values) {
  if (!values.size) return;
  const names = [...values.keys()].sort((a, b) => a.split(".").length - b.split(".").length);
  for (const name of names) {
    // #2140 — RE-RESOLVE for every name. This used to read one map built before the loop
    // started, and that map goes stale as the loop runs: restoring the shallowest child
    // (`format.codec`) drives a native rebuild that REPLACES every widget below it, so
    // each deeper name still pointed at a widget the node was no longer carrying. Two
    // things followed. The value went nowhere — a plain prompt build silently reset
    // SaveVideo's `format.codec.encoding.crf` to the schema default. And for a dynamic
    // child the write drove a DETACHED accessor, whose `updateWidgets` deletes the
    // group's rows and their widget-store entries BEFORE it checks that it is still
    // attached: it strips the live rows, then throws into the catch below.
    //
    // That is what separated the two recoveries #2140's reporter measured. A same-value
    // write runs this restore and did not recover the node; a real option round trip
    // skips it and did — on identical final widget values.
    const widget = liveWidgetByName(node, name);
    if (!widget) continue;
    const next = values.get(name);
    try {
      if (widget.value === next) continue;
      widget.value = next;
    } catch {
      // A restore that the native setter rejects is not a reason to fail the reconcile;
      // the rebuilt child already has the definition's default.
    }
  }
}

function valueDescriptor(widget) {
  try {
    let proto = widget;
    while (proto && proto !== Object.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc) return desc;
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    /* an unreadable widget is not wrappable */
  }
  return null;
}

/**
 * #2031 — native DynamicCombo value assignment DESTROYS dotted children and
 * recreates them from spec defaults. graphToPrompt re-assigns the parent combo
 * even when the selected option did not change (Vue v-model / serialize flush),
 * so a confirmed `mode.scale` write is rebuilt from `default: 2` after
 * panel_query_graph already showed 1.5.
 *
 * Wrap the setter so a SAME-VALUE assignment keeps live children (no rebuild)
 * and a stripped root still rebuilds. Changing the selected option still
 * rebuilds from the new option's spec.
 */
function wrapDynamicComboSetter(node, widget) {
  if (!widget) return;
  const desc = valueDescriptor(widget);
  if (!desc || typeof desc.set !== "function") return;
  // Mark the SETTER, not the widget. After reconnect the first serialize can
  // replace a store-backed accessor with native DynamicCombo `updateWidgets`;
  // a widget-level flag would skip resealing that new setter (#2033).
  if (desc.set[DYNAMIC_COMBO_PRESERVE_CHILDREN]) return;
  const origSet = desc.set;
  const origGet = typeof desc.get === "function" ? desc.get : null;
  const set = function preserveDynamicComboChildren(next) {
    let previous;
    try {
      previous = origGet ? origGet.call(this) : undefined;
    } catch {
      previous = undefined;
    }
    const preserved = capturePrefixedValues(node, widget.name);
    // #2033 — a same-value write whose dotted children are already live must not
    // run the native rebuild. That rebuild replaces the child widgets, so a later
    // queue-time snapshot restore still holding the captured child throws
    // `Dynamic widget doesn't exist on node`. A stripped root (preserved empty)
    // still needs the rebuild — that is the #2140 rescue.
    if (previous === next && preserved.size) return;
    origSet.call(this, next);
    if (previous === next) restorePrefixedValues(node, preserved);
  };
  set[DYNAMIC_COMBO_PRESERVE_CHILDREN] = true;
  Object.defineProperty(widget, "value", {
    configurable: true,
    enumerable: desc.enumerable !== false,
    get() {
      return origGet ? origGet.call(this) : undefined;
    },
    set,
  });
}

/** Seal live DynamicCombo value setters across `graph` and nested subgraphs. */
export function wrapGraphDynamicComboSetters(graph) {
  for (const node of graphNodes(graph)) {
    try {
      const required = nodeDef(node)?.input?.required;
      const dynamicNames = new Set();
      if (required && typeof required === "object") {
        for (const [name, spec] of Object.entries(required)) {
          if (isDynamicComboSpec(spec)) dynamicNames.add(name);
        }
      }
      for (const widget of node.widgets ?? []) {
        if (typeof widget?.name !== "string") continue;
        const isRoot = dynamicNames.has(widget.name);
        const hasChildren = (node.widgets ?? []).some(
          (candidate) =>
            candidate !== widget &&
            typeof candidate?.name === "string" &&
            candidate.name.startsWith(`${widget.name}.`),
        );
        if ((isRoot || hasChildren) && hasValueSetter(widget)) wrapDynamicComboSetter(node, widget);
      }
      if (node?.subgraph) wrapGraphDynamicComboSetters(node.subgraph);
    } catch {
      /* a hostile node must not block wrapping the rest of the graph */
    }
  }
}

/**
 * Re-run the native value setter for dynamic-combo roots on a newly-created node.
 *
 * COMFY_DYNAMICCOMBO_V3 installs its rebuild logic as an own `value` setter. The
 * constructor runs that setter before `graph.add`, when the widget-value store has no
 * node identity yet. Replaying the same value after registration makes the node's
 * dynamic rows and store state agree.
 *
 * Two schema-verified leftovers are routed through a current dynamic root so the
 * native setter removes them:
 *   - a dotted child of an ordinary current input (`format.codec` when `codec` is
 *     the required DynamicCombo — #2254)
 *   - a bare name that also exists as a nested child of a required DynamicCombo
 *     (`codec` next to `format.codec` when `format` is the required DynamicCombo —
 *     #1931). SaveVideo declares `codec` only under a chosen `format` option; a
 *     top-level `codec` widget is an orphan the queue-time serializer trips on.
 *
 * @param {object} node
 * @param {object} currentDef
 * @returns {{replayed: string[], relocated: string[], failures: Array<{name: string, phase: string, error: unknown}>, cleanupStore: () => {cleaned: boolean, error?: unknown}}}
 */
export function reconcileFreshDynamicWidgets(node, currentDef) {
  const required = currentDef?.input?.required;
  const widgets = Array.isArray(node?.widgets) ? node.widgets.slice() : [];
  const empty = {
    replayed: [],
    relocated: [],
    failures: [],
    cleanupStore: () => ({ cleaned: true }),
  };
  if (!required || typeof required !== "object" || !widgets.length) return empty;

  const dynamicNames = new Set(
    Object.entries(required)
      .filter(([, spec]) => isDynamicComboSpec(spec))
      .map(([name]) => name),
  );
  if (!dynamicNames.size) return empty;

  const nestedByRoot = nestedChildNamesByRoot(required);
  const byName = new Map(
    widgets
      .filter((widget) => typeof widget?.name === "string")
      .map((widget) => [widget.name, widget]),
  );
  const roots = new Set();
  const relocated = [];
  const failures = [];
  const relocatedWidgets = new Set();

  let relocationIndex = 0;
  const relocationByName = new Map();

  const relocateInto = (widget, dynamicRoot) => {
    const oldName = widget.name;
    const oldWidgetId = readWidgetId(widget);
    let replacement = relocationByName.get(oldName);
    if (!replacement) {
      replacement = `${dynamicRoot}.__cmcp_stale_${relocationIndex++}`;
      relocationByName.set(oldName, replacement);
    }
    try {
      widget.name = replacement;
      relocatedWidgets.add(widget);
      // Current LiteGraph widgets derive widgetId from name. graph.add() already
      // registered the old key, so renaming alone leaves that key behind and the
      // native setter would delete only the newly-derived key. Re-register the
      // renamed widget, then give native cleanup an alias carrying the original
      // key so both registrations are deleted by deleteWidget().
      if (oldWidgetId) {
        node.widgets.push(storeCleanupAlias(dynamicRoot, oldWidgetId, relocationIndex++));
      }
      if (typeof widget.setNodeId === "function" && node?.id != null) {
        widget.setNodeId(node.id);
      }
      relocated.push(oldName);
    } catch (error) {
      failures.push({ name: oldName, phase: "relocate", error });
    }
  };

  // A current dynamic root is the only accessor we are authorized to replay. Before
  // doing so, move a schema-verified leftover into that root's native group. This
  // lets the native setter call its own onRemove/widget-store deletion logic; simply
  // filtering node.widgets would leave a stale store entry behind.
  for (const widget of widgets) {
    const dynamicRoot = staleDynamicGroup(widget?.name, required, dynamicNames);
    if (!dynamicRoot) continue;
    relocateInto(widget, dynamicRoot);
  }
  for (const widget of widgets) {
    if (relocatedWidgets.has(widget)) continue;
    const dynamicRoot = orphanParentRoot(widget?.name, nestedByRoot, node.widgets ?? widgets);
    if (!dynamicRoot) continue;
    relocateInto(widget, dynamicRoot);
  }
  if (Array.isArray(node.inputs)) {
    for (const input of node.inputs) {
      const replacement = relocationByName.get(input?.name);
      if (replacement) input.name = replacement;
    }
  }

  // Current dynamic declarations must be replayed even when they have no stale rows.
  // A required name that is only a nested child of another required DynamicCombo is
  // the orphan we just relocated, not a missing root.
  for (const name of dynamicNames) {
    const widget = byName.get(name);
    if (!widget || relocatedWidgets.has(widget) || widget.name !== name) {
      if (isNestedChildName(name, nestedByRoot)) continue;
      if (!widget) {
        failures.push({ name, phase: "missing-root", error: new Error("dynamic widget root is missing") });
      }
      continue;
    }
    if (!hasValueSetter(widget)) {
      failures.push({ name, phase: "missing-setter", error: new Error("dynamic widget value setter is missing") });
      continue;
    }
    roots.add(widget);
  }

  const replayed = [];
  for (const widget of widgets) {
    if (!roots.has(widget) || !node.widgets.includes(widget) || !hasValueSetter(widget)) {
      continue;
    }
    const preserved = capturePrefixedValues(node, widget.name);
    try {
      const value = widget.value;
      widget.value = value;
      replayed.push(widget.name);
      restorePrefixedValues(node, preserved);
    } catch (error) {
      failures.push({ name: widget.name, phase: "setter", error });
    }
  }

  const cleanupStore = () => {
    const root = roots.values().next().value;
    if (!root) {
      return { cleaned: false, error: new Error("no verified dynamic root can clean widget-store entries") };
    }

    const widgetIds = new Set();
    for (const widget of node.widgets ?? []) {
      const widgetId = readWidgetId(widget);
      if (widgetId) widgetIds.add(widgetId);
    }
    const aliases = [];
    let aliasIndex = 0;
    for (const widgetId of widgetIds) {
      const alias = storeCleanupAlias(root.name, widgetId, `rollback_${aliasIndex++}`);
      aliases.push(alias);
      node.widgets.push(alias);
    }
    try {
      const value = root.value;
      root.value = value;
      const remaining = aliases.filter((alias) => node.widgets.includes(alias));
      return remaining.length
        ? { cleaned: false, error: new Error("native dynamic cleanup left widget-store aliases attached") }
        : { cleaned: true };
    } catch (error) {
      return { cleaned: false, error };
    }
  };

  return { replayed, relocated, failures, cleanupStore };
}

/**
 * Apply {@link reconcileFreshDynamicWidgets} to every node on a loaded graph.
 *
 * add_node and load share this materialiser: SaveVideo's nested `format.codec`
 * must exist and a bare orphan `codec` must not, whether the node was just
 * created or restored from a saved workflow.
 *
 * Failures are recorded per node and never thrown — a load of a 30-node graph
 * must not abort because one SaveVideo leftover could not be cleaned.
 *
 * @param {object} graph
 * @returns {Array<object>}
 */
export function reconcileGraphDynamicWidgets(graph) {
  const nodes = graphNodes(graph);
  const results = [];
  for (const node of nodes) {
    try {
      const def = nodeDef(node);
      if (def) results.push(reconcileFreshDynamicWidgets(node, def));
      if (node?.subgraph) results.push(...reconcileGraphDynamicWidgets(node.subgraph));
    } catch (error) {
      results.push({
        replayed: [],
        relocated: [],
        failures: [{ name: String(node?.type ?? node?.id ?? "node"), phase: "graph", error }],
        cleanupStore: () => ({ cleaned: false, error }),
      });
    }
  }
  return results;
}

/**
 * The child names a DynamicCombo option DECLARES for the currently selected key.
 *
 * `null` (not `[]`) when the spec is not a DynamicCombo or the live value names no
 * declared option — in both cases the definition proves nothing about what the node
 * should be carrying, so no conclusion is drawn.
 *
 * @param {unknown} spec
 * @param {unknown} selected
 * @returns {string[] | null}
 */
function selectedOptionChildNames(spec, selected) {
  if (!isDynamicComboSpec(spec)) return null;
  const option = selectedOption(spec, selected);
  if (!option) return null;
  const names = [];
  const inputs = option.inputs;
  if (inputs && typeof inputs === "object") {
    for (const group of ["required", "optional"]) {
      const groupInputs = inputs[group];
      if (!groupInputs || typeof groupInputs !== "object") continue;
      for (const childName of Object.keys(groupInputs)) {
        if (typeof childName === "string" && childName) names.push(childName);
      }
    }
  }
  return names;
}

function selectedOption(spec, selected) {
  const options = spec?.[1]?.options;
  if (!Array.isArray(options)) return null;
  return options.find((option) => option?.key === selected) ?? null;
}

function readWidgetValue(widget) {
  try {
    return { ok: true, value: widget.value };
  } catch {
    return { ok: false, value: undefined };
  }
}

function findWidgetByName(node, name) {
  for (const widget of Array.isArray(node?.widgets) ? node.widgets : []) {
    if (widget?.name === name) return widget;
  }
  return null;
}

function hasOwn(object, key) {
  return !!object && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);
}

function hasInputNamed(node, name) {
  for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
    if (input?.name === name) return true;
  }
  return false;
}

/**
 * Walk one required DynamicCombo root against the live widget rows.
 *
 * A root is UNRESOLVED when the option it currently selects declares a child the node is
 * not carrying. That is the observable signature of #2140. The native
 * `dynamicComboWidget` rebuild removes a group's rows — and deletes their widget-store
 * entries — BEFORE it checks that the accessor driving it is still attached to the node,
 * and only then throws `Dynamic widget doesn't exist on node`. So a rebuild driven
 * through a detached accessor strips the live rows and leaves a root whose declared
 * children simply are not there.
 *
 * `describeOrphanDynamicWidgets` cannot see that state: there is no orphan and no
 * residue to strip. That is why #2140 reached its reporter as a bare, node-less string
 * with `panel_get_errors` clean, and why they had to read the schema of 21 nodes to work
 * out which one the message was about.
 */
function collectUnresolvedDynamicCombos(node, rootName, spec, out, depth, required = true) {
  if (depth > DYNAMIC_COMBO_MAX_DEPTH) return;
  const widget = findWidgetByName(node, rootName);
  if (!widget) {
    // Only a REQUIRED top-level root earns its own entry. A nested child is already
    // reported in its parent's `missing` list, and an OPTIONAL root is allowed to have no
    // row at all — SaveVideo declares a hidden optional top-level `codec` that the #1931
    // relocate path deliberately removes, so reporting it absent would fire on every
    // healthy SaveVideo on the canvas.
    if (depth === 0 && required) {
      out.push({ root: rootName, selected: null, missing: [], reason: "root-missing" });
    }
    return;
  }
  const read = readWidgetValue(widget);
  if (!read.ok) return;
  const declared = selectedOptionChildNames(spec, read.value);
  if (!Array.isArray(declared)) return;
  const missing = [];
  for (const childName of declared) {
    const fullName = `${rootName}.${childName}`;
    if (findWidgetByName(node, fullName)) continue;
    // A declared child is not always a widget ROW. `addInputWidget` returns before
    // creating one when the input is forceInput or its type has no registered widget
    // constructor, leaving only the socket — legitimately absent from node.widgets. The
    // #2140 state removes the socket too, because the native sweep clears node.inputs
    // before node.widgets and throws before it can restore either. So a surviving socket
    // is the discriminator: it means this child was never meant to have a row.
    if (hasInputNamed(node, fullName)) continue;
    missing.push(fullName);
  }
  if (missing.length) {
    out.push({ root: rootName, selected: read.value, missing, reason: "children-missing" });
  }
  // A second, structurally unambiguous signature of a half-completed rebuild: the native
  // sweep removes a group's rows by NAME PREFIX and then appends the new ones, so two
  // live rows can never legitimately share one dotted child name. When they do, one of
  // them is a leftover the sweep did not reach, and the accessor that owns it is not the
  // one the node is carrying.
  const duplicated = [];
  const seen = new Set();
  for (const widget of Array.isArray(node?.widgets) ? node.widgets : []) {
    const name = widget?.name;
    if (typeof name !== "string" || !name.startsWith(`${rootName}.`)) continue;
    if (isInternalRelocationName(name)) continue;
    if (seen.has(name)) {
      if (!duplicated.includes(name)) duplicated.push(name);
      continue;
    }
    seen.add(name);
  }
  if (duplicated.length) {
    out.push({ root: rootName, selected: read.value, missing: duplicated, reason: "duplicate-rows" });
  }
  const option = selectedOption(spec, read.value);
  for (const group of ["required", "optional"]) {
    const groupInputs = option?.inputs?.[group];
    if (!groupInputs || typeof groupInputs !== "object") continue;
    for (const [childName, childSpec] of Object.entries(groupInputs)) {
      if (!isDynamicComboSpec(childSpec)) continue;
      const nestedName = `${rootName}.${childName}`;
      if (!findWidgetByName(node, nestedName)) continue;
      collectUnresolvedDynamicCombos(node, nestedName, childSpec, out, depth + 1);
    }
  }
}

/**
 * Nodes carrying a required DynamicCombo whose SELECTED option declares a child row the
 * node does not have.
 *
 * @param {object} graph
 * @returns {Array<{nodeId: unknown, nodeType: string, root: string, selected: unknown, missing: string[], reason: string}>}
 */
export function describeUnresolvedDynamicCombos(graph) {
  const found = [];
  for (const node of graphNodes(graph)) {
    try {
      const input = nodeDef(node)?.input;
      // BOTH groups. `reconcileFreshDynamicWidgets` reads only `required` because a
      // replay is an authorized WRITE; this is read-only naming, and a node whose
      // DynamicCombo is declared optional produces exactly the same bare, node-less
      // serializer throw. SaveVideo itself declares a top-level optional `codec`.
      for (const group of ["required", "optional"]) {
        const groupInputs = input?.[group];
        if (!groupInputs || typeof groupInputs !== "object") continue;
        for (const [name, spec] of Object.entries(groupInputs)) {
          if (!isDynamicComboSpec(spec)) continue;
          if (group === "optional" && hasOwn(input?.required, name)) continue;
          const perRoot = [];
          collectUnresolvedDynamicCombos(node, name, spec, perRoot, 0, group === "required");
          for (const entry of perRoot) {
            found.push({
              nodeId: node.id,
              nodeType: typeof node.type === "string" ? node.type : "node",
              ...entry,
            });
          }
        }
      }
      if (node?.subgraph) found.push(...describeUnresolvedDynamicCombos(node.subgraph));
    } catch {
      // A hostile node must not hide the rest of the graph.
    }
  }
  return found;
}

/**
 * Nodes that declare a required DynamicCombo at all — the LAST-RESORT identity.
 *
 * Used only when nothing more specific was found. Three candidate node ids is not a
 * diagnosis, but it is a bisection the reporter of #2140 did not have.
 *
 * @param {object} graph
 * @returns {Array<{nodeId: unknown, nodeType: string, roots: string[]}>}
 */
export function describeDynamicComboCandidates(graph) {
  const found = [];
  for (const node of graphNodes(graph)) {
    try {
      const input = nodeDef(node)?.input;
      const roots = [];
      for (const group of ["required", "optional"]) {
        const groupInputs = input?.[group];
        if (!groupInputs || typeof groupInputs !== "object") continue;
        for (const [name, spec] of Object.entries(groupInputs)) {
          if (!isDynamicComboSpec(spec) || roots.includes(name)) continue;
          // An optional root with no row is not a candidate to inspect — it is a
          // declaration the node was free not to materialise.
          if (group === "optional" && !findWidgetByName(node, name)) continue;
          roots.push(name);
        }
      }
      if (roots.length) {
        found.push({
          nodeId: node.id,
          nodeType: typeof node.type === "string" ? node.type : "node",
          roots,
        });
      }
      if (node?.subgraph) found.push(...describeDynamicComboCandidates(node.subgraph));
    } catch {
      // A hostile node must not hide the rest of the graph.
    }
  }
  return found;
}

export function isDynamicWidgetMissingError(error) {
  let raw = "";
  try {
    raw = error instanceof Error ? error.message : String(error ?? "");
  } catch {
    return false;
  }
  return DYNAMIC_WIDGET_MISSING_RE.test(raw);
}

/**
 * Nodes that still carry a schema-verified DynamicCombo orphan (bare `codec`
 * next to `format.codec` on SaveVideo). Used to name the serializer throw.
 *
 * @param {object} graph
 * @returns {Array<{nodeId: unknown, nodeType: string, orphan: string, nested: string}>}
 */
export function describeOrphanDynamicWidgets(graph) {
  const found = [];
  for (const node of graphNodes(graph)) {
    try {
      const required = nodeDef(node)?.input?.required;
      const nestedByRoot = nestedChildNamesByRoot(required);
      if (!nestedByRoot.size) {
        if (node?.subgraph) found.push(...describeOrphanDynamicWidgets(node.subgraph));
        continue;
      }
      const widgets = Array.isArray(node.widgets) ? node.widgets : [];
      const names = new Set();
      for (const widget of widgets) {
        if (typeof widget?.name === "string") names.add(widget.name);
      }
      for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
        if (typeof input?.name === "string") names.add(input.name);
      }
      for (const name of names) {
        const root = orphanParentRoot(name, nestedByRoot, widgets);
        if (!root) continue;
        found.push({
          nodeId: node.id,
          nodeType: typeof node.type === "string" ? node.type : "node",
          orphan: name,
          nested: `${root}.${name.split(".")[0]}`,
        });
      }
      if (node?.subgraph) found.push(...describeOrphanDynamicWidgets(node.subgraph));
    } catch {
      // A hostile node must not hide the rest of the graph.
    }
  }
  return found;
}

function namedDynamicWidgetError(error, graph) {
  const orphans = describeOrphanDynamicWidgets(graph);
  const primitives = describeTypedPrimitiveWidgets(graph);
  const unresolved = describeUnresolvedDynamicCombos(graph);
  const listedParts = [
    ...orphans.map(
      (entry) => `${entry.nodeType} node ${entry.nodeId} has ${entry.nested} and orphan ${entry.orphan}`,
    ),
    ...primitives.map(
      (entry) =>
        `${entry.nodeType} node ${entry.nodeId} has typed ${entry.outputType} ${entry.widgetName} widget`,
    ),
    // #2140 — the state that reached the reporter as a bare string: a DynamicCombo root
    // whose selected option declares children the node is not carrying. No orphan, no
    // residue, so neither describer above says anything about it.
    ...unresolved.map((entry) => {
      if (entry.reason === "root-missing") {
        return `${entry.nodeType} node ${entry.nodeId} is missing dynamic root ${entry.root}`;
      }
      const verb = entry.reason === "duplicate-rows" ? "has duplicate" : "is missing";
      return `${entry.nodeType} node ${entry.nodeId} ${entry.root}=${JSON.stringify(entry.selected)} ${verb} ${entry.missing.join(", ")}`;
    }),
  ];
  // Last resort. #2140's reporter had a clean panel_get_errors and a message naming no
  // node, and reconstructed the culprit by reading the schema of 21 nodes by hand. Three
  // candidate ids is not a diagnosis, but it is a place to start bisecting.
  if (!listedParts.length) {
    const candidates = describeDynamicComboCandidates(graph);
    if (candidates.length) {
      const named = candidates
        .slice(0, 3)
        .map((entry) => `${entry.nodeType} node ${entry.nodeId} (${entry.roots.join(", ")})`)
        .join("; ");
      const more = candidates.length > 3 ? ` and ${candidates.length - 3} more` : "";
      listedParts.push(`no node could be identified; dynamic-combo nodes on this graph: ${named}${more}`);
    }
  }
  let base = "";
  try {
    base = error instanceof Error ? error.message : String(error ?? "");
  } catch {
    base = "";
  }
  if (!listedParts.length) {
    return error instanceof Error ? error : new Error(base || "Dynamic widget doesn't exist on node");
  }
  const listed = listedParts.slice(0, 8).join("; ");
  const extra = listedParts.length > 8 ? ` (${listedParts.length - 8} more)` : "";
  const message =
    DYNAMIC_WIDGET_MISSING_RE.test(base) && !/\bnode\s+\d+/i.test(base)
      ? `Dynamic widget doesn't exist on node: ${listed}${extra}`
      : `${base} (${listed}${extra})`;
  const named = new Error(message);
  if (error instanceof Error) named.cause = error;
  return named;
}

function prepareLiveDynamicWidgets(graph) {
  try {
    registerLivePrimitiveWidgets(graph);
  } catch {
    // Best-effort: a hostile PrimitiveNode must not block serialization.
  }
  try {
    // #2031 — wrap before native serialize: graphToPrompt re-assigns DynamicCombo
    // roots, which would otherwise rebuild dotted children from spec defaults.
    wrapGraphDynamicComboSetters(graph);
    reconcileGraphDynamicWidgets(graph);
  } catch {
    // Best-effort: a hostile node must not block serialization.
  }
}

function sealLiveDynamicComboSetters(graph) {
  try {
    // #2033 — native graphToPrompt can INSTALL DynamicCombo accessors on the first
    // serialize after reconnect. Wrapping only before that call leaves those new
    // setters unsealed, and queue-time snapshot restore then detaches children.
    wrapGraphDynamicComboSetters(graph);
  } catch {
    // Best-effort: a hostile node must not block serialization.
  }
}

function retryLiveDynamicWidgets(graph) {
  try {
    resyncLivePrimitiveWidgets(graph);
  } catch {
    // Retry with whatever widgets are still live.
  }
  try {
    wrapGraphDynamicComboSetters(graph);
    reconcileGraphDynamicWidgets(graph);
  } catch {
    // Retry with whatever state we could clean.
  }
}

/**
 * Reconcile nested DynamicCombo leftovers and register live PrimitiveNode
 * widgets immediately before every prompt build, and retry once if the frontend
 * still throws the unnamed serializer error. add_node/load already clean what
 * they can; 0.15.124 recurrences still queued a graph that grew the orphan back
 * (set_widget, restore, restart). #2009 recurrences mint a PrimitiveNode
 * STRING widget after graph.add(), which reads and writes but is absent from
 * the serializer's widget-store schema.
 *
 * @param {object} app
 * @returns {boolean}
 */
export function installGraphToPromptDynamicReconcile(app) {
  if (!app || typeof app.graphToPrompt !== "function") return false;
  if (app[GRAPH_TO_PROMPT_RECONCILE]) return true;
  const graphToPromptFn = app.graphToPrompt;
  const orig = (...args) => rawApply(graphToPromptFn, app, args);
  app.graphToPrompt = function reconcileThenGraphToPrompt(graph, ...rest) {
    const target = graph ?? app.rootGraph ?? app.graph ?? null;
    prepareLiveDynamicWidgets(target);
    const retry = (error) => {
      if (!isDynamicWidgetMissingError(error)) throw error;
      retryLiveDynamicWidgets(target);
      try {
        const retried = orig(graph, ...rest);
        if (retried && typeof retried.then === "function") {
          return Promise.resolve(retried).then(
            (value) => {
              sealLiveDynamicComboSetters(target);
              return value;
            },
            (retryError) => {
              throw namedDynamicWidgetError(retryError, target);
            },
          );
        }
        sealLiveDynamicComboSetters(target);
        return retried;
      } catch (retryError) {
        throw namedDynamicWidgetError(retryError, target);
      }
    };
    try {
      const result = orig(graph, ...rest);
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).then((value) => {
          sealLiveDynamicComboSetters(target);
          return value;
        }, retry);
      }
      sealLiveDynamicComboSetters(target);
      return result;
    } catch (error) {
      return retry(error);
    }
  };
  app[GRAPH_TO_PROMPT_RECONCILE] = true;
  return true;
}
