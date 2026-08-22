/**
 * Is a per-node `properties` difference ENTIRELY rgthree Seed's random-range rewrite?
 * (#1608)
 *
 * ## The measurement this rests on
 *
 * rgthree Seed (`src_web/comfyui/seed.ts`) stamps two keys in the constructor,
 * before LiteGraph copies the saved bag on top:
 *
 *     this.properties["randomMax"] = 1125899906842624;
 *     this.properties["randomMin"] = 0;
 *
 * LiteGraph then MERGES saved properties (missing keys keep the constructor
 * stamp). `onPropertyChanged` Number()-coerces and clamps the same two keys.
 * A file that omitted them, or stored them as a different numeric type, cannot
 * round-trip: the live bag carries frontend-computed bounds the payload never
 * had, and `panel_open_workflow` reported CONTENT_UNVERIFIED — no
 * `workflow_uuid` — over a complete node set whose authored widgets matched.
 *
 * ## What this does NOT do
 *
 * It does not wave the `properties` field through. Any other key that moved —
 * a pack-version stamp, an extension's stored settings — returns false, and
 * the caller reads false as NOT PROVEN. Same contract as
 * `nodeInputsDifferOnlyByDefinitionRebuild` (#1467).
 */

const RANDOM_RANGE_PROPERTY_KEYS = new Set(["randomMin", "randomMax"]);

function readableProps(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Missing properties is an empty bag: the constructor fills keys, it does not
 *  replace a bag that was never saved with a non-object. */
function asBag(value) {
  if (value === undefined) return {};
  return value;
}

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

/**
 * `undefined` is ABSENT, matching `classifyNodeDifference`: JSON cannot carry
 * it, so a live in-memory key with that value is not a difference from a file.
 */
function hasOwnDefined(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function bagsEqualIgnoringRandomRange(before, after) {
  const left = asBag(before);
  const right = asBag(after);
  if (!readableProps(left) || !readableProps(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (RANDOM_RANGE_PROPERTY_KEYS.has(key)) continue;
    const present = hasOwnDefined(left, key) === hasOwnDefined(right, key);
    const a = JSON.stringify(canonicalize(left[key]));
    const b = JSON.stringify(canonicalize(right[key]));
    if (!present || a !== b) return false;
  }
  return true;
}

/**
 * Whole-graph form: every node's properties difference must be confined to
 * `randomMin` / `randomMax`.
 *
 * Pairs nodes by id+type, matching `classifyNodeDifference`'s identity rule —
 * a caller only reaches here once that classifier has already established the
 * node SET matches, but this must not depend on that having been done.
 */
export function nodePropertiesDifferOnlyByRandomRangeNormalization(expectedNodes, actualNodes) {
  if (!Array.isArray(expectedNodes) || !Array.isArray(actualNodes)) return false;
  try {
    const key = (n) => JSON.stringify([String(n?.id ?? ""), String(n?.type ?? "")]);
    const byKey = (list) => {
      const map = new Map();
      for (const node of list) {
        if (!node || typeof node !== "object") return null;
        const k = key(node);
        if (map.has(k)) return null;
        map.set(k, node);
      }
      return map;
    };
    const expected = byKey(expectedNodes);
    const actual = byKey(actualNodes);
    if (!expected || !actual) return false;
    if (expected.size !== actual.size) return false;

    for (const [k, before] of expected) {
      const after = actual.get(k);
      if (!after) return false;
      if (!bagsEqualIgnoringRandomRange(before.properties, after.properties)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
