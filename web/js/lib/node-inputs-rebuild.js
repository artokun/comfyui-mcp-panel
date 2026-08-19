/**
 * Is a per-node `inputs` difference ENTIRELY the frontend's definition rebuild?
 * (comfyui-mcp#1467)
 *
 * ## The measurement this rests on
 *
 * `comfyui_frontend_package` 1.48.7, `ComfyNode.prototype.configure` — which runs
 * BEFORE LiteGraph's own `configure` ever sees the payload:
 *
 *     let t = [`name`,`type`,`shape`,`localized_name`],
 *         n = new Map(e.inputs?.map(e => [e.name, e]) ?? []),   // saved, by name
 *         r = new Set(this.inputs.map(e => e.name)),            // the DEFINITION
 *         i = this.inputs.map(e => {                            // walk the DEFINITION
 *           let r = n.get(e.name);
 *           return r ? { ...r, ...xn.pick(e, t.concat(`widget`)) } : e;
 *         }),
 *         a = e.inputs?.filter(e => !r.has(e.name));            // unknown, appended
 *     e.inputs = [...i, ...a ?? []];
 *
 * Read directly, the live `inputs` array is GENERATED, not restored:
 *
 *   - its ORDER is the definition's, not the saved file's;
 *   - `name`, `type`, `shape`, `localized_name` and `widget` are taken from the
 *     DEFINITION on every load, whatever the file said;
 *   - a slot the definition does not know is kept, appended at the end.
 *
 * So a byte-perfect open cannot reproduce a saved `inputs` array, and three
 * reporters hit a CONTENT_UNVERIFIED refusal on exactly that.
 *
 * ## What this does NOT do
 *
 * It does not wave the surface through. Everything the rebuild does not explain
 * — a slot that disappeared, one that appeared from nowhere, a changed `link`,
 * any other key that moved — returns false, and the caller reads false as NOT
 * PROVEN rather than as "changed". Same contract as
 * `definitionsDifferOnlyByRenumber` (#886, comfyui-mcp#1706), which is the precedent this
 * follows: characterise a specific frontend rewrite, admit exactly that, refuse
 * everything else.
 *
 * In particular `link` is compared. A rebuilt slot keeps whatever link the saved
 * entry had (`{...r, ...pick(definition)}` overlays only the five listed fields),
 * so a differing `link` is NOT explained by this rebuild and must still refuse.
 */

/** The keys `ComfyNode.configure` overlays from the node definition on every
 *  load. Their values in a saved file are advisory — the definition wins — so a
 *  difference in them says nothing about content. `widget` is included because
 *  the frontend appends it to that same pick list. */
const DEFINITION_OWNED_INPUT_KEYS = new Set([
  "name",
  // `type` is DELIBERATELY NOT HERE, though the frontend overlays it too.
  //
  // The rebuild explains a type difference MECHANICALLY, but "explained" is not
  // the question this function answers — it answers whether the live graph
  // reproduces the SAVED content. A slot saved as IMAGE that loads as MASK
  // because the node definition changed between save and load is a different
  // connection contract, and proving content across it would publish a fence for
  // a graph an agent's next write could land on wrongly (review, P1). Definition
  // drift is exactly when a caller should NOT be told the open was faithful.
  "shape",
  "localized_name",
  "widget",
]);

/**
 * A canonical encoding that distinguishes values `JSON.stringify` conflates.
 *
 * `JSON.stringify(a ?? null)` — the first version of this comparison — made
 * `null`, `undefined` and an ABSENT property identical, and `NaN` identical to
 * all three (`JSON.stringify(NaN) === "null"`). So a field going from `null` to
 * gone, or to `NaN`, read as no difference at all — in a function whose entire
 * job is to refuse unexplained differences, and directly contradicting its own
 * "presence before value" note (review, P1).
 *
 * Recursive, because the conflation applies at every depth, not just the top.
 */
function canonical(value) {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "#NaN";
    if (Object.is(value, -0)) return "#-0";
    return `#${value}`;
  }
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) {
    // Indexed explicitly, with holes distinguished from present values: `.map`
    // SKIPS holes and `.join` renders them empty, so `[,,]` and `["",""]` and a
    // shorter array could all encode alike (review). A hole is not a value.
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(hasOwn(value, i) ? canonical(value[i]) : "h");
    }
    return `[${parts.join(",")}]`;
  }
  // EXOTIC OBJECTS FAIL CLOSED. A Date, Map or Set has no enumerable own string
  // keys, so the key-walk below would encode every one of them as `{}` — making
  // `new Date(0)` and `new Date(1)`, or two differently-populated Maps, compare
  // EQUAL and be admitted as rebuild-only (review). Nothing in a serialized
  // workflow should be one of these; if one appears, the honest answer is that
  // this comparison cannot read it. Throwing lands in the caller's catch, which
  // answers false.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("unreadable value in node inputs");
  }
  // Key-sorted, so property order is not mistaken for a difference.
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(",")}}`;
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** A slot's identity for pairing. The frontend keys its rebuild off `name`, so
 *  that is the only honest way to pair two slots across a reorder. */
function slotName(slot) {
  return typeof slot?.name === "string" ? slot.name : null;
}

/**
 * Compare one node's input arrays, ignoring exactly what the rebuild controls.
 *
 * @returns {boolean} true ONLY when every difference is accounted for by the
 *   definition rebuild. False for any unexplained difference, and false for
 *   anything it cannot read — never throws.
 */
export function inputsDifferOnlyByDefinitionRebuild(expectedInputs, actualInputs) {
  // Absent on both sides is not a difference; absent on one side is a real one
  // (a node that lost its inputs array entirely is exactly the loss case).
  if (expectedInputs === undefined && actualInputs === undefined) return true;
  if (!Array.isArray(expectedInputs) || !Array.isArray(actualInputs)) return false;

  try {
    const byName = (list) => {
      const map = new Map();
      for (const slot of list) {
        if (!slot || typeof slot !== "object") return null; // unreadable entry
        const name = slotName(slot);
        if (name === null) return null; // cannot pair a nameless slot honestly
        if (map.has(name)) return null; // duplicate names — pairing would be a guess
        map.set(name, slot);
      }
      return map;
    };

    const expected = byName(expectedInputs);
    const actual = byName(actualInputs);
    if (!expected || !actual) return false;

    // THE SET MUST MATCH. The rebuild reorders and re-fields; it never adds or
    // drops a slot NAME — an unknown saved slot is appended, not discarded, and
    // a definition slot missing from the file is materialised but then present
    // on both sides of a second open. A name appearing or vanishing is therefore
    // unexplained, and is the shape a real partial load takes.
    if (expected.size !== actual.size) return false;
    for (const name of expected.keys()) if (!actual.has(name)) return false;

    for (const [name, before] of expected) {
      const after = actual.get(name);
      // Compare the union of keys, so a key PRESENT on one side and absent on
      // the other is caught rather than skipped — the same presence-before-value
      // rule `classifyNodeDifference` had to learn.
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        if (DEFINITION_OWNED_INPUT_KEYS.has(key)) continue;
        // PRESENCE FIRST, and as its own answer. A key on one side only is a
        // difference whatever its value would have been — collapsing that into a
        // value comparison is how an absent field starts matching an explicit
        // null.
        const inBefore = hasOwn(before, key);
        const inAfter = hasOwn(after, key);
        if (inBefore !== inAfter) return false;
        if (!inBefore) continue;
        if (canonical(before[key]) !== canonical(after[key])) return false;
      }
    }
    return true;
  } catch {
    return false; // unreadable proves nothing
  }
}

/**
 * Whole-graph form: every node's inputs difference must be explained.
 *
 * Pairs nodes by id+type, matching `classifyNodeDifference`'s identity rule — a
 * caller only reaches here once that classifier has already established the node
 * SET matches, but this must not depend on that having been done.
 */
export function nodeInputsDifferOnlyByDefinitionRebuild(expectedNodes, actualNodes) {
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
      if (!inputsDifferOnlyByDefinitionRebuild(before.inputs, after.inputs)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
