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

import { isFrontendVirtualNode } from "./frontend-virtual-nodes.js";
import {
  parseAnnotatedFilepath,
  splitInputAssetRef,
  uploadConfigOf,
  uploadInputAccepts,
} from "./input-asset.js";

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
  return parseClassCombos(body, className)?.options ?? null;
}

/**
 * The CONFIG object each combo input carries, from the same body/parse as
 * `comboInputsOf`. ComfyUI declares a combo as `[[...allowed], {opts}]`; `{opts}`
 * is where an upload input announces itself (`{image_upload: true}`), and that
 * flag is the only thing that distinguishes a list the server can fully enumerate
 * from one it structurally cannot (see `scanComboAvailability`). null on an absent
 * class, exactly like `comboInputsOf`.
 *
 * @returns {Map<string, object>|null} widget name -> config (`{}` when absent)
 */
export function comboConfigsOf(body, className) {
  return parseClassCombos(body, className)?.configs ?? null;
}

function parseClassCombos(body, className) {
  if (!body || typeof body !== "object") return null;
  const spec = body[className];
  if (!spec || typeof spec !== "object") return null;
  const input = spec.input;
  const options = new Map();
  const configs = new Map();
  if (!input || typeof input !== "object") return { options, configs };
  for (const group of ["required", "optional"]) {
    const entries = input[group];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, def] of Object.entries(entries)) {
      // A combo is declared as `[[...allowed], {opts}]`; a typed input as
      // `["MODEL", {...}]`. Only the first form enumerates values.
      if (Array.isArray(def) && Array.isArray(def[0])) {
        options.set(name, def[0].filter((v) => typeof v === "string"));
        configs.set(name, def[1] && typeof def[1] === "object" ? def[1] : {});
      }
    }
  }
  return { options, configs };
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
/**
 * #984 — names of this node's widgets whose value the graph does NOT use, because a
 * matching input is connected.
 *
 * When a widget is converted to an input, ComfyUI keeps the entry in `node.widgets`
 * AND adds an input of the same name. While that input is CONNECTED the widget's own
 * `.value` is dead weight — frequently a stale leftover from before the conversion —
 * and the queue reads the link instead. Judging such a value against the combo
 * reports an error on a graph that runs fine.
 *
 * Deliberately narrow: an input counts only when it names the widget (directly or via
 * its `widget.name` back-reference) AND holds a non-null `link`. Everything else —
 * no `inputs` array, an unconnected input, a malformed entry — yields nothing, so the
 * widget stays judged. Skipping is the only thing this can do, and only on evidence.
 */
export function linkDrivenWidgetNames(node) {
  const names = new Set();
  try {
    const inputs = node?.inputs;
    if (!Array.isArray(inputs)) return names;
    for (const input of inputs) {
      if (!input || input.link === null || input.link === undefined) continue;
      const name = typeof input.name === "string" ? input.name : null;
      // Newer frontends carry the association explicitly; older ones match by name.
      const widgetName = typeof input.widget?.name === "string" ? input.widget.name : null;
      if (widgetName) names.add(widgetName);
      else if (name) names.add(name);
    }
  } catch {
    /* a malformed node judges every widget, exactly as before */
  }
  return names;
}

/**
 * #1357 — the wording for a value the combo has no jurisdiction over and the
 * server could not be asked about. Kept in one place so "I could not check this"
 * never drifts into reading like "I checked and it is fine".
 */
const UNENUMERABLE_PREFIX =
  "not checked: this value names a file below the input root (or under an " +
  "[output]/[temp]/[input] annotation), which /object_info's combo list cannot enumerate";

export async function scanComboAvailability(
  nodes,
  fetchClassInfo,
  {
    maxClasses = 80,
    maxAssetProbes = 48,
    budgetMs = 0,
    now = () => Date.now(),
    confirmServerAsset = null,
    backslashIsSeparator = false,
  } = {},
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
      const body = await fetchClassInfo(className);
      const combos = comboInputsOf(body, className);
      entry = combos === null
        ? { reason: "node type not found in /object_info" }
        : { combos, configs: comboConfigsOf(body, className) ?? new Map() };
    } catch {
      // A failed lookup is UNKNOWN, never "no combos".
      entry = { reason: "node type could not be looked up (/object_info call failed)" };
    }
    cache.set(className, entry);
    return entry;
  };

  // #1357 — an UPLOAD combo is the one option list the server cannot fully
  // enumerate, so non-membership in it is NOT evidence of absence.
  //
  // ComfyUI's LoadImage.INPUT_TYPES lists only TOP-LEVEL files of the input dir
  // (`os.listdir` + `isfile`), yet `folder_paths.get_annotated_filepath` happily
  // resolves `AgentLibrary/HaReen/Main-9-1.png` — and an `x.png [output]` value
  // resolves against a DIFFERENT root entirely. Such a value can therefore NEVER
  // be a member of the combo, no matter how fresh the fetch. Calling it
  // `missing_asset` is exactly the "could not look it up" / "looked it up and it
  // is not there" collapse this module exists to prevent: the reporter's file was
  // on disk, `panel_set_widget` had already server-confirmed it via the SAME
  // /view probe (#387), and get_errors contradicted it in the next breath.
  //
  // So for those values the combo abstains and the SERVER is asked instead:
  //   present  -> nothing to report
  //   absent   -> a real answer; report it exactly as before
  //   no answer (no probe injected, failed, capped, out of budget) -> UNKNOWN
  //
  // Everything else keeps the combo as the authority: a BARE root-level name IS
  // enumerated, a non-upload combo (`ckpt_name`, whose folder_paths listing IS
  // recursive) IS enumerated, and a value whose extension is not a loadable asset
  // of this input's upload kind stays rejected on #240 strictness — a mere /view
  // hit proves a file exists, not that LoadImage can load it.
  const assetProbes = new Map();
  let assetProbeCount = 0;
  let assetProbeLimitHit = false;
  const adjudicateUnenumerableAsset = async (config, value) => {
    const cfg = uploadConfigOf(config);
    if (!cfg) return null;
    const { name: bare, type: root, annotated } = parseAnnotatedFilepath(value);
    const { subfolder, filename } = splitInputAssetRef(bare, { backslashIsSeparator });
    if (!filename) return null;
    if (!annotated && !subfolder) return null;
    if (!uploadInputAccepts(cfg, bare)) return null;
    if (typeof confirmServerAsset !== "function") {
      return { reason: `${UNENUMERABLE_PREFIX}, and no server file check was available` };
    }
    const key = `${root}:${subfolder}/${filename}`;
    let probe = assetProbes.get(key);
    if (!probe) {
      if (assetProbeCount >= maxAssetProbes) {
        assetProbeLimitHit = true;
        return { reason: `${UNENUMERABLE_PREFIX}, and this call's ${maxAssetProbes}-file server-existence probe cap was reached` };
      }
      if (now() >= deadline) {
        outOfBudget = true;
        return { reason: `${UNENUMERABLE_PREFIX}, and get_errors ran out of its shared server-call budget` };
      }
      assetProbeCount += 1;
      // The injected probe is TRI-state on purpose: `false` must mean "the server
      // answered and the file is not there" and nothing else, or a flaky fetch
      // would masquerade as a confirmed miss.
      probe = Promise.resolve()
        .then(() => confirmServerAsset(value, { filename, subfolder, type: root }))
        .then(
          (r) => (r === true ? "present" : r === false ? "absent" : "unknown"),
          () => "unknown",
        );
      assetProbes.set(key, probe);
    }
    const verdict = await probe;
    if (verdict === "present") return { present: true };
    if (verdict === "absent") return null;
    return { reason: `${UNENUMERABLE_PREFIX}, and the server file check did not answer` };
  };

  for (const node of nodes) {
    const className = typeof node?.type === "string" ? node.type : null;
    if (!className || !Array.isArray(node.widgets)) continue;
    // comfyui-mcp#1657 / panel#1284 — a FRONTEND VIRTUAL node is skipped BEFORE the
    // lookup, not reported as unchecked after it.
    //
    // These have no /object_info entry by design and never reach the server, so there is
    // no combo for the server to judge their widget values against. Sending them through
    // the scan produced `{reason: "node type not found in /object_info"}` on a working
    // canvas — a sentence that reads as an accusation about a missing pack, on nodes whose
    // pack is installed and functioning. On the reported 422-node workflow that filled the
    // error surface (GetNode, SetNode, MarkdownNote, Label (rgthree), Fast Bypasser).
    //
    // "Skipped" here means NOTHING IS CLAIMED, which is honest rather than lenient: there
    // was never a judgement available to withhold. It costs no coverage — a virtual node's
    // widget value is not a server-side asset — and it saves a wasted round trip plus a
    // slot in the class cap, so a large canvas spends its budget on nodes that can fail.
    //
    // A node whose pack is NOT loaded is a defless placeholder, carries no `isVirtualNode`,
    // and is still scanned and still reported (see frontend-virtual-nodes.js).
    if (isFrontendVirtualNode(node)) continue;
    const entry = await comboMapFor(className);
    if (!entry.combos) {
      // Unjudgeable. Report the node once, with the REASON it was skipped — a
      // budget cutoff and a missing node type are different facts, and giving
      // both the same explanation is the collapse this module exists to avoid.
      unknown.push({ id: node.id, type: className, reason: entry.reason });
      continue;
    }
    const combos = entry.combos;
    // #984 — a widget whose matching input carries a LINK is driven by that link;
    // ComfyUI serializes the connection and ignores the widget's own value, which is
    // often a stale leftover from before the conversion. Judging it reports an error
    // on a workflow that runs correctly. Consulted ONLY to skip: an unlinked input, a
    // node with no `inputs`, or any unexpected shape leaves the widget judged exactly
    // as before, so this can never suppress a value the graph really uses.
    const linkDriven = linkDrivenWidgetNames(node);
    for (const widget of node.widgets) {
      const name = typeof widget?.name === "string" ? widget.name : null;
      if (!name) continue;
      if (linkDriven.has(name)) continue;
      const options = combos.get(name);
      if (!options) continue; // not a combo input — nothing to judge it against
      const value = widget.value;
      if (typeof value !== "string" || value === "") continue;
      if (options.includes(value)) continue;
      // #1357 — before calling it missing, check whether this combo could have
      // listed it at all.
      const asset = await adjudicateUnenumerableAsset(entry.configs?.get(name), value);
      if (asset?.present) continue;
      if (asset?.reason) {
        unknown.push({ id: node.id, type: className, widget: name, value, reason: asset.reason });
        continue;
      }
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
  if (!truncated && !outOfBudget && !assetProbeLimitHit) return { unavailable, unknown };
  return {
    unavailable,
    unknown,
    ...(outOfBudget ? { unchecked_budget_exhausted: true } : {}),
    ...(truncated && !outOfBudget ? { unchecked_class_limit: maxClasses } : {}),
    ...(assetProbeLimitHit ? { unchecked_asset_probe_limit: maxAssetProbes } : {}),
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
    `whose type could not be resolved — or a value this scan has no authority ` +
    `over — is listed under unchecked_nodes rather than being reported as healthy.`
  );
}

/**
 * Wording for `unchecked_nodes`, emitted whenever the scan abstained. Without it
 * an abstention sits in the payload next to "no errors recorded" and reads as a
 * clearance, which is the reading #1357 was harmed by — in the opposite
 * direction, but from the same collapse of "unknown" into a verdict.
 */
export function uncheckedNodesNote(unknown) {
  if (!Array.isArray(unknown) || unknown.length === 0) return "";
  const values = unknown.filter((u) => typeof u?.widget === "string").length;
  const types = unknown.length - values;
  const parts = [];
  // "could not resolve the type" would be wrong for two of the three ways a NODE
  // lands here — the class cap and the budget cutoff both skip a type that
  // resolves perfectly well. The per-entry `reason` distinguishes them; this
  // summary must not assert a cause it has not read.
  if (types) parts.push(`${types} node(s) this scan could not judge`);
  if (values) {
    parts.push(
      `${values} widget value(s) the server's combo list has no authority over ` +
        `(an input file below the input root, or one carrying an [output]/[temp]/[input] ` +
        `annotation, which /object_info never enumerates)`,
    );
  }
  return (
    `NOT CHECKED: ${parts.join(" and ")}. These are abstentions, not clearances: ` +
    `each entry carries the reason it could not be judged. Nothing here is a ` +
    `report that the value is missing, and nothing here is a report that it is ` +
    `fine — confirm the file yourself if it matters.`
  );
}
