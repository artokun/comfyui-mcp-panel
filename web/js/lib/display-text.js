// Coerce an arbitrary chat payload into readable display text.
//
// Structured backend failures and multi-part messages sometimes arrive at the
// render layer as objects. Painting them with implicit string coercion yields
// the useless literal "[object Object]" (see panel issue #176). This helper is
// the panel's last line of defense: prefer a human-readable string field, then
// fall back to a safe JSON serialization — never Object.prototype.toString.

/** Return readable text for a value that may be a string, error, or object. */
export function toDisplayText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return value.message || value.name || "Error";
  if (typeof value === "object") {
    // Prefer a conventional human-readable field before serializing the whole
    // object, so a { error | message | text | detail } payload reads cleanly.
    for (const key of ["message", "error", "text", "detail", "description"]) {
      const field = value[key];
      if (typeof field === "string" && field) return field;
      // A nested { error: { message } } style payload is common for quota/API errors.
      if (field && typeof field === "object") {
        const nested = toDisplayText(field);
        if (nested && nested !== "[object Object]") return nested;
      }
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      // Cyclic / non-serializable — fall through to the constructor-name hint.
    }
    return value.constructor?.name ? `[${value.constructor.name}]` : "[object]";
  }
  return String(value);
}
