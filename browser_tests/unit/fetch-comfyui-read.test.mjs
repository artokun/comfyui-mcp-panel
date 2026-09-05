import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FETCH_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS,
  MAX_FETCH_COMFYUI_READ_OBJECT_INFO_BYTES,
  dispatchFetchComfyUIReadForMcp,
  fetchComfyUIReadForMcp,
  validateFetchComfyUIReadArgs,
} from "../../web/js/lib/fetch-comfyui-read.js";
import {
  commandIsCanvasIndependent,
  commandIsCanvasTargetless,
} from "../../web/js/lib/workflow-chat-identity.js";

function response({
  status = 200,
  body = "{}",
  contentType = "application/json",
  contentLength,
  url,
  type,
  redirected = false,
  stream = true,
} = {}) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    ...(url === undefined ? {} : { url }),
    ...(type === undefined ? {} : { type }),
    redirected,
    headers: {
      get(name) {
        const key = name.toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return contentLength == null ? null : String(contentLength);
        return null;
      },
    },
    ...(stream
      ? {
          body: {
            getReader() {
              return {
                async read() {
                  if (offset >= bytes.byteLength) return { done: true, value: undefined };
                  const chunk = bytes.subarray(offset, offset + 3);
                  offset += chunk.byteLength;
                  return { done: false, value: chunk };
                },
                cancel() {},
                releaseLock() {},
              };
            },
          },
        }
      : {
          body: null,
          async text() {
            return body;
          },
        }),
  };
}

async function rejection(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("#2196/#2283: the allowed operations use only their fixed same-origin routes", async () => {
  const apiURLCalls = [];
  const fileURLCalls = [];
  const apiCalls = [];
  const rawCalls = [];
  const bodies = {
    history: '{"prompt-1":{"status":{"status_str":"success"}}}',
    system_stats: '{"system":{"os":"windows"},"devices":[]}',
    logs: "ERROR: render failed\n",
    object_info: '{"KSampler":{"input":{"required":{}}}}',
    workflow_templates: '{"templates":[]}',
  };
  for (const operation of Object.keys(bodies)) {
    const result = await fetchComfyUIReadForMcp(
      { operation, workflow_uuid: "stamped-by-bridge", workflow_path: "ignored-by-targetless-read" },
      {
        expectedOrigin: "https://panel.test",
        api: {
          apiURL: (path) => {
            apiURLCalls.push(path);
            return `https://panel.test/comfy/api${path}`;
          },
          fileURL: (path) => {
            fileURLCalls.push(path);
            return `https://panel.test/comfy${path}`;
          },
          fetchApi: async (path, init) => {
            apiCalls.push({ path, init });
            return response({ body: bodies[operation] });
          },
        },
        fetchImpl: async (url, init) => {
          rawCalls.push({ url, init });
          return response({ body: bodies[operation], url });
        },
      },
    );

    assert.deepEqual(result, {
      operation,
      body: bodies[operation],
      contentType: "application/json",
      bytes: new TextEncoder().encode(bodies[operation]).byteLength,
    });
  }

  assert.deepEqual(apiURLCalls, ["/history", "/system_stats", "/object_info", "/workflow_templates"]);
  assert.deepEqual(fileURLCalls, ["/internal/logs/raw"]);
  assert.deepEqual(apiCalls.map(({ path }) => path), ["/history", "/system_stats", "/object_info", "/workflow_templates"]);
  assert.deepEqual(rawCalls.map(({ url }) => url), ["https://panel.test/comfy/internal/logs/raw"]);
  for (const { init } of [...apiCalls, ...rawCalls]) {
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("#2228: apiURL and fileURL keep the Comfy API object as this when they read this.api_base", async () => {
  function apiURL(path) {
    return `${this.api_base}${path}`;
  }
  function fileURL(path) {
    return `${this.api_base}${path}`;
  }
  const api = {
    api_base: "https://panel.test/comfy/api",
    apiURL,
    fileURL,
    fetchApi: async () => response({ body: '{"prompt-1":{"status":{"status_str":"success"}}}' }),
  };

  const history = await fetchComfyUIReadForMcp(
    { operation: "history" },
    { expectedOrigin: "https://panel.test", api },
  );
  assert.equal(history.operation, "history");
  assert.equal(history.body, '{"prompt-1":{"status":{"status_str":"success"}}}');

  const logs = await fetchComfyUIReadForMcp(
    { operation: "logs" },
    {
      expectedOrigin: "https://panel.test",
      api: { ...api, api_base: "https://panel.test/comfy" },
      fetchImpl: async (url) => {
        assert.equal(url, "https://panel.test/comfy/internal/logs/raw");
        return response({ body: "ERROR: render failed\n", url });
      },
    },
  );
  assert.equal(logs.operation, "logs");
  assert.equal(logs.body, "ERROR: render failed\n");

  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "system_stats" },
      {
        expectedOrigin: "https://panel.test",
        api: {
          api_base: "https://evil.test/api",
          apiURL,
          fetchApi: async () => { throw new Error("must not fetch"); },
        },
        fetchImpl: async () => { throw new Error("must not fetch"); },
      },
    ),
    "invalid_origin",
  );
});

test("#2283: logs raw transport retains origin, redirect, and body-size fences", async () => {
  const options = {
    expectedOrigin: "https://panel.test",
    api: {
      apiURL: () => { throw new Error("logs must not use apiURL"); },
      fileURL: (path) => `https://panel.test/comfy${path}`,
      fetchApi: async () => { throw new Error("logs must not use fetchApi"); },
    },
  };

  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "logs" },
      { ...options, fetchImpl: async (url) => response({ url: "https://evil.test/internal/logs" }) },
    ),
    "invalid_origin",
  );
  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "logs" },
      { ...options, fetchImpl: async (url) => response({ status: 302, url, stream: false }) },
    ),
    "redirect_error",
  );
  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "logs" },
      { ...options, maxBytes: 4, fetchImpl: async (url) => response({ body: "12345", url }) },
    ),
    "too_large",
  );
});

test("#2511: models inventory operations use only their fixed same-origin /models routes", async () => {
  const apiURLCalls = [];
  const apiCalls = [];
  const bodies = {
    models: '["checkpoints","loras","diffusion_models"]',
    "models/checkpoints": '["remote-ckpt.safetensors"]',
    "models/loras": '["remote-lora.safetensors"]',
    "models/diffusion_models": '["remote-unet.safetensors"]',
  };
  for (const operation of Object.keys(bodies)) {
    const result = await fetchComfyUIReadForMcp(
      { operation },
      {
        expectedOrigin: "https://panel.test",
        api: {
          apiURL: (path) => {
            apiURLCalls.push(path);
            return `https://panel.test/comfy/api${path}`;
          },
          fileURL: () => { throw new Error("models must not use fileURL"); },
          fetchApi: async (path, init) => {
            apiCalls.push({ path, init });
            return response({ body: bodies[operation] });
          },
        },
        fetchImpl: async () => { throw new Error("models must not use raw fetch"); },
      },
    );
    assert.deepEqual(result, {
      operation,
      body: bodies[operation],
      contentType: "application/json",
      bytes: new TextEncoder().encode(bodies[operation]).byteLength,
    });
  }
  assert.deepEqual(apiURLCalls, ["/models", "/models/checkpoints", "/models/loras", "/models/diffusion_models"]);
  assert.deepEqual(apiCalls.map(({ path }) => path), ["/models", "/models/checkpoints", "/models/loras", "/models/diffusion_models"]);
  for (const { init } of apiCalls) {
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "manual");
  }
});

test("#2283: arbitrary paths, URLs, origins, targets, and operation names are refused before fetch", async () => {
  const invalid = [
    {},
    { operation: "unknown" },
    { operation: "models/" },
    { operation: "models/../object_info" },
    { operation: "models/foo/bar" },
    { operation: "models/checkpoints?q=1" },
    { operation: "object_info", path: "/admin" },
    { operation: "history", path: "/admin" },
    { operation: "history", url: "https://evil.test" },
    { operation: "history", origin: "https://evil.test" },
    { operation: "history", target: "other-tab" },
    { operation: "history", method: "POST" },
  ];
  for (const args of invalid) {
    assert.throws(() => validateFetchComfyUIReadArgs(args), { code: "invalid_input" }, JSON.stringify(args));
    await rejection(
      fetchComfyUIReadForMcp(args, {
        expectedOrigin: "https://panel.test",
        api: { apiURL: (path) => path },
        fetchImpl: async () => { throw new Error("must not fetch"); },
      }),
      "invalid_input",
    );
  }
});

test("#2283: the resolved and final response origins stay fenced", async () => {
  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "history" },
      {
        expectedOrigin: "https://panel.test",
        api: { apiURL: () => "https://evil.test/history" },
        fetchImpl: async () => { throw new Error("must not fetch"); },
      },
    ),
    "invalid_origin",
  );

  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "system_stats" },
      {
        expectedOrigin: "https://panel.test",
        api: { apiURL: (path) => path },
        fetchImpl: async (url) => response({ url: "https://evil.test/system_stats" }),
      },
    ),
    "invalid_origin",
  );
});

test("#2283: redirects and oversized bodies are refused", async () => {
  const options = {
    expectedOrigin: "https://panel.test",
    api: {
      apiURL: (path) => path,
      fileURL: (path) => `https://panel.test${path}`,
    },
  };
  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "logs" },
      { ...options, fetchImpl: async () => response({ status: 302, url: "https://panel.test/login", stream: false }) },
    ),
    "redirect_error",
  );
  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "history" },
      { ...options, maxBytes: 4, fetchImpl: async () => response({ body: "12345" }) },
    ),
    "too_large",
  );
});

test("#2283: object_info uses its documented large/slow route budget while other reads stay bounded", async () => {
  assert.ok(MAX_FETCH_COMFYUI_READ_OBJECT_INFO_BYTES > 25_104_088);
  assert.ok(FETCH_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS > 20_840);
  const body = JSON.stringify({
    KSampler: {
      input: { required: {} },
      output: ["MODEL"],
      output_is_list: [false],
      output_name: ["model"],
      name: "KSampler",
      display_name: "KSampler",
      description: "x".repeat(25_104_088),
      category: "sampling",
      output_node: false,
    },
  });
  assert.ok(body.length > 25_104_088);
  const result = await fetchComfyUIReadForMcp(
    { operation: "object_info" },
    {
      expectedOrigin: "https://panel.test",
      api: {
        apiURL: (path) => path,
        fetchApi: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20_841));
          return response({ body, contentLength: body.length, stream: false });
        },
      },
    },
  );
  assert.equal(result.operation, "object_info");
  assert.equal(result.bytes, body.length);

  await rejection(
    fetchComfyUIReadForMcp(
      { operation: "history" },
      {
        expectedOrigin: "https://panel.test",
        api: {
          apiURL: (path) => path,
          fetchApi: async () => response({ body, contentLength: body.length, stream: false }),
        },
      },
    ),
    "too_large",
  );
});

test("#2283: the production dispatcher and helper carry a >20.84s, >25MB object_info reply", async () => {
  const productionDelayMs = 20_841;
  const body = JSON.stringify({
    KSampler: {
      input: { required: {} },
      output: ["MODEL"],
      output_is_list: [false],
      output_name: ["model"],
      name: "KSampler",
      display_name: "KSampler",
      description: "x".repeat(25_104_088),
      category: "sampling",
      output_node: false,
    },
  });
  assert.ok(body.length > 25_104_088);
  assert.ok(MAX_FETCH_COMFYUI_READ_OBJECT_INFO_BYTES >= body.length);
  assert.ok(FETCH_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS > 20_840);

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let seenRequest;
    const pending = dispatchFetchComfyUIReadForMcp(
      { operation: "object_info", rid: "rid-production-shaped" },
      {
        api: {
          apiURL: (path) => path,
          fetchApi: async (_path, init) => {
            seenRequest = init;
            await new Promise((resolve, reject) => {
              let settled = false;
              let producerTimer;
              let onAbort;
              const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(producerTimer);
                init.signal.removeEventListener("abort", onAbort);
                if (error) reject(error);
                else resolve();
              };
              onAbort = () => finish(Object.assign(new Error("producer aborted"), { name: "AbortError" }));
              producerTimer = setTimeout(() => finish(), productionDelayMs);
              init.signal.addEventListener("abort", onAbort, { once: true });
              if (init.signal.aborted) onAbort();
            });
            return response({ body, contentLength: body.length, stream: false });
          },
        },
      },
    );
    mock.timers.tick(productionDelayMs);
    const result = await pending;
    assert.equal(result.operation, "object_info");
    assert.equal(result.bytes, new TextEncoder().encode(body).byteLength);
    assert.ok(seenRequest.signal instanceof AbortSignal);
  } finally {
    mock.timers.reset();
  }
});

test("#2283: object_info still refuses an oversize body and a timeout", async () => {
  const oversize = "x".repeat(MAX_FETCH_COMFYUI_READ_OBJECT_INFO_BYTES + 1);
  await rejection(
    dispatchFetchComfyUIReadForMcp(
      { operation: "object_info" },
      {
        expectedOrigin: "https://panel.test",
        api: {
          apiURL: (path) => path,
          fetchApi: async () => response({ body: oversize, contentLength: oversize.length, stream: false }),
        },
      },
    ),
    "too_large",
  );

  await rejection(
    dispatchFetchComfyUIReadForMcp(
      { operation: "object_info" },
      {
        timeoutMs: 5,
        expectedOrigin: "https://panel.test",
        api: {
          apiURL: (path) => path,
          fetchApi: () => new Promise((resolve) => setTimeout(() => resolve(response()), 25)),
        },
      },
    ),
    "timeout",
  );
});

test("#2283: the command remains on the authenticated rid executor/reply path", () => {
  const source = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(source, /fetch_comfyui_read\(args = \{\}\)/);
  assert.match(source, /return dispatchFetchComfyUIReadForMcp\(args, \{ api \}\)/);
  assert.match(source, /"ui_render", "ui_update", "ui_dismiss", "fetch_image", "fetch_comfyui_read"/);
  assert.match(source, /const isCommandFrame = msg && typeof msg\.rid === "string" && typeof msg\.cmd === "string"/);
  assert.match(source, /const executor = GRAPH_TOOL_EXECUTORS\[msg\.cmd\]/);
  assert.match(source, /reply = \{ rid: msg\.rid, ok: true, result: withViewingWitness\(result\) \}/);
  assert.match(source, /deliverReply\(reply, msg\.cmd, superseded, inFlightMark\)/);
  assert.equal(commandIsCanvasIndependent("fetch_comfyui_read"), true);
  assert.equal(commandIsCanvasTargetless("fetch_comfyui_read"), true);
});
