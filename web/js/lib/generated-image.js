// Codex built-in image generation lands as a generatedImage / imageGeneration
// item with a base64 `result`. The chat renderer used to keep only the text
// half of that payload, so a successful generate never became a media card.

const IMAGE_ITEM_TYPES = new Set([
  "generatedimage",
  "imagegeneration",
  "image_generation",
  "image_generation_call",
]);

const COMPLETE_STATUSES = new Set(["", "completed", "complete", "success", "done"]);
const PNG_MAGIC = "iVBORw0KGgo";
const JPEG_MAGIC = "/9j/";
const GIF_MAGIC = "R0lGOD";
const WEBP_MAGIC = "UklGR";
const MIN_BASE64_CHARS = 32;
const WALK_DEPTH = 4;

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function asNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function typeKey(value) {
  const raw = asNonEmptyString(value);
  return raw ? raw.replace(/[-]/g, "_").toLowerCase() : "";
}

function isImageItemType(value) {
  return IMAGE_ITEM_TYPES.has(typeKey(value));
}

function statusAllowsPaint(status) {
  if (status == null) return true;
  if (typeof status !== "string") return false;
  return COMPLETE_STATUSES.has(status.trim().toLowerCase());
}

function mimeFromBase64(body) {
  if (body.startsWith(PNG_MAGIC)) return "image/png";
  if (body.startsWith(JPEG_MAGIC)) return "image/jpeg";
  if (body.startsWith(GIF_MAGIC)) return "image/gif";
  if (body.startsWith(WEBP_MAGIC)) return "image/webp";
  return "image/png";
}

function compactBase64(value) {
  return value.replace(/[\t\n\f\r ]/g, "");
}

/** A data:image URL the chat <img> can load, or null when `result` is not image bytes. */
export function generatedImageDataUrl(result) {
  const raw = asNonEmptyString(result);
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  const body = compactBase64(raw);
  if (body.length < MIN_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  return `data:${mimeFromBase64(body)};base64,${body}`;
}

function basenameOf(path) {
  const raw = asNonEmptyString(path);
  if (!raw) return "";
  const parts = raw.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "";
}

function captionOf(record) {
  const named = asNonEmptyString(record.filename) || asNonEmptyString(record.caption);
  if (named) return named;
  return basenameOf(record.savedPath) || basenameOf(record.saved_path);
}

function generatedField(record) {
  return record.generatedImage;
}

function resultBytes(record) {
  const direct = generatedImageDataUrl(record.result);
  if (direct) return direct;
  const generated = generatedField(record);
  const fromString = generatedImageDataUrl(typeof generated === "string" ? generated : null);
  if (fromString) return fromString;
  const nested = asRecord(generated);
  if (nested) {
    const fromNested = generatedImageDataUrl(nested.result);
    if (fromNested) return fromNested;
  }
  return generatedImageDataUrl(record.b64_json);
}

function mediaItemFrom(record) {
  if (!record) return null;
  if (!statusAllowsPaint(record.status)) return null;
  const dataUrl = resultBytes(record);
  if (!dataUrl) return null;
  const typed = isImageItemType(record.type) || isImageItemType(record.kind);
  const generated = generatedField(record);
  const wrapped = asRecord(generated);
  const hasGeneratedField = generated != null;
  if (!typed && !wrapped && !hasGeneratedField && !isImageItemType(record.name)) return null;
  const filename = captionOf(record) || (wrapped ? captionOf(wrapped) : "") || "generated.png";
  return {
    kind: "image",
    dataUrl,
    filename,
    caption: filename,
  };
}

function isImagePart(part) {
  return isGeneratedImagePayload(part) || mediaItemFrom(asRecord(part)) != null;
}

function walk(value, out, depth, seen) {
  if (depth > WALK_DEPTH || value == null) return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, out, depth + 1, seen);
    return;
  }

  const item = mediaItemFrom(value);
  if (item) out.push(item);

  const nested = asRecord(value.generatedImage);
  if (nested) {
    const wrapped = mediaItemFrom({ ...nested, type: nested.type || "generatedImage" });
    if (wrapped) out.push(wrapped);
  }

  const innerItem = asRecord(value.item);
  if (innerItem) walk(innerItem, out, depth + 1, seen);
  const detail = asRecord(value.detail);
  if (detail) walk(detail, out, depth + 1, seen);

  if (Array.isArray(value.content)) walk(value.content, out, depth + 1, seen);
  if (Array.isArray(value.images)) walk(value.images, out, depth + 1, seen);
  const text = value.text;
  if (text && typeof text === "object") walk(text, out, depth + 1, seen);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.dataUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** True when `value` itself is a Codex generated-image result, not prose wrapping one. */
export function isGeneratedImagePayload(value) {
  const rec = asRecord(value);
  if (!rec) return false;
  if (!isImageItemType(rec.type) && !isImageItemType(rec.kind)) return false;
  return mediaItemFrom(rec) != null;
}

/**
 * Show-media items for a Codex generated-image result.
 * Empty when the payload has no completed image bytes — never invents a card.
 */
export function generatedImageMediaItems(payload) {
  const out = [];
  walk(payload, out, 0, new WeakSet());
  return dedupe(out);
}

function textPartsOf(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    const rec = asRecord(part);
    if (!rec || isImagePart(rec)) continue;
    const text = asNonEmptyString(rec.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function dumpsImageBytes(text, items) {
  for (const item of items) {
    const comma = item.dataUrl.indexOf(",");
    const body = comma >= 0 ? item.dataUrl.slice(comma + 1) : "";
    if (body && text.includes(body.slice(0, 24))) return true;
  }
  return false;
}

/**
 * Visible prose that remains after the image card is painted.
 * Image-only payloads return "" so the chat does not dump base64/JSON.
 */
export function generatedImageRemainderText(payload, items) {
  const media = Array.isArray(items) ? items : generatedImageMediaItems(payload);
  if (!media.length) {
    if (typeof payload === "string") return payload;
    return "";
  }
  if (isGeneratedImagePayload(payload)) return "";
  const rec = asRecord(payload);
  if (!rec) return "";
  if (typeof rec.text === "string") {
    return dumpsImageBytes(rec.text, media) ? "" : rec.text;
  }
  if (rec.text && typeof rec.text === "object") {
    return generatedImageRemainderText(rec.text, media);
  }
  if (Array.isArray(rec.content)) return textPartsOf(rec.content);
  return "";
}

/**
 * Convert a generated-image payload into a show-media paint.
 * `showMedia` is the shipped chat painter (composeShowMediaReply / onShowMedia).
 * Missing attachments fail closed: painted is 0 when there are no items or no painter.
 */
export async function presentGeneratedImage(payload, showMedia) {
  const items = generatedImageMediaItems(payload);
  if (!items.length) return { painted: 0, items };
  if (typeof showMedia !== "function") return { painted: 0, items };
  const reply = await showMedia(items);
  const painted = typeof reply?.painted === "number" ? reply.painted : 0;
  return { painted, items, reply };
}
