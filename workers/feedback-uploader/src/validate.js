/**
 * validate.js — payload validation for the feedback uploader.
 *
 * Pure (no Worker APIs) so it unit-tests under plain `node --test`. The
 * Worker accepts ONLY the documented `comfyui-mcp.feedback/1` shape and
 * stores a sanitized copy — unknown top-level fields are dropped, sizes are
 * capped, and nothing the panel didn't document can ride along.
 */

/** Absolute request-body cap (bytes). The panel caps its transcript at
 *  ~700k chars, so 1 MiB leaves envelope headroom without inviting abuse. */
export const MAX_BODY_BYTES = 1_048_576;

const MAX_WHY_CHARS = 4_000;
const MAX_ID_CHARS = 100;
const MAX_TIMESTAMP_CHARS = 40;
const MAX_TRANSCRIPT_ENTRIES = 2_000;

function strOrNull(v, cap = 200) {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
}

/**
 * Validate + sanitize a parsed feedback payload.
 * @param {unknown} data parsed JSON body
 * @returns {{ok: true, feedback: object} | {ok: false, errors: string[]}}
 */
export function validateFeedback(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const { verdict, transcript, why, versions, schema, id, timestamp } = data;

  if (verdict !== "good" && verdict !== "bad") {
    errors.push('verdict must be "good" or "bad"');
  }
  if (!Array.isArray(transcript) || transcript.length === 0) {
    errors.push("transcript must be a non-empty array");
  } else if (transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    errors.push(`transcript exceeds ${MAX_TRANSCRIPT_ENTRIES} entries`);
  } else if (!transcript.every((m) => m && typeof m === "object" && typeof m.role === "string")) {
    errors.push("every transcript entry must be an object with a string role");
  }
  if (why !== undefined && typeof why !== "string") {
    errors.push("why must be a string when present");
  }
  if (versions !== undefined && (typeof versions !== "object" || versions === null || Array.isArray(versions))) {
    errors.push("versions must be an object when present");
  }
  if (schema !== undefined && (typeof schema !== "string" || !schema.startsWith("comfyui-mcp.feedback/"))) {
    errors.push("schema must be a comfyui-mcp.feedback/* tag when present");
  }
  if (errors.length) return { ok: false, errors };

  const v = versions ?? {};
  return {
    ok: true,
    feedback: {
      schema: typeof schema === "string" ? schema : "comfyui-mcp.feedback/1",
      id: strOrNull(id, MAX_ID_CHARS),
      timestamp: strOrNull(timestamp, MAX_TIMESTAMP_CHARS),
      verdict,
      ...(typeof why === "string" && why.trim() ? { why: why.trim().slice(0, MAX_WHY_CHARS) } : {}),
      versions: {
        model: strOrNull(v.model),
        panel: strOrNull(v.panel),
        mcp: strOrNull(v.mcp),
        backend: strOrNull(v.backend),
        comfyui: strOrNull(v.comfyui),
      },
      transcript,
    },
  };
}
