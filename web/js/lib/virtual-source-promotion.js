/**
 * #1181 — a frontend-only VIRTUAL value source (the canvas PrimitiveNode) wired
 * INTO a promoted subgraph input never reaches the prompt.
 *
 * Reported on ComfyUI 0.32.0 / frontend 1.48.7: a PrimitiveNode connected to a
 * promoted STRING input on a subgraph showed the new value on the canvas, and
 * panel_query_graph reported the subgraph input as link-driven — but
 * `app.graphToPrompt` DROPS the virtual node, so the link carries nothing
 * across the subgraph boundary and the inner node's STORED widget value is what
 * serialized. The execution succeeded silently with the old prompt and reused
 * cached conditioning: canvas state and actual execution prompt disagreed. The
 * reporter verified the counterpart too — a BACKEND PrimitiveStringMultiline
 * wired the same way appears in the execution graph and drives the value.
 *
 * Native graphToPrompt still drops the virtual origin. panel_run now copies
 * promoted host-rail values and linked primitive payloads into the flattened
 * prompt so the inner stored widget is not what executes. This module is still
 * the detector for leftover PrimitiveNode feeds: stop asserting `driven_by_link`
 * (the stored value is stale) when the origin is virtual.
 *
 * WHY THE TARGET IS A SUBGRAPH CONTAINER: a top-level PrimitiveNode feeding an
 * ORDINARY node works — graphToPrompt resolves the primitive's value into the
 * consumer's widget. The value is lost only at the subgraph boundary, where the
 * promoted input's inner consumers are rewired to an origin that no longer
 * exists in the prompt. So `virtualFedInputs` fires on container inputs only.
 *
 * Read-only and dependency-free, like graph-read.js / muted-subgraph-outputs.js,
 * so it can be unit-tested in isolation
 * (browser_tests/unit/virtual-source-promotion.test.mjs). Nothing here mutates
 * the graph: the compile path patches the prompt object, not live widgets.
 */

/**
 * True when `node` is a frontend-only VIRTUAL value source whose output cannot
 * reach the serialized prompt: ComfyUI's graphToPrompt drops it, so a link from
 * it carries nothing.
 *
 * Two positive shapes, both deliberately narrow:
 *   1. type "PrimitiveNode" — the reported, verified case. The broader
 *      FRONTEND_ONLY_NODE_TYPES allowlist is NOT reused wholesale: Note has no
 *      outputs, a Reroute relays whatever is upstream (fine when the upstream
 *      is real), and KJNodes' Get/Set bus is resolved BY graphToPrompt — calling
 *      any of those "carries nothing" would be a false claim. GetNode/SetNode
 *      are therefore excluded by type even though a GetNode is virtual and has
 *      no connected input (its "value" widget is the bus NAME, not a payload).
 *   2. any OTHER litegraph virtual node (`isVirtualNode === true`) that is not a
 *      subgraph container and has NO connected input to forward — whatever it
 *      displays lives only in the frontend. A subgraph container is excluded
 *      explicitly: it is virtual too, but its outputs are COMPUTED from real
 *      inner nodes and serialize normally.
 */
export function isNonSerializingValueSource(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "GetNode" || node.type === "SetNode") return false;
  if (node.type === "PrimitiveNode") return true;
  if (node.isVirtualNode === true && !node.subgraph) {
    return !(node.inputs ?? []).some((i) => i?.link != null);
  }
  return false;
}

/** Resolve a node by id inside `graph`, tolerating both live-graph shapes. */
function nodeById(graph, id) {
  if (!graph || id == null) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(id) ?? null;
  const nodes = Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.find((n) => String(n?.id) === String(id)) ?? null;
}

/**
 * Map of input-name → { node_id, output_slot, origin_type } for every input on a
 * SUBGRAPH CONTAINER whose link origin is a non-serializing virtual source —
 * i.e. a promoted input that LOOKS fed but receives nothing at queue time.
 *
 * Keyed by input name so it composes with `linkDrivenWidgets`/`drivenWidgetsFor`
 * (same key space). `graph` defaults to `node.graph`; the graph walker passes it
 * explicitly because a container found mid-walk may not carry a back-pointer.
 * Never throws: a malformed link or missing origin yields fewer entries.
 */
export function virtualFedInputs(node, graph = node?.graph) {
  const out = {};
  if (!node?.subgraph) return out;
  const links = graph?.links ?? {};
  for (const inp of node.inputs ?? []) {
    if (!inp || inp.link == null || typeof inp.name !== "string") continue;
    const l = links[inp.link];
    if (!l) continue;
    // Support both object links ({origin_id,origin_slot}) and array links [id,os,...].
    const originId = l.origin_id ?? l[1];
    const originSlot = l.origin_slot ?? l[2];
    if (originId == null) continue;
    const origin = nodeById(graph, originId);
    if (!isNonSerializingValueSource(origin)) continue;
    out[inp.name] = {
      node_id: originId,
      output_slot: originSlot ?? 0,
      origin_type: typeof origin.type === "string" ? origin.type : null,
    };
  }
  return out;
}

/**
 * Walk every graph level, depth-first, and return one finding per promoted
 * subgraph input fed by a non-serializing virtual source. Used by `graph_run`
 * to say at QUEUE time that a run will ignore the canvas value.
 *
 * The cycle guard is PATH-LOCAL (a new Set per branch), matching
 * collectDisabledAncestorOutputs: one subgraph definition can be instanced more
 * than once, and a global visited set would consume the shared definition on
 * the first instance and miss the second. Fully defensive — a diagnostic must
 * never take down the run it describes.
 */
export function collectVirtualSourceFeeds(rootGraph) {
  const found = [];
  const walk = (graph, seenOnPath) => {
    if (!graph || seenOnPath.has(graph)) return;
    const nextSeen = new Set(seenOnPath);
    nextSeen.add(graph);
    const nodes = Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
    for (const node of nodes) {
      if (!node || node.id == null) continue;
      if (node.subgraph) {
        const fed = virtualFedInputs(node, graph);
        for (const [name, src] of Object.entries(fed)) {
          found.push({
            subgraph_node_id: String(node.id),
            subgraph_title: typeof node.title === "string" ? node.title : null,
            input_name: name,
            origin_id: String(src.node_id),
            origin_type: src.origin_type,
          });
        }
        walk(node.subgraph, nextSeen);
      }
    }
  };
  try {
    walk(rootGraph, new Set());
  } catch {
    /* partial findings beat none; never throw out of a diagnostic */
  }
  return found;
}

/**
 * The queue-time sentence. States what happens (the source is dropped, the
 * STORED inner value executes), that the panel is not the one deciding it, the
 * build it was measured on, and the remedy the reporter verified — a BACKEND
 * primitive carries the value across the same boundary.
 */
export function virtualSourceNote(feeds) {
  if (!Array.isArray(feeds) || feeds.length === 0) return "";
  const n = feeds.length;
  const which = feeds
    .slice(0, 5)
    .map(
      (f) =>
        `${f.origin_type ?? "virtual node"} #${f.origin_id} → subgraph #${f.subgraph_node_id} input "${f.input_name}"`,
    )
    .join("; ");
  const more = n > 5 ? `; and ${n - 5} more` : "";
  return (
    `This workflow feeds ${n} promoted subgraph input${n === 1 ? "" : "s"} from a frontend-only ` +
      `VIRTUAL node — ${which}${more}. ComfyUI's prompt compiler DROPS that source at the subgraph ` +
      `boundary, so the native flattened prompt would execute each inner node's STORED widget. ` +
      `panel_run compiles the linked PrimitiveNode/GetNode (or host-rail) value into those inner ` +
      `inputs so the stored fallback is not what executes (#1181). Replace the virtual source with ` +
      `a BACKEND node if you want the origin itself to appear in the prompt.`
  );
}

/**
 * The outline/compact-row counterpart of `drivenTag` for a widget whose link
 * origin is a non-serializing virtual source. The plain tag ("link-driven")
 * means "the stored value is stale, the link overrides it" — true for a real
 * source, exactly backwards for this one, so it needs its own words.
 */
export function virtualSourceTag(src) {
  if (!src) return "";
  return ` [⚠ virtual source #${src.node_id}.${src.output_slot} — NOT serialized; panel_run compiles the linked value into the prompt]`;
}

// ---------------------------------------------------------------------------
// Recurrence 2026-09-04: reporting was not enough. Krea2-style graphs promote
// width/height on the subgraph instance and wire an external primitive into a
// STRING input; graphToPrompt still serializes the INNER stored widgets. Patch
// the compiled prompt only — never the live graph (#979/#233).
// ---------------------------------------------------------------------------

const GRAPH_TO_PROMPT_VIRTUAL_APPLY = Symbol.for("comfyui-mcp.graphToPromptVirtualSourceApply");
const rawApply = Reflect.apply;

const SUBGRAPH_INPUT_RAIL_ID = -10;
const PRIMITIVE_OUTPUT_TYPES = new Set(["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO", "*"]);

function graphNodes(graph) {
  if (Array.isArray(graph?._nodes)) return graph._nodes;
  if (Array.isArray(graph?.nodes)) return graph.nodes;
  return [];
}

function promptMap(prompt) {
  if (prompt?.output && typeof prompt.output === "object" && !Array.isArray(prompt.output)) return prompt.output;
  if (prompt && typeof prompt === "object" && !Array.isArray(prompt) && prompt.output == null) {
    // Bare id→entry map (some callers pass graphToPrompt().output).
    const keys = Object.keys(prompt);
    if (keys.some((k) => prompt[k] && typeof prompt[k] === "object" && "class_type" in prompt[k])) return prompt;
  }
  return null;
}

function isPrimitivePayload(value) {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

function isLinkInput(value) {
  return Array.isArray(value) && value.length >= 2 && (typeof value[0] === "string" || typeof value[0] === "number");
}

function eachStoredLink(graph, visit) {
  const links = graph?.links;
  if (!links) return;
  const list = Array.isArray(links) ? links : Object.values(links);
  for (const l of list) {
    if (!l) continue;
    visit({
      originId: l.origin_id ?? l[1],
      originSlot: l.origin_slot ?? l[2],
      targetId: l.target_id ?? l[3],
      targetSlot: l.target_slot ?? l[4],
    });
  }
}

function widgetPayload(node) {
  if (!node || typeof node !== "object") return undefined;
  let widgets;
  try {
    widgets = Array.isArray(node.widgets) ? node.widgets : [];
  } catch {
    return undefined;
  }
  const named = widgets.find((w) => w && w.name === "value" && isPrimitivePayload(w.value));
  if (named) return named.value;
  for (const w of widgets) {
    if (!w || w.serialize === false) continue;
    if (w.name === "control_after_generate") continue;
    if (w.name === "Constant") continue;
    if (isPrimitivePayload(w.value)) return w.value;
  }
  return undefined;
}

function findSetNode(graph, name) {
  if (!graph || name == null || name === "") return null;
  const seen = new Set();
  let current = graph;
  while (current && !seen.has(current)) {
    seen.add(current);
    for (const node of graphNodes(current)) {
      if (node?.type === "SetNode" && node.widgets?.[0]?.value === name) return node;
    }
    const parent = current.parent ?? current._parent ?? null;
    current = parent && parent !== current ? parent : current.rootGraph && current.rootGraph !== current ? current.rootGraph : null;
  }
  return null;
}

function payloadFromConnectedInput(node, graph, seen) {
  const input = node?.inputs?.[0];
  if (!input || input.link == null) return undefined;
  const owner = node.graph ?? graph;
  const links = owner?.links ?? {};
  const link = Array.isArray(links)
    ? links.find((entry) => (entry?.id ?? entry?.[0]) === input.link)
    : links[input.link];
  if (!link) return undefined;
  const origin = nodeById(owner, link.origin_id ?? link[1]);
  return linkedSourcePayload(origin, owner, seen);
}

/**
 * A live widget payload that should appear in the compiled prompt when this
 * node feeds a subgraph input. GetNode/SetNode bus names are not payloads.
 * Backend primitives (PrimitiveStringMultiline, PrimitiveInt, …) ARE — they
 * serialize as real nodes at the root, but the subgraph flatten can still
 * leave the inner stored scalar in place.
 */
export function linkedSourcePayload(node, graph = node?.graph, seen = new Set()) {
  if (!node || typeof node !== "object") return undefined;
  if (seen.has(node) || seen.size > 16) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(node);
  if (node.subgraph) return undefined;
  if (node.type === "GetNode") {
    try {
      if (typeof node.getInputLink === "function") {
        const link = node.getInputLink(0);
        if (link) {
          const owner = node.graph ?? graph;
          const origin = nodeById(owner, link.origin_id ?? link[1]);
          const viaLink = linkedSourcePayload(origin, owner, nextSeen);
          if (viaLink !== undefined) return viaLink;
        }
      }
    } catch {
      /* GetNode helpers are best-effort */
    }
    const key = node.widgets?.[0]?.value;
    const setter = findSetNode(node.graph ?? graph, key);
    if (!setter) return undefined;
    return linkedSourcePayload(setter, setter.graph ?? graph, nextSeen);
  }
  if (node.type === "SetNode") {
    const viaInput = payloadFromConnectedInput(node, graph, nextSeen);
    if (viaInput !== undefined) return viaInput;
    return undefined;
  }
  if (node.type === "PrimitiveNode") return widgetPayload(node);
  const outType = node.outputs?.[0]?.type;
  if (typeof outType === "string" && outType && !PRIMITIVE_OUTPUT_TYPES.has(outType)) return undefined;
  return widgetPayload(node);
}

function isPassThroughInner(node) {
  if (!node || node.subgraph) return false;
  if (node.type === "Reroute" || node.type === "Reroute (rgthree)") return true;
  if (typeof node.type === "string" && /any switch/i.test(node.type)) return true;
  if (node.isVirtualNode === true && (node.inputs ?? []).some((i) => i?.link != null)) return true;
  return false;
}

function railOriginIds(subgraph) {
  const ids = new Set([SUBGRAPH_INPUT_RAIL_ID, "-10"]);
  const rail = subgraph?.inputNode ?? subgraph?._inputNode ?? null;
  if (rail?.id != null) {
    ids.add(rail.id);
    ids.add(String(rail.id));
  }
  return ids;
}

function innerConsumersFromRailSlot(subgraph, slotIndex) {
  const found = [];
  if (!subgraph || slotIndex == null) return found;
  const railIds = railOriginIds(subgraph);
  const seen = new Set();
  const queue = [];
  eachStoredLink(subgraph, (l) => {
    if (l.originSlot !== slotIndex && String(l.originSlot) !== String(slotIndex)) return;
    if (!railIds.has(l.originId) && !railIds.has(String(l.originId))) return;
    queue.push({ nodeId: l.targetId, slot: l.targetSlot });
  });
  while (queue.length) {
    const cur = queue.shift();
    const mark = `${cur.nodeId}:${cur.slot}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const node = nodeById(subgraph, cur.nodeId);
    if (!node) continue;
    const inp = node.inputs?.[cur.slot];
    found.push({ node, input: inp, slot: cur.slot });
    if (!isPassThroughInner(node)) continue;
    for (const [oi, out] of (node.outputs ?? []).entries()) {
      const outLinks = out?.links;
      if (Array.isArray(outLinks) && outLinks.length) {
        for (const linkId of outLinks) {
          const links = subgraph.links ?? {};
          const l = Array.isArray(links) ? links.find((x) => (x?.id ?? x?.[0]) === linkId) : links[linkId];
          if (!l) continue;
          queue.push({
            nodeId: l.target_id ?? l[3],
            slot: l.target_slot ?? l[4],
          });
        }
      } else {
        eachStoredLink(subgraph, (l) => {
          if (l.originId !== node.id && String(l.originId) !== String(node.id)) return;
          if (l.originSlot !== oi && String(l.originSlot) !== String(oi)) return;
          queue.push({ nodeId: l.targetId, slot: l.targetSlot });
        });
      }
    }
  }
  return found;
}

function innerWidgetTarget(host, widgetName) {
  const wanted = String(widgetName);
  const proxy = host?.properties?.proxyWidgets;
  if (Array.isArray(proxy)) {
    for (const entry of proxy) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      if (String(entry[1]) === wanted) {
        const inner = nodeById(host.subgraph, entry[0]);
        if (inner) return { node: inner, widgetName: String(entry[1]) };
      }
    }
  }
  const matches = [];
  for (const inner of graphNodes(host?.subgraph)) {
    const w = (inner?.widgets ?? []).find((x) => x?.name === wanted);
    if (w) matches.push({ node: inner, widgetName: wanted });
  }
  return matches.length === 1 ? matches[0] : null;
}

function writePromptInput(map, key, inputName, value) {
  const entry = map[key];
  if (!entry || typeof entry !== "object") return false;
  if (!entry.inputs || typeof entry.inputs !== "object") entry.inputs = {};
  const current = entry.inputs[inputName];
  if (isLinkInput(current)) {
    const originKey = String(current[0]);
    if (map[originKey]) return false;
  }
  if (Object.is(current, value)) return false;
  entry.inputs[inputName] = value;
  return true;
}

/**
 * Copy promoted instance rails and linked primitive payloads onto the
 * flattened prompt entries. Mutates `prompt` in place; never touches live
 * widgets. Returns the number of inputs rewritten.
 */
export function applyLinkedSubgraphValuesToPrompt(rootGraph, prompt) {
  const map = promptMap(prompt);
  if (!map || !rootGraph) return 0;
  let patched = 0;
  const walk = (graph, path, seenOnPath) => {
    if (!graph || seenOnPath.has(graph)) return;
    const nextSeen = new Set(seenOnPath);
    nextSeen.add(graph);
    for (const node of graphNodes(graph)) {
      if (!node?.subgraph) continue;
      const hostPath = path.concat(node.id);
      try {
        for (const w of node.widgets ?? []) {
          if (!w || typeof w.name !== "string" || w.serialize === false) continue;
          if (w.name === "control_after_generate") continue;
          if (!isPrimitivePayload(w.value)) continue;
          const target = innerWidgetTarget(node, w.name);
          if (!target) continue;
          const innerKey = hostPath.map((p) => String(p)).concat(String(target.node.id)).join(":");
          if (writePromptInput(map, innerKey, target.widgetName, w.value)) patched += 1;
        }
      } catch {
        /* one hostile rail must not block the rest */
      }
      try {
        for (const [index, inp] of (node.inputs ?? []).entries()) {
          if (!inp || inp.link == null) continue;
          const links = graph.links ?? {};
          const l = links[inp.link];
          if (!l) continue;
          const originId = l.origin_id ?? l[1];
          const origin = nodeById(graph, originId);
          const payload = linkedSourcePayload(origin);
          if (payload === undefined) continue;
          const slotIndex = inp._subgraphSlot?.index ?? index;
          for (const consumer of innerConsumersFromRailSlot(node.subgraph, slotIndex)) {
            const name = consumer.input?.name ?? consumer.input?.widget?.name;
            const widgetName =
              (typeof consumer.input?.widget?.name === "string" && consumer.input.widget.name) ||
              (typeof name === "string" && name) ||
              null;
            if (!widgetName) continue;
            const hasWidget =
              consumer.input?.widget != null ||
              (consumer.node.widgets ?? []).some((w) => w?.name === widgetName);
            if (!hasWidget) continue;
            const innerKey = hostPath.map((p) => String(p)).concat(String(consumer.node.id)).join(":");
            if (writePromptInput(map, innerKey, widgetName, payload)) patched += 1;
          }
        }
      } catch {
        /* one hostile input must not block the rest */
      }
      walk(node.subgraph, hostPath, nextSeen);
    }
  };
  try {
    walk(rootGraph, [], new Set());
  } catch {
    /* partial patch beats none */
  }
  return patched;
}

/**
 * Wrap `app.graphToPrompt` so every compiled prompt (preflight AND the deferred
 * queue-loop serialize) carries promoted rails and linked primitive payloads
 * across subgraph boundaries. Idempotent. Does not mutate the live graph.
 */
export function installGraphToPromptVirtualSourceApply(app) {
  if (!app || typeof app.graphToPrompt !== "function") return false;
  if (app[GRAPH_TO_PROMPT_VIRTUAL_APPLY]) return true;
  const graphToPromptFn = app.graphToPrompt;
  const orig = (...a) => rawApply(graphToPromptFn, app, a);
  app.graphToPrompt = function applyVirtualSourcesThenGraphToPrompt(graph, ...rest) {
    const target = graph ?? app.rootGraph ?? app.graph ?? null;
    const finish = (value) => {
      try {
        applyLinkedSubgraphValuesToPrompt(target, value);
      } catch {
        /* a patch must never take down serialization */
      }
      return value;
    };
    const result = orig(graph, ...rest);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(finish);
    }
    return finish(result);
  };
  app[GRAPH_TO_PROMPT_VIRTUAL_APPLY] = true;
  return true;
}
