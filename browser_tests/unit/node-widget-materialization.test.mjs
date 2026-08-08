import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyCurrentDefWidgetValues,
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  declaredTypeMembers,
  registeredSocketTypes,
  requiredWidgetInputTypes,
  unavailableRequiredCustomWidgetTypes,
  unavailableRequiredWidgetMessage,
  unavailableRequiredWidgetReport,
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
// ---- #695: socket-vs-widget classification must be STRUCTURAL, not a name list ------
//
// Reported as "MASK is missing from SAFE_SOCKET_TYPES". MASK/MESH/VOXEL were added by
// the #620/#608 work, but the same failure class survives in two places, both verified
// against a live /object_info (2887 classes):
//   * PHOTOMAKER — a stock core datatype the list still omits.
//   * COMMA-JOINED UNION types. ComfyUI declares a link-compatible union of datatypes as
//     ONE string: core `PreviewImageOrMask` requires ("IMAGE,MASK"), `ImageUncropByMask`
//     requires ("BBOX,BOUNDING_BOX"), `LoraExtractKJ` requires ("MODEL,CLIP"). The guard
//     compared the WHOLE string against the allowlist and against the output-proof set
//     (which only ever holds single type names), so every union failed closed — a 5s
//     poll for a widget constructor that can never appear, reported as "custom widgets
//     still loading".

const CORE_SOCKET_DATATYPES = ["MASK", "MESH", "VOXEL", "PHOTOMAKER"];

function requiring(required) {
  return { constructor: { nodeData: { input: { required } } } };
}

test("#695: the core connection datatypes named in the report are all safe sockets", () => {
  // Pinned by name so a future edit cannot quietly drop one again. No output proof and
  // no fresh def is supplied: this is the allowlist half on its own.
  for (const type of CORE_SOCKET_DATATYPES) {
    assert.deepEqual(
      unavailableRequiredCustomWidgetTypes(requiring({ thing: [type, {}] }), {}),
      [],
      `${type} must not be treated as a possibly-registering custom widget`,
    );
  }
});

test("#695: core PhotoMakerEncode adds without waiting for a widget", () => {
  // Verbatim from live /object_info.
  const def = {
    input: {
      required: {
        photomaker: ["PHOTOMAKER", {}],
        image: ["IMAGE", {}],
        clip: ["CLIP", {}],
        text: ["STRING", { default: "photograph of photomaker", multiline: true, dynamicPrompts: true }],
      },
    },
  };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, { STRING: () => {} }, new Set(), def),
    [],
  );
});

test("#695: a comma-joined union of core link datatypes is a socket (core PreviewImageOrMask)", () => {
  // Verbatim from live /object_info: required.input = ["IMAGE,MASK", {tooltip}].
  const def = { input: { required: { input: ["IMAGE,MASK", { tooltip: "The image or mask to preview." }] } } };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(def, {}, new Set(), def), []);
  // …and the same union with no config at all (ImageConcanate.image2).
  const bare = { input: { required: { image2: ["IMAGE,MASK", {}] } } };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(bare, {}, new Set(), bare), []);
});

test("#695: a union whose members are only proven by /object_info outputs resolves too", () => {
  // ImageUncropByMask.bbox = ["BBOX,BOUNDING_BOX"]. BBOX is allowlisted; BOUNDING_BOX is
  // not, and is proven a link datatype only because some installed node outputs it.
  const def = { input: { required: { mask: ["MASK"], bbox: ["BBOX,BOUNDING_BOX"] } } };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, {}, new Set(["BOUNDING_BOX"]), def),
    [],
  );
  // Without that proof it still fails closed — an unproven member is still unknown.
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, {}, new Set(), def),
    ["BBOX,BOUNDING_BOX"],
  );
});

test("#788: a union of PRIMITIVES is added, not waited on (reverses #695's ruling)", () => {
  // LTXVEmptyLatentAudio.frame_rate = ["FLOAT,INT", {widgetType:"FLOAT", default:25, min, max, step}].
  //
  // This test previously asserted the OPPOSITE, on the reasoning that the input
  // declares a VALUE so the wait for its widget constructor must survive. The
  // first half is right and the conclusion is wrong: nothing will ever register a
  // constructor keyed "FLOAT,INT". FLOAT and INT are implemented by the core
  // frontend, not by packs, so this was waiting on evidence that cannot arrive
  // (#796) — and the refusal's own remedy, reload the tab, could not help.
  //
  // Three pieces of evidence, none of them inference:
  //   - the node is CORE ComfyUI (comfy_extras), so no pack exists to register it;
  //   - the stock frontend resolves it with `widgetType ?? type` — verified in the
  //     shipped 1.47.12 bundle — and never looks for a union-keyed constructor;
  //   - a reporter confirmed the stock UI adds this node fine by double-click,
  //     while panel_add_node refused it after every restart and refresh.
  //
  // Cost of the old ruling: LTXVEmptyLatentAudio was permanently unaddable, which
  // blocks every LTX-2.3 audio-video graph — the audio latent is mandatory for AV
  // models (panel#788).
  const def = {
    input: {
      required: {
        frame_rate: ["FLOAT,INT", { widgetType: "FLOAT", default: 25, min: 1, max: 1000, step: 0.01 }],
      },
    },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(def, {}, new Set(["FLOAT", "INT"]), def), []);
  // …and with no output proof at all, which is the fresh-tab case.
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(def, {}, new Set(), def), []);
});

test("#788 #580 INTACT: a union naming a CUSTOM member still fails closed", () => {
  // The guard this reverses is narrow. A pack's own type mixed with a primitive
  // still needs that pack's constructor, and still waits for it — waiving on
  // "contains a primitive" would be the #580 false accept all over again.
  const def = {
    input: { required: { style: ["ACME_VALUE,INT", { default: 1, min: 0, max: 9 }] } },
  };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, {}, new Set(["INT"]), def),
    ["ACME_VALUE,INT"],
  );
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, { "ACME_VALUE,INT": () => {} }, new Set(["INT"]), def),
    [],
  );
});

test("#788 a union of SOCKET types is unchanged by this", () => {
  // ("IMAGE,MASK", {widgetType:"IMAGE", default}) — the shape the old comment
  // reasoned about. Sockets are not primitives, so the new waiver does not reach
  // it and the existing input-level bar still decides.
  const def = {
    input: { required: { img: ["IMAGE,MASK", { widgetType: "IMAGE", default: null }] } },
  };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, {}, new Set(["IMAGE", "MASK"]), def),
    ["IMAGE,MASK"],
  );
});

test("#695: a genuinely-still-registering custom widget is still waited for", () => {
  // The legitimate #580 case must be untouched by any of the above: an unknown type that
  // is not a union, has no output proof, and declares a value.
  const def = { input: { required: { gallery: ["ZIPN_STYLE_GALLERY", { default: "none" }] } } };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, {}, new Set(), def),
    ["ZIPN_STYLE_GALLERY"],
  );
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, { ZIPN_STYLE_GALLERY: () => {} }, new Set(), def),
    [],
  );
});

test("#695: declaredTypeMembers splits a union and leaves a single type alone", () => {
  assert.deepEqual(declaredTypeMembers("MASK"), ["MASK"]);
  assert.deepEqual(declaredTypeMembers("IMAGE,MASK"), ["IMAGE", "MASK"]);
  assert.deepEqual(declaredTypeMembers("BBOX, BOUNDING_BOX"), ["BBOX", "BOUNDING_BOX"]);
  // ComfyUI's own `INT:seed` / `INT:noise_seed` registry keys carry no comma and must
  // survive intact — they ARE registered widget constructors, not unions.
  assert.deepEqual(declaredTypeMembers("INT:seed"), ["INT:seed"]);
  assert.deepEqual(declaredTypeMembers(""), []);
  assert.deepEqual(declaredTypeMembers(",,"), []);
  assert.deepEqual(declaredTypeMembers(undefined), []);
});

test("#695: a union registered under its own key in the widget registry is a widget", () => {
  // The whole declared string is looked up before it is decomposed, so a pack that
  // registers a constructor for the union itself keeps it.
  const def = { input: { required: { value: ["IMAGE,MASK", {}] } } };
  assert.deepEqual(unavailableRequiredWidgetReport(def, { "IMAGE,MASK": () => {} }, new Set(), def), []);
});

test("#695: a union with ONE unproven member still fails closed", () => {
  // SaveGaussianSplat.model_3d = FILE_3D_SPLAT_ANY,FILE_3D_PLY,… — proving some members
  // is not proving the type, so the guard is not weakened into "any member counts".
  const def = { input: { required: { model_3d: ["FILE_3D_SPLAT_ANY,FILE_3D_PLY", {}] } } };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, {}, new Set(["FILE_3D_SPLAT_ANY"]), def),
    ["FILE_3D_SPLAT_ANY,FILE_3D_PLY"],
  );
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(
      def,
      {},
      new Set(["FILE_3D_SPLAT_ANY", "FILE_3D_PLY"]),
      def,
    ),
    [],
  );
});

test("#695: the report names the stuck INPUT and which of the two causes it is", () => {
  const def = {
    input: {
      required: {
        // Proven a link datatype by the backend, but declares a widget value.
        amount: ["ACME_VALUE", { default: 3 }],
        // Nothing outputs this and nothing registers a widget for it.
        gallery: ["ZIPN_STYLE_GALLERY", { default: "none" }],
        also_gallery: ["ZIPN_STYLE_GALLERY", { default: "none" }],
      },
    },
  };
  assert.deepEqual(unavailableRequiredWidgetReport(def, {}, new Set(["ACME_VALUE"]), def), [
    { type: "ACME_VALUE", inputs: ["amount"], linkProven: true },
    { type: "ZIPN_STYLE_GALLERY", inputs: ["gallery", "also_gallery"], linkProven: false },
  ]);
});

test("#695: the refusal message stops asserting one cause for two situations", () => {
  const message = unavailableRequiredWidgetMessage(
    [{ type: "ZIPN_STYLE_GALLERY", inputs: ["gallery"], linkProven: false }],
    "ZipnStyler",
    5000,
  );
  // Before: `Required custom widget "MASK" have not registered. They may be custom
  // widgets still loading; retry shortly.` — no node, no input, one asserted cause, and
  // a remedy ("retry shortly") that cannot work for a datatype with no widget.
  assert.match(message, /Cannot add "ZipnStyler"/);
  assert.match(message, /input "gallery"/, "names the input, not just the datatype");
  assert.match(message, /no installed node outputs "ZIPN_STYLE_GALLERY"/);
  assert.match(message, /5\.0s/, "discloses what the wait cost");
  assert.match(message, /Reload the ComfyUI browser tab/, "gives the remedy that can work");
  assert.match(message, /retrying alone will not fix it/);
  assert.doesNotMatch(message, /retry shortly/, "no longer promises a retry will help");

  const linkProven = unavailableRequiredWidgetMessage(
    [{ type: "ACME_VALUE", inputs: ["amount", "other"], linkProven: true }],
    "AcmeNode",
    5000,
  );
  assert.match(linkProven, /input "amount", "other"/);
  assert.match(linkProven, /declares "ACME_VALUE" as a link datatype, but this input also declares a widget value/);
  // The line #695's reporter needed: this is not the socket-allowlist bug again.
  assert.match(linkProven, /added immediately, without any wait/);
});

test("#695: graph_add_node consumes the report and message, and names the class", () => {
  // Without this the classification could be perfect and entirely unwired.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /unavailableRequiredWidgetReport,/, "imported");
  assert.match(src, /unavailableRequiredWidgetMessage,/, "imported");
  assert.doesNotMatch(
    src,
    /They may be custom widgets still loading; retry shortly/,
    "the single-cause message is gone from the add path",
  );
  assert.match(
    src,
    /unavailableRequiredWidgetReport\(nodeData, comfyApp\?\.widgets, knownSocketTypes, currentDef\)/,
    "the poll checks the report",
  );
  assert.match(
    src,
    /unavailableRequiredWidgetMessage\(unavailable, classType, Date\.now\(\) - startedAt\)/,
    "the refusal is built from the report, with the elapsed wait",
  );
  assert.match(
    src,
    /await awaitRequiredCustomWidgetRegistration\(\s*nodeData,\s*comfyApp,\s*knownSocketTypes,\s*currentDef,\s*class_type,\s*\)/,
    "the class_type reaches the message",
  );
});

test("#695 gate r1: an all-built-in UNION that declares a widget value still fails closed", () => {
  // Members being built-in link datatypes is not the INPUT being a link. A pack can
  // declare ("IMAGE,MASK", {widgetType, default}) — the shape LTXV already uses for
  // ("FLOAT,INT", …) — which is a widget that ACCEPTS those links. Waiving it on the
  // member types alone added a node with neither a widget value nor a link (#580).
  const def = {
    input: { required: { source: ["IMAGE,MASK", { widgetType: "IMAGE", default: "none" }] } },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(def, {}, new Set(), def), ["IMAGE,MASK"]);
  // It is reported as the link-proven case, because that is what it is: the datatypes are
  // real link types, and the INPUT is nonetheless asking for a value.
  assert.deepEqual(unavailableRequiredWidgetReport(def, {}, new Set(), def), [
    { type: "IMAGE,MASK", inputs: ["source"], linkProven: true },
  ]);
  // …and it clears once the constructor registers under the union's own key.
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, { "IMAGE,MASK": () => {} }, new Set(), def),
    [],
  );
  // A SINGLE built-in keeps its type-only shortcut, exactly as before this fix: no widget
  // constructor exists for MASK, so there is nothing for the input to be waiting on.
  const single = { input: { required: { mask: ["MASK", { default: "none" }] } } };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(single, {}, new Set(), single), []);
});

test("#695 gate r1: the type list is deduped and first-seen ordered, as it always was", () => {
  // requiredWidgetInputTypes has always returned [...new Set(...)], so the Map-based
  // rewrite must not start emitting one entry per input.
  const def = {
    input: {
      required: {
        first: ["ACME", { default: 1 }],
        other: ["ZED", { default: 2 }],
        second: ["ACME", { default: 3 }],
      },
    },
  };
  assert.deepEqual(unavailableRequiredCustomWidgetTypes(def, {}, new Set(), def), ["ACME", "ZED"]);
  assert.deepEqual(unavailableRequiredWidgetReport(def, {}, new Set(), def), [
    { type: "ACME", inputs: ["first", "second"], linkProven: false },
    { type: "ZED", inputs: ["other"], linkProven: false },
  ]);
});

// ── #686: core V3 DYNAMIC-INPUT declarations ──────────────────────────────
//
// panel_add_node could not create ANY node whose schema uses ComfyUI 0.30's
// autogrow input type — StringFormat, ComfyMathExpression — failing with
// "Required custom widget COMFY_AUTOGROW_V3 have not registered … retry
// shortly". It never resolved: refresh_nodes returned refreshed:true and the
// next attempt failed identically, while dragging the same node in from
// ComfyUI's own menu worked and the node then executed normally.
//
// It is a THIRD kind of required input that both existing waivers misclassify:
// nothing OUTPUTS the type (so `linkProven` is structurally unreachable) and no
// widget constructor is ever registered for it (the frontend implements it
// natively), so the wait was for something that could never happen.

const AUTOGROW = "COMFY_AUTOGROW_V3";
/** app.widgets with the ordinary value types registered — AUTOGROW never is. */
const REGISTERED = { STRING: () => {}, FLOAT: () => {}, INT: () => {} };

/** StringFormat as ComfyUI 0.30 emits it. Autogrow's Input.as_dict() yields the
 *  base neutral keys plus `template`, and NO widget-value keys. */
const stringFormatDef = {
  input: {
    required: {
      format: ["STRING", { default: "{a}_{b:02d}" }],
      values: [AUTOGROW, { template: { input: ["STRING", {}], prefix: "value", min: 1, max: 10 } }],
    },
  },
};

test("#686 an autogrow node is addable — StringFormat no longer waits for a widget that never registers", () => {
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(stringFormatDef, REGISTERED, undefined, stringFormatDef),
    [],
  );
});

test("#686 the waiver cannot come from output evidence — knownSocketTypes can never contain it", () => {
  // The load-bearing point. Nothing outputs COMFY_AUTOGROW_V3, so passing a fully
  // populated knownSocketTypes changes nothing: if the fix depended on link-proof
  // it would still fail closed forever. Same verdict with and without.
  const known = new Set(["IMAGE", "MASK", "LATENT", "STRING"]);
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(stringFormatDef, REGISTERED, known, stringFormatDef),
    [],
  );
});

test("#686 covers the whole reserved COMFY_*_V3 family, not just the reported type", () => {
  // ComfyMathExpression is the second node in the report, and the other three are
  // declared alongside autogrow in ComfyUI's comfy_api/latest/_io.py. Fixing only
  // the reported one would leave the identical bug for its siblings.
  for (const type of [
    "COMFY_AUTOGROW_V3",
    "COMFY_DYNAMICCOMBO_V3",
    "COMFY_DYNAMICSLOT_V3",
    "COMFY_MATCHTYPE_V3",
    "COMFY_MULTITYPED_V3",
  ]) {
    const def = { input: { required: { values: [type, { template: {} }] } } };
    assert.deepEqual(
      unavailableRequiredCustomWidgetTypes(def, REGISTERED, undefined, def),
      [],
      `${type} must be addable`,
    );
  }
});

test("#686 does NOT weaken #580: an unregistered custom widget still fails closed", () => {
  const def = { input: { required: { thing: ["SOME_CUSTOM_WIDGET", { default: 1, min: 0 }] } } };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, REGISTERED, undefined, def),
    ["SOME_CUSTOM_WIDGET"],
  );
});

test("#686 the REAL per-type config shapes are all addable (from ComfyUI's own as_dict)", () => {
  // These are the exact config keys each family member emits in comfy_api/latest/_io.py,
  // not an invented shape. The first version of this fix additionally required the input
  // to be "socket-shaped", which silently excluded DynamicCombo — its `options` key is in
  // WIDGET_VALUE_CONFIG_KEYS — and so left SaveVideo (#636) exactly as unaddable as before.
  const REAL_SHAPES = {
    COMFY_AUTOGROW_V3: { template: { input: ["STRING", {}], prefix: "v", min: 1, max: 10 } },
    COMFY_DYNAMICCOMBO_V3: { options: [{ key: "auto", inputs: {} }, { key: "h264", inputs: {} }] },
    COMFY_DYNAMICSLOT_V3: { inputs: {} },
    COMFY_MATCHTYPE_V3: { template: {}, template_id: "t", allowed_types: ["IMAGE"] },
    COMFY_MULTITYPED_V3: { template: {}, template_id: "t", allowed_types: ["IMAGE", "MASK"] },
  };
  for (const [type, config] of Object.entries(REAL_SHAPES)) {
    const def = { input: { required: { v: [type, config] } } };
    assert.deepEqual(
      unavailableRequiredCustomWidgetTypes(def, REGISTERED, undefined, def),
      [],
      `${type} must be addable with its REAL emitted config`,
    );
  }
});

test("#636 SaveVideo is addable — the node the DynamicCombo gap actually blocked", () => {
  // comfy_extras/nodes_video.py: video is a link input, codec is a DynamicCombo.
  // VIDEO clears via knownSocketTypes (CreateVideo/LoadVideo output it); codec needs
  // the reserved-namespace waiver. Both halves have to hold or the node stays unaddable.
  const saveVideo = { input: { required: {
    video: ["VIDEO", { tooltip: "The video to save." }],
    filename_prefix: ["STRING", { default: "video/ComfyUI" }],
    format: [["auto", "mp4", "webm"], { default: "auto" }],
    codec: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "auto", inputs: {} }] }],
  } } };
  const known = new Set(["VIDEO", "IMAGE", "LATENT"]);
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(saveVideo, { STRING: () => {}, COMBO: () => {} }, known, saveVideo),
    [],
  );
});

test("#686 matches the RESERVED namespace only — a lookalike is not waived", () => {
  // The rule is ComfyUI's own COMFY_*_V3 prefix. A third-party type that merely
  // resembles it gets no waiver.
  for (const type of ["COMFY_FAKE_V2", "COMFY_THING", "MYPACK_AUTOGROW_V3", "comfy_autogrow_v3"]) {
    const def = { input: { required: { v: [type, {}] } } };
    assert.deepEqual(
      unavailableRequiredCustomWidgetTypes(def, REGISTERED, undefined, def),
      [type],
      `${type} must NOT be waived`,
    );
  }
});

test("#686 a registered constructor still wins — the waiver never shadows a real widget", () => {
  const def = { input: { required: { v: [AUTOGROW, { template: {} }] } } };
  assert.deepEqual(
    unavailableRequiredCustomWidgetTypes(def, { ...REGISTERED, [AUTOGROW]: () => {} }, undefined, def),
    [],
  );
});
