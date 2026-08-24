// #1260 — one node's restore must not abort the rest of the load.
//
import { isLinkDisconnectCrash, nodeHasResidualLinks } from "./safe-remove-node.js";

// LiteGraph restores a serialized graph in passes: every node is CREATED
// first, then each node is configured in `nodes` order through the PROTOTYPE's
// `LGraphNode.prototype.configure`, and only afterwards are links and groups
// applied. A node whose configure THROWS — the reported case is Impact-Pack's
// FaceDetailer, whose widgets are built asynchronously by its JS extension, so
// the widget list is incomplete when the serialized values are applied —
// aborts that whole sequence: every later node stays at construction defaults
// (pos [10,10], default widgets), and links and groups are never applied. The
// load then reports a clean success over a graph that cannot queue.
//
// The throw belongs to ONE node, so it is contained to that node: while a
// panel-initiated load runs, `configure` is wrapped so a throw is RECORDED and
// the sequence continues — links, groups, and every other node restore
// normally. The caller retries the recorded nodes once after the load (the
// asynchronously-built widgets usually exist by then) and discloses any that
// still fail, instead of reporting a clean success.

function errorText(err) {
  if (err instanceof Error && err.message) return err.message;
  try {
    return String(err);
  } catch {
    return "an unprintable error";
  }
}

function cloneSerializedValue(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior) return prior;
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneSerializedValue(value[key], seen),
      writable: true,
    });
  }
  return clone;
}

function sameNodeId(left, right) {
  return left === right || (left != null && right != null && String(left) === String(right));
}

const graphIdentityTokens = new WeakMap();
let nextGraphIdentityToken = 1;

function graphIdentityToken(graph) {
  if ((typeof graph !== "object" || graph === null) && typeof graph !== "function") return null;
  let token = graphIdentityTokens.get(graph);
  if (token == null) {
    token = nextGraphIdentityToken++;
    graphIdentityTokens.set(graph, token);
  }
  return token;
}

function graphLinkEntries(graph) {
  const map = graph?._links;
  if (map && typeof map.entries === "function") return [...map.entries()];
  const links = graph?.links;
  if (links && typeof links === "object") return Object.keys(links).map((key) => [key, links[key]]);
  return [];
}

function hasBrokenLinkEndpoint(graph, node, err) {
  const nodeId = node?.id;
  if (nodeId == null || typeof graph?.getNodeById !== "function") return false;
  const message = String(err?.message ?? "");
  const mirrorWrite = /Cannot set propert(?:y|ies) of (?:undefined|null) \(setting ['\"](?:link|links)['\"]\)|Cannot set property ['\"](?:link|links)['\"] of (?:undefined|null)/.test(message);
  const method = /findOutputSlot/.test(message) ? "findOutputSlot" : "findInputSlot";
  for (const [, link] of graphLinkEntries(graph)) {
    if (!link) continue;
    const nodeIsOrigin = sameNodeId(link.origin_id, nodeId);
    const nodeIsTarget = sameNodeId(link.target_id, nodeId);
    const farId = nodeIsOrigin ? link.target_id : nodeIsTarget ? link.origin_id : null;
    if (farId == null) continue;
    const far = graph.getNodeById(farId);
    if (mirrorWrite) {
      const farSlot = nodeIsOrigin ? link.target_slot : link.origin_slot;
      const farSlots = nodeIsOrigin ? far?.inputs : far?.outputs;
      if (far != null && farSlot != null && (!Array.isArray(farSlots) || farSlots[Number(farSlot)] == null)) return true;
      continue;
    }
    if (far != null && typeof far[method] !== "function") return true;
  }
  return false;
}

function sameSerializedValue(a, b) {
  const seen = new Map();
  const equal = (left, right) => {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== typeof right) return false;
    if (typeof left !== "object") return false;
    const prior = seen.get(left);
    if (prior) return prior === right;
    seen.set(left, right);
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      return left.every((value, index) => equal(value, right[index]));
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.prototype.hasOwnProperty.call(right, key))) {
      return false;
    }
    return leftKeys.every((key) => equal(left[key], right[key]));
  };
  try {
    return equal(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify the state of one node after a link-disconnect configure failure.
 *
 * A linked widget is allowed to differ: ComfyUI's connection propagation can
 * replace its displayed value while the link, mode, flags, properties, and
 * every other widget remain the serialized values. That is an explicit,
 * inspectable warning, not a general normalization exemption. Every other
 * serialized field must match, including the node's position and topology.
 */
export function verifyNodeRestore(node, info) {
  try {
    const actual = node?.serialize?.();
    if (!actual || !info || typeof actual !== "object" || typeof info !== "object") {
      return { comparable: false, verified: false, differences: [], linkDrivenWidgetDifferences: [] };
    }
    const linkedWidgetNames = new Set();
    for (const input of [...(info.inputs ?? []), ...(node.inputs ?? [])]) {
      if (input?.link != null && typeof input?.widget?.name === "string") {
        linkedWidgetNames.add(input.widget.name);
      }
    }
    const serializedWidgets = (node.widgets ?? []).filter((widget) => widget && widget.serialize !== false);
    const widgetNames = serializedWidgets.map((widget) => widget.name);
    const differences = [];
    const linkDrivenWidgetDifferences = [];
    const fields = new Set([...Object.keys(info), ...Object.keys(actual)]);
    for (const field of fields) {
      const expectedHas = Object.prototype.hasOwnProperty.call(info, field) && info[field] !== undefined;
      const actualHas = Object.prototype.hasOwnProperty.call(actual, field) && actual[field] !== undefined;
      if (!expectedHas && !actualHas) continue;
      if (field === "widgets_values" && Array.isArray(info[field]) && Array.isArray(actual[field])) {
        const length = Math.max(info[field].length, actual[field].length);
        for (let index = 0; index < length; index += 1) {
          if (sameSerializedValue(info[field][index], actual[field][index])) continue;
          const name = widgetNames[index] ?? `#${index}`;
          if (linkedWidgetNames.has(name)) linkDrivenWidgetDifferences.push(name);
          else differences.push(`widgets_values.${name}`);
        }
        continue;
      }
      if (expectedHas !== actualHas || !sameSerializedValue(info[field], actual[field])) {
        differences.push(field);
      }
    }
    return {
      comparable: true,
      verified: differences.length === 0,
      differences: [...new Set(differences)],
      linkDrivenWidgetDifferences: [...new Set(linkDrivenWidgetDifferences)],
    };
  } catch {
    return { comparable: false, verified: false, differences: [], linkDrivenWidgetDifferences: [] };
  }
}

function waitForLinkStateToSettle() {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer != null && typeof clearTimeout === "function") clearTimeout(timer);
      resolve();
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(finish);
      // requestAnimationFrame may be paused indefinitely for a hidden tab;
      // retain a bounded recovery path for background graph loads.
      if (typeof setTimeout === "function") timer = setTimeout(finish, 100);
    } else if (typeof setTimeout === "function") {
      timer = setTimeout(finish, 0);
    } else {
      finish();
    }
  });
}

/**
 * Contain per-node `configure` throws for the duration of one load.
 *
 * Returns null when isolation is impossible (no LiteGraph / LGraphNode /
 * prototype configure) — the caller then loads exactly as before, with no
 * containment and nothing recorded, which is the pre-fix behaviour and never
 * worse than it.
 *
 * Otherwise returns `{ failures, restore }`. `failures` accumulates one entry
 * per throwing configure: `{ id, type, error, info }`, where `info` is the
 * serialized node data the retry pass needs and must NOT be serialized into a
 * tool result. `restore()` deactivates the wrapper and puts the original back
 * — but only when this wrapper is still the installed one: a second isolation
 * (or the frontend) may have chained on top, and restoring over that would
 * silently drop THEIR wrapper. A deactivated wrapper left in a chain is a
 * pass-through, so every restore order stays correct.
 *
 * The handle also reports `entered`: how many times the wrapper actually RAN
 * while active. Installed is not entered — a frontend whose nodes do not resolve
 * `configure` through `LGraphNode.prototype` leaves this at 0 while every field
 * above still reads like a clean load. It is a DIAGNOSTIC here and nothing gates
 * on it; `loadRestoreCompleted` explains why the graph-level count is the one
 * that licenses the verdict and this one must not.
 */
export function installNodeConfigureIsolation(LG, graph = null) {
  const proto = LG?.LGraphNode?.prototype;
  if (!proto || typeof proto.configure !== "function") return null;
  const original = proto.configure;
  const failures = [];
  let active = true;
  let entered = 0;
  const wrapped = function (info) {
    if (!active) return original.call(this, info);
    entered += 1;
    let serializedSnapshot = null;
    try {
      serializedSnapshot = info == null ? null : cloneSerializedValue(info);
    } catch {
      // An uncloneable payload cannot be safely verified after a throw.
      serializedSnapshot = null;
    }
    try {
      return original.call(this, info);
    } catch (err) {
      const ownerGraph = this?.graph ?? null;
      const evidenceGraph = this?.graph ?? graph ?? null;
      failures.push({
        id: info?.id ?? this?.id ?? null,
        type: info?.type ?? this?.type ?? null,
        error: errorText(err),
        linkDisconnectCrash: isLinkDisconnectCrash(err),
        linkDisconnectEvidence: isLinkDisconnectCrash(err) && hasBrokenLinkEndpoint(evidenceGraph, this, err),
        // A node inside a subgraph can share an id with a root node. Keep the
        // graph that owned the failed configure so the retry cannot retarget
        // the root graph by id alone.
        ownerGraph,
        ownerGraphToken: graphIdentityToken(ownerGraph),
        // configure implementations can mutate their input before throwing;
        // retain an independent serialized snapshot for the retry/verification.
        info: serializedSnapshot,
      });
      return undefined;
    }
  };
  proto.configure = wrapped;
  return {
    failures,
    get entered() {
      return entered;
    },
    restore() {
      active = false;
      if (proto.configure === wrapped) proto.configure = original;
    },
  };
}

/**
 * One best-effort re-application of each node whose configure threw during the
 * load, AFTER the load has settled — a node whose widgets are built
 * asynchronously (the FaceDetailer shape) commonly configures cleanly by then.
 * Each retry is isolated too: a node that throws again is disclosed with the
 * NEW error, never retried further by this pass.
 *
 * A recorded failure whose node never landed on the graph (creation failed
 * too, not just configure) cannot be retried; it is disclosed with
 * `retry: "node-not-on-graph"` so the caller does not confuse "restore threw
 * again" with "there is nothing to restore onto". Callers that can observe
 * workflow identity may pass `{ isCurrent }`; the check runs before configure
 * and again after the settle wait so a tab switch cannot retarget the retry.
 * Callers whose root graph can be replaced may also pass `{ isGraphCurrent }`;
 * it receives the graph selected for this failure and must prove that graph is
 * still owned by the caller's post-load root before configure runs.
 */
export async function retryNodeRestores(graph, failures, options = {}) {
  const restored = [];
  const failed = [];
  const recovered = [];
  const isCurrent = () => {
    if (typeof options?.isCurrent !== "function") return true;
    try {
      return options.isCurrent() === true;
    } catch {
      return false;
    }
  };
  for (const failure of failures ?? []) {
    if (!isCurrent()) {
      failed.push({
        id: failure?.id ?? null,
        type: failure?.type ?? null,
        error: "active workflow changed during restore retry",
        retry: "workflow-switched",
      });
      continue;
    }
    const retryGraph = failure?.ownerGraph ?? graph;
    if (typeof options?.isGraphCurrent === "function") {
      let graphCurrent = false;
      try {
        graphCurrent = options.isGraphCurrent(retryGraph, failure) === true;
      } catch {
        graphCurrent = false;
      }
      if (!graphCurrent) {
        failed.push({
          id: failure?.id ?? null,
          type: failure?.type ?? null,
          error: "restore graph changed during retry",
          retry: "graph-switched",
        });
        continue;
      }
    }
    const node =
      failure?.id != null && typeof retryGraph?.getNodeById === "function"
        ? retryGraph.getNodeById(failure.id)
        : null;
    if (!node || !failure.info || typeof node.configure !== "function") {
      failed.push({
        id: failure?.id ?? null,
        type: failure?.type ?? null,
        error: failure?.error ?? "unknown",
        retry: "node-not-on-graph",
      });
      continue;
    }
    const linkDisconnectCrash = failure.linkDisconnectCrash === true;
    if (linkDisconnectCrash && failure.linkDisconnectEvidence !== true) {
      failed.push({
        id: failure.id,
        type: failure.type,
        error: failure.error ?? "link-disconnect restore failure",
        retry: "link-disconnect-unverified",
      });
      continue;
    }
    // Check the same discriminator safeRemoveNode uses while the failed
    // restore's residual link state is still observable. Do not let configure
    // manufacture links during the retry and then use those as proof.
    if (linkDisconnectCrash && !nodeHasResidualLinks(retryGraph, node)) {
      failed.push({
        id: failure.id,
        type: failure.type,
        error: failure.error ?? "link-disconnect restore failure",
        retry: "no-residual-links",
      });
      continue;
    }
    if (linkDisconnectCrash) await waitForLinkStateToSettle();
    if (!isCurrent()) {
      failed.push({
        id: failure.id,
        type: failure.type,
        error: "active workflow changed during restore retry",
        retry: "workflow-switched",
      });
      continue;
    }
    let retryInfo;
    try {
      // configure may mutate its input too; keep the failure's independent
      // snapshot untouched for verification after this retry.
      retryInfo = cloneSerializedValue(failure.info);
    } catch {
      failed.push({ id: failure.id, type: failure.type, error: "restore payload could not be cloned", retry: "uncloneable-info" });
      continue;
    }
    let retryError = null;
    try {
      node.configure(retryInfo);
    } catch (err) {
      retryError = err;
    }
    if (linkDisconnectCrash) {
      // The initial crash makes the retry worth attempting, but ANY exception
      // from that retry means configure still failed. Serialization after a
      // throwing configure is not proof that the node was restored.
      if (retryError) {
        failed.push({ id: failure.id, type: failure.type, error: errorText(retryError) });
        continue;
      }
      const verification = verifyNodeRestore(node, failure.info);
      if (verification.verified) {
        restored.push({ id: failure.id, type: failure.type });
        const ownerGraphToken = failure.ownerGraphToken ?? graphIdentityToken(failure.ownerGraph);
        recovered.push({
          id: failure.id,
          type: failure.type,
          ...(ownerGraphToken != null ? { ownerGraphToken } : {}),
          linkDrivenWidgetDifferences: verification.linkDrivenWidgetDifferences,
        });
        continue;
      }
      failed.push({
        id: failure.id,
        type: failure.type,
        error: errorText(retryError ?? new TypeError(failure.error ?? "link-disconnect restore failure")),
        ...(verification.differences.length ? { widgetDifferences: verification.differences } : {}),
        ...(verification.linkDrivenWidgetDifferences.length
          ? { linkDrivenWidgetDifferences: verification.linkDrivenWidgetDifferences }
          : {}),
      });
      continue;
    }
    if (!retryError) restored.push({ id: failure.id, type: failure.type });
    else failed.push({ id: failure.id, type: failure.type, error: errorText(retryError) });
  }
  return { restored, failed, recovered };
}

/**
 * Did the graph restore RUN TO COMPLETION? (panel#1283 family)
 *
 * ## Why this observation has to exist
 *
 * `resolveOpenRebindVerdict` refuses to report an open applied whenever the graph
 * on the canvas is not byte-reproducible from the payload. Its reason, as that comment
 * read BEFORE this observation existed (it now points here instead):
 *
 *   "LiteGraph creates every node (with its id and type) and THEN configures each
 *    one, and `loadGraphData` catches a `configure()` failure and returns. A throw
 *    in that second pass leaves the complete node id/type set, the links, and the
 *    panel's marker over nodes that silently LOST their widget values and
 *    properties. That is byte-for-byte the same observation as 'the loader
 *    normalized the widget values', and no discriminator available to the panel
 *    separates them."
 *
 * MEASURED against the frontend source (`LGraph.prototype.configure`, the same
 * build #1260 was measured on): that account is exactly right, and it is
 * exhaustive. The node pass is
 *
 *     for (const [id, nodeData] of nodeDataMap) {
 *       const node = this.getNodeById(toNodeId(id))
 *       node?.configure(nodeData)          // <- no try/catch
 *     }
 *
 * with no try/catch anywhere between it and `loadGraphData`'s own. So the ONLY way
 * the feared partial load can present is a THROW — out of a node's `configure`, or
 * out of `LGraph.prototype.configure` itself (its later passes: floating links,
 * reroute validation, groups, execution order, proxy-widget migration).
 *
 * Both are observable. `installNodeConfigureIsolation` above already records the
 * first, for #1260. This records the second. Together they answer the question that
 * comment said could not be answered: **did any part of this restore abort?**
 *
 * ## Why the pair is exhaustive and the node wrap alone is not
 *
 * `installNodeConfigureIsolation` wraps `LGraphNode.prototype.configure`, and the
 * frontend's `ComfyNode.prototype.configure` runs BEFORE it and calls `super`. A
 * ComfyNode configure that throws before reaching super therefore never enters that
 * wrapper — it escapes the node loop instead, which aborts `LGraph.prototype.configure`
 * itself. That is the throw THIS wrap records. The same holds one level down: a
 * `Subgraph.configure` that throws before `super.configure` aborts the ROOT
 * `LGraph.configure` call that invoked it, which is wrapped.
 *
 * So every abort lands in exactly one of the two records: contained by the node
 * wrapper, or observed escaping into the graph one. Neither alone would be enough to
 * license anything.
 *
 * That is a POSITIVE observation, not a widened tolerance. It never says a
 * difference is benign; it says the load did not stop early, which is the one
 * hypothesis the refusal rests on.
 *
 * ## What it does NOT change
 *
 * Behaviour. The wrapper records the throw and RE-THROWS it, so every caller sees
 * precisely what it saw before — including `loadGraphData`'s own catch. An
 * observation that altered control flow would be measuring something other than
 * what production does.
 *
 * Returns null when the wrap is impossible (no LiteGraph / LGraph / prototype
 * configure). The caller must read null as UNKNOWN — never as "nothing threw" —
 * because a frontend this cannot instrument is exactly one whose restore it cannot
 * vouch for.
 *
 * ## INSTALLED is not ENTERED — why the handle counts `entered`
 *
 * Wrapping a prototype method proves the method exists. It does NOT prove the
 * restore went THROUGH it. On a frontend where the root graph stops resolving
 * `configure` via `LGraph.prototype` — an own-property `configure` on the graph
 * instance, or a subclass whose `configure` does not call `super` — the wrap
 * installs, is never entered, and `throws` stays empty for the whole load. An
 * empty `throws` then means either "nothing threw" or "nothing was watched", and
 * those are the two states this module exists to keep apart. A genuinely partial
 * load would be waved through as normalization, which is precisely the harm the
 * observation was added to prevent.
 *
 * So `entered` counts every call that reached the ACTIVE wrapper (a deactivated
 * one is a pass-through and counts nothing — an entry after `restore()` is not
 * evidence about the load). `entered === 0` means the question was never asked,
 * and `loadRestoreCompleted` folds it to UNKNOWN.
 */
export function installGraphConfigureWatch(LG) {
  const proto = LG?.LGraph?.prototype;
  if (!proto || typeof proto.configure !== "function") return null;
  const original = proto.configure;
  const throws = [];
  let active = true;
  let entered = 0;
  const wrapped = function (...args) {
    if (!active) return original.apply(this, args);
    // BEFORE the try. This counts ENTRY, not success: a call that throws was
    // still watched, and a counter incremented on the way out would read 0 for
    // exactly the aborted load this watch exists to see.
    entered += 1;
    try {
      return original.apply(this, args);
    } catch (err) {
      throws.push(errorText(err));
      // RE-THROWN. This is an observer, not an isolation: swallowing here would
      // change what `loadGraphData` sees and what the canvas ends up holding.
      throw err;
    }
  };
  proto.configure = wrapped;
  return {
    throws,
    get entered() {
      return entered;
    },
    restore() {
      active = false;
      // Only when this wrapper is still the installed one — the same rule
      // `installNodeConfigureIsolation` follows, so a nested install/restore in
      // either order never drops somebody else's wrapper.
      if (proto.configure === wrapped) proto.configure = original;
    },
  };
}

/**
 * Fold the two observations into ONE answer with THREE states.
 *
 * `true`  — the graph restore RAN THROUGH the watch and nothing threw: it ran to
 *           the end.
 * `false` — something threw. The partial-load hypothesis is LIVE for this load.
 * `null`  — the question was never asked. Either a wrap could not be installed, or
 *           it was installed on a method the restore never called. Unknown, and the
 *           caller must treat it as such: a load that could not be watched proves
 *           nothing about whether it completed.
 *
 * The null case is the point. Collapsing "nothing threw" and "nobody looked" into
 * one boolean is the exact defect this whole family is about, one level down.
 *
 * ## Why `graphWatch.entered` gates the verdict
 *
 * The first cut of this fold asked only whether both handles EXIST and neither
 * recorded anything. Existence is an answer about the prototype, not about the
 * load: install on a method nothing calls and both records stay empty, which is
 * byte-identical to a clean restore. That is the same two-states-one-answer fold
 * one level further down, and no test could see it, because a test that drives the
 * wrappers always enters them.
 *
 * An ABSENT or non-numeric count is unknown too, not a pass. A handle that cannot
 * say whether it ran has not established that it ran.
 *
 * ## Why `nodeIsolation.entered` does NOT, and must not
 *
 * Two reasons, and they point the same way.
 *
 * 1. Zero node configures is a LEGITIMATE completed restore — an empty workflow,
 *    or one whose nodes all failed to construct. Gating on it would answer UNKNOWN
 *    for loads that demonstrably ran to the end: a false negative manufactured by
 *    the guard, which is the fix being worse than the bug.
 * 2. It is not needed. The node wrapper is a CONTAINMENT, and the graph watch is
 *    the backstop underneath it: a node whose `configure` never routes through
 *    `LGraphNode.prototype` still throws INTO `LGraph.prototype.configure`'s node
 *    loop, which has no try/catch of its own — so the abort escapes into the graph
 *    watch and is recorded there. An unentered node wrapper loses containment for
 *    that node; it does not lose the OBSERVATION. An unentered graph watch loses
 *    the observation outright, which is why only that one may answer null.
 */
export function loadRestoreCompleted({ nodeIsolation, graphWatch, recoveredFailures = [] } = {}) {
  if (!nodeIsolation || !graphWatch) return null;
  const nodeFailures = Array.isArray(nodeIsolation.failures) ? nodeIsolation.failures : null;
  const graphThrows = Array.isArray(graphWatch.throws) ? graphWatch.throws : null;
  if (!nodeFailures || !graphThrows) return null;
  // INSTALLED IS NOT ENTERED. An empty `throws` off a watch the restore never
  // reached is "nobody looked", and it must not read as "nothing threw".
  const graphEntered = graphWatch.entered;
  // `>= 1` and not `< 1`: NaN fails every comparison, so a `< 1` test would let it
  // through as "entered" — the same fold, hiding in an operator.
  if (typeof graphEntered !== "number" || !(graphEntered >= 1)) return null;
  if (graphThrows.length !== 0) return false;
  if (nodeFailures.length === 0) return true;
  const recovered = Array.isArray(recoveredFailures) ? recoveredFailures : [];
  const usedRecovered = new Set();
  return nodeFailures.every(
    (failure) => {
      if (failure?.linkDisconnectCrash !== true || failure?.linkDisconnectEvidence !== true) return false;
      const ownerGraphToken = failure?.ownerGraphToken ?? graphIdentityToken(failure?.ownerGraph);
      const recoveredIndex = recovered.findIndex(
        (candidate, index) =>
          !usedRecovered.has(index) &&
          sameNodeId(candidate?.id, failure?.id) &&
          (ownerGraphToken == null || candidate?.ownerGraphToken === ownerGraphToken),
      );
      if (recoveredIndex < 0) return false;
      usedRecovered.add(recoveredIndex);
      return true;
    },
  );
}

/** Run one production graph load under the completion proof.
 *
 * `loadGraphData` may catch a configure throw and resolve while the graph is only
 * partly restored. Install both observations before calling it, remove them before
 * the caller reads the graph, and expose only the proof result needed by callers.
 * A thrown loader error still propagates; the helper is an observer, not a control
 * flow change. `completed` is deliberately tri-state: only `true` licenses success. */
export async function loadGraphDataWithCompletionProof({ liteGraph, graph = null, load } = {}) {
  const nodeIsolation = installNodeConfigureIsolation(liteGraph, graph);
  const graphWatch = installGraphConfigureWatch(liteGraph);
  try {
    const value = await load();
    return {
      value,
      completed: loadRestoreCompleted({ nodeIsolation, graphWatch }),
    };
  } finally {
    nodeIsolation?.restore();
    graphWatch?.restore();
  }
}
