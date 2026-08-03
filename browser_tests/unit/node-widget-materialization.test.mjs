import test from "node:test";
import assert from "node:assert/strict";
import { missingRequiredWidgetMaterializations } from "../../web/js/lib/node-widget-materialization.js";

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

test("canvas-only control cannot satisfy a required custom input", () => {
  const node = v3Node([
    { name: "gallery", serialize: false },
    { name: "spacer", serialize: true },
    { name: "style" },
  ]);
  assert.deepEqual(missingRequiredWidgetMaterializations(node, widgetConstructors), ["gallery"]);
});

test("a forceInput declaration remains a wireable socket", () => {
  const node = v3Node([
    { name: "gallery", serialize: true },
    { name: "spacer", serialize: true },
  ]);
  node.constructor.nodeData.input.required.style = ["STRING", { forceInput: true }];
  assert.deepEqual(missingRequiredWidgetMaterializations(node, { ...widgetConstructors, STRING: () => {} }), []);
});
