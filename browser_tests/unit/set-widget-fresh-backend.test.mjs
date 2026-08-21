/**
 * Unit tests for the FRESH-BACKEND type authorization in web/js/lib/set-widget.js
 * — run with `node --test`.
 *
 * The #458 set_widget gap (found in review of #375): graph_set_widget authorized
 * the target node's type SOLELY from the mutable LiteGraph registry. That registry
 * keeps a STALE POSITIVE for an uninstalled pack when the browser tab was never
 * reloaded after a ComfyUI restart, so a since-removed type ("GoneNode") sailed
 * through every registry guard and the write reported a fabricated SUCCESS against
 * a backend that no longer defines it. graph_add_node already authorizes its
 * class_type against the CURRENT /object_info; these tests prove graph_set_widget
 * now authorizes the RESOLVED write target's type against the same fresh oracle.
 *
 * They drive the REAL production handler body (runSetWidget) — the SAME async unit
 * GRAPH_TOOL_EXECUTORS.graph_set_widget delegates to — with the fresh-oracle
 * capability wired exactly as the handler wires it (getRegistry / getFreshObjectInfo
 * / refreshCombos). So dropping the fresh gate, or letting it fall back to the stale
 * registry, fails a test.
 *
 * Invariants under test:
 *   1. REMOVED type (stale registry positive, ABSENT from fresh /object_info)
 *      ⇒ FAIL CLOSED, no mutation — even though every registry-only guard passes.
 *   2. Backend UNREACHABLE (fresh /object_info returns null) ⇒ FAIL CLOSED.
 *   3. Transient fetch REJECTION ⇒ FAIL CLOSED (never trust the stale registry).
 *   4. A LIVE VALID type (present in fresh /object_info + registry) ⇒ still succeeds,
 *      fetching /object_info exactly once (hot path).
 *   5. The stale-combo refresh retry (#338/#317/#299/#288) still works with the
 *      fresh oracle wired, WITHOUT a second /object_info fetch.
 *   6. No fresh-oracle wired ⇒ degrades to the registry guard (back-compat).
 *   7. A subgraph PROMOTED write authorizes the INNER target's type (removed/
 *      unreachable ⇒ fail closed; live ⇒ succeeds), and the promoted target is
 *      resolved exactly ONCE so the write can't re-resolve to a swapped-in node.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { refreshComboOptionsFromDefs } from "../../web/js/lib/asset-staleness.js";
import { commandTargetsActiveWorkflow } from "../../web/js/lib/workflow-chat-identity.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

// A registry shaped like LG.registered_node_types once /object_info loaded. Each
// entry carries a `.nodeData` def (registerNodesFromDefs stamps one per class), so
// a genuinely-resolved instance passes the stale-placeholder-instance cross-check.
function loadedRegistry(extra = []) {
  const reg = {};
  for (const t of [
    "KSampler",
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "VAEDecode",
    "VAELoader",
    "EmptyLatentImage",
    "LoadImage",
    "SaveImage",
    ...extra,
  ]) {
    const ctor = function NodeCtor() {};
    ctor.nodeData = { input: { required: {} } };
    reg[t] = ctor;
  }
  return reg;
}

// Fresh /object_info map (class_type -> def), the authoritative oracle.
function objectInfo(extra = []) {
  const info = {};
  for (const t of [
    "KSampler",
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "VAEDecode",
    "VAELoader",
    "EmptyLatentImage",
    "LoadImage",
    "SaveImage",
    ...extra,
  ]) {
    info[t] = { input: { required: {} } };
  }
  return info;
}

// A GENUINELY-RESOLVED node instance: its own constructor carries the live def, so
// the registry-only placeholder-instance guard is satisfied. This is deliberate —
// it proves ONLY the fresh oracle catches a removed type, not any registry check.
function regNode(type, widgets, extra = {}) {
  return {
    id: 3,
    type,
    widgets,
    constructor: { nodeData: { input: { required: {} } } },
    ...extra,
  };
}

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

test("#718 graph_set_widget: a workflow switch during fresh-object-info wait refuses before the write", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 20 }]);
  let activeUuid = "workflow-A";
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  const pending = runSetWidget(node, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => {
      markFetchStarted();
      return new Promise((resolve) => {
        releaseFetch = () => resolve(objectInfo());
      });
    },
    assertTargetStillCurrent: () => {
      if (!commandTargetsActiveWorkflow({
        cmd: "graph_set_widget",
        commandUuid: "workflow-A",
        activeUuid,
      })) {
        throw new Error("workflow instance mismatch");
      }
    },
    ...HOOKS,
  });

  await fetchStarted;
  // The command was fenced for A at dispatch, then the user changed the active
  // canvas while graph_set_widget awaited its required fresh backend oracle.
  activeUuid = "workflow-B";
  releaseFetch();

  await assert.rejects(pending, /workflow instance mismatch/);
  assert.equal(node.widgets[0].value, 20, "the stale command must not mutate workflow B");
});

test("#718 graph_set_widget: a switch during fresh-object-info wait cannot reconcile stale widget names", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "UNKNOWN", type: "INT", value: 20 }]);
  node.constructor.nodeData = { input: { required: { steps: ["INT"] } } };
  let activeUuid = "workflow-A";
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  const pending = runSetWidget(node, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => {
      markFetchStarted();
      return new Promise((resolve) => {
        releaseFetch = () => resolve(objectInfo());
      });
    },
    assertTargetStillCurrent: () => {
      if (!commandTargetsActiveWorkflow({
        cmd: "graph_set_widget",
        commandUuid: "workflow-A",
        activeUuid,
      })) {
        throw new Error("workflow instance mismatch");
      }
    },
    ...HOOKS,
  });

  await fetchStarted;
  activeUuid = "workflow-B";
  releaseFetch();

  await assert.rejects(pending, /workflow instance mismatch/);
  assert.equal(node.widgets[0].name, "UNKNOWN", "the stale command must not repair workflow B's widget metadata");
  assert.equal(node.widgets[0].value, 20);
});

for (const commandUuid of [undefined, "   "]) {
  test(`#718 graph_set_widget: ${commandUuid === undefined ? "missing" : "blank"} stamp refuses at the post-await write boundary`, async () => {
    const reg = loadedRegistry();
    const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 20 }]);
    let releaseFetch;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });

    const pending = runSetWidget(node, "steps", 30, {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: () => {
        markFetchStarted();
        return new Promise((resolve) => {
          releaseFetch = () => resolve(objectInfo());
        });
      },
      assertTargetStillCurrent: () => {
        if (!commandTargetsActiveWorkflow({
          cmd: "graph_set_widget",
          commandUuid,
          activeUuid: "workflow-A",
        })) {
          throw new Error("workflow instance mismatch");
        }
      },
      ...HOOKS,
    });

    await fetchStarted;
    releaseFetch();

    await assert.rejects(pending, /workflow instance mismatch/);
    assert.equal(node.widgets[0].value, 20, "an unstamped command must not mutate after its await");
  });
}

test("#718 wiring: graph_set_widget passes the execution-time workflow fence into runSetWidget", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // Located loosely, then the stamp is asserted separately below. Pinning the exact
  // destructuring made this fail on ANY added or removed argument and report "must accept
  // the bridge-owned stamp" about a signature that still accepts it — a locator failure
  // dressed up as a fence failure. The stamp itself is asserted, so nothing is lost.
  const start = src.search(/async graph_set_widget\(\{[^}]*\}\)/);
  const end = src.indexOf("\n  graph_set_node_property(", start);
  assert.notEqual(start, -1, "graph_set_widget executor must exist");
  assert.match(
    src.slice(start, src.indexOf(")", start)),
    /workflow_uuid/,
    "graph_set_widget executor must accept the bridge-owned stamp",
  );
  assert.notEqual(end, -1, "graph_set_widget executor boundary must exist");
  const body = src.slice(start, end);
  assert.match(
    body,
    /assertTargetStillCurrent:\s*\(\)\s*=>\s*assertActiveWorkflowCommandTarget\([\s\S]*workflow_uuid/,
    "the post-await write boundary must recheck the exact command stamp",
  );
});

test("#1126 wiring: the activity summary DISCLOSES a write nothing validated", () => {
  // The lib sets `option_list_unreadable` when the combo's option list could not be read
  // and the value was taken as written. If the summary ignores it, the one line a user
  // actually reads renders an admittedly-unchecked write as an ordinary "Set … " success
  // — which is the same class of lie #366 and #639 each had to fix here. Asserted against
  // the SOURCE because this is a one-expression install in the renderer: deleting it would
  // leave every behavioural test in this repo green.
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf('case "graph_set_widget": {');
  assert.notEqual(start, -1, "the graph_set_widget summary branch must exist");
  const end = src.indexOf('case "graph_get_subgraph":', start);
  assert.notEqual(end, -1, "the summary branch boundary must exist");
  const branch = src.slice(start, end);
  // Read as DATA off the result — never pattern-matched out of the disclosure prose,
  // which is translated and would disarm a text predicate in 11 of 12 locales.
  assert.match(
    branch,
    /r\.option_list_unreadable === true/,
    "the summary must read the lib's field, not the note's wording",
  );
  // …and it must actually reach the rendered text, not merely be computed.
  assert.match(
    branch,
    /unvalidatedUnreadable[\s\S]*tr\(\s*"panel\.set_widget_option_list_unreadable"/,
    "the disclosure must be appended to the summary line",
  );
  // The warning icon, so it does not read as a clean success at a glance.
  assert.match(branch, /writeDisclosed \|\| unvalidatedUnreadable \? "pi-exclamation-triangle"/);
});

test("#1492 wiring: the activity summary DISCLOSES the inner callback an instance-scoped write skipped", () => {
  // widget-write sets `promoted_from.inner_callback_not_invoked` when an instance-scoped
  // promoted write left the SHARED inner widget's callback uninvoked — the reported case
  // flips another node between ACTIVE and BYPASS, so the graph is half-changed. Rendered
  // as a plain "Set … " success, the one line a user reads says the opposite. Asserted at
  // the SOURCE for the same reason as #1126 above: this is a one-expression install in the
  // renderer, and deleting it leaves every behavioural test in this repo green.
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf('case "graph_set_widget": {');
  assert.notEqual(start, -1, "the graph_set_widget summary branch must exist");
  const end = src.indexOf('case "graph_get_subgraph":', start);
  assert.notEqual(end, -1, "the summary branch boundary must exist");
  const branch = src.slice(start, end);
  // Read as DATA off the result. The note itself is prose and would be translated, so a
  // text predicate over it would be disarmed in 11 of 12 locales.
  assert.match(
    branch,
    /r\.set\?\.promoted_from\?\.inner_callback_not_invoked === true/,
    "the summary must read the lib's field, not the note's wording",
  );
  // …and it must reach the rendered text, not merely be computed.
  assert.match(
    branch,
    /innerCallbackNotInvoked[\s\S]*tr\(\s*"panel\.set_widget_inner_callback_not_invoked"/,
    "the disclosure must be appended to the summary line",
  );
  // The warning icon, so a half-applied change does not read as a clean success.
  assert.match(branch, /innerCallbackNotInvoked \|\| writeDisclosed/);
});

test("#1223 × #1126 wiring: graph_set_widget THREADS the schema provenance into runSetWidget", () => {
  // The lib's blind-write fallback fails closed on any schema that is not LIVE, and
  // node-resolve.test.mjs proves that behaviour by passing `schemaProvenance` directly.
  // But the lib can only know the provenance if the executor hands it over: which branch
  // of `getFreshObjectInfo` answered — and whether a reconnect landed while it was in
  // flight — are facts ONLY the panel holds. Stub the wiring to a constant `"live"` and
  // every behavioural test in this repo stays green while production authorizes blind
  // writes from stale schemas again — a dead-code fix of exactly the kind this PR's own
  // body warns about (#1223 v1, #757 v1). So it is asserted at the source, like the #718
  // fence above.
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.search(/async graph_set_widget\(\{[^}]*\}\)/);
  assert.notEqual(start, -1, "graph_set_widget executor must exist");
  // Bounded at the NEXT executor, not at graph_set_node_property: graph_remove_widget sits
  // between them and does its own /object_info read, so the wider slice made a negative
  // assertion about this executor fail on a neighbour's code.
  const end = src.indexOf("\n  async graph_remove_widget(", start);
  assert.notEqual(end, -1, "graph_set_widget executor boundary must exist");
  const body = src.slice(start, end);
  // A FUNCTION, not a value: `getFreshObjectInfo` has not run when the options object is
  // built, so which branch answered is only knowable afterwards — and the lib may re-ask,
  // which changes the answer. A snapshotted value would always read as the first call's.
  assert.match(
    body,
    /schemaProvenance:\s*\(\)\s*=>\s*setWidgetSchemaProvenance/,
    "the executor must thread the schema provenance it holds, as a deferred read",
  );
  // THE VERDICT IS DELEGATED, not reconstructed. Four review rounds each found another way
  // a response could fail to be live while this file's own reconstruction still said it was
  // (served from the TTL, joined to another read, reconnected out from under, retired
  // mid-flight by an invalidate). object-info-cache.js owns the generation counter and
  // decides how every read is served, so it answers; the panel copies that answer through.
  assert.match(
    body,
    /objectInfoCache\.readWithProvenance\(/,
    "the executor must ask the cache for its verdict rather than infer one",
  );
  // …and hold the QUESTION, not the answer. A verdict is a statement about a moment, and
  // this ladder awaits a combo refresh and an upload probe between reading the schema and
  // deciding — so a stored string can be superseded during those awaits while still
  // insisting the answer is live. `provenanceNow` re-answers on every call.
  assert.match(
    body,
    /provenanceNow,\s*\} = await readThroughCache\(/,
    "…and take the re-askable verdict from that call",
  );
  assert.match(
    body,
    /setWidgetSchemaProvenance = provenanceNow;/,
    "the threaded provenance must be the cache's re-askable question, not a snapshot of it",
  );
  assert.match(
    body,
    /schemaProvenance: \(\) => setWidgetSchemaProvenance\(\)/,
    "…and the lib must INVOKE it, so its read happens after the recovery awaits",
  );
  // The reconnect epoch is the one fact the cache cannot know, handed in as an opaque stamp
  // it re-checks across the await. Drop this and a reconnect-spanning response reads as live.
  assert.match(
    body,
    /\{\s*stamp:\s*\(\)\s*=>\s*backendReconnectEpoch\s*,?\s*\}/,
    "the reconnect epoch must be handed to the cache as an issuance stamp",
  );
  // Nothing may reconstruct liveness alongside the delegated answer — two sources for one
  // fact is exactly what produced four rounds of drift. Scoped to the DECLARATION of a local
  // signal, not to the identifier: `record`'s own option is still named `observedAtEpoch`,
  // and that is its API, not a second opinion about this response.
  assert.doesNotMatch(
    body,
    /let observedAtEpoch/,
    "the executor must not keep a second, hand-rolled liveness signal",
  );
  // The other two branches are the panel's own to report: the cache never sees them.
  // Also as functions, so every branch answers the same shape of question.
  for (const [branch, pattern] of [
    ["snapshot", /setWidgetSchemaProvenance = \(\) => "snapshot"/],
    ["nothing established", /setWidgetSchemaProvenance = \(\) => "none"/],
  ]) {
    assert.match(body, pattern, `the ${branch} branch must record its provenance`);
  }
  // #1223's snapshot may only retain a LIVE answer, gated on the same verdict. `record`'s own
  // epoch test would still accept a GENERATION-RETIRED response — a refresh/install bumps the
  // cache generation without moving the reconnect epoch — so the snapshot could otherwise
  // retain a schema the panel itself had just superseded.
  assert.match(
    body,
    /if \(readProvenance === "live"\) \{\s*objectInfoSnapshot\.record\(/,
    "only a live answer may be filed as the last-observed schema",
  );
  // …and the lib must be able to force a genuinely live re-read, or a cache hit could only
  // ever fail closed — refusing writes 2..N of an ordinary burst. Through `readFresh`, NOT a
  // global `invalidate()`: two writes reaching this path together each invalidated, and the
  // second retired the first's just-issued request, so one caller refused another's valid
  // write. `readFresh` bypasses only the stored entry and coalesces concurrent rereads.
  assert.match(
    body,
    /refetchObjectInfoLive:[\s\S]{0,240}objectInfoCache\.readFresh\(/,
    "the executor must offer a coalescing, non-retiring forced reread",
  );
  assert.doesNotMatch(
    body,
    /objectInfoCache\.invalidate\(\)/,
    "…and must NOT reach for the global invalidation on the recovery path",
  );
  // Both entry points must share ONE oracle body, or the snapshot fallback, the failure-route
  // bookkeeping and the provenance handling drift between the ordinary and forced reads.
  assert.match(
    body,
    /getFreshObjectInfo: async \(\) =>\s*setWidgetOpts\.readObjectInfo\(/,
    "the ordinary read must go through the shared oracle body",
  );
  assert.match(
    body,
    /refetchObjectInfoLive: async \(\) =>\s*setWidgetOpts\.readObjectInfo\(/,
    "and so must the forced one",
  );
  // The snapshot disclosure keeps its own STICKY variable: a write that consulted the
  // snapshot at any point must keep reporting `schema_source`, even if a later re-ask came
  // back live. Provenance answers "may this authorize?"; the note answers "what did this
  // call touch?" — they are different questions and must not be collapsed.
  assert.match(
    body,
    /if \(setWidgetSchemaFromSnapshot !== null[\s\S]*schema_source: "last-observed"/,
    "the reply's snapshot disclosure must stay driven by its own sticky variable",
  );
});

test("#1582 wiring: a reusable snapshot shortens only the ordinary schema probe", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.search(/async graph_set_widget\(\{[^}]*\}\)/);
  const end = src.indexOf("\n  async graph_remove_widget(", start);
  assert.notEqual(start, -1, "graph_set_widget executor must exist");
  assert.notEqual(end, -1, "graph_set_widget executor boundary must exist");
  const body = src.slice(start, end);
  assert.match(
    body,
    /readObjectInfo: async \(readThroughCache, \{ reuseSnapshot = true \} = \{\}\)/,
    "the shared oracle must know whether the caller is an ordinary read or a forced reread",
  );
  assert.match(
    body,
    /reuseSnapshot &&[\s\S]{0,260}objectInfoSnapshot\.isReusable\([\s\S]{0,180}OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS/,
    "a current-connection snapshot must cap the ordinary serial probe",
  );
  assert.match(
    body,
    /objectInfoCache\.readFresh\([\s\S]{0,120}\{ reuseSnapshot: false \}/,
    "the forced live recovery must bypass that cap",
  );
});

test("#458 set_widget: REMOVED type (stale registry positive, absent from fresh object_info) ⇒ FAIL CLOSED, no mutation", async () => {
  // GoneNode's pack was uninstalled + ComfyUI restarted WITHOUT a tab reload: the
  // registry still holds it (with a def) AND the instance is genuinely-resolved, so
  // every registry-only guard passes. The fresh /object_info no longer lists it.
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides GoneNode
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "value must NOT be mutated on a removed type");
});

test("#458 set_widget: REMOVED type carrying a truthy `subgraph` field (no promoted match) ⇒ FAIL CLOSED (subgraph-shaped bypass)", async () => {
  // The subgraph-shaped bypass: a stale GoneNode survives in the registry (with a
  // matching instance def) AND carries a truthy `subgraph:{}` field, but the write
  // targets its OWN widget (resolvePromotedInnerTarget → {promoted:false}). A truthy
  // `subgraph` field must NOT exempt it from fresh authorization — otherwise authTarget
  // would be null, preflight would skip (subgraph parents skip the registry preflight),
  // and only the STALE registry guard would run, fabricating success on a removed type.
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }], { subgraph: {} });
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 7, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => ({ KSampler: {} }), // backend does NOT provide GoneNode
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "removed subgraph-shaped node must NOT be mutated");
});

test("#458 set_widget: backend UNREACHABLE (fresh object_info null) ⇒ FAIL CLOSED, no mutation", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null, // fetch unavailable
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("KSampler"\)/.test(err.message) &&
      // #982 — the wording no longer asserts an unreachable backend, because the panel
      // never established that: a reporter read exactly that sentence while their backend
      // was answering /object_info by hand. What it claims now is only what it observed.
      /no usable \/object_info schema was obtained/i.test(err.message) &&
      !/backend is unreachable/i.test(err.message),
  );
  // …and when the oracle recorded WHAT it tried, the refusal carries it. Without this
  // the whole point of the change — a reporter reading "unavailable" while their backend
  // answered by hand — is unfixed even though the wording changed.
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        describeObjectInfoFailure: () =>
          " Tried 2 routes: api.getNodeDefs() threw: Failed to fetch; GET /object_info was not OK (status 503).",
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Tried 2 routes: api\.getNodeDefs\(\) threw: Failed to fetch/.test(err.message) &&
      /status 503/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "value must NOT be mutated when the backend is unverifiable");
});

test("#458 set_widget: transient fetch REJECTION ⇒ FAIL CLOSED (never trust the stale registry)", async () => {
  const reg = loadedRegistry(["GoneNode"]); // registry HIT survives
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => {
          throw new Error("object_info fetch failed (transient)");
        },
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /cannot verify (the )?node type|object_info is unavailable/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20);
});

test("#458 set_widget: LIVE VALID type (in fresh object_info + registry) ⇒ still succeeds", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 20 }]);
  let objectInfoFetches = 0;
  const res = await runSetWidget(node, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => {
      objectInfoFetches++;
      return objectInfo();
    },
    ...HOOKS,
  });
  assert.equal(res.set.value, 30);
  assert.equal(node.widgets[0].value, 30);
  assert.equal(objectInfoFetches, 1, "hot path fetches fresh object_info exactly once");
});

test("#1582 set_widget: snapshot authorization still validates a combo value", async () => {
  const reg = loadedRegistry(["UNETLoader"]);
  const widget = {
    name: "unet_name",
    type: "combo",
    options: { values: ["model.safetensors"] },
    value: "old.safetensors",
  };
  const node = regNode("UNETLoader", [widget]);
  const snapshotDefs = { UNETLoader: {} }; // #1223's detached, membership-only shape
  const opts = {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => snapshotDefs,
    schemaProvenance: () => "snapshot",
    ...HOOKS,
  };

  const accepted = await runSetWidget(node, "unet_name", "model.safetensors", opts);
  assert.equal(accepted.set.value, "model.safetensors", "a current combo option still writes");

  await assert.rejects(
    () => runSetWidget(node, "unet_name", "not-listed.safetensors", opts),
    /not a valid option/i,
    "the snapshot must not turn a combo write into an unchecked write",
  );
  assert.equal(widget.value, "model.safetensors", "an off-list value is still refused without mutation");
});

test("#458 set_widget: stale-combo refresh retry STILL works with the fresh oracle wired (#338)", async () => {
  // The type is LIVE (passes the fresh oracle) but the combo option list is stale —
  // the just-staged value is accepted only after refreshCombos pulls the fresh list.
  const reg = loadedRegistry();
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = regNode("LoadImage", [widget]);
  let objectInfoFetches = 0;
  let comboRefreshes = 0;
  const res = await runSetWidget(node, "image", "just_staged.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => {
      objectInfoFetches++;
      return objectInfo();
    },
    refreshCombos: async () => {
      comboRefreshes++;
      widget.options.values = ["old_a.png", "just_staged.png"];
    },
    ...HOOKS,
  });
  assert.equal(res.set.value, "just_staged.png");
  assert.equal(res.refreshed, true, "combo refresh retry path still runs");
  assert.equal(comboRefreshes, 1, "combo refresh attempted exactly once");
  assert.equal(objectInfoFetches, 1, "type authorization fetches fresh object_info exactly once (hot path)");
});

test("#458 P2: combo retry reuses the AUTH /object_info via the PRODUCTION refreshCombos — exactly ONE getNodeDefs total", async () => {
  // Drives the REAL production refreshCombos wiring (refreshComboOptionsFromDefs from
  // the already-fetched defs, with a full-refresh FALLBACK) rather than a stub, so it
  // proves the auth fetch + combo recovery make a SINGLE api.getNodeDefs() call. The
  // fresh /object_info encodes LoadImage's combo INCLUDING the just-staged value, so
  // the retry refreshes the widget's options from that payload — no second fetch.
  const reg = loadedRegistry();
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = regNode("LoadImage", [widget]);

  const FRESH = objectInfo();
  FRESH.LoadImage = { input: { required: { image: [["old_a.png", "just_staged.png"], {}] } } };

  let getNodeDefsCalls = 0;
  // The single backend fetch primitive — BOTH the auth oracle and the production
  // fallback refresh route through it, so this counter is the total /object_info hits.
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };
  let fallbackRefreshes = 0;
  const refreshComfyNodeDefs = async (defs) => {
    fallbackRefreshes++;
    if (!defs) await getNodeDefs(); // the real fallback re-fetches /object_info
  };

  const res = await runSetWidget(node, "image", "just_staged.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => getNodeDefs(),
    // EXACT production wiring from comfyui-mcp-panel.js: when defs are present, refresh
    // this target's combo options in place (keyed on the concrete type) and NEVER
    // re-fetch; only a missing payload falls back to the full (re-fetching) refresh.
    refreshCombos: (defs, target, concreteType, nameMap) => {
      if (defs) {
        refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
        return;
      }
      return refreshComfyNodeDefs();
    },
    ...HOOKS,
  });

  assert.equal(res.set.value, "just_staged.png");
  assert.equal(res.refreshed, true, "combo recovery ran and the retry succeeded");
  assert.equal(fallbackRefreshes, 0, "no full-refresh fallback — combos came from the cached defs");
  assert.equal(getNodeDefsCalls, 1, "exactly ONE /object_info fetch across auth + combo retry (#458 P2)");
  assert.equal(widget.value, "just_staged.png");
});

test("#458 P2: defs present but nothing refreshable (dynamic/non-array combo) ⇒ STILL no second fetch, fails closed", async () => {
  // Codex regression guard: when refreshComboOptionsFromDefs updates 0 widgets (the
  // fresh def exposes no array-backed option list for this widget), the production
  // callback must NOT fall back to the re-fetching full refresh just because the
  // update count was 0 — a present payload means single-fetch, period. A genuinely
  // invalid value then stays rejected on the retry.
  const reg = loadedRegistry();
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = regNode("LoadImage", [widget]);

  const FRESH = objectInfo();
  // LoadImage present (auth passes) but its `image` input is a TYPE, not an option
  // array — so refreshComboOptionsFromDefs finds nothing to refresh (returns 0).
  FRESH.LoadImage = { input: { required: { image: ["IMAGE", {}] } } };

  let getNodeDefsCalls = 0;
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };
  let fallbackRefreshes = 0;

  await assert.rejects(
    () =>
      runSetWidget(node, "image", "never_valid.png", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: () => getNodeDefs(),
        refreshCombos: (defs, target, concreteType, nameMap) => {
          if (defs) {
            refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
            return;
          }
          fallbackRefreshes++;
          return getNodeDefs(); // the re-fetching fallback — must NOT run here
        },
        ...HOOKS,
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(fallbackRefreshes, 0, "present payload must never trigger the re-fetching fallback");
  assert.equal(getNodeDefsCalls, 1, "exactly ONE /object_info fetch even when nothing was refreshable (#458 P2)");
  assert.equal(widget.value, "old_a.png", "no mutation on a genuinely-invalid value");
});

test("#458 set_widget: NO fresh-oracle wired ⇒ FAIL CLOSED (never authorize from the stale registry)", async () => {
  // P1-A: a caller that omits getFreshObjectInfo must NOT fall back to the stale
  // registry — that would reopen the exact #458 false-success hole (a stale-positive
  // GoneNode would write + report success). Even a registered live type is refused
  // when the backend can't be consulted; the panel always wires the oracle.
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () => runSetWidget(node, "steps", 30, { registry: reg, ...HOOKS }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("GoneNode"\)/.test(err.message) &&
      /no \/object_info oracle is wired|cannot verify/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "must not mutate when the backend can't be verified");
});

// A real SubgraphNode whose promoted "sched_alias" input maps to an inner node's
// "scheduler" widget. innerType flips the inner node between a live type and a
// since-removed one so the fresh oracle can be exercised on the RESOLVED target.
function makeSubgraphFixture(innerType) {
  const inner = {
    id: 54,
    type: innerType,
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  // #366: the AUTHORITATIVE parent rail projection — object-identity linked from the
  // host input (`_widget`) and a live member of parent.widgets. Required so a promoted
  // write can identify + sync the rail; without it the write fails closed.
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) },
    inputs: [{ name: "sched_alias", _widget: railWidget, widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } }],
    widgets: [
      { name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 }, // decoy own-widget (#233)
      railWidget,
    ],
  };
  const resolveSource = (_n, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#458 set_widget: SUBGRAPH promoted write to a LIVE inner type ⇒ succeeds (inner type fresh-authorized)", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  const { set } = await runSetWidget(parent, "sched_alias", "karras", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // backend defines KSampler
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, "karras");
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
});

test("#458 set_widget: SUBGRAPH promoted write to a REMOVED inner type ⇒ FAIL CLOSED, inner untouched", async () => {
  // The inner GoneNode survives in the stale registry (with a def + resolved
  // instance) so every registry-only guard passes — but the fresh /object_info no
  // longer lists it. The promoted write must be refused, not fabricated as success.
  const reg = loadedRegistry(["GoneNode"]);
  const { parent, inner, resolveSource } = makeSubgraphFixture("GoneNode");
  await assert.rejects(
    () =>
      runSetWidget(parent, "sched_alias", "karras", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides GoneNode
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 54 \("GoneNode"\)/.test(err.message) &&
      /Unknown node type "GoneNode"|backend does not provide/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "simple", "inner widget untouched");
});

test("#458 set_widget: SUBGRAPH promoted write with UNREACHABLE backend ⇒ FAIL CLOSED, inner untouched", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "sched_alias", "karras", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => {
          throw new Error("object_info fetch failed (transient)");
        },
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 54 \("KSampler"\)/.test(err.message) &&
      /cannot verify (the )?node type|object_info is unavailable/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "simple", "inner widget untouched");
});

// A TWO-LEVEL nested promotion: outer subgraph A promotes "steps" from inner subgraph
// B, which promotes "steps" from a concrete node. ComfyUI supports this. The immediate
// resolved target of A's promotion is the VIRTUAL node B (subgraph id not in
// /object_info); fresh-auth must TRAVERSE A→B→concrete and authorize the concrete type.
function makeNestedSubgraphFixture(reg, concreteType) {
  const concrete = {
    id: 90,
    type: concreteType,
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB", // virtual subgraph id — absent from /object_info
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "90" ? concrete : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  // #366 rail projection on the OUTER node A (the write resolves A→B one level, so A's
  // host input must carry the authoritative rail widget present in A.widgets).
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA", // virtual
    widgets: [{ name: "steps_decoy", type: "INT", value: 999 }, aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  // Virtual subgraph nodes register as native/defless types (no nodeData) — the write's
  // registry guard trusts them, exactly like real litegraph subgraph instances.
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  return { a, b, concrete, resolveSource };
}

test("#458 set_widget: NESTED promotion (A→B→KSampler) authorizes the CONCRETE type ⇒ succeeds (not falsely refused)", async () => {
  // The false-failure: authorizing the immediate inner target (virtual SubgraphB,
  // absent from /object_info) would refuse a valid write. Following the chain to the
  // concrete KSampler (present in fresh defs) lets the write proceed.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler present; SubgraphA/B are NOT
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "nested promoted write is authorized via the concrete type and succeeds");
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30);
});

test("#458 set_widget: NESTED promotion whose ULTIMATE CONCRETE type is REMOVED ⇒ FAIL CLOSED", async () => {
  // The chain A→B→GoneNode resolves to a concrete node the backend no longer provides
  // — traversal reaches GoneNode and fresh-auth refuses it (removed pack stays closed).
  const reg = loadedRegistry(["GoneNode"]);
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "GoneNode");
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend does NOT provide GoneNode
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 90 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "nested write refused — no mutation");
});

test("#458 set_widget: NESTED promotion to a STALE concrete INSTANCE (registered type, no instance def) ⇒ FAIL CLOSED", async () => {
  // The stale-INSTANCE bypass: A→B(virtual)→KSampler, where the concrete KSampler
  // instance is a STALE generic placeholder (constructor carries NO nodeData — the
  // workflow was loaded while ComfyUI was down). Its TYPE is live in /object_info, so
  // fresh TYPE auth passes; but applyWidgetWrite only instance-checks the IMMEDIATE
  // virtual node B (defless/trusted), so without the concrete-instance guard the stale
  // KSampler would be mutated through B's forwarding callback. Must fail closed.
  const reg = loadedRegistry();
  const { a, b, concrete, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  concrete.constructor = { name: "GenericFallback" }; // stale placeholder: no nodeData
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler live on the backend
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error && /unresolved placeholder|live definition is missing/i.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "stale concrete instance never mutated");
});

test("#458 set_widget: NESTED chain with an UNRESOLVABLE deeper link ⇒ FAIL CLOSED (no write through the registry guard)", async () => {
  // A→B resolves, but B's deeper promotion is stale/unresolvable. The chain can't reach
  // a concrete node, so the ultimate type is unverifiable — must fail closed rather than
  // mutate the immediate virtual node B behind only the (defless-trusting) registry guard.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  // Break B's deeper link: resolveSource returns nothing for B.
  const brokenSource = (subgraphNode, si) =>
    subgraphNode === a && si?.name === "steps" ? { sourceNodeId: "80", sourceWidgetName: "steps" } : null;
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource: brokenSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation on an unresolvable deeper link");
});

test("#458 set_widget: NESTED chain ending on a terminal VIRTUAL own-widget ⇒ FAIL CLOSED (virtual type never treated as concrete)", async () => {
  // A→B resolves, but B's "steps" is B's OWN (non-promoted) widget — the chain ends on a
  // virtual node. A virtual subgraph type is never in /object_info, so treating it as a
  // verified concrete node would be wrong; fail closed.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  b.inputs = []; // B no longer promotes "steps" — it becomes B's own virtual widget
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation on a terminal virtual own-widget");
});

test("#458 set_widget: NESTED chain ending on a concrete node with NO string type ⇒ FAIL CLOSED", async () => {
  // A→B→{type: undefined}: the terminal node has no `.subgraph` but also no real type,
  // so it cannot be authorized against /object_info. It must NOT slip through the
  // "no string type ⇒ skip auth" gap and mutate the immediate virtual node B.
  const reg = loadedRegistry();
  const { a, b, concrete, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  concrete.type = undefined; // malformed terminal — no backend type to verify
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation on a typeless concrete terminal");
});

test("#458 set_widget: NESTED promotion CYCLE ⇒ FAIL CLOSED (terminates, no mutation)", async () => {
  // A→B→A cycle: followPromotionToConcrete's seen-set breaks the loop and reports no
  // concrete node, so the write fails closed instead of spinning or authorizing a virtual.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  // Make B promote back to A (id 70), and let A be reachable from B's subgraph.
  b.subgraph.getNodeById = (id) => (String(id) === "70" ? a : String(id) === "90" ? b.subgraph._nodes[0] : null);
  const cyclicSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "70", sourceWidgetName: "steps" };
    return null;
  };
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource: cyclicSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
});

test("#458 set_widget: NESTED promoted COMBO recovery keys on the CONCRETE type ⇒ just-staged value accepted (not falsely rejected)", async () => {
  // A promotes B's `image`; B promotes LoadImage.image. B's exposed combo is stale
  // (missing a just-uploaded image), but fresh /object_info lists it under the CONCRETE
  // LoadImage def. The retry must refresh B's widget from LoadImage's options (keyed on
  // the concrete type), NOT the virtual SubgraphB (absent from /object_info) — otherwise
  // a legit just-uploaded image on a nested-promoted combo is wrongly rejected.
  const reg = loadedRegistry();
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const loadImage = {
    id: 90,
    type: "LoadImage",
    widgets: [{ name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    subgraph: { _nodes: [loadImage], getNodeById: (id) => (String(id) === "90" ? loadImage : null) },
    inputs: [{ name: "image", _subgraphSlot: { name: "image" } }],
  };
  // #366 rail projection on the OUTER node A (the write resolves A→B one level).
  const aRail = { name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "image", _widget: aRail, widget: { name: "image" }, _subgraphSlot: { name: "image" } }],
  };
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "image") return { sourceNodeId: "80", sourceWidgetName: "image" };
    if (subgraphNode === b && si?.name === "image") return { sourceNodeId: "90", sourceWidgetName: "image" };
    return null;
  };

  // Fresh /object_info: LoadImage's `image` combo now lists the just-uploaded file;
  // SubgraphA/B are virtual and absent (as they always are).
  const FRESH = objectInfo();
  FRESH.LoadImage = { input: { required: { image: [["old.png", "new_upload.png"], {}] } } };

  let getNodeDefsCalls = 0;
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };

  const res = await runSetWidget(a, "image", "new_upload.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => getNodeDefs(),
    // Production wiring: refresh the write-target node's combos keyed on the CONCRETE type.
    refreshCombos: (defs, target, concreteType, nameMap) => {
      if (defs) {
        refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
        return;
      }
      return getNodeDefs();
    },
    resolveSource,
    ...HOOKS,
  });

  assert.equal(res.set.value, "new_upload.png", "nested promoted combo accepts the just-staged value after concrete refresh");
  assert.equal(res.refreshed, true);
  assert.equal(b.widgets.find((w) => w.name === "image").value, "new_upload.png");
  assert.equal(getNodeDefsCalls, 1, "single /object_info fetch across auth + nested combo retry");
});

test("#458×#366 set_widget: RENAMED nested promoted COMBO recovery bridges the widget name ⇒ value accepted", async () => {
  // #366 supports RENAMED promotions: A exposes "img_a" → B's "img_b" → LoadImage's
  // "image". The stale combo lives on B's "img_b" widget, but its authoritative options
  // live under the CONCRETE def's "image" input. The retry must bridge img_b → image
  // (the ultimate concrete widget name) — keying by the mutated widget's own name would
  // find nothing in LoadImage's def and reject a valid just-staged value.
  const reg = loadedRegistry();
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const loadImage = {
    id: 90,
    type: "LoadImage",
    widgets: [{ name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "img_b", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    subgraph: { _nodes: [loadImage], getNodeById: (id) => (String(id) === "90" ? loadImage : null) },
    inputs: [{ name: "img_b", _subgraphSlot: { name: "img_b" } }],
  };
  const aRail = { name: "img_a", type: "combo", options: { values: ["old.png"] }, value: "old.png" };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "img_a", _widget: aRail, widget: { name: "img_a" }, _subgraphSlot: { name: "img_a" } }],
  };
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "img_a") return { sourceNodeId: "80", sourceWidgetName: "img_b" };
    if (subgraphNode === b && si?.name === "img_b") return { sourceNodeId: "90", sourceWidgetName: "image" };
    return null;
  };

  const FRESH = objectInfo();
  FRESH.LoadImage = { input: { required: { image: [["old.png", "new_upload.png"], {}] } } };
  let getNodeDefsCalls = 0;
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };

  const res = await runSetWidget(a, "img_a", "new_upload.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => getNodeDefs(),
    refreshCombos: (defs, target, concreteType, nameMap) => {
      if (defs) {
        refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
        return;
      }
      return getNodeDefs();
    },
    resolveSource,
    ...HOOKS,
  });

  assert.equal(res.set.value, "new_upload.png", "renamed nested promoted combo accepts the just-staged value");
  assert.equal(res.refreshed, true);
  assert.equal(b.widgets.find((w) => w.name === "img_b").value, "new_upload.png");
  assert.equal(getNodeDefsCalls, 1, "single /object_info fetch across auth + renamed nested combo retry");
});

test("#458×#366 set_widget: promoted write reuses the THREADED resolution AND syncs the authoritative rail (composed)", async () => {
  // #423 threads the resolution the fresh-auth gate used into applyWidgetWrite, so the
  // write targets the authorized inner node; #366 syncs the authoritative parent rail
  // atomically. A decoy sibling node (GoneNode) sits in the same subgraph and must
  // NEVER be the write target. Together: the write lands on the authorized live inner
  // node + the rail, and the decoy is untouched.
  const reg = loadedRegistry(["GoneNode"]);
  const live = {
    id: 54,
    type: "KSampler",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const gone = {
    id: 77,
    type: "GoneNode",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const subgraph = {
    _nodes: [live, gone],
    getNodeById: (id) => (String(id) === "54" ? live : String(id) === "77" ? gone : null),
  };
  // #366 authoritative rail projection identity-linked from the host input.
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "sched_alias", _widget: railWidget, widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } }],
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 }, railWidget],
  };
  // Deterministic promotion → the LIVE inner (KSampler); GoneNode is only a decoy
  // sibling, never linked by the promotion.
  const resolveSource = (_n, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;

  const { set } = await runSetWidget(parent, "sched_alias", "karras", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler live, GoneNode absent
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, "karras");
  assert.equal(live.widgets.find((w) => w.name === "scheduler").value, "karras", "write landed on the authorized live inner node");
  assert.equal(railWidget.value, "karras", "#366: authoritative parent rail synced");
  assert.equal(gone.widgets.find((w) => w.name === "scheduler").value, "simple", "the decoy sibling was never touched");
});

// ---- #458 NESTED-INTERMEDIATE (adversarial review of #475): a nested promotion must
//      authorize the INTERMEDIATE node whose widget is actually mutated, not only the
//      terminal traversal target. A removed-backend husk sitting as the intermediate
//      must be REFUSED (never "defless + subgraph metadata" = trusted). --------------

// Outer subgraph A promotes "val" through an INTERMEDIATE node to a terminal KSampler
// widget. `intermediate` is parameterized so the test can make it a genuine virtual
// container OR a removed-backend husk. `reg` is mutated to register the intermediate.
function makeNestedIntermediateFixture(reg, { intermediateType, intermediateBackend, intermediateRealSubgraph = true }) {
  const terminal = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const midSubgraph = intermediateRealSubgraph
    ? { _nodes: [terminal], getNodeById: (id) => (String(id) === "90" ? terminal : null) }
    : {}; // FAKE subgraph marker — not a real container
  const mid = {
    id: 80,
    type: intermediateType,
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: midSubgraph,
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  // The intermediate's registered class + instance provenance.
  const midCtor = function MidCtor() {};
  if (intermediateBackend) {
    midCtor.nodeData = { input: { required: {} } }; // BACKEND provenance (removed pack's stale class)
    mid.constructor = midCtor;
  }
  reg[intermediateType] = midCtor;

  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [mid], getNodeById: (id) => (String(id) === "80" ? mid : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {}; // A is a genuine virtual container (defless, no backend provenance)
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === mid && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  return { a, mid, terminal, resolveSource };
}

test("#458 NESTED-INTERMEDIATE: a REMOVED-BACKEND husk intermediate (backend provenance, real subgraph, absent from object_info) ⇒ FAIL CLOSED — no fabricated success", async () => {
  // Exact trigger: outer A promotes through a stale removed-backend `GoneNode` (which
  // still carries a real subgraph + promotion metadata AND backend provenance) to a
  // genuine terminal KSampler. Fresh object_info lacks GoneNode. The terminal passes,
  // but the write MUTATES GoneNode's own widget — it must be refused on GoneNode.
  const reg = loadedRegistry(["GoneNode"]); // GoneNode registered WITH nodeData (backend provenance)
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "GoneNode",
    intermediateBackend: true,
  });
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler present, GoneNode absent
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 80 \("GoneNode"\)/.test(err.message) &&
      /not a verifiable frontend-only \/ virtual-subgraph node|masquerading/i.test(err.message),
  );
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 20, "the removed-backend intermediate is never mutated (#458)");
});

test("#458 NESTED-INTERMEDIATE: a defless husk intermediate with a FAKE `subgraph:{}` (no real nested graph) ⇒ FAIL CLOSED", async () => {
  // A bare husk (no backend provenance) carrying only a truthy `subgraph:{}` marker is
  // NOT a real virtual container (no _nodes/getNodeById), so it must not be trusted.
  const reg = loadedRegistry();
  // Build with a REAL subgraph first so followPromotionToConcrete can traverse to the
  // terminal, then swap the intermediate's subgraph to a fake marker to model the husk.
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "BareHusk",
    intermediateBackend: false,
  });
  mid.subgraph = {}; // fake marker — not a real container
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource,
        ...HOOKS,
      }),
    // Refused — either by the new intermediate guard or the pre-existing
    // concrete-resolution guard (a fake subgraph can't be traversed to a concrete node).
    (err) => err instanceof Error && /refusing to write|could not be resolved to a concrete backend node|not a verifiable frontend-only/i.test(err.message),
  );
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 20, "a fake-subgraph husk intermediate is never mutated");
});

test("#458 NESTED-INTERMEDIATE REGRESSION: a GENUINE virtual-container intermediate (real subgraph, no backend provenance) ⇒ still SUCCEEDS", async () => {
  const reg = loadedRegistry();
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "SubgraphB",
    intermediateBackend: false,
  });
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "a genuine nested promotion through a virtual container still writes");
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 30);
});

test("#458 NESTED-INTERMEDIATE (3-level A→B→C→concrete): a REMOVED-BACKEND husk as the DEEPER intermediate C ⇒ FAIL CLOSED (every driven-through container is authorized, not just the immediate inner)", async () => {
  // The value is driven A→B→C→KSampler. B is a genuine virtual container, but C is a
  // removed-backend node (backend provenance) carrying a real subgraph. The terminal
  // KSampler passes; the immediate inner B passes; C must STILL be authorized and refused.
  const reg = loadedRegistry(["GoneNode"]);
  const terminal = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  // C — removed-backend husk with a REAL nested graph AND backend provenance.
  const cCtor = function GoneNodeCtor() {};
  cCtor.nodeData = { input: { required: {} } }; // backend provenance (class + instance)
  const c = {
    id: 85,
    type: "GoneNode",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [terminal], getNodeById: (id) => (String(id) === "90" ? terminal : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
    constructor: cCtor,
  };
  reg["GoneNode"] = cCtor;
  // B — genuine virtual container (defless, no backend provenance).
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [c], getNodeById: (id) => (String(id) === "85" ? c : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphB = function SubgraphB() {};
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "85", sourceWidgetName: "steps" };
    if (subgraphNode === c && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler present; GoneNode/SubgraphA/B absent
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 85 \("GoneNode"\)/.test(err.message) &&
      /not a verifiable frontend-only \/ virtual-subgraph node|masquerading/i.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation when a deeper intermediate is a removed-backend node");
  assert.equal(c.widgets.find((w) => w.name === "steps").value, 20);
});

test("#458 NESTED-INTERMEDIATE (3-level): all-genuine virtual containers A→B→C→KSampler ⇒ still SUCCEEDS", async () => {
  const reg = loadedRegistry();
  const terminal = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const c = {
    id: 85,
    type: "SubgraphC",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [terminal], getNodeById: (id) => (String(id) === "90" ? terminal : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphC = function SubgraphC() {};
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [c], getNodeById: (id) => (String(id) === "85" ? c : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphB = function SubgraphB() {};
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "85", sourceWidgetName: "steps" };
    if (subgraphNode === c && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "a fully-virtual 3-level promotion still writes");
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30);
});

test("#458 EVER-SEEN INTERMEDIATE: a PROVENANCE-CLEAN, real-subgraph intermediate whose type was EVER in object_info ⇒ REFUSED (forged-container concern closed by observed history)", async () => {
  // The forged-virtual-container concern: a removed-backend node can be made
  // provenance-clean (generic placeholder) with a real `.subgraph`, passing every
  // client-side shape/provenance check. The ever-seen gate refuses it: the backend
  // reported this type earlier this session, so its absence now = removed.
  const reg = loadedRegistry();
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "WasBackendContainer",
    intermediateBackend: false, // provenance-clean, real subgraph (looks like a virtual container)
  });
  const everSeen = new Set(["WasBackendContainer"]); // backend reported it earlier this session
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler present; WasBackendContainer absent now
        wasTypeEverDefined: (t) => everSeen.has(t),
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 80 \("WasBackendContainer"\)/.test(err.message) &&
      /was defined by the ComfyUI backend earlier this session|since-removed/i.test(err.message),
  );
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 20, "a since-removed container intermediate is never driven-through");
});

test("#458 EVER-SEEN INTERMEDIATE: a genuine virtual container (type NEVER in object_info) ⇒ still SUCCEEDS with the gate wired", async () => {
  const reg = loadedRegistry();
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "SubgraphB",
    intermediateBackend: false,
  });
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    wasTypeEverDefined: () => false, // virtual subgraph ids are never in /object_info
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30);
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 30);
});

// ---- #512: outer UUID subgraph node whose class carries the frontend's SYNTHESIZED
//      def markers. Current ComfyUI_frontend's registerSubgraphNodeDef stamps static
//      nodeData + comfyClass on EVERY subgraph node's registered class (registered
//      under the subgraph's UUID), so the #458 provenance heuristic false-fired on the
//      genuine container and refused a CORRECT promoted write as an "unverifiable
//      virtual-subgraph node". The container must instead be authorized through its
//      RESOLVED, fresh-authorized concrete inner target — while a promotion that does
//      NOT resolve (or an ever-seen/removed container type) must still fail closed. ----

// The bundled ltx-2.3-img2vid repro: outer node 320, type is the subgraph's UUID.
const SUBGRAPH_UUID = "2454ad83-157c-40dd-9f19-5daaf4041ce0";

// A SubgraphNode shaped the way current ComfyUI_frontend actually builds one: the type
// is the subgraph's UUID (never in /object_info), and BOTH the registered class and the
// instance's own constructor carry the synthesized nodeDef (nodeData + comfyClass) that
// registerSubgraphNodeDef stamps BY DESIGN. `innerType` flips the inner node between a
// live and a removed backend type. Returns null resolveSource when `resolvable` is
// false to model a stale/empty promoted link.
function makeUuidSubgraphFixture(reg, innerType, { resolvable = true } = {}) {
  const inner = {
    id: 301,
    type: innerType,
    widgets: [{ name: "value_4", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  // #366: the AUTHORITATIVE parent rail projection — identity-linked from the host
  // input (`_widget`) and a live member of parent.widgets.
  const railWidget = { name: "value_4", type: "INT", value: 20 };
  const parent = {
    id: 320,
    type: SUBGRAPH_UUID,
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) },
    inputs: [{ name: "value_4", _widget: railWidget, widget: { name: "value_4" }, _subgraphSlot: { name: "value_4" } }],
    widgets: [railWidget],
  };
  // registerSubgraphNodeDef: the synthesized def is stamped on the class, which is
  // registered under the subgraph's UUID — the "backend provenance" that false-fired.
  const ctor = function ComfySubgraphNode() {};
  ctor.nodeData = { input: { required: {} }, name: SUBGRAPH_UUID };
  ctor.comfyClass = SUBGRAPH_UUID;
  parent.constructor = ctor;
  reg[SUBGRAPH_UUID] = ctor;
  const resolveSource = (_n, si) =>
    resolvable && si?.name === "value_4" ? { sourceNodeId: "301", sourceWidgetName: "value_4" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#512: promoted write on an outer UUID subgraph node (synthesized-def provenance) ⇒ SUCCEEDS via the resolved inner target", async () => {
  // The exact reported repro: the guard refused this as "not a verifiable frontend-only
  // / virtual-subgraph node" purely because the class carries the frontend-stamped def.
  // The promotion resolves to a live, fresh-authorized inner node — the write is correct
  // and must proceed, landing on the inner node + syncing the authoritative rail.
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  const { set } = await runSetWidget(parent, "value_4", 42, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler present; the UUID never is
    wasTypeEverDefined: () => false, // UUID subgraph types are never backend-defined
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 42);
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 42, "write landed on the resolved inner node");
  assert.equal(railWidget.value, 42, "#366: authoritative parent rail synced");
});

test("#512: promoted write on a UUID subgraph node whose inner type is REMOVED ⇒ still FAIL CLOSED", async () => {
  // The relaxation authorizes the CONTAINER through the resolved inner target — it says
  // nothing about the target itself. A removed inner type is still refused by the fresh
  // oracle, exactly as before.
  const reg = loadedRegistry(["GoneNode"]);
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "GoneNode");
  await assert.rejects(
    () =>
      runSetWidget(parent, "value_4", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides GoneNode
        wasTypeEverDefined: () => false,
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 301 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#512: UNRESOLVABLE promotion on a UUID subgraph node ⇒ still REFUSED (no concrete target, no write)", async () => {
  // The exemption is scoped to a POSITIVELY-resolved, concrete-authorized promotion. A
  // promoted widget whose inner link is stale/empty never earns it — fail closed.
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler", { resolvable: false });
  await assert.rejects(
    () =>
      runSetWidget(parent, "value_4", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        wasTypeEverDefined: () => false,
        resolveSource, // stale/empty linkIds — the promotion cannot be resolved
        ...HOOKS,
      }),
    (err) => err instanceof Error && /refused.*no resolvable inner link|no resolvable inner link/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#512: the EVER-SEEN gate still REFUSES a container type the backend reported earlier (the flag never bypasses the trust root)", async () => {
  // If the backend DID report this type earlier this session and it is now absent, the
  // node is a removed backend node masquerading as a subgraph container — refused before
  // the resolved-promotion exemption is ever consulted (#458 stays closed).
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "value_4", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // the type is ABSENT now…
        wasTypeEverDefined: (t) => t === SUBGRAPH_UUID, // …but was reported EARLIER this session
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 320/.test(err.message) &&
      /was defined by the ComfyUI backend earlier this session|since-removed/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#512: NESTED promotion through a provenance-stamped UUID intermediate ⇒ SUCCEEDS (every driven-through container authorized via the chain)", async () => {
  // On current frontends EVERY subgraph node in the chain carries the synthesized def,
  // not just the outer one — a nested A→B→KSampler promotion must authorize the
  // intermediate B through the same resolved-chain evidence or it false-refuses too.
  const reg = loadedRegistry();
  const INNER_UUID = "bbbbbbbb-1111-4222-8333-cccccccccccc";
  const concrete = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const stamp = (node, uuid) => {
    const ctor = function ComfySubgraphNode() {};
    ctor.nodeData = { input: { required: {} }, name: uuid };
    ctor.comfyClass = uuid;
    node.constructor = ctor;
    reg[uuid] = ctor;
  };
  const b = {
    id: 80,
    type: INNER_UUID,
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "90" ? concrete : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  stamp(b, INNER_UUID);
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: SUBGRAPH_UUID,
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  stamp(a, SUBGRAPH_UUID);
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler present; both UUIDs absent
    wasTypeEverDefined: () => false,
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "nested promoted write authorized via the resolved concrete chain");
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30, "the intermediate forwarded the write");
  assert.equal(aRail.value, 30, "#366: authoritative outer rail synced");
});

// ---- #612: a widget that is NOT promoted on a GENUINE subgraph container must be
//      refused with the HONEST diagnosis — "not a promoted widget on this subgraph",
//      naming what IS promoted and the actionable remedy — never the generic #458
//      "the ComfyUI backend does not provide node type <uuid>" message, which
//      misreports a benign not-promoted case as an uninstalled/removed pack and
//      sends the agent reinstalling packs or restarting ComfyUI. This is also the
//      #512 recurrence: the krea2 pack's legacy proxyWidgets promotion of
//      control_after_generate is QUARANTINED on load by the current frontend (a
//      canvas-only control widget has no connectable slot), so the outer node has
//      no such promotion and the refusal is correct — only its message was wrong. ----

test("#612: non-promoted widget on a genuine UUID subgraph node ⇒ honest 'not a promoted widget' refusal", async () => {
  // The exact reported shape (#612 node 105 / #512-recurrence node 78): a genuine
  // subgraph container with one promoted widget (value_4), asked to write a widget
  // that is NOT promoted (control_after_generate — it exists on an inner node but
  // is not exposed on the boundary).
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "control_after_generate", "fixed", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // healthy backend
        wasTypeEverDefined: () => false, // the UUID was never backend-defined
        resolveSource,
        ...HOOKS,
      }),
    (err) => {
      assert.match(err.message, /Cannot set widget on subgraph node 320/);
      assert.match(err.message, /"control_after_generate" is not a promoted widget on this subgraph/);
      // The reason must name what IS promoted so the caller can self-correct…
      assert.match(err.message, /promoted: value_4/);
      // …and point at the actionable remedy…
      assert.match(err.message, /panel_enter_subgraph/);
      assert.match(err.message, /panel_promote_widget/);
      // …and NEVER blame a removed/uninstalled pack — nothing was uninstalled.
      assert.doesNotMatch(err.message, /backend does not provide/i);
      assert.doesNotMatch(err.message, /not installed, or its pack was removed/i);
      return true;
    },
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#612: an UNREACHABLE backend does NOT establish the not-promoted diagnosis — it reports the honest 'could not verify' instead", async () => {
  // The definite "this is an unpromoted widget on a subgraph" finding claims the node is
  // a virtual-only container, and that claim rests on the type being ABSENT from the
  // CURRENT /object_info. When the fetch FAILED there is no current /object_info at all:
  // an unavailable map is could-not-determine, not "the backend lacks this type". Both
  // read as "no entry" to a membership test, so they must be told apart here or an
  // unreachable backend silently becomes positive evidence for a definite verdict.
  //
  // The refusal is unchanged (fail closed). Only the diagnosis differs, and "reconnect
  // and retry" is the accurate one: it IS a transient verification failure.
  const reg = loadedRegistry();
  const { parent, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "control_after_generate", "fixed", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null, // backend unreachable
        wasTypeEverDefined: () => false,
        resolveSource,
        ...HOOKS,
      }),
    (err) => {
      assert.match(err.message, /object_info is unavailable|cannot verify the node type/i);
      assert.doesNotMatch(err.message, /is not a promoted widget on this subgraph/);
      return true;
    },
  );
  assert.equal(railWidget.value, 20, "no mutation");
});

test("#612: a REJECTED /object_info fetch is treated the same as an unavailable one", async () => {
  // The fetch is wrapped in a catch that sets freshDefs = null, so a throwing oracle and
  // a null-returning one arrive at the identical state. Both must be could-not-determine.
  const reg = loadedRegistry();
  const { parent, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "control_after_generate", "fixed", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => {
          throw new Error("network down");
        },
        wasTypeEverDefined: () => false,
        resolveSource,
        ...HOOKS,
      }),
    (err) => {
      assert.doesNotMatch(err.message, /is not a promoted widget on this subgraph/);
      return true;
    },
  );
  assert.equal(railWidget.value, 20, "no mutation");
});

test("#612: an EVER-SEEN container type keeps the removed-type diagnosis (the trust root wins)", async () => {
  // The honest "not a promoted widget" branch is only for a container whose type the
  // backend NEVER reported. A container-shaped node whose type was in an earlier
  // /object_info this session is a removed backend node masquerading as a container —
  // the #458 removed-type diagnosis is the accurate one and must not be masked.
  const reg = loadedRegistry();
  const { parent, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "control_after_generate", "fixed", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // the type is ABSENT now…
        wasTypeEverDefined: (t) => t === SUBGRAPH_UUID, // …but was reported EARLIER
        resolveSource,
        ...HOOKS,
      }),
    (err) => {
      assert.match(err.message, /was defined by the ComfyUI backend earlier this session|since-removed/i);
      assert.doesNotMatch(err.message, /not a promoted widget/i);
      return true;
    },
  );
  assert.equal(railWidget.value, 20, "no mutation");
});

test("#612: a bare `subgraph:{}` marker that is NOT a real container keeps the #458 fresh-auth diagnosis", async () => {
  // The subgraph-shaped bypass fixture: a stale type carrying a truthy `subgraph`
  // field that fails the virtual-container shape check. It must NOT get the benign
  // "not a promoted widget" message — the backend-type diagnosis stands.
  const reg = loadedRegistry();
  const node = regNode("SubgraphNode", [{ name: "steps", type: "INT", value: 20 }], { subgraph: {} });
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 7, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend provides no "SubgraphNode"
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) => {
      assert.match(err.message, /backend does not provide/i);
      assert.doesNotMatch(err.message, /not a promoted widget/i);
      return true;
    },
  );
  assert.equal(node.widgets[0].value, 20, "no mutation");
});

// ---- The #612 diagnosis must NOT be asserted from an absence of evidence. It claims
//      the node is a virtual-only container, and that claim needs TWO positive facts:
//      the current /object_info does NOT define the type, AND the history oracle
//      positively reports never-seen. Getting either wrong refuses a LEGITIMATE write
//      and hands the caller a remedy that is actionable but WRONG — worse than a bare
//      refusal, because it sends them to promote a widget on a node that is not a
//      subgraph at all. These tests pin both directions: the honest refusal survives,
//      and the valid direct write is permitted FOR THE FRESH-TYPE REASON. ----

// A backend-defined, subgraph-SHAPED node installed AFTER the startup baseline: the
// pack's class builds an inner graph (so isVirtualSubgraphContainer says "container"),
// but the backend genuinely defines the type and it carries a direct OWN widget with no
// promoted inputs. On its FIRST observation the history oracle honestly reports
// never-seen — it was not in the baseline — while the fresh /object_info this very call
// fetched positively defines it.
const LATE_INSTALLED_TYPE = "AcmeVirtualCompositor";
function makeLateInstalledContainerNode() {
  const own = { name: "strength", type: "INT", value: 20 };
  const ctor = function AcmeVirtualCompositor() {};
  ctor.nodeData = { input: { required: {} } };
  return {
    node: {
      id: 412,
      type: LATE_INSTALLED_TYPE,
      // Container SHAPE — a real nested graph, not a bare `subgraph:{}` marker.
      subgraph: { _nodes: [], getNodeById: () => null },
      inputs: [], // nothing promoted onto the boundary
      widgets: [own],
      constructor: ctor,
    },
    own,
    ctor,
  };
}
function registryWithLateInstalled() {
  const reg = loadedRegistry();
  const { ctor } = makeLateInstalledContainerNode();
  reg[LATE_INSTALLED_TYPE] = ctor;
  return reg;
}

test("#612 regression: a backend-defined container-shaped node added AFTER the baseline ⇒ its direct own-widget write is PERMITTED by fresh-type authorization", async () => {
  // never-seen history is "the startup baseline did not list it", NOT "the backend does
  // not define it". The fresh /object_info this call already fetched settles it, and the
  // fresh-type authorization is entitled to permit the write. Short-circuiting to the
  // not-promoted diagnosis on history alone refuses a write that worked yesterday.
  const reg = registryWithLateInstalled();
  const { node, own } = makeLateInstalledContainerNode();
  reg[LATE_INSTALLED_TYPE] = node.constructor;
  let fetches = 0;
  const { set } = await runSetWidget(node, "strength", 42, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => {
      fetches += 1;
      return objectInfo([LATE_INSTALLED_TYPE]); // the backend DOES define it now
    },
    wasTypeEverDefined: () => false, // absent from the startup baseline ⇒ never-seen
    ...HOOKS,
  });
  assert.equal(set.value, 42);
  assert.equal(own.value, 42, "the write landed on the node's OWN widget");
  // THE REASON, not just the outcome: the permission came from the FRESH backend
  // definition. The oracle was actually consulted…
  assert.equal(fetches, 1, "the fresh /object_info oracle was consulted");
});

test("#612 regression, the discriminating half: the SAME node with the type ABSENT from fresh /object_info is still REFUSED as not-promoted", async () => {
  // Paired with the test above, this is what makes "permitted for the fresh-type reason"
  // an assertion rather than a hope: the ONLY difference between the two is whether the
  // current /object_info defines the type. Nothing else about the node changed. If the
  // loosened branch permitted on some other ground, this one would pass too.
  const reg = registryWithLateInstalled();
  const { node, own } = makeLateInstalledContainerNode();
  reg[LATE_INSTALLED_TYPE] = node.constructor;
  await assert.rejects(
    () =>
      runSetWidget(node, "strength", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // the type is NOT defined
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) => {
      assert.match(err.message, /is not a promoted widget on this subgraph/);
      return true;
    },
  );
  assert.equal(own.value, 20, "no mutation");
});

test("#612: an UNWIRED history oracle falls THROUGH to fresh-type authorization — a live type is PERMITTED", async () => {
  // `no-oracle` is the could-not-determine case BY DEFINITION: it establishes neither
  // "never backend-defined" nor safe container identity (backendHistoryVerdict's own
  // fail-closed contract). It must therefore not short-circuit to the definite "this is
  // an unpromoted widget on a subgraph" negative — it must defer to the fresh result the
  // call already fetched, which here positively defines the type.
  const reg = registryWithLateInstalled();
  const { node, own } = makeLateInstalledContainerNode();
  reg[LATE_INSTALLED_TYPE] = node.constructor;
  const { set } = await runSetWidget(node, "strength", 7, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo([LATE_INSTALLED_TYPE]),
    // wasTypeEverDefined deliberately OMITTED ⇒ "no-oracle"
    ...HOOKS,
  });
  assert.equal(set.value, 7);
  assert.equal(own.value, 7, "the valid direct write was not refused for a missing oracle");
});

test("#612: an UNWIRED history oracle still FAILS CLOSED when the fresh backend does not define the type", async () => {
  // Falling through is not loosening the refusal — only the diagnosis. With no history
  // oracle we cannot establish that this UUID node is a genuine container rather than a
  // removed backend node, so we must not assert the container diagnosis; the fresh-auth
  // refusal stands and nothing is mutated.
  const reg = loadedRegistry();
  const { parent, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "control_after_generate", "fixed", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        // wasTypeEverDefined deliberately OMITTED
        resolveSource,
        ...HOOKS,
      }),
    (err) => {
      // Refused — and the message does NOT claim the not-promoted finding, which no
      // oracle established here.
      assert.doesNotMatch(err.message, /is not a promoted widget on this subgraph/);
      assert.match(err.message, /backend does not provide/i);
      return true;
    },
  );
  assert.equal(railWidget.value, 20, "no mutation");
});
