/**
 * #2005 — `panel_save_subgraph` publishes through ComfyUI's subgraph store,
 * which validates `properties.proxyWidgets` as an array of string tuples
 * (`[nodeId, widgetName]` or `[nodeId, widgetName, extra]`). A legacy-store
 * promote — the path `panel_promote_widget` takes when the widget has no
 * connectable slot — writes `[{ sourceNodeId, sourceWidgetName }, null]`
 * instead, and publish throws:
 *
 *   Invalid assignment for properties.proxyWidgets: Validation error:
 *   Expected string, received object at "[n][0]"; Expected string,
 *   received null at "[n][1]"
 *
 * The publisher is the frontend; this module cannot change its schema. It
 * rewrites the live node's metadata to the string form the schema wants,
 * but only when that rewrite is a proven lossless mapping of the same
 * promotions. A guess would publish a blueprint whose promoted widgets are
 * not the ones the instance actually has.
 *
 * Null placeholders are dropped. Object entries are resolved to a concrete
 * inner node id and widget name. If either step cannot be proved against the
 * live subgraph, the save is refused with the affected names and a repair
 * action — before `publishSubgraph` is invoked.
 */

function asNodeId(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asWidgetName(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cloneValue(value) {
  if (value == null || typeof value !== "object") return value;
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    /* JSON fallback below */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function valuesMatch(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function innerNodes(subgraphNode) {
  const subgraph = subgraphNode?.subgraph;
  if (!subgraph || typeof subgraph !== "object") return [];
  if (Array.isArray(subgraph._nodes)) return subgraph._nodes;
  if (Array.isArray(subgraph.nodes)) return subgraph.nodes;
  return [];
}

function innerNodeById(subgraphNode, nodeId) {
  if (nodeId == null) return null;
  const subgraph = subgraphNode?.subgraph;
  if (subgraph && typeof subgraph.getNodeById === "function") {
    try {
      const found = subgraph.getNodeById(nodeId);
      if (found) return found;
    } catch {
      /* fall through to a numeric / list lookup */
    }
    if (typeof nodeId === "string" && /^-?(?:0|[1-9]\d*)$/.test(nodeId)) {
      try {
        const byNumber = subgraph.getNodeById(Number(nodeId));
        if (byNumber) return byNumber;
      } catch {
        /* list lookup below */
      }
    }
  }
  const want = String(nodeId);
  return innerNodes(subgraphNode).find((node) => String(node?.id) === want) ?? null;
}

function nodeHasWidget(node, widgetName) {
  if (!node || !asWidgetName(widgetName)) return false;
  try {
    return (node.widgets ?? []).some((widget) => widget?.name === widgetName);
  } catch {
    return false;
  }
}

function looksLikeGraphNode(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Array.isArray(obj.widgets) || Array.isArray(obj.inputs) || obj.subgraph) return true;
  return false;
}

function identifiersFromObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  // A live graph node often has a title `name` that is NOT a widget. Never
  // take obj.name as a widget identifier on that shape — the paired tuple
  // slot (or sourceWidgetName/widgetName) is the widget.
  if (looksLikeGraphNode(obj)) {
    const fromNode = asNodeId(obj.id);
    const widgetName = asWidgetName(obj.sourceWidgetName ?? obj.widgetName);
    if (fromNode && widgetName) return { nodeId: fromNode, widgetName };
    if (fromNode) return { nodeId: fromNode, widgetName: null };
  }
  const nodeId = asNodeId(
    obj.sourceNodeId ?? obj.interiorNodeId ?? obj.nodeId ?? obj.node?.id,
  );
  const widgetName = asWidgetName(obj.sourceWidgetName ?? obj.widgetName ?? obj.name);
  if (nodeId && widgetName) return { nodeId, widgetName };
  if (nodeId || widgetName) return { nodeId, widgetName };
  return null;
}

function findWidgetByIdentity(subgraphNode, widgetObj) {
  if (!widgetObj || typeof widgetObj !== "object") return [];
  const hits = [];
  for (const node of innerNodes(subgraphNode)) {
    let widgets;
    try {
      widgets = node?.widgets;
    } catch {
      continue;
    }
    if (!Array.isArray(widgets)) continue;
    for (const widget of widgets) {
      if (widget === widgetObj && asNodeId(node?.id) && asWidgetName(widget?.name)) {
        hits.push({ nodeId: asNodeId(node.id), widgetName: widget.name });
      }
    }
  }
  return hits;
}

function findWidgetByUniqueName(subgraphNode, widgetName) {
  const name = asWidgetName(widgetName);
  if (!name) return null;
  const hits = [];
  const seen = new Set();
  for (const node of innerNodes(subgraphNode)) {
    const nodeId = asNodeId(node?.id);
    if (!nodeId || !nodeHasWidget(node, name)) continue;
    const key = `${nodeId}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ nodeId, widgetName: name });
  }
  return hits.length === 1 ? hits[0] : null;
}

function isNullPlaceholder(entry) {
  if (entry == null) return true;
  if (!Array.isArray(entry)) return false;
  if (entry.length === 0) return true;
  return entry.every((slot) => slot == null);
}

function canonicalTuple(nodeId, widgetName, extra) {
  const id = asNodeId(nodeId);
  const name = asWidgetName(widgetName);
  if (!id || !name) return null;
  if (extra === undefined || extra == null) return [id, name];
  if (typeof extra === "string") return [id, name, extra];
  return null;
}

function tupleFromCanonicalSlots(entry) {
  if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) return null;
  if (entry.length === 3) return canonicalTuple(entry[0], entry[1], entry[2]);
  return canonicalTuple(entry[0], entry[1]);
}

/**
 * Resolve one proxyWidgets entry to a string tuple, or classify it as a
 * droppable placeholder / unreadable.
 *
 * @returns {{
 *   kind: "keep" | "drop" | "resolve" | "refuse",
 *   tuple?: string[],
 *   nodeId?: string | null,
 *   widgetName?: string | null,
 *   reason?: string,
 * }}
 */
export function classifyLegacyProxyWidgetEntry(entry, subgraphNode) {
  if (isNullPlaceholder(entry)) return { kind: "drop" };

  const already = tupleFromCanonicalSlots(entry);
  if (already) {
    const changed =
      already[0] !== entry[0] ||
      already[1] !== entry[1] ||
      (already.length === 3 && already[2] !== entry[2]) ||
      already.length !== entry.length;
    return {
      kind: changed ? "resolve" : "keep",
      tuple: already,
      nodeId: already[0],
      widgetName: already[1],
    };
  }

  if (!Array.isArray(entry)) {
    if (entry && typeof entry === "object") {
      const identified = resolveObjectEntry(entry, null, subgraphNode);
      if (identified?.tuple) {
        return {
          kind: "resolve",
          tuple: identified.tuple,
          nodeId: identified.nodeId,
          widgetName: identified.widgetName,
        };
      }
      return {
        kind: "refuse",
        nodeId: identified?.nodeId ?? null,
        widgetName: identified?.widgetName ?? null,
        reason: identified?.reason ?? "legacy object entry had no inner node id and widget name",
      };
    }
    return { kind: "refuse", reason: "proxyWidgets entry was not a [nodeId, widgetName] tuple" };
  }

  if (entry.length > 3) {
    return { kind: "refuse", reason: "proxyWidgets tuple had more than three slots" };
  }

  const first = entry[0];
  const second = entry[1] === undefined ? null : entry[1];
  const extra = entry.length === 3 ? entry[2] : undefined;

  if (first != null && typeof first === "object" && !Array.isArray(first)) {
    const identified = resolveObjectEntry(first, second, subgraphNode);
    if (identified?.tuple) {
      const tuple =
        extra === undefined || extra == null
          ? identified.tuple
          : canonicalTuple(identified.tuple[0], identified.tuple[1], extra);
      if (!tuple) {
        return {
          kind: "refuse",
          nodeId: identified.nodeId,
          widgetName: identified.widgetName,
          reason: "legacy object entry resolved, but the third tuple slot was not a string",
        };
      }
      return {
        kind: "resolve",
        tuple,
        nodeId: identified.nodeId,
        widgetName: identified.widgetName,
      };
    }
    return {
      kind: "refuse",
      nodeId: identified?.nodeId ?? asNodeId(second) ?? null,
      widgetName: identified?.widgetName ?? asWidgetName(second) ?? null,
      reason: identified?.reason ?? "legacy object/null entry could not be resolved to [innerNodeId, widgetName]",
    };
  }

  if (second != null && typeof second === "object" && !Array.isArray(second)) {
    const nodeId = asNodeId(first);
    const identified = resolveObjectEntry(second, null, subgraphNode);
    const widgetName = identified?.widgetName ?? asWidgetName(second?.name);
    const tuple = canonicalTuple(nodeId ?? identified?.nodeId, widgetName, extra);
    if (tuple) {
      return {
        kind: "resolve",
        tuple,
        nodeId: tuple[0],
        widgetName: tuple[1],
      };
    }
    return {
      kind: "refuse",
      nodeId: nodeId ?? identified?.nodeId ?? null,
      widgetName: widgetName ?? null,
      reason: "legacy [id, object] entry could not be resolved to a widget name",
    };
  }

  const coerced = canonicalTuple(first, second, extra);
  if (coerced) {
    return {
      kind: "resolve",
      tuple: coerced,
      nodeId: coerced[0],
      widgetName: coerced[1],
    };
  }

  return {
    kind: "refuse",
    nodeId: asNodeId(first),
    widgetName: asWidgetName(second),
    reason: "proxyWidgets entry was not a string tuple and could not be coerced",
  };
}

function resolveObjectEntry(obj, pairedSlot, subgraphNode) {
  const identityHits = findWidgetByIdentity(subgraphNode, obj);
  if (identityHits.length === 1) {
    const pairedName = asWidgetName(pairedSlot);
    if (pairedName && pairedName !== identityHits[0].widgetName) {
      return { reason: "live widget object disagreed with the paired widget name" };
    }
    return {
      tuple: [identityHits[0].nodeId, identityHits[0].widgetName],
      nodeId: identityHits[0].nodeId,
      widgetName: identityHits[0].widgetName,
    };
  }
  if (identityHits.length > 1) {
    return { reason: "live widget object matched more than one inner node" };
  }

  const extracted = identifiersFromObject(obj);
  const pairedName = asWidgetName(pairedSlot);
  const pairedId = asNodeId(pairedSlot);
  const nodeId = extracted?.nodeId ?? pairedId;
  const widgetName = extracted?.widgetName ?? pairedName;
  if (nodeId && widgetName) {
    return { tuple: [nodeId, widgetName], nodeId, widgetName };
  }

  if (widgetName && !nodeId) {
    const unique = findWidgetByUniqueName(subgraphNode, widgetName);
    if (unique) return { tuple: [unique.nodeId, unique.widgetName], ...unique };
    return { widgetName, reason: "object named a widget but not which inner node owns it" };
  }
  if (nodeId && !widgetName) {
    return { nodeId, reason: "object named an inner node but not which widget to promote" };
  }
  return { reason: "legacy object entry had no inner node id and widget name" };
}

function liveProof(subgraphNode, nodeId, widgetName) {
  const inner = innerNodeById(subgraphNode, nodeId);
  if (inner && nodeHasWidget(inner, widgetName)) return true;
  // Host-level promotions persist as node id "-1". They have no inner node;
  // the parent rail of that name is the proof.
  if (String(nodeId) === "-1") {
    try {
      const rails = subgraphNode?.widgets;
      if (Array.isArray(rails) && rails.some((rail) => rail?.name === widgetName)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Normalize `properties.proxyWidgets` to the string-only schema.
 *
 * @param {unknown} raw
 * @param {{ subgraphNode?: object, requireLiveProof?: boolean }} [opts]
 * @returns {{
 *   ok: true,
 *   tuples: string[][],
 *   changed: boolean,
 *   resolved: number,
 *   dropped: number,
 * } | {
 *   ok: false,
 *   affected: Array<{ index: number, nodeId: string | null, widgetName: string | null, reason: string }>,
 * }}
 */
export function normalizeLegacyProxyWidgets(raw, { subgraphNode, requireLiveProof = true } = {}) {
  if (raw == null) {
    return { ok: true, tuples: [], changed: false, resolved: 0, dropped: 0 };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      affected: [
        {
          index: -1,
          nodeId: null,
          widgetName: null,
          reason: "properties.proxyWidgets was present but not an array",
        },
      ],
    };
  }

  const tuples = [];
  const affected = [];
  let resolved = 0;
  let dropped = 0;
  let changed = false;

  for (let index = 0; index < raw.length; index += 1) {
    const classified = classifyLegacyProxyWidgetEntry(raw[index], subgraphNode);
    if (classified.kind === "drop") {
      dropped += 1;
      changed = true;
      continue;
    }
    if (classified.kind === "refuse" || !classified.tuple) {
      affected.push({
        index,
        nodeId: classified.nodeId ?? null,
        widgetName: classified.widgetName ?? null,
        reason: classified.reason ?? "unreadable proxyWidgets entry",
      });
      continue;
    }
    // Already-canonical tuples are the live node's own metadata — do not
    // re-prove them. Live proof is for a rewrite we are about to invent.
    if (
      classified.kind === "resolve" &&
      requireLiveProof &&
      subgraphNode &&
      !liveProof(subgraphNode, classified.tuple[0], classified.tuple[1])
    ) {
      affected.push({
        index,
        nodeId: classified.tuple[0],
        widgetName: classified.tuple[1],
        reason:
          "resolved to [innerNodeId, widgetName] but that inner widget is not on the live subgraph, so the mapping is not proven",
      });
      continue;
    }
    if (classified.kind === "resolve") {
      resolved += 1;
      changed = true;
    }
    tuples.push(classified.tuple);
  }

  if (affected.length) return { ok: false, affected };
  return { ok: true, tuples, changed, resolved, dropped };
}

function snapshotPromotedBindings(node) {
  const widgets = [];
  const inputs = [];
  try {
    const rails = node?.widgets;
    if (Array.isArray(rails)) {
      for (const rail of rails) {
        if (!rail || typeof rail.name !== "string" || !rail.name) continue;
        let value;
        try {
          value = cloneValue(rail.value);
        } catch {
          return null;
        }
        let widgetId = null;
        try {
          widgetId = typeof rail.widgetId === "string" && rail.widgetId ? rail.widgetId : null;
        } catch {
          widgetId = null;
        }
        widgets.push({ name: rail.name, value, widgetId });
      }
    }
  } catch {
    return null;
  }
  try {
    const slots = node?.inputs;
    if (Array.isArray(slots)) {
      for (const slot of slots) {
        if (!slot || typeof slot.name !== "string" || !slot.name) continue;
        inputs.push({
          name: slot.name,
          link: slot.link ?? null,
          widgetId: typeof slot.widgetId === "string" && slot.widgetId ? slot.widgetId : null,
        });
      }
    }
  } catch {
    return null;
  }
  return { widgets, inputs };
}

function bindingsPreserved(before, after) {
  if (!before || !after) return false;
  for (const rail of before.widgets) {
    const found = after.widgets.find((entry) => entry.name === rail.name);
    if (!found) return false;
    if (!valuesMatch(found.value, rail.value)) return false;
    if (rail.widgetId && found.widgetId && found.widgetId !== rail.widgetId) return false;
  }
  for (const slot of before.inputs) {
    const found = after.inputs.find((entry) => entry.name === slot.name);
    if (!found) return false;
    if (!Object.is(found.link, slot.link)) return false;
    if (slot.widgetId && found.widgetId && found.widgetId !== slot.widgetId) return false;
  }
  return true;
}

function readRawProxyWidgets(node) {
  try {
    return node?.properties?.proxyWidgets;
  } catch {
    return { unreadable: true };
  }
}

function writeProxyWidgets(node, tuples) {
  if (!node.properties || typeof node.properties !== "object") {
    node.properties = { proxyWidgets: tuples };
    return;
  }
  node.properties.proxyWidgets = tuples;
}

export function legacyProxyWidgetsRefusalMessage(affected) {
  const named = (affected ?? [])
    .map((entry) => {
      const indexBit = entry.index >= 0 ? `index ${entry.index}` : "the whole property";
      const who =
        entry.nodeId && entry.widgetName
          ? `inner node ${entry.nodeId} widget "${entry.widgetName}"`
          : entry.nodeId
            ? `inner node ${entry.nodeId}`
            : entry.widgetName
              ? `widget "${entry.widgetName}"`
              : "an unnamed entry";
      return `${who} (${indexBit}: ${entry.reason})`;
    })
    .join("; ");
  const repairTargets = (affected ?? []).filter((entry) => entry.nodeId && entry.widgetName);
  const repair =
    repairTargets.length > 0
      ? `Repair: panel_enter_subgraph on this subgraph node, then ` +
        repairTargets
          .map(
            (entry) =>
              `panel_promote_widget({node_id: ${JSON.stringify(entry.nodeId)}, widget: ${JSON.stringify(entry.widgetName)}, demote: true})`,
          )
          .join(" and ") +
        ` to drop the invalid promotion, then retry panel_save_subgraph.`
      : `Repair: panel_enter_subgraph on this subgraph node, demote widgets that were promoted via the legacy store, then retry panel_save_subgraph.`;
  return (
    `panel_save_subgraph cannot publish this subgraph: properties.proxyWidgets has ` +
    `legacy object/null metadata that could not be mapped losslessly to [innerNodeId, widgetName] ` +
    `strings${named ? `: ${named}` : ""}. ${repair} ` +
    `Do not publish until the metadata is string tuples.`
  );
}

/**
 * Rewrite a subgraph node's `properties.proxyWidgets` to the string-only
 * schema, or throw a repairable refusal. No-op when the property is absent
 * or already canonical. Restores the previous value if applying the rewrite
 * would drop a promoted value or rail binding.
 *
 * @param {object} subgraphNode
 * @returns {{ changed: boolean, resolved: number, dropped: number }}
 */
export function prepareSubgraphProxyWidgetsForPublish(subgraphNode) {
  const raw = readRawProxyWidgets(subgraphNode);
  if (raw && typeof raw === "object" && raw.unreadable) {
    throw new Error(
      `panel_save_subgraph cannot publish this subgraph: properties.proxyWidgets could not be read, ` +
        `so the blueprint validator's string-tuple schema cannot be proved. Repair: inspect the ` +
        `subgraph node's properties.proxyWidgets, demote any legacy promotions, then retry.`,
    );
  }
  if (raw === undefined) return { changed: false, resolved: 0, dropped: 0 };

  const normalized = normalizeLegacyProxyWidgets(raw, { subgraphNode, requireLiveProof: true });
  if (!normalized.ok) {
    throw new Error(legacyProxyWidgetsRefusalMessage(normalized.affected));
  }
  if (!normalized.changed) return { changed: false, resolved: 0, dropped: 0 };

  const before = snapshotPromotedBindings(subgraphNode);
  if (!before) {
    throw new Error(
      `panel_save_subgraph cannot publish this subgraph: promoted widget values and rail bindings ` +
        `could not be snapshotted, so rewriting properties.proxyWidgets cannot be proved lossless. ` +
        `Repair: panel_enter_subgraph on this node, demote widgets promoted via the legacy store, ` +
        `then retry panel_save_subgraph.`,
    );
  }

  try {
    writeProxyWidgets(subgraphNode, normalized.tuples);
  } catch (error) {
    throw new Error(
      `panel_save_subgraph cannot publish this subgraph: writing the normalized string-tuple ` +
        `properties.proxyWidgets failed (${error instanceof Error ? error.message : String(error)}). ` +
        `Repair: panel_enter_subgraph on this node, demote widgets promoted via the legacy store, ` +
        `then retry panel_save_subgraph.`,
    );
  }

  const after = snapshotPromotedBindings(subgraphNode);
  if (!after || !bindingsPreserved(before, after)) {
    try {
      writeProxyWidgets(subgraphNode, raw);
    } catch {
      /* restore is best-effort; the refusal still stands */
    }
    throw new Error(
      `panel_save_subgraph cannot publish this subgraph: normalizing properties.proxyWidgets to ` +
        `string tuples would not preserve promoted values or rail bindings. ` +
        `Repair: panel_enter_subgraph on this node, demote widgets promoted via the legacy store, ` +
        `then retry panel_save_subgraph.`,
    );
  }

  return { changed: true, resolved: normalized.resolved, dropped: normalized.dropped };
}
