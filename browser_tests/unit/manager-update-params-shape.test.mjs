// panel#809 — panel_update_node crashed BEFORE updating anything on ComfyUI-
// Manager v4:
//
//   AttributeError: 'InstallPackParams' object has no attribute 'node_name'
//     comfyui_manager/glob/manager_server.py, do_update(), line 879
//
// Manager v4's QueueTaskItem.params is an UNTAGGED Pydantic union with
// InstallPackParams listed FIRST:
//
//   params: Union[InstallPackParams, UpdatePackParams, UpdateAllPacksParams, ...]
//
// InstallPackParams requires exactly {id, selected_version, mode, channel} —
// every field the v2 update dispatch used to send ALONGSIDE node_name, "for
// correlation parity with install (harmless if the server ignores it)". It is
// not harmless: sending all of InstallPackParams' required fields makes THAT
// model match FIRST, Pydantic silently drops the unrecognized node_name as an
// extra field, and `kind: "update"` is never consulted for which model to
// pick. do_update then reads params.node_name off an InstallPackParams object
// and crashes — before the update itself ever runs.
//
// UpdatePackParams is exactly {node_name, node_ver?} and nothing else. Sending
// ONLY those two fields is what makes it the sole match. Verified against a
// local ComfyUI-Manager 4.2.2 install (see the issue).
//
// There is no live-Manager harness in this unit suite, and exercising this
// against a real install would mutate an installed package on shared
// infrastructure — a live end-to-end check is not appropriate verification
// here. Source inspection is the established idiom for this class of fix in
// this codebase (see open-workflow-fence-unreadable.test.ts's equivalent
// pattern on the orchestrator side).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function updateV2Block() {
  const src = readFileSync(PANEL_JS, "utf8");
  const fnStart = src.indexOf("async graph_update_node({");
  assert.ok(fnStart > 0, "graph_update_node not found in the shipped source");
  const v2Start = src.indexOf('if (dialect === "v2")', fnStart);
  assert.ok(v2Start > fnStart, "the v2 dialect branch was not found inside graph_update_node");
  // Bounded to the v2 branch only — the sibling v2-batch/legacy dialects build
  // an entirely different body for a different endpoint (manager/queue/batch,
  // not manager/queue/task) and are not subject to this Pydantic union at all.
  return src.slice(v2Start, v2Start + 1500);
}

test("#809 the v2 update dispatch sends ONLY UpdatePackParams-shaped fields", () => {
  const block = updateV2Block();
  assert.match(block, /const params = \{ node_name: id, node_ver: sel \};/);
});

test("#809 the InstallPackParams-shaped extras are GONE — this is the actual fix", () => {
  const block = updateV2Block();
  // Any one of these present alongside node_name reproduces the union
  // collision. Assert the exact removed fields are absent from the params
  // object construction, not merely that node_ver/node_name are present —
  // a regression that re-adds `id` back in without touching node_name/node_ver
  // would still crash and must still be caught.
  for (const leaked of ["id,\n", "selected_version:", "version: sel,", 'mode || "remote"', 'channel || "default"']) {
    assert.ok(!block.includes(leaked), `InstallPackParams-shaped field leaked back in: ${JSON.stringify(leaked)}`);
  }
});

test("#809 the request body still names kind:\"update\" and carries ui_id/client_id at the envelope level", () => {
  // ui_id/client_id sit OUTSIDE the params union entirely — this is where
  // correlation belongs, per the issue's own fix note ("ui_id already carries
  // it at the envelope level"). Confirms the fix did not also strip envelope
  // fields the server genuinely needs.
  const block = updateV2Block();
  assert.match(block, /body: \{ kind: "update", params, ui_id, client_id \}/);
});
