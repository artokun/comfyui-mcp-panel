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

test("core MASK required input is a safe socket (#620 SetLatentNoiseMask)", () => {
  const node = {
    constructor: {
      nodeData: {
        input: {
          required: {
            samples: ["LATENT", {}],
            mask: ["MASK", {}],
          },
        },
      },
    },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}), []);
});

test("third-party socket type is available only once the live registry proves it (#620 STITCHER)", () => {
  const node = {
    constructor: {
      nodeData: {
        input: {
          required: { stitcher: ["STITCHER", {}] },
        },
      },
    },
  };
  // No registry proof: indistinguishable from a widget pending its extension
  // hook — still fails closed, exactly as #580 requires.
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}), ["STITCHER"]);
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}, new Set()), ["STITCHER"]);
  // Some registered node declaring STITCHER as an OUTPUT proves it is a link
  // datatype no widget constructor will ever appear for.
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}, new Set(["STITCHER"])), []);
});

test("native VIDEO socket resolves via registry proof (#608 SaveVideo)", () => {
  const node = {
    constructor: {
      nodeData: {
        input: {
          required: {
            video: ["VIDEO", {}],
            filename_prefix: ["STRING", {}],
          },
        },
      },
    },
  };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(node, { STRING: () => {} }, new Set(["VIDEO"])),
    [],
  );
});

test("canvasOnly upload control counts as materialized while a plain serialize:false widget stays missing (#620 LoadImage)", () => {
  const node = {
    widgets: [
      // ComfyUI's own IMAGEUPLOAD button: deliberately serialize:false,
      // canvasOnly:true — a canvas control paired with the real value widget.
      { name: "upload", options: { serialize: false, canvasOnly: true } },
      { name: "gallery", options: { serialize: false } },
    ],
    constructor: {
      nodeData: {
        input: {
          required: {
            upload: ["IMAGEUPLOAD", {}],
            gallery: ["ZIPN_STYLE_GALLERY", {}],
          },
        },
      },
    },
  };
  assert.deepEqual(
    missingRequiredWidgetMaterializations(node, { ...widgetConstructors, IMAGEUPLOAD: () => {} }),
    ["gallery"],
  );
});
