import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyCurrentDefWidgetValues,
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  registeredSocketTypes,
  requiredWidgetInputTypes,
  unavailableRequiredCustomWidgetTypes,
} from "../../web/js/lib/node-widget-materialization.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

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

test("a same-name required input whose TYPE changed mid-session is drift", () => {
  const staleNode = {
    constructor: {
      nodeData: {
        input: {
          required: {
            mode: ["STRING", { default: "legacy" }],
            style: [["none", "film"], {}],
            quality: ["INT", { default: 5 }],
          },
        },
      },
    },
  };
  // mode retyped STRING -> COMBO, style's combo VALUES changed, quality only
  // gained a benign default change.
  const currentDef = {
    input: {
      required: {
        mode: [["modern"], {}],
        style: [["noir", "film"], {}],
        quality: ["INT", { default: 7 }],
      },
    },
  };
  assert.deepEqual(driftedRequiredInputNames(currentDef, staleNode), ["mode", "style"]);
});

test("defaultInput renders a socket, and a widget<->defaultInput flip mid-session is drift", () => {
  // defaultInput: the input is a socket BY DEFAULT (no widget materialized),
  // convertible back by the user — the guards must not demand a widget.
  const socketByDefault = {
    constructor: {
      nodeData: {
        input: { required: { value: ["INT", { defaultInput: true }] } },
      },
    },
  };
  assert.deepEqual(requiredWidgetInputTypes(socketByDefault), []);
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(socketByDefault, { INT: () => {} }),
    [],
  );
  assert.deepEqual(
    missingRequiredWidgetMaterializations(
      { ...socketByDefault, widgets: [] },
      { INT: () => {} },
    ),
    [],
  );
  // Widget -> defaultInput socket: the fresh def wants a socket, the stale
  // constructor would build a widget — drift must refuse with a reload remedy.
  const widgetShape = {
    constructor: {
      nodeData: { input: { required: { value: ["INT", {}] } } },
    },
  };
  const socketDef = { input: { required: { value: ["INT", { defaultInput: true }] } } };
  assert.deepEqual(driftedRequiredInputNames(socketDef, widgetShape), ["value"]);
  // defaultInput socket -> widget: the reverse flip is drift too (otherwise
  // the stale socket-shaped node would be reported as missing a widget).
  const widgetDef = { input: { required: { value: ["INT", {}] } } };
  assert.deepEqual(driftedRequiredInputNames(widgetDef, socketByDefault), ["value"]);
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

// ---- #626 P0-1: output-type compatibility is not proof an input is LINK-ONLY -------
//
// `knownSocketTypes` waived registration for any input whose type appears as SOME fresh
// definition's OUTPUT. That is evidence about the TYPE; the question is about the INPUT.
// ComfyUI's frontend supports converting widget inputs to links, so widget-bearing
// inputs are link-compatible too — a custom ACME_VALUE can be a widget on one node and
// an output on another. Waiving on the output side alone meant a required custom widget
// whose constructor NEVER registers passed the guard, and `panel_add_node` added a node
// with NEITHER the required widget value NOR a link — invalid, and rejected only later
// at queue time. The later materialization guard could not report it either: with no
// constructor there is nothing for it to look for.

const ACME_OUTPUT_PROOF = new Set(["ACME_VALUE"]);

test("#626: a required input that DECLARES a value is not waived just because some node OUTPUTS its type", () => {
  // The V3 custom-widget shape: the input declares a `default`, which only a widget can
  // carry. Another node outputs ACME_VALUE, so the type IS a proven link datatype — and
  // that still does not make THIS input link-only.
  const node = {
    constructor: {
      nodeData: { input: { required: { amount: ["ACME_VALUE", { default: 3, min: 0, max: 10 }] } } },
    },
  };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(node, {}, ACME_OUTPUT_PROOF),
    ["ACME_VALUE"],
    "output-side proof alone must not waive a value-declaring input",
  );
  // …and it clears the moment the widget constructor actually registers, which is the
  // only thing that makes the node valid.
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(node, { ACME_VALUE: () => {} }, ACME_OUTPUT_PROOF),
    [],
  );
});

test("#626: a socket-SHAPED input of a proven link type is still waived (#620/#608 preserved)", () => {
  // The discriminating half. Identical type, identical output-side proof — the ONLY
  // difference is that this input declares no value config, i.e. it is asking for a
  // link. Without this the guard would fail closed forever on third-party socket
  // datatypes again, which is the regression #620/#608 were about.
  const node = {
    constructor: { nodeData: { input: { required: { thing: ["ACME_VALUE", {}] } } } },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}, ACME_OUTPUT_PROOF), []);
  // A null/absent config is the same statement.
  const bare = {
    constructor: { nodeData: { input: { required: { thing: ["ACME_VALUE"] } } } },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(bare, {}, ACME_OUTPUT_PROOF), []);
  // `tooltip` and `lazy` say nothing about widget-vs-socket and must not flip it.
  const annotated = {
    constructor: {
      nodeData: { input: { required: { thing: ["ACME_VALUE", { tooltip: "hi", lazy: true }] } } },
    },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(annotated, {}, ACME_OUTPUT_PROOF), []);
});

test("#626: one socket-shaped input does NOT waive a SIBLING of the same type that declares a value", () => {
  // A def can require the same datatype twice, once as a link and once as a widget.
  // Waiving the widget one because its sibling is a socket reproduces the same error a
  // level down, so the waiver needs EVERY required input of the type to be socket-shaped.
  const node = {
    constructor: {
      nodeData: {
        input: {
          required: {
            wired: ["ACME_VALUE", {}],
            typed: ["ACME_VALUE", { default: 1 }],
          },
        },
      },
    },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}, ACME_OUTPUT_PROOF), ["ACME_VALUE"]);
});

test("#626: an explicit forceInput/widget:false still reads as a socket even with value config", () => {
  // An explicit socket flag is the strongest input-level statement there is and settles
  // it outright — inputWidgetType already drops these, so they never reach the guard.
  const node = {
    constructor: {
      nodeData: {
        input: { required: { amount: ["ACME_VALUE", { default: 3, forceInput: true }] } },
      },
    },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(node, {}, new Set()), []);
});

// ---- #626 P0-2: the node is built from STALE nodeData, not the current definition ----

function intWidget(value, options) {
  return { name: "steps", type: "number", value, options: { ...options } };
}

test("#626: a required INT whose range moved takes the CURRENT default, not the stale one", () => {
  // The reported fold: {default:1,min:0,max:10} -> {default:20,min:20,max:100}. Both
  // signatures are `INT`, so drift does not fire, and LG.createNode builds from the
  // registered nodeData — producing `1`, which the backend rejects at QUEUE time, far
  // from its cause.
  const node = { widgets: [intWidget(1, { min: 0, max: 10 })] };
  const currentDef = { input: { required: { steps: ["INT", { default: 20, min: 20, max: 100 }] } } };
  const corrections = applyCurrentDefWidgetValues(node, currentDef);
  assert.equal(node.widgets[0].value, 20, "the value comes from the CURRENT definition");
  assert.equal(node.widgets[0].options.min, 20, "bounds come from the current definition too");
  assert.equal(node.widgets[0].options.max, 100);
  // The correction is DISCLOSED, not applied silently — it is a value the caller did
  // not ask for, even though it is the right one.
  assert.deepEqual(corrections, [{ name: "steps", from: 1, to: 20 }]);
});

test("#626: bounds are written BEFORE the value, so a raised default is not clamped by the stale max", () => {
  // Order is load-bearing: applying the value first against a stale max of 10 would
  // clamp 20 back to 10 and ship an out-of-range value while reporting a correction.
  const node = { widgets: [intWidget(1, { min: 0, max: 10 })] };
  applyCurrentDefWidgetValues(node, {
    input: { required: { steps: ["INT", { default: 20, min: 20, max: 100 }] } },
  });
  assert.equal(node.widgets[0].value, 20);
});

test("#626: a value outside the CURRENT range with no declared default is clamped and reported", () => {
  const node = { widgets: [intWidget(1, { min: 0, max: 10 })] };
  const corrections = applyCurrentDefWidgetValues(node, {
    input: { required: { steps: ["INT", { min: 20, max: 100 }] } },
  });
  assert.equal(node.widgets[0].value, 20, "clamped up to the current minimum");
  assert.deepEqual(corrections, [{ name: "steps", from: 1, to: 20 }]);
});

test("#626: an UNCHANGED definition produces NO corrections, so nothing is disclosed", () => {
  // Keeps the ordinary add byte-identical to before: an empty list means the payload
  // carries no correction key and no warning at all.
  const node = { widgets: [intWidget(20, { min: 20, max: 100 })] };
  assert.deepEqual(
    applyCurrentDefWidgetValues(node, {
      input: { required: { steps: ["INT", { default: 20, min: 20, max: 100 }] } },
    }),
    [],
  );
  assert.equal(node.widgets[0].value, 20);
});

test("#626: no current definition (a frontend-only type) leaves the node untouched", () => {
  const node = { widgets: [intWidget(1, { min: 0, max: 10 })] };
  assert.deepEqual(applyCurrentDefWidgetValues(node, undefined), []);
  assert.deepEqual(applyCurrentDefWidgetValues(node, {}), []);
  assert.equal(node.widgets[0].value, 1);
});

test("#626: an input with NO materialized widget is not invented into one", () => {
  // A socket input has no widget, and reconciliation must not create one — that would
  // put a value on a slot the user is expected to wire.
  const node = { widgets: [] };
  assert.deepEqual(
    applyCurrentDefWidgetValues(node, {
      input: { required: { model: ["MODEL", {}], steps: ["INT", { default: 20 }] } },
    }),
    [],
  );
  assert.equal(node.widgets.length, 0);
});

test("#626: graph_add_node actually CONSUMES the reconciliation and discloses it", () => {
  // Without this the helper could be perfectly correct and entirely unwired.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /applyCurrentDefWidgetValues,/, "imported");
  assert.match(
    src,
    /const valueCorrections = applyCurrentDefWidgetValues\(node, currentDef\);/,
    "called on the created node with the CURRENT def",
  );
  assert.match(src, /added\.schema_value_corrections = valueCorrections;/, "disclosed on the result");
  // …and it must run BEFORE the node is added to the graph, or the graph briefly holds
  // the stale value and an undo step captures it.
  assert.ok(
    src.indexOf("const valueCorrections = applyCurrentDefWidgetValues(node, currentDef);") <
      src.indexOf("      graph.add(node);"),
    "reconciliation must precede graph.add",
  );
});