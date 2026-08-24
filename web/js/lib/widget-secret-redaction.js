// Agent-facing graph reads must not echo credentials stored in workflow widgets.
// Keep this deliberately narrow: ordinary prompt/model/path values remain visible,
// while conventional credential field names and unmistakable key/header values do not.

export const REDACTED_WIDGET_VALUE = "[REDACTED]";

const SENSITIVE_WIDGET_NAME_RE =
  /(?:^|_)(?:credentials?|secret(?:_keys?)?|private_keys?|api_keys?|apikeys?|access_token|refresh_token|auth_token|authentication_token|authorization|bearer|password|passwd|client_secrets?)(?:_|$)/;
const TOKEN_WIDGET_NAME_RE = /(?:^|_)tokens?(?:$|_(?:value|values|string|header|headers))/;

// Value-based coverage is intentionally limited to formats that are useful to catch
// without treating arbitrary prose as a credential. The field-name checks above cover
// provider-specific API-key widgets; these patterns catch an unhelpfully named field.
const SECRET_VALUE_RE =
  /(?:^|[\s"'=:`])(?:sk-[A-Za-z0-9][A-Za-z0-9._-]{15,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|bearer\s+[A-Za-z0-9._~+/=-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

function normalizeWidgetName(name) {
  return String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isSensitiveName(name) {
  const normalized = normalizeWidgetName(name);
  return SENSITIVE_WIDGET_NAME_RE.test(normalized) || TOKEN_WIDGET_NAME_RE.test(normalized);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactSensitiveValue(value, seen) {
  // Empty optional credential inputs are useful state and do not contain a secret.
  if (value == null || value === "") return value;
  if (Array.isArray(value) && value.length === 0) return value;
  if (isPlainObject(value) && Object.keys(value).length === 0) return value;
  if (Array.isArray(value) || isPlainObject(value)) return redactNestedValue(value, seen, true);
  return REDACTED_WIDGET_VALUE;
}

function setEnumerable(out, key, value) {
  // defineProperty keeps an attacker-controlled `__proto__` key as data.
  Object.defineProperty(out, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function memoKey(redactScalars) {
  return redactScalars ? "sensitive" : "ordinary";
}

function memoGet(seen, value, redactScalars) {
  const entries = seen.get(value);
  const key = memoKey(redactScalars);
  return entries && Object.hasOwn(entries, key) ? entries[key] : undefined;
}

function memoSet(seen, value, redactScalars, result) {
  let entries = seen.get(value);
  if (!entries) {
    entries = Object.create(null);
    seen.set(value, entries);
  }
  entries[memoKey(redactScalars)] = result;
}

function redactNestedValue(value, seen, redactScalars = false) {
  if (typeof value === "string") {
    return redactScalars || SECRET_VALUE_RE.test(value) ? REDACTED_WIDGET_VALUE : value;
  }
  if (redactScalars && (typeof value === "number" || typeof value === "boolean")) {
    return REDACTED_WIDGET_VALUE;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  const memoized = memoGet(seen, value, redactScalars);
  if (memoized !== undefined) return memoized;

  const out = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  // A shared object may be reached once through an ordinary key and once through
  // a credential-like key. Keep a separate in-progress result for each context so
  // the first traversal cannot satisfy the second with an unsanitized alias.
  memoSet(seen, value, redactScalars, out);

  let changed = false;
  for (const key of Object.keys(value)) {
    const original = value[key];
    const next = isSensitiveName(key)
      ? redactSensitiveValue(original, seen)
      : redactNestedValue(original, seen, redactScalars);
    if (next !== original) changed = true;
    setEnumerable(out, key, next);
  }
  if (!changed) {
    memoSet(seen, value, redactScalars, value);
    return value;
  }
  return out;
}

/** Return a safe agent-facing value without mutating the live widget. */
export function redactWidgetValue(name, value) {
  if (isSensitiveName(name)) return redactSensitiveValue(value, new WeakMap());
  if (typeof value === "string") return SECRET_VALUE_RE.test(value) ? REDACTED_WIDGET_VALUE : value;
  return redactNestedValue(value, new WeakMap());
}
