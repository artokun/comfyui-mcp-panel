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
// (card reply, backend error/message object, UI action). `caption`/`filename`
// let a completed render/output payload (#238) surface its media label rather
// than JSON; `content` is handled specially below (codex-style parts array).
const STRING_FIELDS = ["reply", "text", "label", "value", "message", "error", "detail", "caption", "filename"];

/** Coerce an arbitrary chat payload to a human/agent-readable string.
 *  - strings pass through unchanged;
 *  - null/undefined become "";
 *  - primitives use String();
 *  - objects yield the first non-empty known string field, else the joined text
 *    of a `content` parts array (codex app-server shape), else JSON, else "".
 *  Never returns "[object Object]" for a plain object. Shared by the LIVE say
 *  render (#238), the A2UI button path (#219), and persisted-message replay
 *  (#241) so every path serializes structured payloads identically. */
export function coerceMessageText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  for (const key of STRING_FIELDS) {
    const field = value[key];
    if (typeof field === "string" && field) return field;
  }
  // Codex/app-server assistant shapes carry the visible text in a `content`
  // parts array (e.g. [{ type:"text", text:"…" }]). Older persisted records of
  // this shape (#241) must replay as their joined text, not raw JSON.
  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for e.g. a bare function; guard it.
    return typeof json === "string" ? json : "";
  } catch {
    return "";
  }
}

/** Serialize an outbound user_message `context` into the STRING the wire
 *  contract requires (#276). The orchestrator only reads `context` when it is a
 *  string (it prepends it above the user's text as grounding/transcript replay);
 *  a non-string is either silently dropped (older orchestrators) or, once the
 *  panel began joining context parts into one string, coerced by
 *  `Array.prototype.join` into the literal "[object Object]" and prepended above
 *  EVERY message — the exact #276 symptom (a lone "[object Object]" line over the
 *  user's typed text).
 *
 *  The panel composes context as `{ workflow, subgraph }` to ground the agent in
 *  what the user is viewing. Render that known shape as readable lines; fall back
 *  to coerceMessageText for anything else so an object can never become
 *  "[object Object]". A string passes through untouched (transcript replay).
 */
export function serializeContext(context) {
  if (context == null) return "";
  if (typeof context === "string") return context;
  if (typeof context === "object" && !Array.isArray(context)) {
    const lines = [];
    if (typeof context.workflow === "string" && context.workflow) {
      lines.push(`Workflow: ${context.workflow}`);
    }
    if (typeof context.subgraph === "string" && context.subgraph) {
      lines.push(`Viewing subgraph: ${context.subgraph}`);
    }
    if (lines.length) return lines.join("\n");
    // An empty object carries no context — drop it out of the join rather than
    // emitting "{}" above the user's text.
    if (Object.keys(context).length === 0) return "";
  }
  // Unknown shape: JSON/known-field serialize, never "[object Object]".
  return coerceMessageText(context);
}

/** Decide whether a persisted assistant record should be dropped on history
 *  replay (#241). Drop ONLY a structured payload that coerced to nothing (an
 *  object with no extractable text / an unserializable value) — that's the
 *  "[object Object]" case being killed. A genuinely-empty STRING record is
 *  valid stored input (chat-history-store accepts it; imports preserve it) and
 *  must still render its empty bubble, so it is NEVER dropped. */
export function isDroppedAgentReplay(text) {
  return typeof text !== "string" && coerceMessageText(text) === "";
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
