// Defensive text coercion for chat payloads.
//
// Several chat paths (A2UI card replies, structured backend messages, forwarded
// user payloads) can receive an object where a string is expected. Implicit
// coercion turns those into the literal "[object Object]" — a silent context
// loss that has surfaced in the panel chat and in the agent prompt (issues
// #219/#176/#175/#168). Route such values through coerceMessageText() so an
// object is either reduced to a known string field or JSON-serialized, never
// stringified via Object.prototype.toString.

// Preferred string-bearing fields, in priority order, for a structured payload
// (card reply, backend error/message object, UI action).
const STRING_FIELDS = ["reply", "text", "label", "value", "message", "error", "detail"];

/** Coerce an arbitrary chat payload to a human/agent-readable string.
 *  - strings pass through unchanged;
 *  - null/undefined become "";
 *  - primitives use String();
 *  - objects yield the first non-empty known string field, else JSON, else "".
 *  Never returns "[object Object]" for a plain object. */
export function coerceMessageText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  for (const key of STRING_FIELDS) {
    const field = value[key];
    if (typeof field === "string" && field) return field;
  }
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for e.g. a bare function; guard it.
    return typeof json === "string" ? json : "";
  } catch {
    return "";
  }
}

/** Compute the outgoing chat text for an A2UI Button click (#219).
 *
 *  The reply is `component.reply ?? component.label`, coerced to a string via
 *  coerceMessageText FIRST — a malformed spec can carry an object reply, and if
 *  a `submit` button then interpolates it into the fields template
 *  (`${text}\n…`) BEFORE any downstream guard runs, the object stringifies to
 *  "[object Object]" and is baked into the message. Coercing up front makes the
 *  whole path string-safe regardless of the submit branch.
 *
 *  `fields` is the optional list of `{ name, read() }` collected by the form,
 *  appended only for a submit button.
 */
export function buttonReplyText(component, fields = []) {
  const base = coerceMessageText(component?.reply ?? component?.label ?? "");
  if (component?.submit && Array.isArray(fields) && fields.length) {
    const lines = fields.map((f) => `${f?.name}: ${f?.read?.() ?? ""}`);
    if (lines.length) return `${base}\n${lines.join("\n")}`;
  }
  return base;
}
