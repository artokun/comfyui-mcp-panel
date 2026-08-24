import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchImageForMcp, validateFetchImageRef } from "../../web/js/lib/fetch-image.js";
import { commandIsCanvasIndependent, commandIsCanvasTargetless } from "../../web/js/lib/workflow-chat-identity.js";

function response({
  status = 200,
  mime = "image/png",
  bytes = [],
  contentLength,
  body = true,
  url,
  type,
  redirected = false,
} = {}) {
  const data = Uint8Array.from(bytes);
  let consumed = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    ...(url === undefined ? {} : { url }),
    ...(type === undefined ? {} : { type }),
    redirected,
    headers: {
      get(name) {
        const key = name.toLowerCase();
        if (key === "content-type") return mime;
        if (key === "content-length") return contentLength == null ? null : String(contentLength);
        return null;
      },
    },
    body: body
      ? {
          getReader() {
            return {
              async read() {
                if (consumed) return { done: true, value: undefined };
                consumed = true;
                return { done: false, value: data };
              },
              cancel() {},
              releaseLock() {},
            };
          },
        }
      : null,
  };
}

async function rejection(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("#2149: valid refs use the API/base-path URL and return bounded media bytes", async () => {
  const calls = [];
  const result = await fetchImageForMcp(
    { filename: "cat.png", subfolder: "renders", type: "output" },
    {
      api: { apiURL: (path) => `/comfy${path}` },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response({ bytes: [0, 1, 2, 255] });
      },
    },
  );

  assert.deepEqual(result, { ok: true, base64: "AAEC/w==", mimeType: "image/png", bytes: 4 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/comfy/view?filename=cat.png&subfolder=renders&type=output");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("#2149: the normal panel API helper receives the same relative route and credentials", async () => {
  const calls = [];
  const result = await fetchImageForMcp(
    { filename: "cat.png" },
    {
      api: {
        apiURL: (path) => `/base${path}`,
        fetchApi: async (path, init) => {
          calls.push({ path, init });
          return response({ bytes: [137, 80, 78, 71] });
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls[0].path, "/view?filename=cat.png&subfolder=&type=output");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.redirect, "manual");
});

test("#2149: file refs reject separators, traversal, invalid subfolders, types, URLs, and extra fields", async () => {
  const invalidRefs = [
    { filename: 7 },
    { filename: "   " },
    { filename: "nested/cat.png" },
    { filename: "nested\\cat.png" },
    { filename: ".." },
    { filename: "cat.png", subfolder: 7 },
    { filename: "cat.png", subfolder: "../outside" },
    { filename: "cat.png", subfolder: "nested\\child" },
    { filename: "cat.png", subfolder: "/absolute" },
    { filename: "cat.png", subfolder: "http://evil.test" },
    { filename: "cat.png", type: "models" },
    { filename: "https://evil.test/cat.png" },
    { filename: "cat.png", url: "https://evil.test" },
    { filename: "cat.png", origin: "https://evil.test" },
    { filename: "cat.png", target: "other-tab" },
  ];

  for (const ref of invalidRefs) {
    assert.throws(() => validateFetchImageRef(ref), { code: "invalid_input" }, JSON.stringify(ref));
    await rejection(
      fetchImageForMcp(ref, {
        api: { apiURL: (path) => path },
        fetchImpl: async () => { throw new Error("must not fetch"); },
      }),
      "invalid_input",
    );
  }
});

test("#2149: an absolute API URL must remain same-origin", async () => {
  await rejection(
    fetchImageForMcp(
      { filename: "cat.png" },
      {
        api: { apiURL: () => "https://evil.test/view?filename=cat.png" },
        expectedOrigin: "https://panel.test",
        fetchImpl: async () => { throw new Error("must not fetch"); },
      },
    ),
    "invalid_origin",
  );
});

test("#2149: HTTP failures preserve status classification", async () => {
  let error;
  try {
    await fetchImageForMcp(
      { filename: "missing.png" },
      {
        api: { apiURL: (path) => path },
        fetchImpl: async () => response({ status: 404, mime: "text/html", body: false }),
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, "http_error");
  assert.equal(error?.status, 404);
  assert.match(error?.message ?? "", /HTTP 404/);
});

test("#2149: redirects and cross-origin final response URLs are typed refusals", async () => {
  const options = {
    api: { apiURL: (path) => path },
    expectedOrigin: "https://panel.test",
  };

  await rejection(
    fetchImageForMcp(
      { filename: "redirect.png" },
      { ...options, fetchImpl: async () => response({ status: 302, url: "https://panel.test/login", body: false }) },
    ),
    "redirect_error",
  );
  await rejection(
    fetchImageForMcp(
      { filename: "opaque-redirect.png" },
      { ...options, fetchImpl: async () => response({ status: 0, type: "opaqueredirect", body: false }) },
    ),
    "redirect_error",
  );
  await rejection(
    fetchImageForMcp(
      { filename: "cross-origin.png" },
      { ...options, fetchImpl: async () => response({ url: "https://evil.test/image.png", bytes: [1] }) },
    ),
    "invalid_origin",
  );
});

test("#2149: a same-origin final response URL remains valid", async () => {
  const result = await fetchImageForMcp(
    { filename: "same-origin.png" },
    {
      api: { apiURL: (path) => `https://panel.test/base${path}` },
      expectedOrigin: "https://panel.test",
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, "manual");
        return response({ url, bytes: [1, 2, 3] });
      },
    },
  );
  assert.equal(result.bytes, 3);
});

test("#2149: non-media MIME types are refused", async () => {
  await rejection(
    fetchImageForMcp(
      { filename: "not-an-image.txt" },
      {
        api: { apiURL: (path) => path },
        fetchImpl: async () => response({ mime: "text/plain", bytes: [1] }),
      },
    ),
    "invalid_mime",
  );
});

test("#2149: Content-Length and streamed bytes cannot exceed the configured cap", async () => {
  await rejection(
    fetchImageForMcp(
      { filename: "large.png" },
      {
        api: { apiURL: (path) => path },
        maxBytes: 4,
        fetchImpl: async () => response({ contentLength: 5, bytes: [1, 2, 3, 4, 5] }),
      },
    ),
    "too_large",
  );

  await rejection(
    fetchImageForMcp(
      { filename: "chunked.png" },
      {
        api: { apiURL: (path) => path },
        maxBytes: 4,
        fetchImpl: async () => response({ bytes: [1, 2, 3, 4, 5] }),
      },
    ),
    "too_large",
  );
});

test("#2149: the fetch and body read have an abort timeout", async () => {
  let signal;
  await rejection(
    fetchImageForMcp(
      { filename: "hung.png" },
      {
        api: { apiURL: (path) => path },
        timeoutMs: 10,
        fetchImpl: async (_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        },
      },
    ),
    "timeout",
  );
  assert.equal(signal?.aborted, true);
});

test("#2149: fetch_image is wired as a canvas-independent dispatcher command", () => {
  const source = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(source, /fetch_image\(args = \{\}\)/);
  assert.match(source, /return fetchImageForMcp\(args, \{ api \}\)/);
  assert.match(source, /"ui_render", "ui_update", "fetch_image"/);
  assert.equal(commandIsCanvasIndependent("fetch_image"), true);
  assert.equal(commandIsCanvasTargetless("fetch_image"), true);
});
