/**
 * Unit tests for the #387 UPLOAD-ASSET fallback in web/js/lib/set-widget.js —
 * run with `node --test`. These drive runSetWidget(), the SAME async unit
 * graph_set_widget delegates to, so the production ordering is exercised.
 *
 * Bug: an image uploaded under a SUBFOLDER (e.g. "xyr_canvas/foo.png") is a valid,
 * loadable LoadImage input, but ComfyUI's LoadImage.INPUT_TYPES enumerates only
 * TOP-LEVEL input files, so the value is NEVER in the /object_info combo — the
 * #338 stale-combo refresh cannot help. panel_set_widget refused a perfectly good
 * asset. The fallback: when the widget is an UPLOAD input and the server CONFIRMS
 * the file exists, accept it.
 *
 * Invariants:
 *   1. A server-CONFIRMED nested upload the refresh can't list is accepted.
 *   2. Gated to UPLOAD inputs — a plain model combo is NOT rescued by confirmServerAsset.
 *   3. If the server does NOT confirm the file, it stays rejected (#240 strictness).
 *   4. The refresh path still wins first for a TOP-LEVEL file (no needless probe).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";

const REGISTRY = { LoadImage: {}, CheckpointLoaderSimple: {} };

// Fresh /object_info: LoadImage's image combo lists ONLY a top-level file (mirrors the
// backend's top-level-only listing), so a nested value is absent even after refresh.
const FRESH = {
  LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd15.safetensors"]] } } },
};
const freshOracle = { getFreshObjectInfo: async () => FRESH };

// A refreshCombos that mirrors the production refreshComboOptionsFromDefs: it sets the
// widget's option list to the FRESH def's list — which still lacks the nested path.
function refreshFromFreshDefs(defs, target) {
  const def = defs?.[target?.type];
  const spec = def?.input?.required?.[target?.widgets?.[0]?.name];
  if (Array.isArray(spec) && Array.isArray(spec[0]) && target.widgets[0]) {
    target.widgets[0].options.values = spec[0].slice();
  }
}

test("nested LoadImage upload the combo never lists is accepted when the server confirms it (#387)", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["example.png"] }, value: "example.png" };
  const node = { id: 191, type: "LoadImage", widgets: [widget] };
  let probed = null;
  const res = await runSetWidget(node, "image", "xyr_canvas/boswellia_source.png", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: refreshFromFreshDefs,
    confirmServerAsset: async (v) => {
      probed = v;
      return true; // the server has the nested file in its input dir
    },
  });
  assert.equal(res.set.value, "xyr_canvas/boswellia_source.png");
  assert.equal(res.server_confirmed, true);
  assert.equal(probed, "xyr_canvas/boswellia_source.png");
  assert.ok(widget.options.values.includes("xyr_canvas/boswellia_source.png"));
});

test("a plain model combo is NOT rescued by confirmServerAsset (gated to upload inputs)", async () => {
  const widget = {
    name: "ckpt_name",
    type: "combo",
    options: { values: ["sd15.safetensors"] },
    value: "sd15.safetensors",
  };
  const node = { id: 5, type: "CheckpointLoaderSimple", widgets: [widget] };
  let probed = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "ckpt_name", "some_uploaded_input.png", {
        registry: REGISTRY,
        ...freshOracle,
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => {
          probed = true;
          return true;
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(probed, false, "a non-upload combo must never probe the input dir");
});

test("an upload value the server does NOT have stays rejected (#240 strictness)", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["example.png"] }, value: "example.png" };
  const node = { id: 191, type: "LoadImage", widgets: [widget] };
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "typo_never_uploaded.png", {
        registry: REGISTRY,
        ...freshOracle,
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => false, // server has no such file
      }),
    (err) =>
      err instanceof Error &&
      /refused/.test(err.message) &&
      /after refreshing combo options/.test(err.message) &&
      /not a valid option/.test(err.message),
  );
  assert.equal(widget.value, "example.png", "must not mutate on an unconfirmed value");
});

test("a server-EXISTING but non-image file (.txt) into an image combo is refused (#240 strictness, codex P1)", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["example.png"] }, value: "example.png" };
  const node = { id: 191, type: "LoadImage", widgets: [widget] };
  let probed = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "xyr_canvas/notes.txt", {
        registry: REGISTRY,
        ...freshOracle,
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => {
          probed = true;
          return true; // even though the server HAS the file, the extension is wrong
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(probed, false, "a wrong-kind extension must be rejected BEFORE any server probe");
  assert.equal(widget.value, "example.png");
  assert.ok(!widget.options.values.includes("xyr_canvas/notes.txt"));
});

test("a TOP-LEVEL uploaded file the refresh CAN list is accepted by refresh, never probing the server", async () => {
  const widget = { name: "image", type: "combo", options: { values: [] }, value: "" };
  const node = { id: 191, type: "LoadImage", widgets: [widget] };
  let probed = false;
  // Fresh defs that DO list the file (top-level upload visible in /object_info).
  const fresh = {
    LoadImage: { input: { required: { image: [["fresh_upload.png"], { image_upload: true }] } } },
  };
  const res = await runSetWidget(node, "image", "fresh_upload.png", {
    registry: REGISTRY,
    getFreshObjectInfo: async () => fresh,
    refreshCombos: refreshFromFreshDefs,
    confirmServerAsset: async () => {
      probed = true;
      return true;
    },
  });
  assert.equal(res.set.value, "fresh_upload.png");
  assert.equal(res.refreshed, true);
  assert.equal(res.server_confirmed, undefined, "top-level file accepted by refresh, not the probe");
  assert.equal(probed, false, "no server probe when the refresh already lists the value");
});
