// Unit tests for the Micro-Apps service (web/js/cmcp-apps.js): APP-mode
// config import (defensive key probing), heuristic input/output selection,
// widget classification, dependency scanning, manifest assembly, and the
// AppsClient HTTP surface (mocked fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppBuilder, AppsClient } from "../../web/js/cmcp-apps.js";

const APPS_UI = readFileSync(
  fileURLToPath(new URL("../../web/js/cmcp-apps-ui.js", import.meta.url)),
  "utf8",
);

// ── APP-mode config import ──────────────────────────────────────────────────

test("findAppModeConfig: extra.appMode wins, normalized to our shape", () => {
  const wf = {
    nodes: [],
    extra: {
      appMode: {
        inputs: [{ nodeId: "6", name: "text", title: "Prompt", type: "text" }],
        outputs: [{ id: 9 }],
      },
    },
  };
  const cfg = AppBuilder.findAppModeConfig(wf);
  assert.deepEqual(cfg, {
    inputs: [{ nodeId: 6, widget: "text", label: "Prompt", kind: "text" }],
    outputs: [{ nodeId: 9, kind: "images" }],
    importedFromFrontend: true,
  });
});

test("findAppModeConfig: falls back through candidate keys", () => {
  assert.ok(AppBuilder.findAppModeConfig({ extra: { app_mode: { inputs: [{ node_id: 3, key: "seed" }] } } }));
  assert.ok(AppBuilder.findAppModeConfig({ appMode: { outputs: [{ nodeId: 1 }] } }));
  assert.equal(AppBuilder.findAppModeConfig({ nodes: [], extra: {} }), null);
  assert.equal(AppBuilder.findAppModeConfig(null), null);
  assert.equal(AppBuilder.findAppModeConfig({ extra: { appMode: { notInputs: [] } } }), null);
});

test("#1429 findAppModeConfig reads official extra.linearData tuples and bare output ids", () => {
  const wf = {
    extra: {
      linearData: {
        inputs: [
          [6, "text", { description: "Prompt" }],
          ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:4:ckpt_name", "ckpt_name"],
        ],
        outputs: [9, "10"],
      },
    },
  };
  const cfg = AppBuilder.findAppModeConfig(wf);
  assert.deepEqual(cfg, {
    inputs: [
      { nodeId: 6, widget: "text", label: "Prompt", kind: "text" },
      { nodeId: 4, widget: "ckpt_name", label: "ckpt_name", kind: "text" },
    ],
    outputs: [
      { nodeId: 9, kind: "images" },
      { nodeId: 10, kind: "images" },
    ],
    importedFromFrontend: true,
  });
});

test("#1429 extra.linearData wins over extra.appMode when both exist", () => {
  const cfg = AppBuilder.findAppModeConfig({
    extra: {
      linearData: { inputs: [[6, "text"]], outputs: [9] },
      appMode: { inputs: [{ nodeId: 1, widget: "other" }] },
    },
  });
  assert.equal(cfg.inputs[0].nodeId, 6);
  assert.equal(cfg.inputs[0].widget, "text");
  assert.equal(cfg.outputs[0].nodeId, 9);
});

test("findAppModeConfig: skips malformed entries", () => {
  const wf = {
    extra: {
      appMode: {
        inputs: [{ nodeId: "x", widget: "text" }, { widget: "text" }, null, { nodeId: 6, widget: "text" }],
      },
    },
  };
  const cfg = AppBuilder.findAppModeConfig(wf);
  assert.equal(cfg.inputs.length, 1);
  assert.equal(cfg.inputs[0].nodeId, 6);
});

// ── heuristic selection ─────────────────────────────────────────────────────

test("heuristicAppMode: hint-type nodes become inputs, save/preview become outputs", () => {
  const nodes = [
    { id: 4, type: "CheckpointLoaderSimple", widgets_values: ["flux.safetensors"] },
    { id: 6, type: "CLIPTextEncode", widgets_values: ["a cat"] },
    { id: 3, type: "KSampler", widgets_values: [1234, "fixed", 20, 8, "euler", "normal", 1] },
    { id: 8, type: "VAEDecode", widgets_values: [] },
    { id: 9, type: "SaveImage", widgets_values: ["ComfyUI"] },
    { id: 10, type: "PreviewImage" },
  ];
  const cfg = AppBuilder.heuristicAppMode(nodes);
  assert.ok(cfg.inputs.some((i) => i.nodeId === 6 && i.kind === "text"));
  assert.ok(cfg.inputs.some((i) => i.nodeId === 4 && i.kind === "model"));
  assert.ok(cfg.inputs.some((i) => i.nodeId === 3 && i.kind === "number"));
  assert.deepEqual(
    cfg.outputs.map((o) => o.nodeId).sort((a, b) => a - b),
    [9, 10],
  );
  // VAEDecode is neither a hint type nor an output node.
  assert.ok(!cfg.inputs.some((i) => i.nodeId === 8));
  assert.equal(cfg.importedFromFrontend, false);
});

test("heuristicAppMode: object-valued widget entries (link markers) are skipped", () => {
  const nodes = [{ id: 6, type: "CLIPTextEncode", widgets_values: ["ok", { link: 3 }, ["a", "b"]] }];
  const cfg = AppBuilder.heuristicAppMode(nodes);
  assert.equal(cfg.inputs.length, 2); // "ok" (text) + ["a","b"] (combo); link marker dropped
  assert.ok(cfg.inputs.every((i) => i.positional));
});

// ── #428 video-gen family convert ───────────────────────────────────────────

test("heuristicAppMode: an LTX graph exposes Director/ImgToVideo params and a video output", () => {
  const cfg = AppBuilder.heuristicAppMode([
    { id: 6, type: "CLIPTextEncode", widgets_values: ["a cat walks through a forest"] },
    { id: 12, type: "EmptyLTXVLatentVideo", widgets_values: [768, 512, 97, 1] },
    { id: 14, type: "LTXVImgToVideo", widgets_values: [768, 512, 97, 1, 0.6] },
    { id: 20, type: "LTXDirector", widgets_values: ['{"segments":[]}'] },
    { id: 21, type: "LTXVConditioning", widgets_values: [25] },
    { id: 30, type: "SaveVideo", widgets_values: ["ltx"] },
  ]);
  assert.ok(cfg.inputs.some((i) => i.nodeId === 14), "LTXVImgToVideo must be an app input");
  assert.ok(cfg.inputs.some((i) => i.nodeId === 20), "LTXDirector must be an app input");
  assert.ok(cfg.inputs.some((i) => i.nodeId === 21), "LTXVConditioning must be an app input");
  const save = cfg.outputs.find((o) => o.nodeId === 30);
  assert.equal(save?.kind, "video");
  assert.deepEqual(AppBuilder.videoFamiliesOnGraph([
    { type: "LTXDirector" },
    { type: "EmptyLTXVLatentVideo" },
  ]), ["ltx"]);
});

test("heuristicAppMode: a Wan graph exposes sampler/FLF params and VHS_VideoCombine as video", () => {
  const cfg = AppBuilder.heuristicAppMode([
    { id: 1, type: "WanVideoTextEncode", widgets_values: ["walks", "static"] },
    { id: 2, type: "WanVideoSampler", widgets_values: [4, 1, 5] },
    { id: 3, type: "WanFirstLastFrameToVideo", widgets_values: [480, 720, 81] },
    { id: 9, type: "VHS_VideoCombine", widgets_values: [16, "wan"] },
  ]);
  assert.ok(cfg.inputs.some((i) => i.nodeId === 1));
  assert.ok(cfg.inputs.some((i) => i.nodeId === 2));
  assert.ok(cfg.inputs.some((i) => i.nodeId === 3));
  const out = cfg.outputs.find((o) => o.nodeId === 9);
  assert.equal(out?.kind, "video");
  assert.ok(AppBuilder.videoFamiliesOnGraph([{ type: "WanVideoSampler" }]).includes("wan"));
});

test("heuristicAppMode: Bernini r2v, Hunyuan, and Easy-Use Media become video-gen app endpoints", () => {
  const cfg = AppBuilder.heuristicAppMode([
    { id: 5, type: "Bernini r2v", widgets_values: [24, 1.0] },
    { id: 7, type: "HunyuanImageToVideo", widgets_values: [848, 480, 129] },
    { id: 8, type: "easy loadVideo", widgets_values: ["clip.mp4"] },
    { id: 12, type: "easy saveVideo", widgets_values: ["easy"] },
  ]);
  assert.ok(cfg.inputs.some((i) => i.nodeId === 5), "Bernini r2v must be an app input");
  assert.ok(cfg.inputs.some((i) => i.nodeId === 7), "HunyuanImageToVideo must be an app input");
  assert.ok(cfg.inputs.some((i) => i.nodeId === 8 && i.kind === "video"), "easy loadVideo is a video input");
  const save = cfg.outputs.find((o) => o.nodeId === 12);
  assert.equal(save?.kind, "video");
  const families = AppBuilder.videoFamiliesOnGraph([
    { type: "Bernini r2v" },
    { type: "HunyuanImageToVideo" },
    { type: "easy saveVideo" },
  ]);
  assert.deepEqual(families, ["bernini", "hunyuan", "easyuse"]);
});

test("heuristicAppMode: a still-image graph still reports SaveImage as images", () => {
  const cfg = AppBuilder.heuristicAppMode([
    { id: 6, type: "CLIPTextEncode", widgets_values: ["a cat"] },
    { id: 9, type: "SaveImage", widgets_values: ["ComfyUI"] },
  ]);
  assert.equal(cfg.outputs.find((o) => o.nodeId === 9)?.kind, "images");
  assert.deepEqual(AppBuilder.videoFamiliesOnGraph([{ type: "SaveImage" }]), []);
});

// ── widget classification ───────────────────────────────────────────────────

test("classifyWidget", () => {
  assert.equal(AppBuilder.classifyWidget("LoadImage", "image", "x.png"), "image");
  assert.equal(AppBuilder.classifyWidget("CheckpointLoaderSimple", "ckpt_name", "m.safetensors"), "model");
  assert.equal(AppBuilder.classifyWidget("KSampler", "steps", 20), "number");
  assert.equal(AppBuilder.classifyWidget("Foo", "enabled", true), "toggle");
  assert.equal(AppBuilder.classifyWidget("Foo", "sampler", ["euler", "dpm"]), "combo");
  assert.equal(AppBuilder.classifyWidget("CLIPTextEncode", "text", "hello"), "text");
  // seed control: seed/noise_seed names get the dedicated 🎲 widget.
  assert.equal(AppBuilder.classifyWidget("KSampler", "seed", 42), "seed");
  assert.equal(AppBuilder.classifyWidget("KSamplerAdvanced", "noise_seed", 7), "seed");
  // color: an explicit color widget type, or a color-named hex-valued string.
  assert.equal(AppBuilder.classifyWidget("SolidColor", "value", "#ff0000", "color"), "color");
  assert.equal(AppBuilder.classifyWidget("Node", "background_color", "#00ff00"), "color");
  // a plain 6-char string that isn't color-named stays text (no false positive).
  assert.equal(AppBuilder.classifyWidget("Node", "label", "abcdef"), "text");
  // loader still wins over a seed-ish name; positional (nameless) never seeds.
  assert.equal(AppBuilder.classifyWidget("VAELoader", "vae_name", "v.pt"), "model");
  assert.equal(AppBuilder.classifyWidget("KSampler", "", 42), "number");
  // #428: video file loaders are video, not model/text. Model loaders in the
  // Wan wrapper still classify as model (the *Loader rule).
  assert.equal(AppBuilder.classifyWidget("LoadVideo", "video", "clip.mp4"), "video");
  assert.equal(AppBuilder.classifyWidget("VHS_LoadVideo", "video", "a.webm"), "video");
  assert.equal(AppBuilder.classifyWidget("easy loadVideo", "video", "x.mp4"), "video");
  assert.equal(AppBuilder.classifyWidget("WanVideoModelLoader", "model", "wan.safetensors"), "model");
});

test("live convert and run UI drive AppBuilder video-gen helpers, not a copy", () => {
  assert.match(APPS_UI, /AppBuilder\.isInputHint\(/);
  assert.match(APPS_UI, /AppBuilder\.outputKind\(/);
  assert.match(APPS_UI, /AppBuilder\.collectRunMedia\(/);
  assert.match(APPS_UI, /AppBuilder\.isRunVideoRef\(/);
  assert.match(APPS_UI, /video\/\*/);
  assert.equal(APPS_UI.includes("INPUT_HINT_TYPES.has"), false);
});

test("collectRunMedia reads ComfyUI videos[] and isRunVideoRef honours format", () => {
  const media = AppBuilder.collectRunMedia({
    images: [{ filename: "still.png" }],
    gifs: [{ filename: "loop.gif", format: "image/gif" }],
    videos: [{ filename: "clip.mp4", format: "video/h264-mp4" }, { filename: "clip.mp4", format: "video/h264-mp4" }],
  });
  assert.equal(media.length, 3);
  assert.equal(AppBuilder.isRunVideoRef(media.find((r) => r.filename === "clip.mp4")), true);
  assert.equal(AppBuilder.isRunVideoRef(media.find((r) => r.filename === "loop.gif")), false);
  assert.equal(AppBuilder.isRunVideoRef(media.find((r) => r.filename === "still.png")), false);
  assert.deepEqual(AppBuilder.collectRunMedia(null), []);
});

// ── dependency scan ─────────────────────────────────────────────────────────

test("depsFromPrompt: loaders give models, unknown class_types give custom nodes", () => {
  const prompt = {
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux.safetensors" } },
    6: { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    11: { class_type: "SomeCustomThing", inputs: { model: "widget.safetensors" } },
  };
  const deps = AppBuilder.depsFromPrompt(
    prompt,
    new Set(["CLIPTextEncode", "SomeCustomThing", "CheckpointLoaderSimple"]),
  );
  assert.deepEqual(deps.models, [{ name: "flux.safetensors", nodeType: "CheckpointLoaderSimple", widget: "ckpt_name" }]);
  assert.deepEqual(deps.customNodes, []); // both known
  const deps2 = AppBuilder.depsFromPrompt(prompt, new Set(["CLIPTextEncode"]));
  assert.deepEqual(deps2.customNodes.sort(), ["CheckpointLoaderSimple", "SomeCustomThing"]);
});

// ── manifest assembly ───────────────────────────────────────────────────────

test("buildManifest: shape + required fields", () => {
  const m = AppBuilder.buildManifest({ id: "abc", name: "  My App  " });
  assert.equal(m.name, "My App");
  assert.equal(m.version, 1);
  assert.equal(m.hideWorkflow, false);
  assert.deepEqual(m.published, null);
  assert.throws(() => AppBuilder.buildManifest({ id: "abc", name: " " }), /name required/);
  assert.throws(() => AppBuilder.buildManifest({ name: "x" }), /id required/);
});

// ── AppsClient HTTP surface ─────────────────────────────────────────────────

test("AppsClient: routes and error propagation", async () => {
  const calls = [];
  const ok = (data) => ({ ok: true, json: async () => data });
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([url, opts.method || "GET", opts.body ? JSON.parse(opts.body) : null]);
    if (url.endsWith("/apps")) return ok({ apps: [{ id: "a" }] });
    if (url.endsWith("/run")) return ok({ ok: true, prompt_id: "p1" });
    if (url.includes("/bad")) return { ok: false, status: 400, json: async () => ({ error: "nope" }) };
    return ok({ id: "a" });
  };
  const c = new AppsClient();
  assert.deepEqual(await c.list(), [{ id: "a" }]);
  await c.run("a", { "6.text": "hi" });
  await assert.rejects(() => c.get("bad"), /nope/);
  assert.deepEqual(calls[0], ["/comfyui_mcp_panel/apps", "GET", null]);
  assert.deepEqual(calls[1], ["/comfyui_mcp_panel/apps/a/run", "POST", { values: { "6.text": "hi" } }]);
  assert.equal(c.thumbnailUrl("a"), "/comfyui_mcp_panel/apps/a/thumbnail");
});
