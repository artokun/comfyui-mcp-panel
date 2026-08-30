/**
 * #2057 — after load, outline lists promoted host rails (clip_name / width /
 * height) while `_subgraphSlot.linkIds` is still empty. The inner widgets are
 * already driven by input-rail terminals (-10). panel_set_widget must resolve
 * those terminals and write without unpacking.
 *
 * Drives the shipped `resolvePromotedInnerTarget` / `applyWidgetWrite` and the
 * production `promotedTerminalWitnesses` extractor graph_get_subgraph publishes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPromotedContainer } from "../../web/js/lib/graph-read.js";
import {
  applyWidgetWrite,
  followPromotionToConcrete,
  MAX_PROMOTION_CHAIN_DEPTH,
  promotedInputAliases,
  resolvePromotedInnerTarget,
} from "../../web/js/lib/widget-write.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

function extractPromotedTerminalWitnesses() {
  const helperStart = PANEL_SRC.indexOf("function resolveSubgraphLink(");
  const helperEnd = PANEL_SRC.indexOf("\nfunction findPromotedHostInput", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production promotion helper range must remain extractable");
  return new Function(
    "resolvePromotedInnerTarget",
    "followPromotionToConcrete",
    "MAX_PROMOTION_CHAIN_DEPTH",
    "promotedInputAliases",
    "isPromotedContainer",
    `${PANEL_SRC.slice(helperStart, helperEnd)}; return promotedTerminalWitnesses;`,
  )(
    resolvePromotedInnerTarget,
    followPromotionToConcrete,
    MAX_PROMOTION_CHAIN_DEPTH,
    promotedInputAliases,
    isPromotedContainer,
  );
}

/** Loaded Z-Image-Turbo subgraph host: rails on the wrapper, inner widgets
 * wired from -10, host inputs not yet rebound with `_subgraphSlot` / linkIds. */
function makeLoadedZImageHost({ includeHostInputs = true, stubSubgraphSlot = false } = {}) {
  const clipOptions = ["qwen_3_4b.safetensors", "other.safetensors"];
  const clipRail = {
    name: "clip_name",
    type: "combo",
    options: { values: clipOptions },
    value: "qwen_3_4b.safetensors",
    widgetId: "root:57:clip_name",
  };
  const widthRail = { name: "width", type: "INT", value: 1024, widgetId: "root:57:width" };
  const heightRail = { name: "height", type: "INT", value: 1024, widgetId: "root:57:height" };

  const clipInner = { name: "clip_name", type: "combo", options: { values: clipOptions }, value: "qwen_3_4b.safetensors" };
  const widthInner = { name: "width", type: "INT", value: 1024 };
  const heightInner = { name: "height", type: "INT", value: 1024 };

  const clipLoader = {
    id: 12,
    type: "CLIPLoader",
    inputs: [{ name: "clip_name", widget: { name: "clip_name" }, type: "COMBO", link: 1 }],
    widgets: [clipInner],
  };
  const latent = {
    id: 8,
    type: "EmptySD3LatentImage",
    inputs: [
      { name: "width", widget: { name: "width" }, type: "INT", link: 2 },
      { name: "height", widget: { name: "height" }, type: "INT", link: 3 },
    ],
    widgets: [widthInner, heightInner],
  };

  const links = {
    1: { id: 1, origin_id: -10, origin_slot: 6, target_id: 12, target_slot: 0 },
    2: { id: 2, origin_id: -10, origin_slot: 1, target_id: 8, target_slot: 0 },
    3: { id: 3, origin_id: -10, origin_slot: 2, target_id: 8, target_slot: 1 },
  };
  const subgraphInputs = [
    { name: "model", linkIds: [] },
    { name: "width", linkIds: [] },
    { name: "height", linkIds: [] },
    { name: "batch_size", linkIds: [] },
    { name: "seed", linkIds: [] },
    { name: "steps", linkIds: [] },
    { name: "clip_name", linkIds: [] },
  ];
  const subgraph = {
    _nodes: [clipLoader, latent],
    inputs: subgraphInputs,
    inputNode: { id: -10, slots: subgraphInputs },
    links,
    getNodeById: (id) => {
      if (String(id) === "12") return clipLoader;
      if (String(id) === "8") return latent;
      return null;
    },
    getLink: (id) => links[id] ?? null,
  };

  const hostInput = (name) => {
    const input = { name };
    if (stubSubgraphSlot) input._subgraphSlot = { name, linkIds: [] };
    return input;
  };
  const host = {
    id: 57,
    type: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    subgraph,
    inputs: includeHostInputs ? [hostInput("clip_name"), hostInput("width"), hostInput("height")] : [],
    widgets: [clipRail, widthRail, heightRail],
  };
  return { host, clipLoader, latent, clipRail, widthRail, heightRail, clipInner, widthInner, heightInner };
}

test("#2057 after load, a host clip_name combo with no _subgraphSlot resolves to CLIPLoader via -10", () => {
  const { host, clipLoader, clipInner } = makeLoadedZImageHost();
  const res = resolvePromotedInnerTarget(host, "clip_name", () => null);
  assert.equal(res.promoted, true);
  assert.equal(res.target.node, clipLoader);
  assert.equal(res.target.widget, clipInner);
  assert.equal(res.target.parentWidget?.name, "clip_name");
});

test("#2057 after load, host width/height numbers resolve to EmptySD3LatentImage via -10", () => {
  const { host, latent, widthInner, heightInner } = makeLoadedZImageHost();
  const width = resolvePromotedInnerTarget(host, "width", () => null);
  assert.equal(width.promoted, true);
  assert.equal(width.target.node, latent);
  assert.equal(width.target.widget, widthInner);
  const height = resolvePromotedInnerTarget(host, "height", () => null);
  assert.equal(height.promoted, true);
  assert.equal(height.target.node, latent);
  assert.equal(height.target.widget, heightInner);
});

test("#2057 after load, a stub _subgraphSlot with empty linkIds still resolves the inner rail", () => {
  const { host, clipLoader } = makeLoadedZImageHost({ stubSubgraphSlot: true });
  const res = resolvePromotedInnerTarget(host, "clip_name", () => null);
  assert.equal(res.promoted, true);
  assert.equal(res.target.node, clipLoader);
  assert.equal(res.target.widget.name, "clip_name");
});

test("#2057 after load, outline-only host widgets (no host inputs) still resolve via the inner rail", () => {
  const { host, clipLoader } = makeLoadedZImageHost({ includeHostInputs: false });
  const res = resolvePromotedInnerTarget(host, "clip_name", () => null);
  assert.equal(res.promoted, true);
  assert.equal(res.target.node, clipLoader);
  assert.equal(res.target.parentWidget?.name, "clip_name");
});

test("#2057 after load, applyWidgetWrite sets the promoted combo without unpacking", () => {
  const { host, clipInner, clipRail } = makeLoadedZImageHost();
  const set = applyWidgetWrite(host, "clip_name", "other.safetensors", { resolveSource: () => null });
  assert.equal(set.value, "other.safetensors");
  assert.equal(set.promoted_from.subgraph_node_id, 57);
  assert.equal(set.promoted_from.inner_node_id, 12);
  assert.equal(clipInner.value, "other.safetensors");
  assert.equal(clipRail.value, "other.safetensors");
});

test("#2057 after load, applyWidgetWrite sets promoted width/height without unpacking", () => {
  const { host, widthInner, heightInner, widthRail, heightRail } = makeLoadedZImageHost();
  const width = applyWidgetWrite(host, "width", 1280, { resolveSource: () => null });
  const height = applyWidgetWrite(host, "height", 720, { resolveSource: () => null });
  assert.equal(width.value, 1280);
  assert.equal(height.value, 720);
  assert.equal(widthInner.value, 1280);
  assert.equal(heightInner.value, 720);
  assert.equal(widthRail.value, 1280);
  assert.equal(heightRail.value, 720);
});

test("#2057 production witness completes for loaded clip_name / width / height", () => {
  const makeWitnesses = extractPromotedTerminalWitnesses();
  const { host } = makeLoadedZImageHost();
  const entries = makeWitnesses(host);
  for (const name of ["clip_name", "width", "height"]) {
    const witness = entries.find((entry) => entry.widget === name);
    assert.ok(witness, `missing witness for ${name}`);
    assert.equal(witness.error, undefined, `${name} must not publish an incomplete witness`);
    assert.equal(witness.parent_rail?.authoritative, true);
    assert.equal(witness.terminal_widget, name);
    assert.equal(typeof witness.terminal_node_type, "string");
    assert.ok(Array.isArray(witness.terminal_inputs));
  }
  assert.equal(entries.find((entry) => entry.widget === "clip_name")?.terminal_node_type, "CLIPLoader");
  assert.equal(entries.find((entry) => entry.widget === "width")?.terminal_node_type, "EmptySD3LatentImage");
});

test("#2057 a promoted host input with no inner rail terminal still refuses", () => {
  const { host } = makeLoadedZImageHost();
  host.inputs.push({ name: "scheduler" });
  const res = resolvePromotedInnerTarget(host, "scheduler", () => null);
  assert.equal(res.promoted, true);
  assert.equal(res.target, null);
  assert.match(res.error ?? "", /_subgraphSlot missing|no resolvable inner link/i);
});
