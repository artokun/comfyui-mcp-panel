/**
 * Live LiteGraph mode writes for panel_set_node_mode.
 *
 * A stock LGraphNode stores `mode` as a data field, so `node.mode = 4` is the
 * whole write. rgthree's Mute / Bypass Repeater is not stock: the pack shadows
 * `mode` with an accessor that stores `rgthree_mode` and propagates in
 * `onModeChange` to every connected input (or, with no inputs, every other
 * node in its group). A plain assignment that never fires that setter reports
 * success on the wrapper while SaveVideo / other targets stay mute — and a
 * later repeater tick copies the wrapper's still-muted mode back onto them.
 *
 * This helper writes the requested node, walks owning repeaters and their
 * targets, pins `rgthree_mode` when that field exists, and refuses unless
 * every touched live mode matches. Fail-closed: a mismatch restores the
 * journalled modes before throwing.
 */

export const MODE_TO_NUM = Object.assign(Object.create(null), {
  active: 0,
  bypass: 4,
  mute: 2,
});
export const NUM_TO_MODE = { 0: "active", 2: "mute", 4: "bypass" };

export const NODE_MODE_REPEATER_TYPE = "Mute / Bypass Repeater (rgthree)";
export const NODE_MODE_RELAY_TYPE = "Mute / Bypass Relay (rgthree)";

export class NodeModeWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeModeWriteError";
  }
}

export function readLiveMode(node) {
  try {
    return typeof node?.mode === "number" ? node.mode : 0;
  } catch {
    // unknown-ok: an unreadable accessor is treated as active (LiteGraph default)
    return 0;
  }
}

export function modeName(num) {
  return NUM_TO_MODE[num] ?? num;
}

function runtimeNodeType(node) {
  try {
    if (typeof node?.type === "string") return node.type;
    if (typeof node?.constructor?.type === "string") return node.constructor.type;
  } catch {
    // unknown-ok: an unreadable third-party node is not a repeater
  }
  return "";
}

function isModePassThrough(node) {
  const type = runtimeNodeType(node);
  return type.includes("Reroute") || type.includes("Node Combiner") || type.includes("Node Collector");
}

function isRepeater(node) {
  return runtimeNodeType(node) === NODE_MODE_REPEATER_TYPE;
}

function linkRecord(graph, linkId) {
  try {
    const links = graph?.links ?? graph?._links;
    if (!links) return null;
    if (typeof links.get === "function") return links.get(linkId) ?? null;
    return links[linkId] ?? null;
  } catch {
    // unknown-ok: a hostile link store is treated as disconnected
    return null;
  }
}

function graphNodes(graph) {
  try {
    const nodes = graph?._nodes;
    if (Array.isArray(nodes)) return nodes;
    if (nodes && typeof nodes[Symbol.iterator] === "function") return [...nodes];
  } catch {
    // unknown-ok
  }
  return [];
}

function graphGroups(graph) {
  try {
    const groups = graph?._groups;
    if (Array.isArray(groups)) return groups;
    if (groups && typeof groups[Symbol.iterator] === "function") return [...groups];
  } catch {
    // unknown-ok
  }
  return [];
}

function groupMembers(group) {
  try {
    group?.recomputeInsideNodes?.();
    const children = group?._children;
    if (children == null) return [];
    return [...children];
  } catch {
    // unknown-ok
  }
  return [];
}

function describeNode(node) {
  return `${node?.id} (${node?.title ?? node?.type ?? "node"})`;
}

/**
 * Connected input origins of `node`, matching rgthree's
 * `getConnectedInputNodesAndFilterPassThroughs` walk: follow Reroute /
 * Node Combiner / Node Collector, skip disconnected slots.
 */
export function connectedInputNodes(node, graph) {
  const ordered = [];
  const seen = new Set();
  const walk = (current) => {
    let slots;
    try {
      slots = current?.inputs;
    } catch {
      return;
    }
    if (!Array.isArray(slots)) return;
    let g;
    try {
      g = current?.graph ?? graph;
    } catch {
      return;
    }
    for (const slot of slots) {
      let origin = null;
      try {
        const linkId = slot?.link;
        if (typeof linkId !== "number") continue;
        origin = g?.getNodeById?.(linkRecord(g, linkId)?.origin_id);
      } catch {
        continue;
      }
      if (!origin || seen.has(origin)) continue;
      seen.add(origin);
      if (isModePassThrough(origin)) walk(origin);
      else ordered.push(origin);
    }
  };
  walk(node);
  return ordered;
}

/**
 * Nodes a Mute / Bypass Repeater will stamp on mode change: non-relay connected
 * inputs, or (when none) the other members of any group that contains it.
 */
export function repeaterTargets(node, graph) {
  const linked = connectedInputNodes(node, graph).filter(
    (candidate) => runtimeNodeType(candidate) !== NODE_MODE_RELAY_TYPE,
  );
  if (linked.length) return linked;
  const targets = [];
  const seen = new Set();
  for (const group of graphGroups(graph ?? node?.graph)) {
    const members = groupMembers(group);
    if (!members.includes(node)) continue;
    for (const member of members) {
      if (!member || member === node || seen.has(member)) continue;
      seen.add(member);
      targets.push(member);
    }
  }
  return targets;
}

export function owningRepeaters(node, graph) {
  const g = graph ?? node?.graph;
  const owners = [];
  for (const candidate of graphNodes(g)) {
    if (!isRepeater(candidate) || candidate === node) continue;
    if (repeaterTargets(candidate, g).includes(node)) owners.push(candidate);
  }
  return owners;
}

function modeSetter(node) {
  try {
    const own = Object.getOwnPropertyDescriptor(node, "mode");
    if (typeof own?.set === "function") return own.set;
    const proto = Object.getPrototypeOf(node);
    if (proto && proto !== Object.prototype) {
      const inherited = Object.getOwnPropertyDescriptor(proto, "mode");
      if (typeof inherited?.set === "function") return inherited.set;
    }
  } catch {
    // unknown-ok: treat as a data field and fire onModeChange below
  }
  return null;
}

function pinRgthreeMode(node, target) {
  try {
    if ("rgthree_mode" in node) node.rgthree_mode = target;
  } catch {
    // unknown-ok: pin is best-effort; live read-back is authoritative
  }
}

function writeMode(node, target, previous) {
  const setter = modeSetter(node);
  node.mode = target;
  pinRgthreeMode(node, target);
  // A data-property write never runs rgthree's accessor, so onModeChange would
  // not fire. Invoke the pack hook ourselves in that case only — calling it
  // after a real setter would double-propagate, which is harmless but we
  // already walk targets explicitly.
  if (!setter && typeof node.onModeChange === "function") {
    try {
      node.onModeChange(previous, target);
    } catch {
      // unknown-ok: target walk + read-back report the live result
    }
  }
}

function restoreJournal(journal) {
  for (let i = journal.length - 1; i >= 0; i--) {
    const entry = journal[i];
    try {
      writeMode(entry.node, entry.previous, readLiveMode(entry.node));
    } catch {
      // unknown-ok: the throw below is the honest refusal
    }
  }
}

function collectFrontier(seed, graph) {
  const visited = new Set();
  const queue = [seed];
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (isRepeater(current)) {
      for (const target of repeaterTargets(current, graph)) queue.push(target);
    }
    for (const owner of owningRepeaters(current, graph)) queue.push(owner);
  }
  return visited;
}

/**
 * Write `target` (LiteGraph 0/2/4) onto `node` and every rgthree repeater
 * that owns it (and those repeaters' other targets). Returns the observed
 * previous/actual mode of `node`. Throws NodeModeWriteError after restoring
 * the journal if any touched node does not hold `target`.
 */
export function applyGraphNodeMode(node, target, graph) {
  const g = graph ?? node?.graph;
  const previous = readLiveMode(node);
  const journal = [];
  const seen = new Set();

  const stamp = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    const from = readLiveMode(candidate);
    journal.push({ node: candidate, previous: from });
    writeMode(candidate, target, from);
  };

  try {
    for (const candidate of collectFrontier(node, g)) stamp(candidate);

    const mismatched = journal.filter((entry) => readLiveMode(entry.node) !== target);
    if (mismatched.length) {
      restoreJournal(journal);
      const first = mismatched[0];
      if (first.node === node) {
        throw new NodeModeWriteError(
          `Node ${describeNode(node)} did not accept mode "${modeName(target)}": after the write it reads ` +
            `"${modeName(readLiveMode(node))}". Nothing is being reported as changed. ` +
            `Some node packs override \`mode\` to refuse or rewrite it — check the node on the ` +
            `canvas (panel_screenshot) and set the mode from ComfyUI's own menu if it must hold.`,
        );
      }
      throw new NodeModeWriteError(
        `Node ${describeNode(node)} did not keep mode "${modeName(target)}" on the live canvas: ` +
          `rgthree repeater target ${describeNode(first.node)} still reads "${modeName(readLiveMode(first.node))}". ` +
          `Nothing is being reported as changed.`,
      );
    }
  } catch (error) {
    if (error instanceof NodeModeWriteError) throw error;
    restoreJournal(journal);
    throw error;
  }

  const actual = readLiveMode(node);
  const propagated = journal
    .filter((entry) => entry.node !== node)
    .map((entry) => ({
      node_id: entry.node.id,
      previous_mode: modeName(entry.previous),
      mode: modeName(readLiveMode(entry.node)),
    }));
  return { previous, actual, propagated };
}
