// Read-only ComfyUI /view relay for the MCP get_image tool.
//
// This module deliberately accepts only a file reference. It never accepts a
// URL or an origin, and it never paints anything in the panel UI.

export const FETCH_IMAGE_TIMEOUT_MS = 8000;
export const MAX_FETCH_IMAGE_BYTES = 32 * 1024 * 1024;

const SUPPORTED_TYPES = new Set(["input", "output", "temp"]);
const REF_FIELDS = new Set(["filename", "subfolder", "type"]);
// These are bridge transport/routing fields, not fetch_image arguments. The
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

function fetchImageError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidRef(message) {
  return fetchImageError("invalid_input", `fetch_image rejected the file reference: ${message}`);
}

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function hasEncodedPathSyntax(value) {
  return /%(?:2f|2e|5c)/i.test(value);
}

function validateFilename(filename) {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw invalidRef("filename must be a non-empty string");
  }
  if (hasControlCharacter(filename) || hasEncodedPathSyntax(filename)) {
    throw invalidRef("filename contains control or encoded path syntax");
  }
  if (/[\\/]/.test(filename) || filename === "." || filename === "..") {
    throw invalidRef("filename must be a single file name without path separators or traversal");
  }
  if (/[?#:]/.test(filename)) {
    throw invalidRef("filename contains URL or platform path syntax");
  }
}

function validateSubfolder(subfolder) {
  if (subfolder === undefined) return "";
  if (typeof subfolder !== "string") throw invalidRef("subfolder must be a string when provided");
  if (subfolder === "") return "";
  if (
    hasControlCharacter(subfolder) ||
    hasEncodedPathSyntax(subfolder) ||
    subfolder.startsWith("/") ||
    subfolder.endsWith("/") ||
    subfolder.includes("\\") ||
    subfolder.includes("//") ||
    /[?#:]/.test(subfolder)
  ) {
    throw invalidRef("subfolder is not a safe relative folder path");
  }
  const segments = subfolder.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalidRef("subfolder contains empty or traversal segments");
  }
  return subfolder;
}

function validateType(type) {
  const resolved = type === undefined ? "output" : type;
  if (typeof resolved !== "string" || !SUPPORTED_TYPES.has(resolved)) {
    throw invalidRef(`type must be one of ${Array.from(SUPPORTED_TYPES).join(", ")}`);
  }
  return resolved;
}

function validateRefFields(ref, { allowCommandFields = false } = {}) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    throw invalidRef("expected an object");
  }
  for (const key of Object.keys(ref)) {
    if (!REF_FIELDS.has(key) && !(allowCommandFields && COMMAND_FRAME_FIELDS.has(key))) {
      throw invalidRef(`unexpected field "${key}"`);
    }
  }
  if (!hasOwn(ref, "filename")) throw invalidRef("filename is required");
  validateFilename(ref.filename);
  const subfolder = validateSubfolder(hasOwn(ref, "subfolder") ? ref.subfolder : undefined);
  const type = validateType(hasOwn(ref, "type") ? ref.type : undefined);
  return { filename: ref.filename, subfolder, type };
}

/** Validate and normalize the public `{filename, subfolder?, type?}` shape. */
export function validateFetchImageRef(ref) {
  return validateRefFields(ref);
}

function viewPath(ref) {
  const query = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder,
    type: ref.type,
  });
  return `/view?${query.toString()}`;
}

function pageOrigin() {
  const origin = globalThis.location?.origin;
  return typeof origin === "string" && origin && origin !== "null" ? origin : null;
}

function resolveSameOriginUrl(api, path, expectedOrigin = pageOrigin()) {
  if (typeof api?.apiURL !== "function") {
    throw fetchImageError("api_unavailable", "fetch_image requires the panel API URL helper");
  }
  let rawUrl;
  try {
    rawUrl = api.apiURL(path);
  } catch (error) {
    throw fetchImageError("api_unavailable", `fetch_image could not resolve the /view URL: ${error?.message ?? error}`);
  }
  if (typeof rawUrl !== "string" || rawUrl === "") {
    throw fetchImageError("api_unavailable", "fetch_image could not resolve the /view URL");
  }
  try {
    const parsed = new URL(rawUrl, expectedOrigin || "http://comfyui-panel.invalid");
    if (expectedOrigin && parsed.origin !== expectedOrigin) {
      throw fetchImageError("invalid_origin", "fetch_image resolved a non-same-origin /view URL");
    }
    if (!expectedOrigin && parsed.origin !== "http://comfyui-panel.invalid") {
      throw fetchImageError("invalid_origin", "fetch_image cannot verify an absolute /view URL origin");
    }
  } catch (error) {
    if (error?.code) throw error;
    throw fetchImageError("invalid_origin", "fetch_image resolved an invalid /view URL");
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
    throw fetchImageError("invalid_origin", "fetch_image received a response with an invalid URL");
  }
  try {
    const parsed = new URL(rawUrl, expectedOrigin || "http://comfyui-panel.invalid");
    if (
      (!expectedOrigin && parsed.origin !== "http://comfyui-panel.invalid") ||
      (expectedOrigin && parsed.origin !== expectedOrigin)
    ) {
      throw fetchImageError("invalid_origin", "fetch_image received a non-same-origin response URL");
    }
  } catch (error) {
    if (error?.code) throw error;
    throw fetchImageError("invalid_origin", "fetch_image received an invalid response URL");
  }
}

function rejectRedirectResponse(response) {
  const status = Number(response?.status);
  if (
    response?.type === "opaqueredirect" ||
    response?.redirected === true ||
    (Number.isFinite(status) && status >= 300 && status < 400)
  ) {
    throw fetchImageError(
      "redirect_error",
      `fetch_image rejected a redirect response${Number.isFinite(status) ? ` (HTTP ${status})` : ""}`,
      { status: Number.isFinite(status) ? status : null },
    );
  }
}

function mediaMimeType(response) {
  const raw = responseHeader(response, "content-type") || "";
  const mimeType = raw.split(";", 1)[0].trim().toLowerCase();
  if (!/^(?:image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType)) {
    throw fetchImageError(
      "invalid_mime",
      `fetch_image received a non-media MIME type "${mimeType || "unset"}"`,
    );
  }
  return mimeType;
}

function declaredLength(response) {
  const raw = responseHeader(response, "content-length");
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

function timeoutState(timeoutMs) {
  const controller = new AbortController();
  const timeoutError = fetchImageError("timeout", `fetch_image timed out after ${timeoutMs}ms`);
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

async function readResponseBytes(response, maxBytes, timeoutPromise) {
  const length = declaredLength(response);
  if (length !== null && length > maxBytes) {
    throw fetchImageError("too_large", `fetch_image response exceeds the ${maxBytes}-byte limit`, { bytes: length });
  }

  if (typeof response?.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const part = await Promise.race([reader.read(), timeoutPromise]);
        if (part.done) break;
        const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try { void reader.cancel(); } catch { /* best effort */ }
          throw fetchImageError("too_large", `fetch_image response exceeds the ${maxBytes}-byte limit`, { bytes: total });
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* best effort */ }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  if (typeof response?.arrayBuffer !== "function") {
    throw fetchImageError("read_error", "fetch_image response has no readable body");
  }
  // A non-streaming host cannot be allowed to allocate an unbounded body just
  // to discover its size after the fact. Real browser Responses take the
  // streaming branch; this fallback is only safe with a trusted small length.
  if (length === null) {
    throw fetchImageError("read_error", "fetch_image response has no bounded body length");
  }
  const buffer = await Promise.race([response.arrayBuffer(), timeoutPromise]);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > maxBytes) {
    throw fetchImageError("too_large", `fetch_image response exceeds the ${maxBytes}-byte limit`, { bytes: bytes.byteLength });
  }
  return bytes;
}

function bytesToBase64(bytes) {
  if (typeof globalThis.btoa === "function") {
    const parts = [];
    // 0x6000 is divisible by three, so concatenating chunk encodings is safe.
    for (let offset = 0; offset < bytes.length; offset += 0x6000) {
      const chunk = bytes.subarray(offset, Math.min(offset + 0x6000, bytes.length));
      parts.push(globalThis.btoa(String.fromCharCode(...chunk)));
    }
    return parts.join("");
  }
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString("base64");
  throw fetchImageError("encode_error", "fetch_image cannot base64-encode the response");
}

/**
 * Fetch a ComfyUI file reference for MCP get_image.
 *
 * `args` may be the bridge command frame (transport fields are ignored after
 * validation) or a direct file reference in unit tests. The panel API helper
 * remains the preferred transport so its normal base-path and credentials
 * behavior is preserved; the raw fetch fallback is only for minimal hosts.
 */
export async function fetchImageForMcp(
  args,
  {
    api,
    fetchImpl = globalThis.fetch,
    timeoutMs = FETCH_IMAGE_TIMEOUT_MS,
    maxBytes = MAX_FETCH_IMAGE_BYTES,
    expectedOrigin,
  } = {},
) {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    throw fetchImageError("invalid_config", "fetch_image timeout must be positive");
  }
  if (!(maxBytes > 0) || !Number.isFinite(maxBytes)) {
    throw fetchImageError("invalid_config", "fetch_image byte limit must be positive");
  }
  const ref = validateRefFields(args, { allowCommandFields: true });
  const path = viewPath(ref);
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
      if (typeof api?.fetchApi === "function") {
        response = await Promise.race([api.fetchApi(path, request), timeout.timeoutPromise]);
      } else {
        if (typeof fetchImpl !== "function") throw fetchImageError("api_unavailable", "fetch_image has no fetch transport");
        response = await Promise.race([fetchImpl(url, request), timeout.timeoutPromise]);
      }
    } catch (error) {
      if (error === timeout.timeoutError || timeout.controller.signal.aborted) throw timeout.timeoutError;
      if (error?.code) throw error;
      throw fetchImageError("network_error", `fetch_image could not reach /view: ${error?.message ?? error}`);
    }

    validateResponseOrigin(response, origin);
    rejectRedirectResponse(response);
    const status = Number(response?.status);
    const ok = response?.ok === true || (Number.isFinite(status) && status >= 200 && status < 300);
    if (!ok) {
      throw fetchImageError(
        "http_error",
        `fetch_image /view returned HTTP ${Number.isFinite(status) ? status : "unknown"}`,
        { status: Number.isFinite(status) ? status : null },
      );
    }
    const mimeType = mediaMimeType(response);
    const bytes = await readResponseBytes(response, maxBytes, timeout.timeoutPromise);
    return { ok: true, base64: bytesToBase64(bytes), mimeType, bytes: bytes.byteLength };
  } catch (error) {
    if (error === timeout.timeoutError || timeout.controller.signal.aborted) throw timeout.timeoutError;
    throw error?.code ? error : fetchImageError("read_error", `fetch_image failed: ${error?.message ?? error}`);
  } finally {
    timeout.dispose();
  }
}
