// Regression coverage for panel issue #1600. ComfyUI-Manager's installed list
// is keyed by the on-disk directory, while its active update map is keyed by
// the registry/aux identity stored in that entry. Exercise the shipped
// graph_update_node against the documented renamed directory shape so a
// Manager KeyError cannot return.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertBatchOk,
  classifyUpdateOutcome,
  dialectRetryTarget,
  isManagerRouteMissing,
  isManagerUnreachable,
  isMethodNotAllowed,
  legacyUpdateBody,
  resolveInstalledUpdateId,
  taskFailureReason,
} from "../../web/js/lib/manager-install.js";
import { isGenericManagerUpdateError } from "../../web/js/lib/manager-update-traceback.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const DIRECTORY_ID = "comfyui-minimax-h3-prompt-enhancer-T8";
const MANAGER_ID = "comfyui-minimax-h3-prompt-enhancer";
const INSTALLED = {
  [DIRECTORY_ID]: {
    ver: "nightly",
    cnr_id: MANAGER_ID,
    aux_id: "example/comfyui-minimax-h3-prompt-enhancer",
    enabled: true,
  },
};

function readPanelSource() {
  return readFileSync(PANEL_JS, "utf8");
}

function buildGraphUpdateNode({ resolveTarget, managerV2 }) {
  const src = readPanelSource();
  const method = src.match(
    /async graph_update_node\(\{ id, version, channel, mode \}\) \{[\s\S]*?\n  \},\r?\n/,
  );
  assert.ok(method, "graph_update_node not found in the shipped source");
  const deps = {
    resolveManagerUpdateTarget: resolveTarget,
    detectManagerDialect: async () => "v2",
    crypto: { randomUUID: () => "u-1600" },
    api: { clientId: "c-1600" },
    legacyUpdateBody,
    managerCall: async () => {
      throw new Error("legacy path should not run");
    },
    managerV2,
    isMethodNotAllowed,
    assertBatchOk,
    isManagerUnreachable,
    isManagerRouteMissing,
    dialectRetryTarget,
    noteManagerDialectDowngrade: () => {},
    reProbeManagerDialect: async () => "v2",
    waitForUpdateResult: async () => ({
      item: {
        ui_id: "u-1600",
        kind: "update",
        result: "success",
        status: { status_str: "success", completed: true, messages: [] },
      },
      status: { total_count: 1, done_count: 1, is_processing: false },
    }),
    classifyUpdateOutcome,
    taskFailureReason,
    isGenericManagerUpdateError,
    readUpdateTraceback: async () => null,
  };
  const factory = new Function(
    ...Object.keys(deps),
    `const handlers = { ${method[0]} };\nreturn handlers.graph_update_node;`,
  );
  return factory(...Object.values(deps));
}

test("#1600 renamed installed directory resolves before Manager update enqueue", async () => {
  const calls = [];
  const update = buildGraphUpdateNode({
    resolveTarget: async (requested) => resolveInstalledUpdateId(requested, INSTALLED),
    managerV2: async (route, { body } = {}) => {
      calls.push({ route, body });
      if (route === "manager/queue/task") {
        // This is the documented Manager failure when the directory spelling
        // leaks through: active_nodes is keyed by MANAGER_ID, not DIRECTORY_ID.
        if (body.params.node_name !== MANAGER_ID) {
          throw new Error(`KeyError: '${body.params.node_name.toLowerCase()}'`);
        }
      }
      return {};
    },
  });

  const result = await update({ id: DIRECTORY_ID, version: "nightly" });
  assert.equal(result.updated, true);
  assert.equal(result.verified, true);
  assert.equal(calls[0].route, "manager/queue/task");
  assert.equal(calls[0].body.params.node_name, MANAGER_ID);
  assert.equal(calls[0].body.params.node_ver, "nightly");
});

test("#1600 an unresolved installed name returns unmanaged_pack without queueing", async () => {
  let mutations = 0;
  const update = buildGraphUpdateNode({
    resolveTarget: async () => null,
    managerV2: async () => {
      mutations += 1;
      throw new Error("a mutation must not be submitted");
    },
  });

  const result = await update({ id: "local-only-pack", version: "nightly" });
  assert.equal(result.queued, false);
  assert.equal(result.updated, false);
  assert.equal(result.verified, false);
  assert.equal(result.unmanaged_pack, true);
  assert.match(result.note, /No update was queued/);
  assert.equal(mutations, 0);
});
