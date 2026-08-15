// panel#708 — `panel_new_workflow` reports a blank tab, a reconnect lands, and the
// tab persists holding the PREVIOUS workflow's graph.
//
// THE REPORT. A dirty 12-node / 4-group workflow was active. `panel_new_workflow`
// returned `{created:true, active:"Unsaved Workflow", key:"tmp:…"}`. The connection
// dropped before any load or graph edit. After reconnect the new tab had persisted as
// "Untitled <timestamp>" and `panel_graph_outline` on it showed the previous 12 nodes
// and 4 groups. No exception anywhere — the success result was simply false. An agent
// told it has a blank canvas starts BUILDING, so this is silent corruption of the
// user's work with no signal to either party until the damage is visible.
//
// THE TWO HALVES, both covered here.
//
// 1. THE CAUSE — a save that reads the GLOBAL canvas for a tab-local file.
//    ComfyUI keeps ONE root graph and ONE `activeWorkflow` pointer, and they can
//    disagree: a reconnect's tab-restore repaints the shared canvas by itself, so the
//    canvas can hold W while the active tab is the brand-new N. `ChangeTracker`
//    serializes `app.rootGraph` into whichever tracker is ACTIVE, so anything that asks
//    "what is on the canvas?" in that window answers with W.
//    The panel's Save-As copy trio did exactly that. `workflowStore.openWorkflow`
//    (which is what `app.extensionManager.workflow` exposes — the STORE, not the
//    service) moves the active pointer WITHOUT repainting the canvas; only
//    `workflowService.openWorkflow` calls `loadGraphData`. The trio then called
//    `prepareForSave()` on the freshly-activated COPY, and that capture overwrote the
//    tab-local state `saveAs` had faithfully copied with whatever the shared canvas
//    held. The fix moves the capture to the SOURCE tab, before the copy is taken, and
//    only when the canvas is PROVEN to be that tab's canvas.
//
// 2. THE ACKNOWLEDGEMENT — `created:true` was never earned. `workflow_new` already
//    computes a both-sides-proven-empty test (for #606's identity stamp). That is the
//    only evidence it has that the tab it calls "a brand-new BLANK workflow" is blank,
//    so it now decides the acknowledgement too: unproven ⇒ outcome-unknown, never
//    `created:true`.
//
// WHAT THESE TESTS DELIBERATELY DO NOT DO. Nothing here blanks a tab. Fixing this by
// emptying tabs that "should" be empty would be data loss in the other direction, so
// the legitimate-content cases are asserted just as hard as the corruption ones.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  saveActiveWorkflow,
  groundActiveWorkflow,
  normalizeCanvasBinding,
} from "../../web/js/lib/workflow-save.js";
import {
  graphRootProvenEmpty,
  activeWorkflowProvenEmpty,
  graphRootWorkflowUuidMatches,
  graphRootWorkflowUuidMismatches,
} from "../../web/js/lib/graph-binding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A serialized graph with `n` nodes and `g` groups — the shape ChangeTracker keeps
 *  and LiteGraph's serialize() emits. */
const graph = (n, g = 0, tag = null) => ({
  last_node_id: n,
  last_link_id: 0,
  nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1, type: `Node${i + 1}` })),
  links: [],
  groups: Array.from({ length: g }, (_, i) => ({ id: i + 1, title: `Group ${i + 1}` })),
  config: {},
  extra: tag ? { comfyui_mcp: { workflow_uuid: tag } } : {},
  version: 0.4,
});

// The previous workflow the reporter had open: dirty, 12 nodes, 4 groups.
const PREVIOUS_WORKFLOW_GRAPH = () => graph(12, 4, "uuid-previous");
const BLANK_GRAPH = () => graph(0, 0, "uuid-new-tab");

// ---------------------------------------------------------------------------
// A frontend double that reproduces the exact store semantics this bug lives in.
//
// Faithful on the three points that matter, each verified against the installed
// frontend source (workflowStore.ts / comfyWorkflow.ts / changeTracker.ts):
//   • `saveAs(wf, path)` builds the copy from `wf.activeState` — TAB-LOCAL content.
//   • `workflowStore.openWorkflow(copy)` loads the copy's own content and moves the
//     active pointer, and DOES NOT touch the canvas. The canvas keeps holding whatever
//     it held. This is the property the bug depends on.
//   • `prepareForSave()` is `captureCanvasState()`: it serializes the ONE shared live
//     canvas into whichever tracker is ACTIVE — never "this workflow's graph".
//   • `save()` writes `JSON.stringify(activeState)`.
// ---------------------------------------------------------------------------
function makeFrontend({ liveCanvas, active, disk = [] }) {
  const canvas = { state: clone(liveCanvas) };
  const files = new Map(disk.map((d) => [d, "{}"]));
  const records = [];

  const attachTracker = (wf) => {
    wf.changeTracker = {
      get activeState() {
        return wf._state;
      },
      // captureCanvasState(): serializes the shared live canvas into THIS tracker,
      // but only while this workflow is the active one (isActiveTracker).
      prepareForSave() {
        if (svc.activeWorkflow !== wf) return;
        wf._state = clone(canvas.state);
      },
    };
    return wf;
  };

  const svc = {
    activeWorkflow: null,
    workflows: records,
    openWorkflows: records,
    canvas,
    files,
    calls: [],
    getWorkflowByPath(path) {
      return records.find((r) => r.path === path) ?? null;
    },
    saveAs(wf, path) {
      svc.calls.push(["saveAs", wf.path, path]);
      // Content comes from the SOURCE TAB's own state — never from the canvas.
      const copy = {
        path,
        filename: path.split("/").pop(),
        directory: path.split("/").slice(0, -1).join("/"),
        initialMode: wf.initialMode,
        isPersisted: false,
        isTemporary: false,
        _state: clone(wf.changeTracker?.activeState ?? null),
        changeTracker: null, // UNLOADED until openWorkflow
      };
      records.push(copy);
      return copy;
    },
    async openWorkflow(copy) {
      svc.calls.push(["openWorkflow", copy.path]);
      // workflowStore.openWorkflow: load the copy's own content, activate it.
      // It does NOT repaint the canvas — canvas.state is untouched here on purpose.
      attachTracker(copy);
      svc.activeWorkflow = copy;
    },
    async saveWorkflow(wf) {
      svc.calls.push(["saveWorkflow", wf.path]);
      files.set(wf.path, JSON.stringify(wf.changeTracker?.activeState ?? null));
    },
  };

  active.forEach((wf) => {
    records.push(wf);
    attachTracker(wf);
  });
  svc.activeWorkflow = records[0];
  return svc;
}

/** A never-saved tab, as ComfyUI models one: a synthesized path in the workflows dir
 *  with no file behind it. `state` is its OWN tracker state. */
const tempTab = (state, { path = "workflows/Unsaved Workflow.json" } = {}) => ({
  path,
  filename: path.split("/").pop(),
  directory: "workflows",
  isPersisted: false,
  isTemporary: true,
  isModified: false,
  _state: clone(state),
});

/** A persisted tab with a real file behind it. */
const savedTab = (path, state) => ({
  path,
  filename: path.split("/").pop(),
  directory: "workflows",
  isPersisted: true,
  isTemporary: false,
  isModified: false,
  _state: clone(state),
});

const saveOpts = (svc, extra = {}) => ({
  autoWorkflowName: () => "Untitled 2026-08-06 12-00-00",
  existsOnDisk: async (path) => svc.files.has(path),
  ...extra,
});

const written = (svc, path) => JSON.parse(svc.files.get(path));

const UNTITLED = "workflows/Untitled 2026-08-06 12-00-00.json";

// ---------------------------------------------------------------------------
// 1. THE CAUSE — the persisted file must be the TAB's graph, never the canvas's
// ---------------------------------------------------------------------------

test("#708 the reported repro: a new blank tab first-saved after a reconnect must NOT persist the previous workflow's graph", async () => {
  // The exact reported state. `panel_new_workflow` created N and it is active; the
  // reconnect's own tab-restore has left the PREVIOUS dirty 12-node / 4-group workflow
  // on the shared canvas; N's own tracker still holds the blank graph it was born with.
  // Nothing has tagged the root in a way this save can read (binding "unknown"), which
  // is the weakest evidence position — and it must still not write the wrong graph.
  const n = tempTab(BLANK_GRAPH());
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });

  const saved = await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "unknown" }));

  assert.equal(saved, "Untitled 2026-08-06 12-00-00");
  const file = written(svc, UNTITLED);
  assert.equal(file.nodes.length, 0, "the new tab's file must hold the NEW tab's graph — 0 nodes");
  assert.equal(file.groups.length, 0, "…and none of the previous workflow's 4 groups");
});

test("#708 the corruption is a canvas READ, not a copy: the copy is never re-captured from the shared canvas", async () => {
  // Structural lock on the mechanism. `openWorkflow` moves the active pointer without
  // repainting, so ANY capture taken after it reads a canvas that was never asked to
  // hold the copy's graph. Prove no such capture happens by making the canvas
  // observably different from the tab and asserting the file matches the TAB.
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });
  const captures = [];
  const originalOpen = svc.openWorkflow;
  svc.openWorkflow = async (copy) => {
    await originalOpen(copy);
    const trackerPrepare = copy.changeTracker.prepareForSave;
    copy.changeTracker.prepareForSave = function (...args) {
      captures.push(copy.path);
      return trackerPrepare.apply(this, args);
    };
  };

  await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "unknown" }));

  assert.deepEqual(captures, [], "no canvas capture may be taken on the copy");
  assert.equal(written(svc, UNTITLED).nodes.length, 3, "the file is the source tab's own graph");
});

test("#708 a PROVEN-foreign canvas refuses the first save outright — no file, no fabricated success", async () => {
  // The other half of the same window. ChangeTracker captures on user input, so by the
  // time the save runs the new tab's OWN state can ALREADY have been overwritten with
  // the restored canvas. Then even a perfectly tab-local copy writes the wrong graph —
  // the tab-local state IS the wrong graph. The only remaining signal is identity: the
  // canvas positively carries a DIFFERENT workflow's tag. Refuse.
  const n = tempTab(PREVIOUS_WORKFLOW_GRAPH()); // poisoned by the frontend's own capture
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });

  await assert.rejects(
    () => saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "foreign" })),
    /#708/,
    "a first save onto a provably foreign canvas must refuse, citing the issue",
  );
  assert.equal(svc.files.size, 0, "nothing may be written");
  assert.deepEqual(svc.calls, [], "and nothing may be created in memory either");
});

test("#708 grounding is best-effort: a refused first save leaves the tab unsaved rather than throwing at the user", async () => {
  const n = tempTab(PREVIOUS_WORKFLOW_GRAPH());
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });

  const result = await groundActiveWorkflow(svc, saveOpts(svc, { canvasBinding: () => "foreign" }));

  assert.equal(result, null, "grounding reports nothing saved");
  assert.equal(svc.files.size, 0, "and writes nothing");
  assert.equal(svc.activeWorkflow, n, "the user's tab is left exactly as it was");
});

test("#708 grounding on an UNKNOWN binding still saves — the tab's own graph, not the canvas's", async () => {
  const n = tempTab(BLANK_GRAPH());
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });

  const name = await groundActiveWorkflow(svc, saveOpts(svc, { canvasBinding: () => "unknown" }));

  assert.equal(name, "Untitled 2026-08-06 12-00-00", "an unprovable binding must not block grounding");
  assert.equal(written(svc, UNTITLED).nodes.length, 0);
});

// ---------------------------------------------------------------------------
// 2. THE OTHER DIRECTION — a tab that legitimately holds content still saves it
// ---------------------------------------------------------------------------

test("#708 no blanking: a temp tab holding real work saves that work (unknown binding ⇒ its own tracker state)", async () => {
  const n = tempTab(graph(7, 2));
  const svc = makeFrontend({ liveCanvas: graph(7, 2), active: [n] });

  await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "unknown" }));

  const file = written(svc, UNTITLED);
  assert.equal(file.nodes.length, 7, "the user's 7 nodes must reach disk");
  assert.equal(file.groups.length, 2, "and their 2 groups");
});

test("#708 a BOUND canvas is still flushed into the save — freshness is preserved where it is provable", async () => {
  // The capture was not removed, it was RELOCATED to the source tab. On a canvas proven
  // to be this tab's, an edit the tracker has not captured yet must still be saved —
  // otherwise the fix would silently drop the user's most recent work.
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: graph(4), active: [n] }); // canvas is one node ahead

  await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "bound" }));

  assert.equal(written(svc, UNTITLED).nodes.length, 4, "the proven-bound canvas is flushed before the copy");
});

test("#708 the flush lands on the SOURCE tab, while it is still the active one", async () => {
  // Ordering lock: `prepareForSave` on the source is a no-op once the copy has been
  // activated (isActiveTracker), so a flush placed after `openWorkflow` would silently
  // do nothing and the "bound" case would regress to stale-state saves.
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: graph(9), active: [n] });
  const order = [];
  const wrappedPrepare = n.changeTracker.prepareForSave;
  n.changeTracker.prepareForSave = function (...args) {
    order.push(["flush-source", svc.activeWorkflow === n]);
    return wrappedPrepare.apply(this, args);
  };
  const originalSaveAs = svc.saveAs;
  svc.saveAs = (...args) => {
    order.push(["saveAs"]);
    return originalSaveAs(...args);
  };

  await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "bound" }));

  assert.deepEqual(
    order,
    [["flush-source", true], ["saveAs"]],
    "the source flush must run BEFORE saveAs, while the source is still active",
  );
  assert.equal(written(svc, UNTITLED).nodes.length, 9);
});

test("#708 a source flush that THROWS aborts the save — never a reported success that dropped the newest edit", async () => {
  // codex gate. "bound" proves the canvas is this tab's; it does not prove `serialize()`
  // works. main aborted the whole save when its capture threw (the capture sat inside the
  // trio's try), so swallowing the throw here would turn that into a success that quietly
  // saved a state we KNOW may be behind the canvas. Refuse, and write nothing.
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: graph(9), active: [n] });
  n.changeTracker.prepareForSave = () => {
    throw new Error("serialize failed");
  };

  await assert.rejects(
    () => saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "bound" })),
    /serialize failed/,
    "the underlying cause must be surfaced, not swallowed",
  );
  assert.equal(svc.files.size, 0, "nothing may be written");
  assert.deepEqual(svc.calls, [], "and the copy must not even be created");
});

test("#708 an absent capture METHOD is not a failed capture: the tab's own state still saves", async () => {
  // The boundary of the rule above, stated exactly (codex gate r2 was right that the
  // earlier wording over-claimed). What a real older frontend presents is a LOADED
  // tracker that simply has no `prepareForSave` — optional chaining then takes no
  // capture at all, which is the same evidential position as an unproven binding, and
  // must stay a normal save rather than a refusal.
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: graph(9), active: [n] });
  const state = n.changeTracker.activeState;
  n.changeTracker = { activeState: state }; // loaded tracker, no capture method

  await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "bound" }));

  assert.equal(written(svc, UNTITLED).nodes.length, 3, "saved the tab's own state, unrefused");
});

test("#708 a fully UNLOADED tracker is not a failed capture either — the refusal is throw-only", async () => {
  // The stronger form: no tracker object at all. `wf?.changeTracker?.prepareForSave?.()`
  // must be a no-op, NOT a throw, so this path is left exactly where main had it (the
  // trio's own `openWorkflow` is what loads a tracker; see resolveSaveAsCopy's preamble
  // on why an unopened copy may never be persisted). This fix must not turn an unloaded
  // tracker into a new refusal.
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: graph(9), active: [n] });
  n._savedState = n.changeTracker.activeState;
  delete n.changeTracker;
  // Feed saveAs the tab's content the way a real unloaded-then-loaded source would.
  const originalSaveAs = svc.saveAs;
  svc.saveAs = (wf, path) => {
    wf.changeTracker = { activeState: wf._savedState };
    return originalSaveAs(wf, path);
  };

  await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "bound" }));

  assert.equal(written(svc, UNTITLED).nodes.length, 3, "no tracker ⇒ no capture ⇒ no refusal");
});

test("#708 the refusal message names WHAT was thrown — never '[object Object]', never a bare 'undefined'", async () => {
  // The refusal above is the only new user-facing error, and it interpolates the thrown
  // value. A plain object stringifies to "[object Object]" and one with a toJSON() that
  // returns undefined defeats JSON.stringify too (codex gate r2), so both are pinned.
  const cases = [
    [{ code: 42 }, /"code":42/],
    [{ toJSON: () => undefined }, /non-Error Object was thrown/],
    [undefined, /non-Error value \(undefined\) was thrown/],
    [null, /non-Error value \(null\) was thrown/],
  ];
  for (const [thrown, expected] of cases) {
    const n = tempTab(graph(3));
    const svc = makeFrontend({ liveCanvas: graph(9), active: [n] });
    n.changeTracker.prepareForSave = () => {
      throw thrown;
    };
    let message = "";
    await saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "bound" })).catch(
      (err) => {
        message = err.message;
      },
    );
    assert.match(message, expected);
    assert.ok(!message.includes("[object Object]"), `opaque cause in: ${message}`);
  }
});

test("#708 a PERSISTED tab's IN-PLACE save is refused too — a foreign canvas must never overwrite a real file", async () => {
  // codex gate r3. Every route persists `wf.activeState`, and ComfyUI fills that by
  // serializing the SHARED canvas into whichever tab is active — including after every
  // completed panel command. So a persisted tab whose state was captured from a
  // reconnect-restored foreign canvas would have its REAL FILE overwritten with the
  // other workflow's graph. That is strictly worse than the reported bug, so the guard
  // is not scoped to first saves.
  const w = savedTab("workflows/Foo.json", PREVIOUS_WORKFLOW_GRAPH()); // state already poisoned
  const svc = makeFrontend({
    liveCanvas: PREVIOUS_WORKFLOW_GRAPH(),
    active: [w],
    disk: ["workflows/Foo.json"],
  });
  const before = svc.files.get("workflows/Foo.json");

  await assert.rejects(
    () => saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: () => "foreign" })),
    /#708/,
  );
  assert.equal(svc.files.get("workflows/Foo.json"), before, "the user's file is untouched");
  assert.deepEqual(svc.calls, [], "and nothing was attempted");
});

test("#708 a PERSISTED tab's Save-As COPY is refused on a foreign canvas as well", async () => {
  // The copy routes read the same `activeState`, so a foreign canvas here produces a
  // NEW file holding another workflow's graph — a fabricated success, even though the
  // original survives.
  const w = savedTab("workflows/Foo.json", PREVIOUS_WORKFLOW_GRAPH());
  const svc = makeFrontend({
    liveCanvas: PREVIOUS_WORKFLOW_GRAPH(),
    active: [w],
    disk: ["workflows/Foo.json"],
  });

  await assert.rejects(
    () => saveActiveWorkflow(svc, "Bar", saveOpts(svc, { canvasBinding: () => "foreign" })),
    /#708/,
  );
  assert.ok(!svc.files.has("workflows/Bar.json"), "no copy is created");
  assert.ok(svc.files.has("workflows/Foo.json"), "and the original is untouched");
});

/** An oracle that reports "bound" once and "foreign" from then on — the reconnect
 *  landing AFTER the entry check but before anything is written. */
const foreignAfterFirstLook = () => {
  let looks = 0;
  return () => (looks++ === 0 ? "bound" : "foreign");
};

test("#708 a canvas that turns foreign AFTER the entry check still refuses (copy route)", async () => {
  // codex gate r4. The entry-time verdict is stale by the time anything is written:
  // `assertExpect` protects the workflow OBJECT, not the canvas, and a reconnect can
  // repaint the shared canvas during the save's awaited disk probes while this tab stays
  // active. Sampling once would wave through the exact write the guard exists to stop.
  const n = tempTab(BLANK_GRAPH());
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });

  await assert.rejects(
    () => saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: foreignAfterFirstLook() })),
    /#708/,
  );
  assert.equal(svc.files.size, 0, "nothing written");
  assert.deepEqual(svc.calls, [], "and no copy created — the re-assert precedes saveAs");
});

test("#708 a canvas that turns foreign AFTER the entry check still refuses (in-place route)", async () => {
  // The same window on the route that overwrites a REAL file.
  const w = savedTab("workflows/Foo.json", graph(5));
  const svc = makeFrontend({ liveCanvas: graph(5), active: [w], disk: ["workflows/Foo.json"] });
  const before = svc.files.get("workflows/Foo.json");

  await assert.rejects(
    () => saveActiveWorkflow(svc, undefined, saveOpts(svc, { canvasBinding: foreignAfterFirstLook() })),
    /#708/,
  );
  assert.equal(svc.files.get("workflows/Foo.json"), before, "the user's file is untouched");
  assert.deepEqual(svc.calls, [], "and no write was attempted");
});

test("#708 availability: an UNKNOWN binding never refuses any route — a persisted Save-As copy still works", async () => {
  // The refusal bar is a POSITIVE identity conflict. An untagged root, an older
  // frontend, or no oracle at all must leave every save exactly as it was before this
  // fix — the whole point of the tri-state.
  const w = savedTab("workflows/Foo.json", graph(5));
  const svc = makeFrontend({
    liveCanvas: PREVIOUS_WORKFLOW_GRAPH(),
    active: [w],
    disk: ["workflows/Foo.json"],
  });

  const saved = await saveActiveWorkflow(svc, "Bar", saveOpts(svc)); // no canvasBinding at all

  assert.equal(saved, "Bar");
  assert.ok(svc.files.has("workflows/Foo.json"), "the original file survives (a copy, never a move)");
  assert.equal(written(svc, "workflows/Bar.json").nodes.length, 5, "the copy holds the SOURCE tab's graph");
});

// ---------------------------------------------------------------------------
// 3. The oracle contract — absence of evidence is never evidence
// ---------------------------------------------------------------------------

test("#708 normalizeCanvasBinding: only the two positive verdicts survive; everything else is unknown", () => {
  assert.equal(normalizeCanvasBinding(() => "bound"), "bound");
  assert.equal(normalizeCanvasBinding(() => "foreign"), "foreign");
  assert.equal(normalizeCanvasBinding(undefined), "unknown", "no oracle proves nothing");
  assert.equal(normalizeCanvasBinding(() => "yes"), "unknown", "an unrecognized verdict proves nothing");
  assert.equal(normalizeCanvasBinding(() => true), "unknown", "a truthy non-verdict must not read as bound");
  assert.equal(normalizeCanvasBinding(() => undefined), "unknown");
  assert.equal(
    normalizeCanvasBinding(() => {
      throw new Error("root unreadable");
    }),
    "unknown",
    "a throwing oracle proves nothing and must never break a save",
  );
});

test("#708 describeLiveCanvasBinding: the panel's real oracle answers from IDENTITY, and only positively", () => {
  // The one piece that wires the save's tri-state to the live canvas. It must resolve the
  // workflow's identity the way the graph fences do (the live object's own uuid first,
  // `workflowStableUuid` only as the fallback — never `app.graph.extra`, which is the
  // stale value being detected), it must exempt a drifted tag the workflow's own lineage
  // claims (#545/#557), and it must answer "unknown" for every absence.
  const src = balancedFrom(SRC, "function describeLiveCanvasBinding(wf)");
  const build = ({ rootGraph, objectUuid = null, stableUuid = "uuid-tab", owns = () => false }) =>
    new Function(
      "app",
      "workflowObjectUuid",
      "workflowStableUuid",
      "graphRootWorkflowUuidMatches",
      "graphRootWorkflowUuidMismatches",
      "workflowOwnsRootUuidTag",
      "WORKFLOW_META_NAMESPACE",
      "WORKFLOW_UUID_FIELD",
      `${src}
return describeLiveCanvasBinding;`,
    )(
      { graph: rootGraph },
      () => objectUuid,
      () => stableUuid,
      graphRootWorkflowUuidMatches,
      graphRootWorkflowUuidMismatches,
      owns,
      "comfyui_mcp",
      "workflow_uuid",
    );
  const tagged = (uuid) => ({ _nodes: [], extra: { comfyui_mcp: { workflow_uuid: uuid } } });
  const wf = {};

  assert.equal(build({ rootGraph: tagged("uuid-tab") })(wf), "bound");
  assert.equal(build({ rootGraph: tagged("uuid-previous") })(wf), "foreign");
  assert.equal(build({ rootGraph: { _nodes: [], extra: {} } })(wf), "unknown", "an untagged root proves nothing");
  assert.equal(build({ rootGraph: null })(wf), "unknown", "no canvas ⇒ nothing to say");
  assert.equal(build({ rootGraph: tagged("uuid-tab") })(null), "unknown", "no workflow ⇒ nothing to say");
  assert.equal(
    build({ rootGraph: tagged("uuid-tab"), stableUuid: null })(wf),
    "unknown",
    "an unresolvable identity is never a match",
  );
  // The live object's own uuid WINS over the stable fallback: a root carrying the
  // fallback value while the object is established as something else is FOREIGN.
  assert.equal(
    build({ rootGraph: tagged("uuid-tab"), objectUuid: "uuid-established" })(wf),
    "foreign",
    "the established object identity decides, not the fallback",
  );
  // #545/#557 — a conflicting tag the workflow's OWN lineage claims is its own drifted
  // stamp on its own canvas. That must stay inconclusive: hard-refusing it would block
  // saves after a save-swap or reconnect stamp drift, which the graph fence itself
  // treats as a rebind rather than a conflict.
  const claimed = [];
  assert.equal(
    build({
      rootGraph: tagged("uuid-drifted"),
      owns: (w, rootUuid) => {
        claimed.push([w, rootUuid]);
        return true;
      },
    })(wf),
    "unknown",
    "a self-claimed drifted stamp is not a foreign canvas",
  );
  assert.deepEqual(claimed, [[wf, "uuid-drifted"]], "the claim is asked about THIS workflow and THAT tag");
});

test("#708 an oracle that throws neither refuses the save nor licenses the canvas flush", async () => {
  const n = tempTab(graph(3));
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });

  await saveActiveWorkflow(
    svc,
    undefined,
    saveOpts(svc, {
      canvasBinding: () => {
        throw new Error("root unreadable");
      },
    }),
  );

  assert.equal(written(svc, UNTITLED).nodes.length, 3, "falls back to the tab's own state");
});

// ---------------------------------------------------------------------------
// 4. THE ACKNOWLEDGEMENT — workflow_new, driven from the real panel source
// ---------------------------------------------------------------------------

/** Balanced extraction starting at a marker's first "{". Mirrors binding-recovery's
 *  helper (the extracted regions contain no template braces outside code). */
function balancedFrom(src, marker, openAt = null) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing marker: ${marker}`);
  const open = openAt ?? src.indexOf("{", start + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === "\\") {
          i += 1;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated block: ${marker}`);
}

/** The REAL canonical-uuid gate from the shipped source — never a second spelling
 *  of the regex here (#640: two spellings of one rule diverge silently). */
const realIsCanonicalWorkflowInstanceUuid = new Function(
  `${balancedFrom(SRC, "function isCanonicalWorkflowInstanceUuid(value)")}\nreturn isCanonicalWorkflowInstanceUuid;`,
)();

/** The REAL `workflow_new` body, with its globals injected.
 *  `uuid` is what workflowStableUuid() returns for the created tab — default is the
 *  deliberately NON-canonical placeholder the existing tests were written against. */
function buildWorkflowNew({ rootGraph, activeWorkflow, uuid = "uuid-new-tab" }) {
  const sigStart = SRC.indexOf("async workflow_new({");
  assert.notEqual(sigStart, -1, "workflow_new not found");
  const bodyBrace = SRC.indexOf(") {", sigStart) + 1;
  const methodSource = balancedFrom(SRC, "async workflow_new({", bodyBrace).replace(
    /^async workflow_new\(/,
    "async function workflow_new(",
  );
  return new Function(
    "app",
    "activeWorkflowRef",
    "workflowTabId",
    "workflowStableUuid",
    "noteOpenAttempt",
    "coerceMessageText",
    "getWorkflowTitle",
    "graphRootProvenEmpty",
    "activeWorkflowProvenEmpty",
    "stampGraphRootWorkflowUuid",
    "backendReconnectEpoch",
    "activeWorkflowResyncEpoch",
    "isCanonicalWorkflowInstanceUuid",
    `${methodSource}\nreturn workflow_new;`,
  )(
    { graph: rootGraph, extensionManager: { command: { execute: async () => {} } } },
    () => activeWorkflow,
    () => "tmp:new-tab",
    () => uuid,
    () => ({ seq: 7 }),
    (e) => String(e),
    () => "Unsaved Workflow",
    graphRootProvenEmpty,
    activeWorkflowProvenEmpty,
    () => {},
    1,
    0,
    realIsCanonicalWorkflowInstanceUuid,
  );
}

/** A live root LiteGraph would produce for a given serialized state. */
const liveRoot = (state) => ({
  _nodes: state.nodes,
  extra: state.extra,
  serialize: () => clone(state),
});

test("#708 ack: a PROVEN-empty new tab reports created:true — the honest success is unchanged", async () => {
  const workflow_new = buildWorkflowNew({
    rootGraph: liveRoot(BLANK_GRAPH()),
    activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
  });

  const out = await workflow_new({ rid: "r1" });

  assert.equal(out.created, true);
  assert.equal(out.empty, true);
  assert.equal(out.routing_key, "tmp:new-tab");
  assert.equal(out.note, undefined, "a proven blank tab needs no caveat");
});

// #755 — workflow_new already MINTS the new canvas's fence identity, then dropped it
// from the reply, so the orchestrator had to make a second workflow_list round trip to
// re-learn a fact this command was holding. That round trip is where the wedge in
// artokun/comfyui-mcp#932 lived: it could be refused, it could fail corroboration, and
// the canvas could change underneath it in between.
const CANONICAL = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";

test("#755: workflow_new returns the workflow_uuid it just minted", async () => {
  const workflow_new = buildWorkflowNew({
    rootGraph: liveRoot(BLANK_GRAPH()),
    activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
    uuid: CANONICAL,
  });

  const out = await workflow_new({ rid: "r1" });

  assert.equal(out.workflow_uuid, CANONICAL);
  // …alongside, and describing the SAME graph as, the routing handle.
  assert.equal(out.routing_key, "tmp:new-tab");
  assert.equal(out.created, true);
});

test("#755: the UNKNOWN-outcome reply carries it too — the tab is real either way", async () => {
  // #708 withholds `created:true` when emptiness is unproven, but the tab and its
  // identity ARE real (the receipt records that). Withholding the uuid here would send
  // exactly the caller who most needs to re-target back through the round trip this
  // change exists to remove.
  const workflow_new = buildWorkflowNew({
    rootGraph: liveRoot(PREVIOUS_WORKFLOW_GRAPH()),
    activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
    uuid: CANONICAL,
  });

  const out = await workflow_new({ rid: "r1" });

  assert.equal(out.created, "unknown", "the #708 honesty rule is untouched");
  assert.equal(out.workflow_uuid, CANONICAL, "but the identity is still reported");
});

test("#755: a NON-canonical value is omitted, never published as an identity", async () => {
  // The shape gate is the #716 rule carried over: publish a real per-instance uuid or
  // nothing. A routing handle offered in its place must not be echoed as one.
  for (const bogus of ["tmp:new-tab", "uuid-new-tab", "", null, undefined]) {
    const workflow_new = buildWorkflowNew({
      rootGraph: liveRoot(BLANK_GRAPH()),
      activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
      uuid: bogus,
    });
    const out = await workflow_new({ rid: "r1" });
    assert.equal("workflow_uuid" in out, false, `${JSON.stringify(bogus)} must be omitted, not echoed`);
    // The reply is still fully usable — omission costs a round trip, nothing more.
    assert.equal(out.routing_key, "tmp:new-tab");
  }
});

test("#708 ack: the reported reconnect shape reports outcome-UNKNOWN, never created:true", async () => {
  // The canvas still holds the previous dirty 12-node / 4-group workflow while the new
  // tab is active. `created:true` here is the sentence that sent the agent building
  // onto someone else's work.
  const workflow_new = buildWorkflowNew({
    rootGraph: liveRoot(PREVIOUS_WORKFLOW_GRAPH()),
    activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
  });

  const out = await workflow_new({ rid: "r1" });

  assert.notEqual(out.created, true, "an unproven tab must NEVER be acknowledged as created:true");
  assert.equal(out.created, "unknown");
  assert.equal(out.empty, "unknown");
  assert.equal(out.routing_key, "tmp:new-tab", "the tab is real and addressable — only 'blank' is unproven");
  assert.equal(out.open_seq, 7, "the open receipt is still recorded");
  assert.match(out.note, /panel_graph_outline/, "the note must tell the agent to VERIFY before building");
  assert.match(out.note, /not idempotent/, "…and that a retry leaves a SECOND blank tab");
});

test("#708 ack: every unprovable side reports unknown — an empty ROOT is not proof about the TAB", async () => {
  const unprovable = [
    // The tab's own state cannot be read at all.
    { root: BLANK_GRAPH(), wf: { isPersisted: false, isModified: false } },
    { root: BLANK_GRAPH(), wf: { isPersisted: false, isModified: false, changeTracker: {} } },
    // A DIRTY tracker can lag the real canvas, so it can never prove emptiness (#545).
    {
      root: BLANK_GRAPH(),
      wf: { isPersisted: false, isModified: true, changeTracker: { activeState: BLANK_GRAPH() } },
    },
    // The tab's own state carries content.
    {
      root: BLANK_GRAPH(),
      wf: { isPersisted: false, isModified: false, changeTracker: { activeState: graph(2) } },
    },
    // Zero nodes but real GROUPS on the canvas — "no nodes" is not "no content".
    {
      root: graph(0, 4),
      wf: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
    },
  ];
  for (const { root, wf } of unprovable) {
    const workflow_new = buildWorkflowNew({ rootGraph: liveRoot(root), activeWorkflow: wf });
    const out = await workflow_new({ rid: "r1" });
    assert.equal(out.created, "unknown", `expected unknown for ${JSON.stringify(wf)}`);
    assert.ok(out.note, "an unknown outcome must carry its explanation");
  }
});

test("#708 ack: an unreadable root (no serializer) is unproven, not assumed empty", async () => {
  const workflow_new = buildWorkflowNew({
    rootGraph: { _nodes: [], extra: {} }, // no serialize() ⇒ non-node content unprovable
    activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
  });

  assert.equal((await workflow_new({ rid: "r1" })).created, "unknown");
});

// ---------------------------------------------------------------------------
// 5. The two halves together — the reported sequence end to end
// ---------------------------------------------------------------------------

test("#708 end to end: create during the reconnect window, then ground — unknown ack AND no foreign graph on disk", async () => {
  // Step 1: `panel_new_workflow` while the shared canvas still holds the previous
  // workflow. The agent is told the outcome is unknown, not that it has a blank canvas.
  const workflow_new = buildWorkflowNew({
    rootGraph: liveRoot(PREVIOUS_WORKFLOW_GRAPH()),
    activeWorkflow: { isPersisted: false, isModified: false, changeTracker: { activeState: BLANK_GRAPH() } },
  });
  const ack = await workflow_new({ rid: "r1" });
  assert.equal(ack.created, "unknown");

  // Step 2: the next turn grounds the new tab. Whatever it writes must be the tab's
  // graph. With the canvas provably foreign it writes nothing at all.
  const n = tempTab(BLANK_GRAPH());
  const svc = makeFrontend({ liveCanvas: PREVIOUS_WORKFLOW_GRAPH(), active: [n] });
  assert.equal(await groundActiveWorkflow(svc, saveOpts(svc, { canvasBinding: () => "foreign" })), null);
  assert.equal(svc.files.size, 0, "no 'Untitled …' file holding the previous 12 nodes");
});
