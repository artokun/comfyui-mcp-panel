/**
 * #1297 — classify a bridge command name before dispatch.
 *
 * A truncated or concatenated serialization (ellipsis, glued JSON, extra
 * payload) is a MALFORMED name, not an unknown command. So is a nested
 * compact-router envelope (`call_tool` / `list_tools` / `describe_tool`,
 * with or without the panel_ prefix). Those mistakes used to fall through
 * to "Unknown command" / "Unknown panel tool", which hid the real error
 * and invited a retry that could not succeed until the name was repaired.
 *
 * Well-formed identifiers that simply are not executors still use the
 * existing unknown-command path. Nothing here mutates the graph; callers
 * must throw before executor lookup.
 */

/** Bridge / MCP command names are lowercase ASCII identifiers. */
const COMMAND_IDENT = /^[a-z][a-z0-9_]*$/;

/**
 * Compact-mode router verbs. These are not canvas commands; a nested
 * envelope that names one of them as the inner tool is malformed.
 */
const ROUTER_VERBS = new Set(["call_tool", "list_tools", "describe_tool"]);

const PANEL_PREFIX = "panel_";

export const MALFORMED_TOOL_NAME_CODE = "malformed_tool_name";

function routerVerbOf(name) {
  if (typeof name !== "string") return "";
  if (ROUTER_VERBS.has(name)) return name;
  if (name.startsWith(PANEL_PREFIX) && ROUTER_VERBS.has(name.slice(PANEL_PREFIX.length))) {
    return name.slice(PANEL_PREFIX.length);
  }
  return "";
}

/**
 * @param {unknown} name
 * @returns {{ kind: "malformed", code: string, reason: "empty" | "nested_router" | "truncated_or_concatenated" } | { kind: "well_formed" }}
 */
export function classifyCommandName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return { kind: "malformed", code: MALFORMED_TOOL_NAME_CODE, reason: "empty" };
  }
  if (routerVerbOf(name)) {
    return { kind: "malformed", code: MALFORMED_TOOL_NAME_CODE, reason: "nested_router" };
  }
  if (!COMMAND_IDENT.test(name)) {
    return { kind: "malformed", code: MALFORMED_TOOL_NAME_CODE, reason: "truncated_or_concatenated" };
  }
  return { kind: "well_formed" };
}

/**
 * Agent-facing validation text, or null when the name is well-formed
 * (unknown-but-legal identifiers stay on the unknown-command path).
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function malformedCommandNameError(name) {
  const verdict = classifyCommandName(name);
  if (verdict.kind !== "malformed") return null;
  if (verdict.reason === "nested_router") {
    return (
      `malformed tool name: nested router envelope, not a canvas tool. ` +
      `Pass the inner tool directly (for example panel_set_widget). Nothing was applied.`
    );
  }
  if (verdict.reason === "empty") {
    return (
      `malformed tool name: the command name is empty. ` +
      `Re-issue with the exact name. Nothing was applied.`
    );
  }
  return (
    `malformed tool name "${name}": truncated or concatenated, not an unknown command. ` +
    `Re-issue with the exact name (for example panel_set_widget). Nothing was applied.`
  );
}

/**
 * Pre-executor exception carrying a structured `malformed_tool_name` payload,
 * or null when the name is well-formed.
 *
 * @param {unknown} name
 * @returns {Error | null}
 */
export function malformedToolNameException(name) {
  const message = malformedCommandNameError(name);
  if (!message) return null;
  const err = new Error(message);
  Object.defineProperty(err, "cmcpMalformedToolName", {
    value: { code: MALFORMED_TOOL_NAME_CODE, applied: false },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return err;
}

/**
 * Structured payload to publish on the reply, or null.
 *
 * Own-property + exact code, so an inherited or forged field cannot
 * relabel a post-mutation throw as a pre-dispatch validation miss.
 *
 * @returns {{ code: "malformed_tool_name", applied: false } | null}
 */
export function readMalformedToolName(err) {
  if (!err || typeof err !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(err, "cmcpMalformedToolName")) return null;
  const payload = err.cmcpMalformedToolName;
  if (!payload || typeof payload !== "object") return null;
  if (payload.code !== MALFORMED_TOOL_NAME_CODE) return null;
  if (payload.applied !== false) return null;
  return { code: MALFORMED_TOOL_NAME_CODE, applied: false };
}
