import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
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

test("#2283: the three allowed operations use only their fixed same-origin routes", async () => {
  const apiURLCalls = [];
  const fileURLCalls = [];
  const apiCalls = [];
  const rawCalls = [];
  const bodies = {
    history: '{"prompt-1":{"status":{"status_str":"success"}}}',
    system_stats: '{"system":{"os":"windows"},"devices":[]}',
    logs: "ERROR: render failed\n",
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

  assert.deepEqual(apiURLCalls, ["/history", "/system_stats"]);
  assert.deepEqual(fileURLCalls, ["/internal/logs/raw"]);
  assert.deepEqual(apiCalls.map(({ path }) => path), ["/history", "/system_stats"]);
  assert.deepEqual(rawCalls.map(({ url }) => url), ["https://panel.test/comfy/internal/logs/raw"]);
  for (const { init } of [...apiCalls, ...rawCalls]) {
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
  }
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

test("#2283: arbitrary paths, URLs, origins, targets, and operation names are refused before fetch", async () => {
  const invalid = [
    {},
    { operation: "object_info" },
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

test("#2283: the command remains on the authenticated rid executor/reply path", () => {
  const source = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(source, /fetch_comfyui_read\(args = \{\}\)/);
  assert.match(source, /return fetchComfyUIReadForMcp\(args, \{ api \}\)/);
  assert.match(source, /"ui_render", "ui_update", "ui_dismiss", "fetch_image", "fetch_comfyui_read"/);
  assert.match(source, /const isCommandFrame = msg && typeof msg\.rid === "string" && typeof msg\.cmd === "string"/);
  assert.match(source, /const executor = GRAPH_TOOL_EXECUTORS\[msg\.cmd\]/);
  assert.match(source, /reply = \{ rid: msg\.rid, ok: true, result: withViewingWitness\(result\) \}/);
  assert.match(source, /deliverReply\(reply, msg\.cmd, superseded, inFlightMark\)/);
  assert.equal(commandIsCanvasIndependent("fetch_comfyui_read"), true);
  assert.equal(commandIsCanvasTargetless("fetch_comfyui_read"), true);
});
