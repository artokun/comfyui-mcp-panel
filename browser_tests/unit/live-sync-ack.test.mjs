// #1299 — live_sync.notified must mean the ACTIVE canvas holds the saved workflow.
//
// The reported failure: H3 apply saved the file, returned notified:true with one
// notified client, and panel_graph_outline still showed the previous clip
// switches. Delivery of a notification is not application. These tests drive
// the SHIPPED helpers (web/js/lib/live-sync-ack.js) plus the panel executor
// wiring, so deleting either — the decision that forbids a false notified, or
// the executor that actually calls it — fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  LIVE_SYNC_RELOAD_ACTION,
  LIVE_SYNC_STATUS,
  decideLiveSyncAck,
  liveSyncPathsMatch,
  widgetFingerprint,
  canvasMatchesSavedWorkflow,
  composeLiveSyncReply,
  runWorkflowLiveSync,
} from "../../web/js/lib/live-sync-ack.js";
import { activeWorkflowFenceApplies } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const PANEL_SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function clipGraph({ clip2 = false, clip3 = false, clip4 = false } = {}) {
  return {
    nodes: [
      { id: 1, type: "CLIPTextEncode", widgets_values: ["a cat"] },
      {
        id: 40,
        type: "Graph",
        widgets_values: [true, clip2, clip3, clip4, false],
      },
    ],
    definitions: {
      subgraphs: [
        {
          id: "clip-block",
          nodes: [
            { id: 2, type: "PrimitiveBoolean", widgets_values: [clip2] },
            { id: 3, type: "PrimitiveBoolean", widgets_values: [clip3] },
            { id: 4, type: "PrimitiveBoolean", widgets_values: [clip4] },
          ],
        },
      ],
    },
  };
}

test("#1299 notified is true ONLY when the canvas matches the saved workflow", () => {
  const applied = decideLiveSyncAck({
    hasActiveTab: true,
    canvasMatchesSaved: true,
  });
  assert.equal(applied.notified, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.status, LIVE_SYNC_STATUS.APPLIED);

  for (const input of [
    { hasActiveTab: false },
    { hasActiveTab: true, pathMatches: false },
    { hasActiveTab: true, isModified: true, canvasMatchesSaved: false },
    { hasActiveTab: true, canvasMatchesSaved: false, diskReadable: false },
    { hasActiveTab: true, canvasMatchesSaved: false, expectedShaMatches: false },
    { hasActiveTab: true, canvasMatchesSaved: false, reloadAttempted: true, reloadCompleted: false },
    { hasActiveTab: true, canvasMatchesSaved: false, reloadAttempted: true, reloadCompleted: true },
    { hasActiveTab: true, canvasMatchesSaved: false },
    {},
  ]) {
    const ack = decideLiveSyncAck(input);
    assert.equal(ack.notified, false, JSON.stringify(input));
    assert.equal(ack.applied, false, JSON.stringify(input));
    assert.notEqual(ack.status, LIVE_SYNC_STATUS.APPLIED, JSON.stringify(input));
  }
});

test("#1299 a dirty tab whose canvas still shows the old clips is refused, not notified", () => {
  const ack = decideLiveSyncAck({
    hasActiveTab: true,
    isModified: true,
    canvasMatchesSaved: false,
  });
  assert.deepEqual(ack, {
    notified: false,
    applied: false,
    status: LIVE_SYNC_STATUS.REFUSED,
    reason: "dirty",
  });
  const reply = composeLiveSyncReply(ack.status === LIVE_SYNC_STATUS.REFUSED
    ? { hasActiveTab: true, isModified: true, canvasMatchesSaved: false }
    : ack);
  assert.equal(reply.notified, false);
  assert.equal(reply.reload, LIVE_SYNC_RELOAD_ACTION);
  assert.match(reply.note, /panel_load_workflow/);
  assert.match(reply.note, /intentionally not replaced/);
});

test("#1299 composeLiveSyncReply cannot be talked into notified:true", () => {
  const reply = composeLiveSyncReply(
    { hasActiveTab: true, isModified: true, canvasMatchesSaved: false },
    { notified: true, applied: true, status: "applied" },
  );
  assert.equal(reply.notified, false);
  assert.equal(reply.applied, false);
  assert.equal(reply.status, LIVE_SYNC_STATUS.REFUSED);
});

test("liveSyncPathsMatch: omitted path means the active tab; slash/backslash and workflows/ prefix agree", () => {
  assert.equal(liveSyncPathsMatch("", "workflows/H3.json"), true);
  assert.equal(liveSyncPathsMatch(null, "workflows/H3.json"), true);
  assert.equal(liveSyncPathsMatch("workflows/H3.json", "workflows/H3.json"), true);
  assert.equal(liveSyncPathsMatch("H3.json", "workflows/H3.json"), true);
  assert.equal(liveSyncPathsMatch("workflows\\H3.json", "workflows/H3.json"), true);
  assert.equal(liveSyncPathsMatch("workflows/Other.json", "workflows/H3.json"), false);
});

test("#1299 widget fingerprint sees subgraph clip switches, not presentation", () => {
  const saved = clipGraph({ clip2: true, clip3: true, clip4: true });
  const liveStale = clipGraph({ clip2: false, clip3: false, clip4: false });
  const liveMoved = clipGraph({ clip2: true, clip3: true, clip4: true });
  liveMoved.nodes[0].pos = [999, 999];
  liveMoved.nodes[1].size = [40, 40];

  assert.equal(canvasMatchesSavedWorkflow(liveStale, saved), false);
  assert.equal(canvasMatchesSavedWorkflow(liveMoved, saved), true);
  assert.equal(widgetFingerprint({ nodes: [] }).comparable, false);
  assert.equal(canvasMatchesSavedWorkflow({ nodes: [] }, { nodes: [] }), false);
});

test("#1299 runWorkflowLiveSync: dirty stale canvas never loads and never reports notified", async () => {
  let loads = 0;
  const saved = clipGraph({ clip2: true, clip3: true, clip4: true });
  const live = clipGraph({ clip2: false, clip3: false, clip4: false });
  const wf = { path: "workflows/H3.json", isModified: true };
  const reply = await runWorkflowLiveSync(
    { path: "workflows/H3.json" },
    {
      getActiveWorkflow: () => wf,
      readDisk: async () => JSON.stringify(saved),
      serializeCanvas: () => live,
      loadGraph: async () => {
        loads += 1;
      },
    },
  );
  assert.equal(loads, 0, "a dirty tab must not be overwritten");
  assert.equal(reply.notified, false);
  assert.equal(reply.applied, false);
  assert.equal(reply.status, LIVE_SYNC_STATUS.REFUSED);
  assert.equal(reply.reason, "dirty");
  assert.equal(reply.reload, LIVE_SYNC_RELOAD_ACTION);
});

test("#1299 runWorkflowLiveSync: a clean tab reloads, and notified is true only after the canvas matches", async () => {
  const saved = clipGraph({ clip2: true, clip3: true, clip4: true });
  let live = clipGraph({ clip2: false, clip3: false, clip4: false });
  const wf = { path: "workflows/H3.json", isModified: false };
  const reply = await runWorkflowLiveSync(
    { path: "H3.json" },
    {
      getActiveWorkflow: () => wf,
      readDisk: async () => JSON.stringify(saved),
      serializeCanvas: () => live,
      loadGraph: async (graph) => {
        live = graph;
      },
      rebaseline: async (target, text) => {
        target.originalContent = text;
      },
    },
  );
  assert.equal(reply.notified, true);
  assert.equal(reply.applied, true);
  assert.equal(reply.status, LIVE_SYNC_STATUS.APPLIED);
  assert.equal(reply.reload, undefined);
  assert.equal(live.nodes[1].widgets_values[1], true);
});

test("#1299 runWorkflowLiveSync: a reload that leaves the canvas stale is NOT notified", async () => {
  const saved = clipGraph({ clip2: true, clip3: true, clip4: true });
  const live = clipGraph({ clip2: false, clip3: false, clip4: false });
  const wf = { path: "workflows/H3.json", isModified: false };
  const reply = await runWorkflowLiveSync(
    {},
    {
      getActiveWorkflow: () => wf,
      readDisk: async () => JSON.stringify(saved),
      serializeCanvas: () => live,
      loadGraph: async () => {
        /* pretended to load; canvas object is unchanged */
      },
    },
  );
  assert.equal(reply.notified, false);
  assert.equal(reply.status, LIVE_SYNC_STATUS.STALE);
  assert.equal(reply.reason, "canvas_unchanged");
});

test("#1299 runWorkflowLiveSync: an edit during the disk-read await still refuses", async () => {
  let loads = 0;
  const saved = clipGraph({ clip2: true });
  const live = clipGraph({ clip2: false });
  const wf = { path: "workflows/H3.json", isModified: false };
  const reply = await runWorkflowLiveSync(
    {},
    {
      getActiveWorkflow: () => wf,
      readDisk: async () => {
        wf.isModified = true;
        return JSON.stringify(saved);
      },
      serializeCanvas: () => live,
      loadGraph: async () => {
        loads += 1;
      },
    },
  );
  assert.equal(loads, 0);
  assert.equal(reply.notified, false);
  assert.equal(reply.reason, "dirty");
});

test("#1299 runWorkflowLiveSync: a tab switch during the disk read does not load into the new canvas", async () => {
  let loads = 0;
  const saved = clipGraph({ clip2: true });
  const live = clipGraph({ clip2: false });
  const original = { path: "workflows/H3.json", isModified: false };
  const other = { path: "workflows/Other.json", isModified: false };
  let current = original;
  const reply = await runWorkflowLiveSync(
    { path: "workflows/H3.json" },
    {
      getActiveWorkflow: () => current,
      readDisk: async () => {
        current = other;
        return JSON.stringify(saved);
      },
      serializeCanvas: () => live,
      loadGraph: async () => {
        loads += 1;
      },
    },
  );
  assert.equal(loads, 0);
  assert.equal(reply.notified, false);
  assert.equal(reply.status, LIVE_SYNC_STATUS.NO_ACTIVE);
});

test("#1299 runWorkflowLiveSync: expected digest mismatch is unverified, not notified", async () => {
  let loads = 0;
  const saved = clipGraph({ clip2: true });
  const live = clipGraph({ clip2: true });
  const wf = { path: "workflows/H3.json", isModified: false };
  const reply = await runWorkflowLiveSync(
    { expected_sha256: "deadbeef" },
    {
      getActiveWorkflow: () => wf,
      readDisk: async () => JSON.stringify(saved),
      serializeCanvas: () => live,
      sha256: async () => "cafebabe",
      loadGraph: async () => {
        loads += 1;
      },
    },
  );
  assert.equal(loads, 0);
  assert.equal(reply.notified, false);
  assert.equal(reply.status, LIVE_SYNC_STATUS.UNVERIFIED);
  assert.equal(reply.reason, "sha_mismatch");
});

test("#1299 live_sync is an active-canvas mutation, so the uuid fence applies", () => {
  assert.equal(activeWorkflowFenceApplies({ cmd: "workflow_live_sync" }), true);
  assert.equal(activeWorkflowFenceApplies({ cmd: "live_sync" }), true);
});

test("#1299 the panel executor is the shipped path: it calls runWorkflowLiveSync", () => {
  const start = PANEL_SRC.indexOf("async workflow_live_sync(");
  assert.notEqual(start, -1, "workflow_live_sync executor missing");
  const alias = PANEL_SRC.indexOf("async live_sync(");
  assert.notEqual(alias, -1, "live_sync alias missing — the H3 cmd name would 404");
  const bodyStart = PANEL_SRC.indexOf("{", start);
  const renameAt = PANEL_SRC.indexOf("\n  async workflow_rename(", start);
  assert.notEqual(renameAt, -1);
  const body = PANEL_SRC.slice(bodyStart, renameAt);
  assert.match(body, /runWorkflowLiveSync\(/);
  assert.doesNotMatch(body, /notified:\s*true/);
  assert.match(PANEL_SRC, /api\.addEventListener\(\s*["']live_sync["']/);
});

test("#1299 extracting the shipped executor: dirty canvas → notified false, no loadGraphData", async () => {
  const start = PANEL_SRC.indexOf("async workflow_live_sync(");
  const end = PANEL_SRC.indexOf("\n  async live_sync(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = PANEL_SRC.slice(start, end);
  let loads = 0;
  const saved = clipGraph({ clip2: true, clip3: true, clip4: true });
  const live = clipGraph({ clip2: false, clip3: false, clip4: false });
  const wf = { path: "workflows/H3.json", isModified: true };
  const fakeApp = {
    extensionManager: { workflow: { activeWorkflow: wf } },
    graph: { serialize: () => live },
    loadGraphData: async () => {
      loads += 1;
    },
  };
  const executor = new Function(
    "runWorkflowLiveSync",
    "getGraphCtx",
    "app",
    "activeWorkflowRef",
    "workflowDiskContent",
    "clearSpuriousOpenModified",
    "sha256Hex",
    "sendLiveSyncAckOnComfySocket",
    `const GRAPH_TOOL_EXECUTORS = { ${source} };
     return GRAPH_TOOL_EXECUTORS.workflow_live_sync;`,
  )(
    runWorkflowLiveSync,
    () => ({ app: fakeApp }),
    fakeApp,
    () => wf,
    async () => JSON.stringify(saved),
    async () => {},
    async () => "abc",
    () => {},
  );
  const reply = await executor({ path: "workflows/H3.json" });
  assert.equal(loads, 0);
  assert.equal(reply.notified, false);
  assert.equal(reply.status, LIVE_SYNC_STATUS.REFUSED);
});
