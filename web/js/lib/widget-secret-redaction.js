// Agent-facing graph reads must not echo credentials stored in workflow widgets.
// Keep this deliberately narrow: ordinary prompt/model/path values remain visible,
// while conventional credential field names and unmistakable key/header values do not.

export const REDACTED_WIDGET_VALUE = "[REDACTED]";

const SENSITIVE_WIDGET_NAME_RE =
  /(?:^|_)(?:api_key|apikey|access_token|refresh_token|auth_token|authentication_token|authorization|bearer|token|secret|password|passwd)$/;

// Value-based coverage is intentionally limited to formats that are useful to catch
// without treating arbitrary prose as a credential. The field-name checks above cover
// provider-specific API-key widgets; these patterns catch an unhelpfully named field.
const SECRET_VALUE_RE = /(?:^|[\s"'=:`])(?:sk-[A-Za-z0-9][A-Za-z0-9._-]{15,}|bearer\s+[A-Za-z0-9._~+/=-]{16,})/i;

function normalizeWidgetName(name) {
  return String(name ?? "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/** Return a safe agent-facing value without mutating the live widget. */
export function redactWidgetValue(name, value) {
  const normalizedName = normalizeWidgetName(name);
  if (SENSITIVE_WIDGET_NAME_RE.test(normalizedName)) {
    // Empty/null values carry no secret and preserving them avoids changing useful
    // state information such as an unconfigured optional API-key input.
    return value == null || value === "" ? value : REDACTED_WIDGET_VALUE;
  }
  if (typeof value === "string" && SECRET_VALUE_RE.test(value)) return REDACTED_WIDGET_VALUE;
  return value;
}
