// panel#745 — panel_get_errors omitted a missing model on a node added after load.
//
// The missing-asset stores are populated by ComfyUI at workflow LOAD; the panel
// reads them and its own logic only SUBTRACTS. So a LoraLoaderModelOnly added this
// session, holding an unavailable basename, was absent from both nodes[] and
// missing_models[] while the four load-time nodes reported correctly.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  missingAssetScanMayBeStale,
  missingAssetScopeNote,
} from "../../web/js/lib/missing-asset-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

test("#745 the caveat fires exactly when the workflow was edited since the scan", () => {
  assert.equal(missingAssetScanMayBeStale({ isModified: true }), true);
  assert.equal(missingAssetScanMayBeStale({ isModified: false }), false);
});

test("#745 an UNKNOWN modification state does not trigger it", () => {
  // An unobserved edit is not an observed one, and a caveat on every call trains
  // readers to skip it — which would cost more than the omission it warns about.
  for (const wf of [undefined, null, {}, { isModified: undefined }, { isModified: "yes" }, { isModified: 1 }]) {
    assert.equal(missingAssetScanMayBeStale(wf), false, `${JSON.stringify(wf)} must not trigger`);
  }
});

test("#745 the note says an EMPTY list is not proof", () => {
  // The precise failure: the reporter's newly added node was missing from the
  // list, and an empty list reads as "nothing is missing".
  const n = missingAssetScopeNote();
  assert.match(n, /not proof that nothing\s+is missing/);
  assert.match(n, /NOT re-scanned/);
});

test("#745 it names the reason and the check that closes it", () => {
  const n = missingAssetScopeNote();
  assert.match(n, /when a workflow is\s+LOADED/, "names WHY the blind spot exists");
  assert.match(n, /panel_query_graph/, "a limitation without a workaround is a dead end");
  assert.match(n, /combo's options/);
});

test("#745 it claims no capability it does not have", () => {
  // It must not imply the scan now covers new nodes — that is the fix this
  // deliberately is not.
  const n = missingAssetScopeNote();
  assert.doesNotMatch(n, /now (detects|includes|scans)/i);
  assert.doesNotMatch(n, /has been re-scanned/i);
});

test("#745 WIRING: the reply carries it, gated on the modified check", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ missingAssetScanMayBeStale, missingAssetScopeNote \}/);
  assert.match(src, /missingAssetScanMayBeStale\(activeWorkflowRef\(\)\)/);
  assert.match(src, /missing_asset_scope: missingAssetScopeNote\(\)/);
});
