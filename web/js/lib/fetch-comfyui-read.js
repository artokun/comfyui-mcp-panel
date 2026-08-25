// Fixed-operation ComfyUI read relay for MCP.
//
// This module deliberately accepts an operation name, never a path, URL, origin,
// or target. The panel API helper keeps the request on the connected ComfyUI
// origin and carries the browser's normal credentials.

export const FETCH_COMFYUI_READ_TIMEOUT_MS = 8000;
export const MAX_FETCH_COMFYUI_READ_BYTES = 16 * 1024 * 1024;

const READ_OPERATIONS = new Map([
  ["history", "/history"],
  ["system_stats", "/system_stats"],
  ["logs", "/internal/logs"],
]);
const LOGS_TRANSPORT_PATH = "/internal/logs/raw";

// These are bridge transport/routing fields, not read arguments. The
// dispatcher may stamp them onto every command frame before it reaches us.
const COMMAND_FRAME_FIELDS = new Set([
  "cmd",
  "rid",
  "retry_of",
  "timeout_ms",
  "epoch",
  "workflow_uuid",
  "workflow_path",
]);

function readError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidInput(message) {
  return readError(
    "invalid_input",
    `fetch_comfyui_read rejected the operation: ${message}`,
  );
}

/** Validate and normalize the public `{operation}` shape. */
export function validateFetchComfyUIReadArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw invalidInput("expected an object");
  }
  for (const key of Object.keys(args)) {
    if (key !== "operation" && !COMMAND_FRAME_FIELDS.has(key)) {
      throw invalidInput(`unexpected field "${key}"`);
    }
  }
  if (!hasOwn(args, "operation")) {
    throw invalidInput("operation is required");
  }
  if (typeof args.operation !== "string" || !READ_OPERATIONS.has(args.operation)) {
    throw invalidInput("operation must be one of history, system_stats, logs");
  }
  return { operation: args.operation, path: READ_OPERATIONS.get(args.operation) };
}

function pageOrigin() {
  const origin = globalThis.location?.origin;
  return typeof origin === "string" && origin && origin !== "null" ? origin : null;
}

function resolveSameOriginUrl(api, path, expectedOrigin = pageOrigin()) {
  const useFileUrl = path === "/internal/logs";
  const resolverName = useFileUrl ? "fileURL" : "apiURL";
  const resolver = api?.[resolverName];
  if (typeof resolver !== "function") {
    throw readError(
      "api_unavailable",
      `fetch_comfyui_read requires the panel ${resolverName} helper`,
    );
  }
  const transportPath = useFileUrl ? LOGS_TRANSPORT_PATH : path;
  let rawUrl;
  try {
    rawUrl = resolver(transportPath);
  } catch (error) {
    throw readError(
      "api_unavailable",
      `fetch_comfyui_read could not resolve ${transportPath}: ${error?.message ?? error}`,
    );
  }
  if (typeof rawUrl !== "string" || rawUrl === "") {
    throw readError("api_unavailable", "fetch_comfyui_read could not resolve the fixed read URL");
  }
  try {
    const parsed = new URL(rawUrl, expectedOrigin || "http://comfyui-panel.invalid");
    if (expectedOrigin && parsed.origin !== expectedOrigin) {
      throw readError("invalid_origin", "fetch_comfyui_read resolved a non-same-origin URL");
    }
    if (!expectedOrigin && parsed.origin !== "http://comfyui-panel.invalid") {
      throw readError("invalid_origin", "fetch_comfyui_read cannot verify an absolute URL origin");
    }
  } catch (error) {
    if (error?.code) throw error;
    throw readError("invalid_origin", "fetch_comfyui_read resolved an invalid URL");
  }
  return rawUrl;
}

function responseHeader(response, name) {
  try {
    return typeof response?.headers?.get === "function" ? response.headers.get(name) : null;
  } catch {
    return null;
  }
}

function validateResponseOrigin(response, expectedOrigin) {
  const rawUrl = response?.url;
  if (rawUrl == null || rawUrl === "") return;
  if (typeof rawUrl !== "string") {
    throw readError("invalid_origin", "fetch_comfyui_read received a response with an invalid URL");
  }
  try {
    const parsed = new URL(rawUrl, expectedOrigin || "http://comfyui-panel.invalid");
    if (
      (!expectedOrigin && parsed.origin !== "http://comfyui-panel.invalid") ||
      (expectedOrigin && parsed.origin !== expectedOrigin)
    ) {
      throw readError("invalid_origin", "fetch_comfyui_read received a non-same-origin response URL");
    }
  } catch (error) {
    if (error?.code) throw error;
    throw readError("invalid_origin", "fetch_comfyui_read received an invalid response URL");
  }
}

function rejectRedirectResponse(response) {
  const status = Number(response?.status);
  if (
    response?.type === "opaqueredirect" ||
    response?.redirected === true ||
    (Number.isFinite(status) && status >= 300 && status < 400)
  ) {
    throw readError(
      "redirect_error",
      `fetch_comfyui_read rejected a redirect response${Number.isFinite(status) ? ` (HTTP ${status})` : ""}`,
      { status: Number.isFinite(status) ? status : null },
    );
  }
}

function declaredLength(response) {
  const raw = responseHeader(response, "content-length");
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

function timeoutState(timeoutMs) {
  const controller = new AbortController();
  const timeoutError = readError("timeout", `fetch_comfyui_read timed out after ${timeoutMs}ms`);
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(timeoutError);
  }, timeoutMs);
  return {
    controller,
    timeoutPromise,
    timeoutError,
    dispose: () => clearTimeout(timer),
  };
}

async function readResponseText(response, maxBytes, timeoutPromise) {
  const length = declaredLength(response);
  if (length !== null && length > maxBytes) {
    throw readError(
      "too_large",
      `fetch_comfyui_read response exceeds the ${maxBytes}-byte limit`,
      { bytes: length },
    );
  }

  if (typeof response?.body?.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let total = 0;
    try {
      while (true) {
        const part = await Promise.race([reader.read(), timeoutPromise]);
        if (part.done) break;
        const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try { void reader.cancel(); } catch { /* best effort */ }
          throw readError(
            "too_large",
            `fetch_comfyui_read response exceeds the ${maxBytes}-byte limit`,
            { bytes: total },
          );
        }
        parts.push(decoder.decode(chunk, { stream: true }));
      }
      parts.push(decoder.decode());
    } finally {
      try { reader.releaseLock?.(); } catch { /* best effort */ }
    }
    return { text: parts.join(""), bytes: total };
  }

  if (typeof response?.text !== "function") {
    throw readError("read_error", "fetch_comfyui_read response has no readable body");
  }
  if (length === null) {
    throw readError("read_error", "fetch_comfyui_read response has no bounded body length");
  }
  const text = await Promise.race([response.text(), timeoutPromise]);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    throw readError(
      "too_large",
      `fetch_comfyui_read response exceeds the ${maxBytes}-byte limit`,
      { bytes },
    );
  }
  return { text, bytes };
}

/** Fetch one fixed ComfyUI read for the MCP fallback path. */
export async function fetchComfyUIReadForMcp(
  args,
  {
    api,
    fetchImpl = globalThis.fetch,
    timeoutMs = FETCH_COMFYUI_READ_TIMEOUT_MS,
    maxBytes = MAX_FETCH_COMFYUI_READ_BYTES,
    expectedOrigin,
  } = {},
) {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    throw readError("invalid_config", "fetch_comfyui_read timeout must be positive");
  }
  if (!(maxBytes > 0) || !Number.isFinite(maxBytes)) {
    throw readError("invalid_config", "fetch_comfyui_read byte limit must be positive");
  }
  const { operation, path } = validateFetchComfyUIReadArgs(args);
  const origin = expectedOrigin ?? pageOrigin();
  const url = resolveSameOriginUrl(api, path, origin);
  const timeout = timeoutState(timeoutMs);
  const request = {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    redirect: "manual",
    signal: timeout.controller.signal,
  };
  try {
    let response;
    try {
      // ComfyUI's internal logs route is not under the API wrapper's /api
      // namespace. Keep history/system_stats on fetchApi (which preserves the
      // frontend's base-path behavior), but send logs through the already
      // origin-validated absolute URL.
      if (operation !== "logs" && typeof api?.fetchApi === "function") {
        response = await Promise.race([api.fetchApi(path, request), timeout.timeoutPromise]);
      } else {
        if (typeof fetchImpl !== "function") {
          throw readError("api_unavailable", "fetch_comfyui_read has no fetch transport");
        }
        response = await Promise.race([fetchImpl(url, request), timeout.timeoutPromise]);
      }
    } catch (error) {
      if (error === timeout.timeoutError || timeout.controller.signal.aborted) throw timeout.timeoutError;
      if (error?.code) throw error;
      throw readError("network_error", `fetch_comfyui_read could not reach ${path}: ${error?.message ?? error}`);
    }

    validateResponseOrigin(response, origin);
    rejectRedirectResponse(response);
    const status = Number(response?.status);
    const ok = response?.ok === true || (Number.isFinite(status) && status >= 200 && status < 300);
    if (!ok) {
      throw readError(
        "http_error",
        `fetch_comfyui_read ${path} returned HTTP ${Number.isFinite(status) ? status : "unknown"}`,
        { status: Number.isFinite(status) ? status : null },
      );
    }
    const body = await readResponseText(response, maxBytes, timeout.timeoutPromise);
    return {
      operation,
      body: body.text,
      contentType: responseHeader(response, "content-type"),
      bytes: body.bytes,
    };
  } catch (error) {
    if (error === timeout.timeoutError || timeout.controller.signal.aborted) throw timeout.timeoutError;
    throw error?.code
      ? error
      : readError("read_error", `fetch_comfyui_read failed: ${error?.message ?? error}`);
  } finally {
    timeout.dispose();
  }
}
