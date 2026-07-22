// Unit tests for the Micro-Apps service (web/js/cmcp-apps.js): APP-mode
// config import (defensive key probing), heuristic input/output selection,
// widget classification, dependency scanning, manifest assembly, and the
// AppsClient HTTP surface (mocked fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppBuilder, AppsClient } from "../../web/js/cmcp-apps.js";

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

// ── widget classification ───────────────────────────────────────────────────

test("classifyWidget", () => {
  assert.equal(AppBuilder.classifyWidget("LoadImage", "image", "x.png"), "image");
  assert.equal(AppBuilder.classifyWidget("CheckpointLoaderSimple", "ckpt_name", "m.safetensors"), "model");
  assert.equal(AppBuilder.classifyWidget("KSampler", "steps", 20), "number");
  assert.equal(AppBuilder.classifyWidget("Foo", "enabled", true), "toggle");
  assert.equal(AppBuilder.classifyWidget("Foo", "sampler", ["euler", "dpm"]), "combo");
  assert.equal(AppBuilder.classifyWidget("CLIPTextEncode", "text", "hello"), "text");
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
