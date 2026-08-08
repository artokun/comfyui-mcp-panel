/**
 * panel#745 — the half #774 deliberately left undone.
 *
 * ComfyUI populates the `missingModel`/`missingMedia` stores when a workflow is
 * LOADED. The panel reads them and its own logic only ever SUBTRACTS, so a
 * loader added after the load, pointing at a file that is not there, is invisible
 * to `panel_get_errors`. #774 disclosed the blind spot; this closes it.
 *
 * #774 named the reason it stopped, and it is the right worry:
 *
 *     judging a combo value requires a TRUSTED /object_info refresh, the refresh
 *     is gated on the store already having candidates, and getting that wrong
 *     reports every combo on the canvas as missing — mass false positives on the
 *     error surface, which is worse than the omission.
 *
 * What makes it safe now is the PER-CLASS endpoint. `/object_info/<class>` is the
 * server's own authoritative enumeration, fetched fresh, and it is cheap enough to
 * ask per node class instead of reusing whatever the frontend happens to hold:
 * measured on a live rig, `LoraLoaderModelOnly` is 5,694 bytes against 5,413,770
 * for the whole document. No store, no cache, no gate.
 *
 * It also draws the line that matters, which a frontend store cannot:
 *
 *   - class absent, or the fetch failed  -> UNKNOWN. Say nothing.
 *   - combo present, value not among its options -> DETERMINED unavailable.
 *
 * An ABSENT class answers `{}` with HTTP 200 (verified live) — it is not a 404, so
 * "I could not look it up" and "I looked it up and it is empty" are different
 * answers and must not collapse into one. That collapse is exactly the defect
 * class the #796 gate exists to keep at zero, and it is the collapse that would
 * produce the mass false positives #774 feared.
 *
 * An EMPTY option list is NOT unknown. The server enumerating zero loras is a real
 * answer: every value is then unavailable. That is the reporter's own case — they
 * set a lora basename while the dropdown was empty.
 */

/** Inputs whose combo lists name files on disk, rather than modes like
 *  `sampler_name: [euler, …]`. A value outside ANY combo's options is a genuine
 *  problem, but only these are missing ASSETS, and calling a bad scheduler a
 *  missing model would be its own dishonest report. Detected from the options
 *  themselves — a filename carries an extension — never from the input name, so a
 *  pack using its own naming is judged on what it actually offers. */
const FILE_LIKE = /\.[A-Za-z0-9_]{2,12}$/;

/** True when the options look like files on disk. An empty list cannot be judged
 *  this way, so the caller supplies the fallback (see `optionsNameFiles`). */
export function optionsLookLikeFiles(options) {
  if (!Array.isArray(options) || options.length === 0) return false;
  const strings = options.filter((o) => typeof o === "string");
  if (!strings.length) return false;
  return strings.filter((s) => FILE_LIKE.test(s)).length * 2 >= strings.length;
}

/**
 * Pull a class's combo inputs out of an /object_info/<class> body.
 *
 * @param {unknown} body the parsed response — `{ [class]: { input: { required, optional } } }`
 * @param {string} className
 * @returns {Map<string, string[]>|null} widget name -> allowed values, or null when
 *   the class is absent (an `{}` body). null means UNKNOWN, never "no combos".
 */
export function comboInputsOf(body, className) {
  if (!body || typeof body !== "object") return null;
  const spec = body[className];
  if (!spec || typeof spec !== "object") return null;
  const input = spec.input;
  if (!input || typeof input !== "object") return new Map();
  const out = new Map();
  for (const group of ["required", "optional"]) {
    const entries = input[group];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, def] of Object.entries(entries)) {
      // A combo is declared as `[[...allowed], {opts}]`; a typed input as
      // `["MODEL", {...}]`. Only the first form enumerates values.
      if (Array.isArray(def) && Array.isArray(def[0])) {
        out.set(name, def[0].filter((v) => typeof v === "string"));
      }
    }
  }
  return out;
}

/**
 * Judge the live graph's combo widget values against the server's own lists.
 *
 * Never throws, and never guesses: a class it could not resolve lands in
 * `unknown` and is reported as such, because "I could not check this node" and
 * "this node is fine" are different answers.
 *
 * @param {Array<{id: unknown, type: string, widgets: Array<{name: string, value: unknown}>}>} nodes
 * @param {(className: string) => Promise<unknown>} fetchClassInfo resolves an
 *   /object_info/<class> body; may reject.
 * @returns {Promise<{unavailable: Array<object>, unknown: Array<object>}>}
 */
export async function scanComboAvailability(
  nodes,
  fetchClassInfo,
  { maxClasses = 80, budgetMs = 0, now = () => Date.now() } = {},
) {
  const unavailable = [];
  const unknown = [];
  let truncated = 0;
  let outOfBudget = false;
  if (!Array.isArray(nodes) || typeof fetchClassInfo !== "function") {
    return { unavailable, unknown };
  }
  // get_errors shares ONE budget across every elective server wait it makes, and
  // overrunning it is not a slow answer — it is a "did not reply" that strands the
  // agent with NO error surface at all (#589). That is strictly worse than the
  // omission this scan exists to close, so the scan fails CLOSED: when the budget
  // is gone the remaining classes are UNCHECKED and say so.
  const deadline = budgetMs > 0 ? now() + budgetMs : Infinity;

  // One fetch per distinct CLASS, not per node — a canvas with thirty
  // KSamplers must not become thirty requests.
  const cache = new Map();
  const comboMapFor = async (className) => {
    if (cache.has(className)) return cache.get(className);
    // A bound on DISTINCT classes, not nodes. get_errors answers inside the
    // orchestrator's reply deadline, and an unbounded scan on a pathological
    // canvas would spend it on lookups. Past the cap every further class is
    // UNCHECKED and says so — silently skipping them would make a truncated
    // scan read exactly like a clean one.
    if (cache.size >= maxClasses) {
      truncated += 1;
      return { reason: `not checked: this call's ${maxClasses}-node-type lookup cap was reached` };
    }
    if (now() >= deadline) {
      outOfBudget = true;
      truncated += 1;
      return { reason: "not checked: get_errors ran out of its shared server-call budget" };
    }
    let entry;
    try {
      const combos = comboInputsOf(await fetchClassInfo(className), className);
      entry = combos === null
        ? { reason: "node type not found in /object_info" }
        : { combos };
    } catch {
      // A failed lookup is UNKNOWN, never "no combos".
      entry = { reason: "node type could not be looked up (/object_info call failed)" };
    }
    cache.set(className, entry);
    return entry;
  };

  for (const node of nodes) {
    const className = typeof node?.type === "string" ? node.type : null;
    if (!className || !Array.isArray(node.widgets)) continue;
    const entry = await comboMapFor(className);
    if (!entry.combos) {
      // Unjudgeable. Report the node once, with the REASON it was skipped — a
      // budget cutoff and a missing node type are different facts, and giving
      // both the same explanation is the collapse this module exists to avoid.
      unknown.push({ id: node.id, type: className, reason: entry.reason });
      continue;
    }
    const combos = entry.combos;
    for (const widget of node.widgets) {
      const name = typeof widget?.name === "string" ? widget.name : null;
      if (!name) continue;
      const options = combos.get(name);
      if (!options) continue; // not a combo input — nothing to judge it against
      const value = widget.value;
      if (typeof value !== "string" || value === "") continue;
      if (options.includes(value)) continue;
      unavailable.push({
        id: node.id,
        type: className,
        widget: name,
        value,
        option_count: options.length,
        // The distinction a reader acts on: nothing of this kind is installed at
        // all, versus this particular one is not among the ones that are.
        kind: options.length === 0 || optionsLookLikeFiles(options)
          ? "missing_asset"
          : "invalid_value",
      });
    }
  }
  if (!truncated) return { unavailable, unknown };
  return {
    unavailable,
    unknown,
    ...(outOfBudget ? { unchecked_budget_exhausted: true } : { unchecked_class_limit: maxClasses }),
  };
}

/** Wording for the reply. States what was checked and what it means, because a
 *  bare list on an error surface invites the reader to assume the opposite one
 *  is empty for a good reason. */
export function comboAvailabilityNote(unavailable) {
  if (!Array.isArray(unavailable) || unavailable.length === 0) return "";
  const assets = unavailable.filter((u) => u.kind === "missing_asset").length;
  const invalid = unavailable.length - assets;
  const parts = [];
  if (assets) parts.push(`${assets} widget value(s) naming a file the server does not have`);
  if (invalid) parts.push(`${invalid} widget value(s) outside the options the server offers`);
  return (
    `LIVE SCAN: ${parts.join(" and ")}. This was read from the server's own ` +
    `/object_info for each node type at the time of this call, so unlike the ` +
    `load-time missing-model scan it DOES see nodes added this session. It covers ` +
    `the graph level currently being viewed; nodes inside a subgraph you are not ` +
    `in are NOT scanned, so an empty list here is not proof about them. A node ` +
    `whose type could not be resolved is listed under unchecked_nodes rather ` +
    `than being reported as healthy.`
  );
}
