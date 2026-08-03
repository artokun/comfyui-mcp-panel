import test from "node:test";
import assert from "node:assert/strict";
import {
  missingRequiredWidgetMaterializations,
  requiredWidgetInputTypes,
  unavailableRequiredCustomWidgetTypes,
} from "../../web/js/lib/node-widget-materialization.js";

const widgetConstructors = { ZIPN_STYLE_GALLERY: () => {}, ZIPN_SPACER: () => {}, COMBO: () => {} };

function v3Node(widgets) {
  return {
    widgets,
    constructor: {
      nodeData: {
        input: {
          required: {
            gallery: ["ZIPN_STYLE_GALLERY", {}],
            spacer: ["ZIPN_SPACER", {}],
            style: [["none", "film"], {}],
            clip: ["CLIP", {}],
          },
        },
      },
    },
  };
}

test("required registered V3 custom widgets must materialize and serialize", () => {
  const node = v3Node([
    { name: "gallery", serialize: true },
    { name: "spacer", serialize: true },
    { name: "style" },
  ]);
  assert.deepEqual(missingRequiredWidgetMaterializations(node, widgetConstructors), []);
});

test("missing V3 custom widget is reported while a socket datatype remains wireable", () => {
  const node = v3Node([{ name: "style" }]);
  assert.deepEqual(missingRequiredWidgetMaterializations(node, widgetConstructors), ["gallery", "spacer"]);
});

test("an unknown custom type stays unavailable until the frontend registry contains it", () => {
  const node = v3Node([{ name: "style" }]);
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}), [
    "ZIPN_STYLE_GALLERY",
    "ZIPN_SPACER",
    "COMBO",
  ]);
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, widgetConstructors), []);
});

test("known core connections and forced inputs remain safe sockets", () => {
  const node = v3Node([]);
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}), [
    "ZIPN_STYLE_GALLERY",
    "ZIPN_SPACER",
    "COMBO",
  ]);
  node.constructor.nodeData.input.required.style = ["STRING", { forceInput: true }];
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}), [
    "ZIPN_STYLE_GALLERY",
    "ZIPN_SPACER",
  ]);
});

test("canvas-only control cannot satisfy a required custom input", () => {
  const node = v3Node([
    { name: "gallery", options: { serialize: false } },
    { name: "spacer", serialize: true },
    { name: "style" },
  ]);
  assert.deepEqual(missingRequiredWidgetMaterializations(node, widgetConstructors), ["gallery"]);
});

test("a widget serialize property does not override ComfyUI options.serialize", () => {
  const node = v3Node([
    { name: "gallery", serialize: false, options: { serialize: true } },
    { name: "spacer", options: { serialize: true } },
    { name: "style" },
  ]);
  assert.deepEqual(missingRequiredWidgetMaterializations(node, widgetConstructors), []);
});

test("a forceInput declaration remains a wireable socket", () => {
  const node = v3Node([
    { name: "gallery", serialize: true },
    { name: "spacer", serialize: true },
  ]);
  node.constructor.nodeData.input.required.style = ["STRING", { forceInput: true }];
  assert.deepEqual(missingRequiredWidgetMaterializations(node, { ...widgetConstructors, STRING: () => {} }), []);
  assert.deepEqual(requiredWidgetInputTypes(node), ["ZIPN_STYLE_GALLERY", "ZIPN_SPACER", "CLIP"]);
});
