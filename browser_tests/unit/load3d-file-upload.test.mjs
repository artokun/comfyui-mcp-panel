// panel#1569 — ComfyUI's 3D upload kind is `file_upload`, not `model_upload`.
//
// `UPLOAD_CONFIG_FLAGS` listed image/video/audio/`model_upload`. ComfyUI's own
// `UploadType` enum (comfy_api/latest/_io.py) is image="image_upload",
// audio="audio_upload", video="video_upload", model="file_upload" — and the V1
// spelling that predates it was already `{"file_upload": True}` (the commit that
// added Load3D, ComfyUI bdf39379). So the panel recognised a flag no ComfyUI has
// ever emitted and did NOT recognise the one two live inputs actually carry.
//
// MEASURED on a live ComfyUI 0.33.2 /object_info (853 types, 529 combo inputs):
//
//     image_upload  4   LoadImage.image, LoadImageMask.image,
//                       LoadImageOutput.image, Painter.mask
//     audio_upload  1   LoadAudio.audio
//     video_upload  1   LoadVideo.file
//     file_upload   2   Load3D.model_file, Load3DAdvanced.model_file   <-- unrecognised
//     model_upload  0
//
// The two 3D inputs serialize as the V2 shape verbatim:
//
//     "model_file": ["COMBO", {"multiselect": false, "options": ["none"],
//                              "file_upload": true}]
//
// WHY THIS IS A WRITE-PATH CHANGE, NOT A TYPO FIX. Recognising these inputs ARMS the
// #387 upload fallback on `panel_set_widget` for two inputs where it has always been
// inert, so what the write path accepts must be checked in BOTH directions. It was
// checked against the server, live, rather than reasoned about:
//
//   * ComfyUI's core combo-membership check is SKIPPED for this input. `Load3D`
//     declares `validate_inputs(cls, model_file, **kwargs)`, and execution.py gates
//     the "Value not in list" error on `x not in validate_function_inputs and not
//     validate_has_kwargs`. Only `folder_paths.exists_annotated_filepath` decides.
//   * So on a live 0.33.2, POST /prompt ACCEPTS `Load3D.model_file` =
//     `meshes/cloud.ply` and `chair.glb` (both exist under input/, neither is
//     enumerated — `Load3D.define_schema` rglobs `input/3d/` only) and REFUSES
//     `3d/nope.glb` with "Invalid 3D model file". Combo membership is irrelevant;
//     existence is everything. The panel refusing a non-enumerated but present file
//     was therefore a FALSE refusal, and the fallback fixes exactly that.
//   * ComfyUI runs NO extension check of its own here: `/prompt` accepts
//     `3d/notes.txt`, and `/view?filename=notes.txt&subfolder=3d&type=input` answers
//     206. `UPLOAD_KIND_EXTENSIONS.file_upload` is the ONLY thing that keeps a
//     server-confirmed `.txt` out of a Load3D combo, so it is asserted here as a
//     gate rather than trusted as a nicety (#240 strictness).
//
// The extension set is Load3D's OWN listing suffixes and must NOT be the weight-file
// set `model_upload` carries: a `.safetensors` is not a loadable 3D asset, and the
// two kinds sharing a set would silently admit one.

import assert from "node:assert/strict";
import test from "node:test";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import {
  authoritativeComboValues,
  uploadConfigOf,
  uploadInputAccepts,
  uploadInputConfig,
} from "../../web/js/lib/input-asset.js";
import { scanComboAvailability } from "../../web/js/lib/live-combo-availability.js";

const REGISTRY = { Load3D: {}, Load3DAdvanced: {}, CheckpointLoaderSimple: {} };

/** The live 0.33.2 `Load3D.model_file` spec, copied from a real /object_info body. */
const load3dSpec = (options = ["none"]) => [
  "COMBO",
  { multiselect: false, options, file_upload: true },
];

const defsWith = (options) => ({
  Load3D: { input: { required: { model_file: load3dSpec(options) } } },
  Load3DAdvanced: { input: { required: { model_file: load3dSpec(options) } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd15.safetensors"], {}] } } },
});

/** Mirrors refreshComboOptionsFromDefs for the V2 shape: the widget takes the fresh list. */
function refreshFromFreshDefs(defs, target) {
  const widget = target?.widgets?.[0];
  const spec = defs?.[target?.type]?.input?.required?.[widget?.name];
  const options = authoritativeComboValues(spec);
  if (widget && Array.isArray(options)) widget.options.values = options.slice();
}

const load3dNode = (value = "none", options = ["none"]) => {
  const widget = { name: "model_file", type: "combo", options: { values: options.slice() }, value };
  return { node: { id: 77, type: "Load3D", widgets: [widget] }, widget };
};

// ---------------------------------------------------------------------------
// Recognition — the flag itself
// ---------------------------------------------------------------------------

test("#1569 the live Load3D/Load3DAdvanced model_file config is recognised as an upload input", () => {
  const defs = defsWith(["none"]);
  for (const type of ["Load3D", "Load3DAdvanced"]) {
    const cfg = uploadInputConfig(defs, type, "model_file");
    assert.ok(cfg, `${type}.model_file must be recognised as an upload input`);
    assert.equal(cfg.file_upload, true);
  }
  // The exact config object the live server publishes, standalone.
  assert.ok(uploadConfigOf({ multiselect: false, options: ["none"], file_upload: true }));
});

test("#1569 the 3D kind gates on Load3D's OWN suffixes, never the weight-file set", () => {
  const cfg = { file_upload: true };
  // Exactly the suffixes comfy_extras/nodes_load_3d.py enumerates.
  for (const ext of ["gltf", "glb", "obj", "fbx", "stl", "spz", "splat", "ply", "ksplat"]) {
    assert.equal(uploadInputAccepts(cfg, `3d/chair.${ext}`), true, `.${ext} is a Load3D suffix`);
    assert.equal(uploadInputAccepts(cfg, `3d/CHAIR.${ext.toUpperCase()}`), true, "case-insensitive");
  }
  // `model_upload`'s weight-file extensions are NOT 3D assets. If the two kinds ever
  // share one Set, this is what catches it.
  for (const ext of ["safetensors", "ckpt", "pt", "pth", "bin", "gguf", "sft", "onnx"]) {
    assert.equal(uploadInputAccepts(cfg, `3d/weights.${ext}`), false, `.${ext} is not a 3D asset`);
  }
  // And the reverse: a weight-upload input must not start taking meshes.
  assert.equal(uploadInputAccepts({ model_upload: true }, "sub/chair.glb"), false);
  assert.equal(uploadInputAccepts({ model_upload: true }, "sub/sd15.safetensors"), true);
  // The server serves this file 206 and ComfyUI's own /prompt validation accepts it.
  // The panel refuses it anyway — that is the #240 overshoot, and it is deliberate.
  assert.equal(uploadInputAccepts(cfg, "3d/notes.txt"), false);
  assert.equal(uploadInputAccepts(cfg, "3d/noext"), false);
});

// ---------------------------------------------------------------------------
// WRITE path — panel_set_widget, both directions
// ---------------------------------------------------------------------------

test("#1569 a server-confirmed 3D model the Load3D combo cannot list is ACCEPTED", async () => {
  // `Load3D.define_schema` rglobs `input/3d/` only, so a file under any other input
  // subfolder is never a combo member however fresh the fetch — yet ComfyUI's own
  // /prompt validates it (measured). The write must succeed.
  const { node, widget } = load3dNode();
  let probed = null;
  const res = await runSetWidget(node, "model_file", "meshes/cloud.ply", {
    registry: REGISTRY,
    getFreshObjectInfo: async () => defsWith(["none"]),
    refreshCombos: refreshFromFreshDefs,
    confirmServerAsset: async (v) => {
      probed = v;
      return true;
    },
  });
  assert.equal(res.set.value, "meshes/cloud.ply");
  assert.equal(res.server_confirmed, true);
  assert.equal(probed, "meshes/cloud.ply");
  assert.ok(widget.options.values.includes("meshes/cloud.ply"));
});

test("#1569 an ANNOTATED 3D value stays refused on the write path — unchanged, not newly broken", async () => {
  // `uploadInputAccepts` reads the extension off the RAW value, so `x.glb [output]`
  // has extension "glb [output]" and matches nothing. That is PRE-EXISTING and kind-
  // independent — an annotated `pic.png [output]` is refused on a LoadImage the same
  // way today — and #1569 deliberately does not change it: the read path strips the
  // annotation before asking (live-combo-availability passes the parsed `bare` name),
  // the write path never has. Pinned here so recognising `file_upload` cannot be read
  // as having quietly opened that door, and so the day someone does open it, they open
  // it for every kind at once rather than only for 3D.
  const { node, widget } = load3dNode();
  let probed = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "model_file", "3d/chair.glb [output]", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => defsWith(["none"]),
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => {
          probed = true;
          return true;
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(probed, false);
  assert.equal(widget.value, "none");
  // Same verdict for the image kind, which nothing in this change touches.
  assert.equal(uploadInputAccepts({ image_upload: true }, "sub/pic.png [output]"), false);
});

test("#1569 a 3D model file the server does NOT have stays REFUSED", async () => {
  // Measured: ComfyUI answers this exact case "Invalid 3D model file: 3d/nope.glb".
  const { node, widget } = load3dNode();
  await assert.rejects(
    () =>
      runSetWidget(node, "model_file", "3d/nope.glb", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => defsWith(["none"]),
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => false,
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(widget.value, "none", "a refused write must not mutate the widget");
  assert.deepEqual(widget.options.values, ["none"]);
});

test("#1569 a server-EXISTING non-3D file is REFUSED, and refused BEFORE the probe", async () => {
  // ComfyUI would take this (`/prompt` accepts `3d/notes.txt`, `/view` serves it 206).
  // The panel is deliberately stricter, and the refusal is decided by extension, so no
  // network call is spent on it at all.
  const { node, widget } = load3dNode();
  let probed = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "model_file", "3d/notes.txt", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => defsWith(["none"]),
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => {
          probed = true;
          return true;
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(probed, false, "a wrong-kind extension is refused before any server probe");
  assert.equal(widget.value, "none");
});

test("#1569 a checkpoint name is REFUSED on a 3D input even though the server has it", async () => {
  // The one way recognising `file_upload` could have loosened too far: if the 3D kind
  // inherited `model_upload`'s weight extensions, this write would be accepted.
  const { node, widget } = load3dNode();
  let probed = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "model_file", "3d/sd15.safetensors", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => defsWith(["none"]),
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => {
          probed = true;
          return true;
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(probed, false);
  assert.equal(widget.value, "none");
});

test("#1569 a plain (non-upload) combo is still never rescued by the probe", async () => {
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
      runSetWidget(node, "ckpt_name", "3d/chair.glb", {
        registry: REGISTRY,
        getFreshObjectInfo: async () => defsWith(["none"]),
        refreshCombos: refreshFromFreshDefs,
        confirmServerAsset: async () => {
          probed = true;
          return true;
        },
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(probed, false, "recognising file_upload must not arm the probe anywhere else");
});

test("#1569 an ENUMERATED 3D model is accepted by the refresh, with no probe at all", async () => {
  const { node } = load3dNode("none", ["none"]);
  let probed = false;
  const res = await runSetWidget(node, "model_file", "3d/chair.glb", {
    registry: REGISTRY,
    getFreshObjectInfo: async () => defsWith(["none", "3d/chair.glb"]),
    refreshCombos: refreshFromFreshDefs,
    confirmServerAsset: async () => {
      probed = true;
      return true;
    },
  });
  assert.equal(res.set.value, "3d/chair.glb");
  assert.equal(res.refreshed, true);
  assert.equal(res.server_confirmed, undefined);
  assert.equal(probed, false, "the fresh list already lists it — nothing to probe");
});

// ---------------------------------------------------------------------------
// READ path — panel_get_errors' live availability scan
// ---------------------------------------------------------------------------

// The READ path (panel_get_errors' live availability scan) reads a class body through
// `parseClassCombos`, which on main recognises the V1 shape `[[...options], config]`
// only. Live 0.33.2 publishes Load3D in the V2 shape, so on main today this scan does
// not see `Load3D.model_file` as a combo AT ALL and never judges it — the read-path
// half of #1569 only reaches a live server once #1568's V2 reader lands. These tests
// therefore drive the V1 shape, which is not a hypothetical: ComfyUI shipped Load3D as
// `(sorted(files), {"file_upload": True})` from bdf39379 (Dec 2024) until the V3
// conversion in 440268d3. They pin the recognition this change is responsible for; the
// shape reading is #1568's to prove.
const load3dClassBody = (options) => ({
  Load3D: { input: { required: { model_file: [options, { file_upload: true }] } } },
});

test("#1569 get_errors stops calling a present, non-enumerated 3D model a missing asset", async () => {
  const probed = [];
  const r = await scanComboAvailability(
    [{ id: 77, type: "Load3D", widgets: [{ name: "model_file", value: "meshes/cloud.ply" }] }],
    async () => load3dClassBody(["none"]),
    {
      confirmServerAsset: (value, ref) => {
        probed.push({ value, ...ref });
        return true;
      },
    },
  );
  assert.deepEqual(r.unavailable, [], "the server has the file; nothing to report");
  assert.deepEqual(r.unknown ?? [], []);
  assert.deepEqual(probed, [
    { value: "meshes/cloud.ply", filename: "cloud.ply", subfolder: "meshes", type: "input" },
  ]);
});

test("#1569 get_errors still reports a 3D model the server answers is ABSENT", async () => {
  const r = await scanComboAvailability(
    [{ id: 77, type: "Load3D", widgets: [{ name: "model_file", value: "3d/nope.glb" }] }],
    async () => load3dClassBody(["none"]),
    { confirmServerAsset: () => false },
  );
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].value, "3d/nope.glb");
});

test("#1569 get_errors ABSTAINS when the 3D file check does not answer (#1357)", async () => {
  const r = await scanComboAvailability(
    [{ id: 77, type: "Load3D", widgets: [{ name: "model_file", value: "meshes/cloud.ply" }] }],
    async () => load3dClassBody(["none"]),
    { confirmServerAsset: () => null },
  );
  assert.deepEqual(r.unavailable, [], "an unanswered probe must never become a confirmed miss");
  assert.equal(r.unknown.length, 1);
  assert.match(r.unknown[0].reason, /did not answer/);
});
