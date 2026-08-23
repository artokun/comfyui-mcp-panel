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
  authoritativeComboValues,
  parseAnnotatedFilepath,
  splitInputAssetRef,
  uploadConfigOf,
  uploadInputAccepts,
} from "./input-asset.js";
import { withTimeout } from "./bounded-step.js";
import { SINGLE_NODE_INFO_OUTCOME } from "./single-node-def.js";

/** Inputs whose combo lists name files on disk, rather than modes like
 *  `sampler_name: [euler, …]`. A value outside ANY combo's options is a genuine
 *  problem, but only these are missing ASSETS, and calling a bad scheduler a
 *  missing model would be its own dishonest report. Detected from the options
 *  themselves — a filename carries an extension — never from the input name, so a
 *  pack using its own naming is judged on what it actually offers. */
const FILE_LIKE = /\.[A-Za-z0-9_]{2,12}$/;

/** Existing production type-scoped object-info reads use this same concurrency. */
const LIVE_SCAN_BATCH_SIZE = 8;

/** The direct helper is also used by focused callers outside the panel IIFE. */
function defaultMonotonicNow() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      const value = performance.now();
      if (Number.isFinite(value)) return value;
    }
  } catch {
    // Fall through to the legacy runtime clock.
  }
  return Date.now();
}

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
 * @returns {Map<string, Array<string|number|boolean>>|null} widget name -> the allowed
 *   values AS DECLARED (a combo may publish numbers — see `comboOffers`), or null when
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
      // #745 (recurrence) — the option list is read through the ONE canonical
      // reader, not off `def[0]`.
      //
      // `def[0]` is the option array only in the V1 shape `[[...allowed], {opts}]`.
      // A V3-schema node (`IO.Combo.Input`, `@comfytype(io_type="COMBO")`) serializes
      // as `["COMBO", { multiselect, options: [...] }]` — the literal type string sits
      // at `def[0]` and the list lives under the config — so `Array.isArray(def[0])`
      // filed every one of them under "not a combo" and the scan skipped the widget
      // ENTIRELY: no finding, and no `unchecked_nodes` entry either, which is the
      // silent drop this module exists to prevent.
      //
      // MEASURED against this machine's live ComfyUI 0.33.2 /object_info (853 types,
      // 652 combo inputs): the `def[0]` read recognised 61 — every one of them V1.
      // `authoritativeComboValues` recognises 528 (61 V1 + 467 V2), of which 27 are
      // server-declared EMPTY, i.e. exactly the reporter's class of case. The scan was
      // blind to 91% of the combos on the canvas it was asked to judge.
      //
      // Strictness is unchanged in the direction that matters: the reader yields null
      // for a REMOTE V2 (1 input) and a dynamic V3 (123 inputs) because those lists are
      // genuinely unread, so an unread list is never mistaken for an empty one. Those
      // stay unjudged, exactly as they are today.
      //
      // The list is stored AS DECLARED. Dropping non-strings — which the V1-era read
      // did, harmlessly, because every V1 list on the live server is all-strings —
      // would collapse an INTEGER list to `[]`, and `[]` means "the server enumerates
      // nothing, so every value is unavailable". Measured: 15 inputs publish pure-int
      // lists (`LtxvApiTextToVideo.duration [6,8,…]`, `MinimaxHailuoVideoNode.duration
      // [6,10]`, …) and ALL FIFTEEN are V2, so every one of them would have been a
      // false `missing_asset` introduced by this change and by nothing else.
      if (!Array.isArray(def)) continue;
      const values = authoritativeComboValues(def);
      if (Array.isArray(values)) {
        options.set(name, values);
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

/**
 * #745 — TRUE when the server's list OFFERS `value`, compared the way the SERVER
 * compares it. Type-faithful on purpose: `"10"` is NOT offered by `[6, 8, 10]`.
 *
 * An earlier revision of this fix coerced numeric options to strings so that a widget
 * holding `"10"` matched an option `10`. Review (codex, P1) called that a false
 * negative, and the SERVER settles it. `execution.py` validates a combo with
 *
 *     invalid_vals = [val] if val not in combo_options else []
 *
 * and Python's `in` is `==`, under which `"10" == 10` is **False**. Verified by
 * execution against this machine's ComfyUI 0.33.2 interpreter:
 *
 *     10 in [6,8,10]      -> True     (accepted)
 *     "10" in [6,8,10]    -> False    (rejected: value_not_in_list)
 *     10.0 in [6,8,10]    -> True     (accepted — JS has one number type, so `===`
 *                                      reproduces this for free)
 *
 * So a stringified numeric value is a REAL defect in the graph, not a harmless
 * spelling of a good one, and the coercion was hiding it. The ComfyUI frontend
 * stringifying combo values on queue (Comfy-Org/ComfyUI_frontend#14641) is exactly
 * how a canvas acquires one — which makes reporting it the useful behaviour, since
 * the queue would fail with `Value not in list` and nothing else would have warned.
 *
 * #1634 — when `backslashIsSeparator` is true (the server's OS is Windows), a `\`
 * in a STRING option is a path separator, not a filename character. folder_paths
 * lists nested models with `os.path.relpath` (backslashes on Windows) while
 * workflows store the same file with forward slashes, and the loader resolves
 * either spelling via `os.path`. Treating them as distinct is a false
 * `missing_asset`. Default false (POSIX): a backslash is literal, so `a\b` is
 * NOT `a/b`. Never applied to number/boolean — `"10"` still is not `10`.
 */
export function comboOffers(options, value, { backslashIsSeparator = false } = {}) {
  if (!Array.isArray(options)) return false;
  return options.some((o) => serverConsidersEqual(o, value, backslashIsSeparator));
}

/**
 * Python `==` for the primitive types a combo can carry, because that is the operator
 * `val not in combo_options` actually runs. Two rules, both measured against this
 * machine's ComfyUI 0.33.2 interpreter rather than inferred:
 *
 *   - a string NEVER equals a number or a boolean — `"10" == 10` is False, and that
 *     is what makes a stringified value a real defect rather than a spelling (#14641);
 *   - a BOOLEAN equals a number when it equals it numerically, because `bool` is a
 *     subclass of `int`: `True == 1` and `False == 0` are both True.
 *
 * The second rule is the one that keeps the boolean fix from becoming a false positive:
 *
 *     True  in [False]      -> False   (report)      True  in [1, 2]  -> True  (clean)
 *     False in [False]      -> True    (clean)       False in [1, 2]  -> False (report)
 *     True  in [True,False] -> True    (clean)       False in [0, 1]  -> True  (clean)
 *
 * A bare `===` would call `true` unavailable on options `[1, 2]`, which the server
 * accepts. JS has one number type, so `10 == 10.0` needs nothing extra.
 */
function serverConsidersEqual(option, value, backslashIsSeparator = false) {
  if (option === value) return true;
  if (
    backslashIsSeparator &&
    typeof option === "string" &&
    typeof value === "string" &&
    option.replace(/\\/g, "/") === value.replace(/\\/g, "/")
  ) {
    return true;
  }
  // bool <-> number only. Never string <-> anything.
  const a = typeof option === "boolean" ? (option ? 1 : 0) : option;
  const b = typeof value === "boolean" ? (value ? 1 : 0) : value;
  return typeof a === "number" && typeof b === "number" && a === b;
}

/**
 * `fetchClassInfo` receives `(className, signal)`. Production forwards that signal
 * to the panel API, so a shared-budget timeout can cancel the underlying fetch;
 * callers that do not accept the second argument still get the bounded fallback.
 */
export async function scanComboAvailability(
  nodes,
  fetchClassInfo,
  {
    maxClasses = 80,
    maxAssetProbes = 48,
    budgetMs = 0,
    now = defaultMonotonicNow,
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
  const startedAt = now();
  const clockUsable = Number.isFinite(startedAt);
  const deadline = budgetMs > 0 && clockUsable ? startedAt + budgetMs : Infinity;
  if (budgetMs > 0 && !clockUsable) outOfBudget = true;

  // One fetch per distinct CLASS, not per node — a canvas with thirty
  // KSamplers must not become thirty requests. The production type-scoped
  // object-info path already proves that eight concurrent class routes are a
  // supported shape; use the same bound here, while charging the whole batch
  // to this scan's one deadline.
  const cache = new Map();
  const classLimit = new Set();
  const budgetLimit = new Set();
  // Every shipped browser has AbortController. If a legacy runtime does not, keep
  // the fallback serial so one unabortable request cannot leave a whole batch live.
  const batchSize = typeof AbortController === "function" ? LIVE_SCAN_BATCH_SIZE : 1;
  const entryFromResponse = (className, response) => {
    let branded = false;
    let kind;
    let body = response;
    try {
      branded = response?.[SINGLE_NODE_INFO_OUTCOME] === true;
      kind = response?.kind;
      if (branded) body = response.body;
    } catch {
      return { reason: "node type could not be looked up (/object_info response was unreadable)" };
    }
    if (branded && kind === "unknown") {
      return { reason: "node type could not be looked up (/object_info call failed)" };
    }
    if (branded && kind === "absent") return { reason: "node type not found in /object_info" };
    const combos = comboInputsOf(body, className);
    if (combos === null) {
      return {
        reason: branded
          ? "node type could not be looked up (/object_info response was malformed)"
          : "node type not found in /object_info",
      };
    }
    return { combos, configs: comboConfigsOf(body, className) ?? new Map() };
  };

  const classNames = new Map();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const className = typeof node?.type === "string" ? node.type : null;
    if (!className || !Array.isArray(node.widgets)) continue;
    if (isFrontendVirtualNode(node) || className === "CustomCombo") continue;
    const priority = (node?.has_errors === true ? 2 : 0) +
      (node?.constructor?.nodeData?.output_node === true ? 1 : 0);
    const previous = classNames.get(className);
    if (!previous || priority > previous.priority) classNames.set(className, { priority, index });
  }
  const orderedClasses = [...classNames.entries()]
    .sort((a, b) => b[1].priority - a[1].priority || a[1].index - b[1].index)
    .map(([className]) => className);
  const allowedClasses = orderedClasses.slice(0, Math.max(0, maxClasses));
  for (const className of orderedClasses.slice(allowedClasses.length)) classLimit.add(className);

  const budgetReason = "not checked: get_errors ran out of its shared server-call budget";
  const fetchBatch = async (batch) => {
    const remaining = deadline - now();
    if (!(remaining > 0)) {
      outOfBudget = true;
      for (const className of batch) budgetLimit.add(className);
      return;
    }
    const run = (className) => {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const request = Promise.resolve()
        .then(() => fetchClassInfo(className, controller?.signal))
        .then(
          (value) => ({ value, settledAt: now() }),
          () => ({ error: true, settledAt: now() }),
        );
      return Number.isFinite(remaining)
        ? withTimeout(request, remaining, () => {
            try {
              controller?.abort();
            } catch {
              // A broken AbortController cannot turn a bounded step into a hang.
            }
            return null;
          })
        : request;
    };
    const results = await Promise.all(batch.map((className) => run(className)));
    for (let i = 0; i < batch.length; i += 1) {
      const result = results[i];
      if (!result || result.error || !Number.isFinite(result.settledAt) || result.settledAt > deadline) {
        const overBudget = !result || !Number.isFinite(result?.settledAt) || result.settledAt > deadline;
        outOfBudget = outOfBudget || overBudget;
        if (overBudget) budgetLimit.add(batch[i]);
        else cache.set(batch[i], { reason: "node type could not be looked up (/object_info call failed)" });
        continue;
      }
      cache.set(batch[i], entryFromResponse(batch[i], result.value));
    }
  };

  for (let offset = 0; offset < allowedClasses.length; offset += batchSize) {
    const batch = allowedClasses.slice(offset, offset + batchSize);
    if (outOfBudget || !(now() < deadline)) {
      outOfBudget = true;
      for (const className of allowedClasses.slice(offset)) budgetLimit.add(className);
      break;
    }
    await fetchBatch(batch);
  }

  const comboMapFor = (className) => {
    if (cache.has(className)) return cache.get(className);
    if (classLimit.has(className)) {
      truncated += 1;
      return { reason: `not checked: this call's ${maxClasses}-node-type lookup cap was reached` };
    }
    if (budgetLimit.has(className) || outOfBudget) {
      truncated += 1;
      return { reason: budgetReason };
    }
    truncated += 1;
    return { reason: "not checked: get_errors could not schedule this node type lookup" };
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
    // panel#1651 — CustomCombo choices are authored by the frontend widget. Its
    // intentionally empty server COMBO list is not evidence that the selected
    // frontend value names a missing asset, so /object_info has no authority here.
    if (className === "CustomCombo") continue;
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
      // #745 (codex P1) — a NUMERIC value is judged, not skipped.
      //
      // This read was `typeof value !== "string"`, which silently passed every numeric
      // combo as clean: `duration: 99` against options `[6, 8, 10]` produced NO finding,
      // while the server rejects it with `value_not_in_list`. Before this branch that
      // was unreachable — all 44 numeric options on the live server sit on V2 combos the
      // scan could not read at all — so teaching the scan to READ numeric lists without
      // also teaching it to JUDGE numeric values left the seam open on the far side.
      // A false NEGATIVE on get_errors is the failure this tool exists to prevent.
      //
      // Gate round 2 (codex P1) extended this to BOOLEANS for the same reason: with
      // `options: [false]` and a widget holding `true`, the server rejects and the scan
      // was returning clean. Judging them requires the bool/int rule in `comboOffers` —
      // without it `true` on options `[1, 2]` would be reported, and the server ACCEPTS
      // that. No live combo declares boolean options (measured: string 2630, number 44,
      // boolean 0), so this closes the shape rather than a sighting.
      //
      // Still skipped: `null`/`undefined`, an empty string, and any object. `0` and
      // `false` are real combo values and must NOT be dropped by a truthiness test.
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      if (value === "") continue;
      if (comboOffers(options, value, { backslashIsSeparator })) continue;
      // #1357 — before calling it missing, check whether this combo could have
      // listed it at all. Only a STRING can name a file, so a numeric value skips
      // straight to the verdict rather than through the annotated-filepath parser.
      const asset =
        typeof value === "string"
          ? await adjudicateUnenumerableAsset(entry.configs?.get(name), value)
          : null;
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
