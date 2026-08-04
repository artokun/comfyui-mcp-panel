import test from "node:test";
import assert from "node:assert/strict";
import {
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  registeredSocketTypes,
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

test("frontend-injected upload input is not guarded once the backend proves it never requires it (#620 LoadImage)", () => {
  const node = {
    widgets: [
      // ComfyUI's own IMAGEUPLOAD button: deliberately serialize:false,
      // canvasOnly:true — a canvas control paired with the real value widget.
      { name: "upload", options: { serialize: false, canvasOnly: true } },
      { name: "image" },
    ],
    constructor: {
      nodeData: {
        input: {
          required: {
            image: [["a.png", "b.png"], {}],
            upload: ["IMAGEUPLOAD", {}],
          },
        },
      },
    },
  };
  // Live /object_info for LoadImage reports required = image only: `upload`
  // is 100% frontend-injected, so it can never be a missing prompt value.
  // Scanning the FRESH def instead of the frontend nodeData means neither
  // guard ever sees it.
  const currentDef = { input: { required: { image: [["a.png", "b.png"], {}] } } };
  assert.deepEqual(
    missingRequiredWidgetMaterializations(
      node,
      { COMBO: () => {}, IMAGEUPLOAD: () => {} },
      currentDef,
    ),
    [],
  );
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(node, { COMBO: () => {} }, undefined, currentDef),
    [],
  );
});

test("a canvasOnly serialize:false widget for a BACKEND-required input is still reported missing", () => {
  // canvasOnly is a Vue-renderer display flag, not proof of non-prompt state;
  // only the backend not requiring the input excuses a non-serializing widget.
  const node = {
    widgets: [{ name: "gallery", options: { serialize: false, canvasOnly: true } }],
    constructor: {
      nodeData: {
        input: {
          required: { gallery: ["ZIPN_STYLE_GALLERY", {}] },
        },
      },
    },
  };
  const currentDef = { input: { required: { gallery: ["ZIPN_STYLE_GALLERY", {}] } } };
  assert.deepEqual(
    missingRequiredWidgetMaterializations(node, widgetConstructors, currentDef),
    ["gallery"],
  );
});

test("a backend def present with no input requirements enforces nothing", () => {
  // The class IS in fresh /object_info but requires no inputs — distinct from
  // a frontend-only type (no def at all), which falls back to the node data.
  const node = v3Node([{ name: "style" }]);
  assert.deepEqual(missingRequiredWidgetMaterializations(node, widgetConstructors, {}), []);
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}, undefined, {}), []);
});

test("a required input added to an already-registered class is seen via the fresh def", () => {
  // Pack upgraded mid-session: the registered nodeData predates the schema
  // change. The guards must still catch the NEW required custom-widget input.
  const staleNode = {
    widgets: [],
    constructor: {
      nodeData: {
        input: { required: { clip: ["CLIP", {}] } },
      },
    },
  };
  const currentDef = {
    input: {
      required: {
        clip: ["CLIP", {}],
        gallery: ["ZIPN_STYLE_GALLERY", {}],
      },
    },
  };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(staleNode, {}, undefined, currentDef),
    ["ZIPN_STYLE_GALLERY"],
  );
  // Constructor registered, but the stale-shaped node never built the widget.
  assert.deepEqual(
    missingRequiredWidgetMaterializations(staleNode, widgetConstructors, currentDef),
    ["gallery"],
  );
  assert.deepEqual(driftedRequiredInputNames(currentDef, staleNode), ["gallery"]);
  assert.deepEqual(driftedRequiredInputNames(currentDef, { input: currentDef.input }), []);
  assert.deepEqual(driftedRequiredInputNames(undefined, staleNode), []);
});

test("raw /object_info snake_case force_input remains a wireable socket", () => {
  const node = {
    constructor: {
      nodeData: {
        input: {
          required: { text: ["STRING", { force_input: true }] },
        },
      },
    },
  };
  assert.deepEqual(requiredWidgetInputTypes(node), []);
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(node, {}, undefined, node.constructor.nodeData),
    [],
  );
});

test("registeredSocketTypes derives link datatypes from fresh /object_info outputs", () => {
  const objectInfoDefs = {
    InpaintCropImproved: { output: ["IMAGE", "MASK", "STITCHER"] },
    LoadVideo: { output: ["VIDEO", "AUDIO"] },
    Broken: { output: "NOT_AN_ARRAY" },
    Empty: {},
  };
  const types = registeredSocketTypes(objectInfoDefs);
  assert.deepEqual(registeredSocketTypes(undefined), new Set());
  assert.ok(types.has("STITCHER"));
  assert.ok(types.has("VIDEO"));
  assert.ok(types.has("MASK"));
  assert.equal(types.size, 5);
});