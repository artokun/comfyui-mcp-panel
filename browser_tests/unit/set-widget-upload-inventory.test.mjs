/**
 * #2222 — panel_set_widget rejected a LoadImage filename that upload_image had
 * just verified against a fresh `/object_info` listing, because the live widget
 * (and the burst-cached whole map refreshCombos reuses) still held the page-load
 * combo. Drive runSetWidget, the same unit graph_set_widget delegates to.
 *
 * Invariants:
 *   1. A stale combo + stale refresh still accepts when the live inventory
 *      contains the EXACT uploaded relative filename.
 *   2. A lookalike / missing name in that inventory stays rejected (#240).
 *   3. A non-upload combo never asks the upload inventory.
 *   4. Production graph_set_widget wires fetchUploadComboInventory and
 *      invalidates the object-info cache before the live read.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { PANEL_SRC } from "./_panel-constants.mjs";

const REGISTRY = { LoadImage: {}, LoadVideo: {}, CheckpointLoaderSimple: {} };

const STALE = {
  LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } },
  LoadVideo: { input: { required: { file: [["old.mp4"], { video_upload: true }] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd15.safetensors"]] } } },
};

function refreshFromDefs(defs, target) {
  const widget = target?.widgets?.[0];
  const spec = defs?.[target?.type]?.input?.required?.[widget?.name];
  if (widget && Array.isArray(spec?.[0])) widget.options.values = spec[0].slice();
}

test("#2222 a just-uploaded LoadImage filename the stale combo omitted is accepted from the live inventory", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["example.png"] }, value: "example.png" };
  const node = { id: 12, type: "LoadImage", widgets: [widget] };
  let asked = null;
  const res = await runSetWidget(node, "image", "fresh_upload.png", {
    registry: REGISTRY,
    getFreshObjectInfo: async () => STALE,
    refreshCombos: refreshFromDefs,
    confirmServerAsset: async () => {
      throw new Error("inventory hit must not fall through to /view");
    },
    fetchUploadComboInventory: async ({ type, widgetName, value }) => {
      asked = { type, widgetName, value };
      return {
        values: ["example.png", "fresh_upload.png"],
        config: { image_upload: true },
      };
    },
  });
  assert.deepEqual(asked, { type: "LoadImage", widgetName: "image", value: "fresh_upload.png" });
  assert.equal(res.set.value, "fresh_upload.png");
  assert.equal(res.refreshed, true);
  assert.equal(res.server_confirmed, undefined);
  assert.ok(widget.options.values.includes("fresh_upload.png"));
});

test("#2222 LoadVideo uses the same live inventory path", async () => {
  const widget = { name: "file", type: "combo", options: { values: ["old.mp4"] }, value: "old.mp4" };
  const node = { id: 4, type: "LoadVideo", widgets: [widget] };
  const res = await runSetWidget(node, "file", "take.mp4", {
    registry: REGISTRY,
    getFreshObjectInfo: async () => STALE,
    refreshCombos: refreshFromDefs,
    fetchUploadComboInventory: async () => ({
      values: ["old.mp4", "take.mp4"],
      config: { video_upload: true },
    }),
  });
  assert.equal(res.set.value, "take.mp4");
});

test("#2222 exact filename only — a live list without that relative path still rejects", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["example.png"] }, value: "example.png" };
  const node = { id: 12, type: "LoadImage", widgets: [widget] };
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "fresh_upload.png", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => STALE,
        refreshCombos: refreshFromDefs,
        confirmServerAsset: async () => false,
        fetchUploadComboInventory: async () => ({
          values: ["example.png", "fresh_upload (1).png"],
          config: { image_upload: true },
        }),
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(widget.value, "example.png");
});

test("#2222 a non-upload combo never asks the upload-file inventory", async () => {
  const widget = {
    name: "ckpt_name",
    type: "combo",
    options: { values: ["sd15.safetensors"] },
    value: "sd15.safetensors",
  };
  const node = { id: 5, type: "CheckpointLoaderSimple", widgets: [widget] };
  let asked = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "ckpt_name", "new.safetensors", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => STALE,
        refreshCombos: refreshFromDefs,
        fetchUploadComboInventory: async () => {
          asked = true;
          return { values: ["new.safetensors"], config: {} };
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(asked, false);
});

test("#2222 production graph_set_widget invalidates combo cache then reads /object_info/<Type>", () => {
  assert.match(PANEL_SRC, /fetchUploadComboInventory:/);
  assert.match(PANEL_SRC, /objectInfoCache\.invalidate\(\)/);
  assert.match(PANEL_SRC, /uploadComboInventoryOf\(scoped\.defs, type, widgetName\)/);
});
