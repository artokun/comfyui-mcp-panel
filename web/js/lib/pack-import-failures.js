import { readComfyLogText } from "./comfy-log.js";

/**
 * panel#775/#778 — a missing node type is not proof of a missing PACK.
 *
 * `apiLoadNote` told the reader to "install the custom-node pack that provides
 * it". I followed that advice on my own machine and it was wrong: the pack WAS
 * installed, and had failed to import.
 *
 *     File ".../ComfyUI-LTXVideo/embeddings_connector.py", line 7, in <module>
 *     ImportError: cannot import name 'interleaved_freqs_cis'
 *                  from 'comfy.ldm.lightricks.model'
 *     [INFO] 0.0 seconds (IMPORT FAILED): .../ComfyUI-LTXVideo
 *
 * I reported that as a missing dependency in the pack's manifest, on a public
 * issue, and had to correct it. The node was in the pack's NODE_CLASS_MAPPINGS
 * the whole time. What made it convincing was that the OTHER LTX nodes resolved
 * — they come from core `comfy_extras`, so 34 of 35 types were present and
 * exactly the pack-provided one was not. A broken install looked like a bad
 * manifest.
 *
 * ComfyUI logs this plainly at startup. So read it instead of guessing: when
 * types are missing AND a pack failed to import, that pack is the far likelier
 * cause, and "install it" is advice that cannot work.
 *
 * This NAMES what failed; it does not claim the failed pack owns the missing
 * types. Establishing that needs the pack's NODE_CLASS_MAPPINGS, which is not
 * readable from the browser — so the wording stays at "check these first".
 *
 * #1544 CORRECTS THAT LAST PARAGRAPH. A pack's class list IS readable from the
 * browser: ComfyUI-Manager's `/customnode/getmappings` is keyed pack →
 * [[classNames…], meta], and the panel had been fetching that very payload for
 * panel_search_nodes while throwing the class list away. Because ownership looked
 * unknowable, every caller settled for a hedge — and a hedge in the last sentence
 * did not stop `panel_add_node PreviewVideo` from reading as "coldinfire_fal_privacy
 * is why". So ownership is now CHECKED (`packsProvidingType`): a pack the map ties
 * to the requested type is named as the cause outright, and one it does not is
 * presented as a separate problem, up front, in the first clause the reader sees.
 *
 * #1447 — a pack that currently PROVIDES types cannot be the reason a different
 * type is missing. ReActorFaceSwap had just been added when `panel_add_node`
 * VideoToImages appended "comfyui-reactor-node FAILED TO IMPORT". That sentence
 * is only true of a pack that registered NONE of its nodes; a live
 * `python_module` on /object_info is the proof it did. Drop those before naming
 * them. Remaining failures still do not prove ownership of the requested type,
 * so the note says so in the type's own words.
 *
 * #1523 — a subgraph UUID is never provided by a custom-node pack. Naming
 * whatever pack happened to fail import (ReActor, on a canvas whose missing
 * type was Image Segmentation (SAM3)) is the same misdiagnosis. No ownership
 * mapping can link a pack to a UUID type, so the note stays off.
 */

// Built from the code point, never written as a literal escape. The first
// version of this line carried a raw 0x1B byte in the source: functional, but
// invisible in a diff and one mangling edit away from silently matching
// nothing. The control-byte scan is what caught it.
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g");

/** `[INFO] 0.0 seconds (IMPORT FAILED): <path>` — ComfyUI's own startup summary. */
const IMPORT_FAILED = /\(IMPORT FAILED\):\s*(.+?)\s*$/;

/**
 * Packs ComfyUI reported as failing to import, newest last, de-duplicated.
 *
 * @param {string} logText raw /internal/logs feed
 * @returns {string[]} pack names (the final path segment), never full paths —
 *   an absolute path leaks the user's directory layout into a message they may
 *   paste into a public issue.
 */
export function packsThatFailedToImport(logText) {
  if (typeof logText !== "string" || !logText) return [];
  const out = [];
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    const m = IMPORT_FAILED.exec(line);
    if (!m) continue;
    const name = m[1].split(/[/\\]/).filter(Boolean).pop();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Fetch the log and extract the failures. Never throws.
 *
 * @param {(route: string) => Promise<{ status?: number, json?: () => Promise<unknown>, text?: () => Promise<string> }>} fetchApi
 */
export async function readPackImportFailures(api) {
  // #775 — the log is NOT under /api; see readComfyLogText. Passing
  // api.fetchApi here is what made this a silent no-op in a real browser.
  const text = await readComfyLogText(api);
  if (!text) return [];
  return packsThatFailedToImport(text);
}

/** Folder-name key: case, hyphens and underscores are the same pack. */
function packKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * `python_module` is `custom_nodes.<folder>` or `custom_nodes.<folder>.<sub>`.
 * The folder is the same path segment the IMPORT FAILED log line names.
 * Core modules (`nodes`, `comfy_extras.*`) are not packs.
 */
function packKeyFromPythonModule(pythonModule) {
  const s = String(pythonModule || "").trim();
  const m = /^(?:custom_nodes)[./]([^./\\]+)/i.exec(s);
  return m ? packKey(m[1]) : "";
}

/**
 * Packs whose IMPORT FAILED line is contradicted by the live backend: at least
 * one current /object_info entry carries their folder as `python_module`.
 *
 * A pack that registered types did not "register NONE of its nodes", so naming
 * it as the reason a *different* type is missing is the #1447 misdiagnosis.
 * No `python_module` evidence leaves the list unchanged — fail open toward the
 * #775 note rather than silently drop a real failure.
 *
 * @param {string[]} failed pack names from the log
 * @param {object|null|undefined} liveDefs current /object_info map (or absent)
 * @returns {string[]}
 */
export function dropLivePackImportFailures(failed, liveDefs) {
  if (!Array.isArray(failed) || failed.length === 0) return [];
  if (!liveDefs || typeof liveDefs !== "object") return failed.slice();
  const live = new Set();
  for (const def of Object.values(liveDefs)) {
    const key = packKeyFromPythonModule(def && typeof def === "object" ? def.python_module : "");
    if (key) live.add(key);
  }
  if (live.size === 0) return failed.slice();
  return failed.filter((name) => !live.has(packKey(name)));
}

/** A subgraph definition id, never a pack-provided class name (#1523). */
const SUBGRAPH_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The pack folder a ComfyUI-Manager node-map KEY corresponds to.
 *
 * Manager keys the map by whatever identifies the pack in its catalogue, and both
 * shapes occur in one payload (observed on a live 5583-entry map): a repo URL
 * (`https://github.com/0velia/ComfyUI-Dynamic-Dropdowns`) and a bare registry id
 * (`llm-toolkit`). Manager clones into a folder named after that last segment, which
 * is the SAME segment the `(IMPORT FAILED)` log line prints — so the final path
 * component, `.git` stripped, is what the two sides have in common. Normalised
 * through `ownerKey` — case-folded, separators KEPT — see there for why the looser
 * `packKey` merges packs that are genuinely different projects.
 */
function packKeyFromNodeMapKey(key) {
  const s = String(key || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  if (!s) return "";
  const seg = s.split(/[/\\]/).filter(Boolean).pop() || s;
  return ownerKey(seg.replace(/\.git$/i, ""));
}

/**
 * The identity an OWNERSHIP claim is matched on: case-folded, separators KEPT.
 *
 * Deliberately stricter than `packKey`, which strips every non-alphanumeric. That
 * loose form is right for #1447 — it matches a pack folder against ITSELF across
 * case and separator drift — but it is wrong here, because it merges packs that are
 * genuinely different projects. `ComfyUI-OmniSVG` (A043-studios) and
 * `ComfyUI_OmniSVG` (smthemex) are separate repos by separate authors and collapse
 * to one key; so do `ComfyUI-QwenVL`, `ComfyUI-Qwen-VL` and `ComfyUI_QwenVL`.
 * Promoting on that would name the WRONG pack as a proven cause — #1544's own bug,
 * restated with more confidence.
 *
 * Measured on the live 5583-entry map: under `packKey`, 79 normalised keys are
 * claimed by more than one catalogue entry and 72 of those disagree about class
 * names. Keeping separators takes that to 3, and costs nothing — the installed
 * folder hit rate is 59/75 either way, because Manager clones into a folder named
 * after the repo, separators and all.
 */
function ownerKey(name) {
  return String(name || "").trim().toLowerCase();
}

/**
 * Pack keys that ComfyUI-Manager's node map says PROVIDE `forType`.
 *
 * The map (`/customnode/getmappings`) is keyed pack → [[classNames…], meta]; that
 * class-name array is the ownership evidence this module previously recorded as
 * unreadable from a browser. It is readable — the panel already fetches this exact
 * payload for panel_search_nodes (`parseNodeMappings`), which consumed only the meta
 * object and discarded the class list.
 *
 * POSITIVE EVIDENCE ONLY, deliberately. The converse — "the map knows this pack and
 * its class list omits the type, therefore it is not the owner" — is NOT sound: on
 * the machine this was measured on, 4 of the 59 installed packs the map recognises
 * share no class at all with their own live /object_info entries, because the
 * catalogue lags a pack's current release. Acting on that would silently discard
 * real import failures — the #775 fault with its sign flipped. So a match PROMOTES a
 * failure to "the cause"; a non-match only declines to promote it.
 *
 * @param {unknown} nodeMap raw `/customnode/getmappings` payload (or null)
 * @param {string} forType requested class_type
 * @returns {Set<string>} normalised pack keys
 */
export function packsProvidingType(nodeMap, forType) {
  const type = String(forType || "").trim();
  const out = new Set();
  if (!type || !nodeMap || typeof nodeMap !== "object") return out;
  // ONLY the documented MAP shape, key → [[classNames…], meta]. `parseNodeMappings`
  // also accepts an ARRAY of pack objects, but it reads ids and titles from those —
  // it never reads a class list, and no array payload carrying one was observed
  // here. Inventing a field name for it would be a guess, and a wrong guess reads as
  // "no owner", which is the branch that already handles not knowing. So an array
  // simply yields no owners and the caller says ownership was not established.
  if (Array.isArray(nodeMap)) return out;
  // UNANIMITY among every catalogue entry sharing an owner key. Keeping separators
  // leaves 3 keys still claimed by entries that disagree about class names, and a
  // single one of those is enough to name the wrong pack with confidence. So a key
  // owns the type only when EVERY entry filed under it provides it: aliases of one
  // pack agree and still promote; two different projects that collide do not.
  const byKey = new Map();
  for (const [key, val] of Object.entries(nodeMap)) {
    const classes = Array.isArray(val) ? val[0] : null;
    if (!Array.isArray(classes)) continue;
    const pk = packKeyFromNodeMapKey(key);
    if (!pk) continue;
    const seen = byKey.get(pk) || { entries: 0, providing: 0 };
    seen.entries += 1;
    if (classes.includes(type)) seen.providing += 1;
    byKey.set(pk, seen);
  }
  for (const [pk, seen] of byKey) {
    if (seen.providing > 0 && seen.providing === seen.entries) out.add(pk);
  }
  return out;
}

/**
 * How many packs a node-map payload actually let us CHECK — entries carrying a
 * class-name array.
 *
 * Counted rather than assumed because a 200 is not a catalogue. #808 measured this
 * on the search path: ComfyUI-Manager answers `{}` when it built its list from none
 * of channel, cache or bundled copy, and a captive proxy can answer 200 with a
 * sign-in page. Both survive a `typeof === "object"` test, and treating either as a
 * consulted map turns "we did not check" into "we checked and found nothing" — the
 * same class of unearned claim #1544 is about, one layer down.
 *
 * @param {unknown} nodeMap raw `/customnode/getmappings` payload
 * @returns {number}
 */
export function nodeMapPackCount(nodeMap) {
  if (!nodeMap || typeof nodeMap !== "object" || Array.isArray(nodeMap)) return 0;
  let n = 0;
  for (const val of Object.values(nodeMap)) {
    if (Array.isArray(val) && Array.isArray(val[0])) n++;
  }
  return n;
}

/**
 * The failures a note would actually name: log failures minus the ones the live
 * backend contradicts (#1447), and none at all for a subgraph UUID (#1523).
 *
 * Exported so a caller can decide whether fetching the node map is worth it BEFORE
 * paying for it — that payload is ~1.4 MB, and there is nothing to adjudicate when
 * this comes back empty.
 */
export function relevantPackImportFailures(failed, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const forType = typeof o.forType === "string" ? o.forType.trim() : "";
  // #1523 — a UUID class_type is a subgraph definition, not a pack-provided node.
  // The note would name an unrelated failed pack with no possible ownership link.
  if (forType && SUBGRAPH_UUID.test(forType)) return [];
  return dropLivePackImportFailures(failed, o.liveDefs);
}

/**
 * What to add to a missing-node message once the import failures are known.
 *
 * Empty when nothing failed — then "install the pack" really is the best advice
 * available, and adding a hedge would only dilute it.
 *
 * `opts.liveDefs` drops packs that currently provide types (#1447).
 * `opts.forType` names the missing class so a leftover failure is labelled
 * unrelated rather than read as its cause. A subgraph UUID forType yields
 * no note at all (#1523) — ownership mapping cannot link a pack to it.
 * `opts.nodeMap` is ComfyUI-Manager's node map; it is what PROMOTES a failure from
 * an unrelated diagnostic to the stated cause (#1544).
 *
 * #1544 — the note used to open with "BEFORE INSTALLING ANYTHING: ComfyUI reported
 * that this pack FAILED TO IMPORT" for ANY unknown type, and hedge only in its last
 * sentence. A reporter asking for `PreviewVideo` was told `coldinfire_fal_privacy`
 * had failed to import; the two have nothing to do with each other, and a leading
 * sentence outweighs a trailing qualifier. So the causal framing is now earned
 * rather than assumed: it appears only for a pack the node map ties to this exact
 * class_type, and every other failure is presented as what it is — a real problem
 * worth fixing that does not explain THIS missing type.
 */
export function importFailureNote(failed, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const forType = typeof o.forType === "string" ? o.forType.trim() : "";
  const relevant = relevantPackImportFailures(failed, o);
  if (relevant.length === 0) return "";

  // Plurality follows the packs the sentence actually NAMES, not every failure in
  // the log — a causal note names only the owner, so "those lines" would point the
  // reader at log lines the message never mentioned.
  const howToReadTheLog = (count) =>
    `Check the server log (get_system_stats action:"logs") for the ImportError above ` +
    `${count > 1 ? "those lines" : "that line"} — it is usually a version ` +
    `mismatch between the pack and ComfyUI.`;

  // EARNED CAUSE — the map ties one of these packs to this exact class_type. Only
  // the owner is named: the other failures are real, but they are not what this add
  // ran into, and listing them here would re-create the #1544 ambiguity inside the
  // one message that finally has a definite answer. A workflow LOAD still reports
  // every failure (the no-forType branch below).
  const owners = packsProvidingType(o.nodeMap, forType);
  const owning = owners.size ? relevant.filter((name) => owners.has(ownerKey(name))) : [];
  if (owning.length) {
    const many = owning.length > 1;
    return (
      ` BEFORE INSTALLING ANYTHING: "${forType}" is provided by ${owning.join(", ")}, and ` +
      `ComfyUI reported that ${many ? "those packs" : "it"} FAILED TO IMPORT at startup. ` +
      `A pack that fails to import registers NONE of its nodes, so its node types are missing ` +
      `exactly as if it were not installed, and installing it again will not help. ` +
      howToReadTheLog(owning.length) +
      ` (Ownership is from ComfyUI-Manager's node map.)`
    );
  }

  const list = relevant.join(", ");
  const plural = relevant.length > 1;

  // NO REQUESTED TYPE — the workflow-load path (#775), where the note explains a SET
  // of missing types rather than one. There is nothing to establish ownership
  // against, so this keeps its original wording.
  if (!forType) {
    return (
      ` BEFORE INSTALLING ANYTHING: ComfyUI reported that ${plural ? "these packs" : "this pack"} ` +
      `FAILED TO IMPORT at startup — ${list}. A pack that fails to import registers NONE of its ` +
      `nodes, so its node types are missing exactly as if it were not installed, and installing it ` +
      `again will not help. ` +
      howToReadTheLog(relevant.length) +
      ` This does not prove ${plural ? "they own" : "it owns"} the ` +
      `missing types; it is the first thing to rule out.`
    );
  }

  // UNEARNED — say so FIRST, so the pack name cannot be read as the answer. Which
  // check came up short is stated exactly: a map that was read and did not link the
  // pack is different evidence from a map that could not be read at all, and the
  // reader's next step differs accordingly.
  // #808's lesson, applied to ownership: a 200 is not a catalogue. Manager answers
  // `{}` when it assembled its list from none of its three sources, and a proxy can
  // answer 200 with something that is not a catalogue at all. Both are objects, so
  // "did we get a map" cannot be `typeof === object` — that would report "the map
  // does not link it to that type" about a map that listed nothing, asserting a
  // check that never ran. Count the packs the payload actually let us check.
  const checkable = nodeMapPackCount(o.nodeMap);
  const gotAnObject = !!o.nodeMap && typeof o.nodeMap === "object";
  const why = checkable
    ? `ComfyUI-Manager's node map does not link ${plural ? "them" : "it"} to that type`
    : gotAnObject
      ? `ComfyUI-Manager returned no usable node catalogue, so ownership could not be checked`
      : `ComfyUI-Manager's node map could not be read, so ownership was not checked`;
  return (
    ` SEPARATE ISSUE, not the cause of this missing type: ComfyUI reported that ` +
    `${plural ? "these packs" : "this pack"} FAILED TO IMPORT at startup — ${list}. ` +
    `Nothing ties ${plural ? "them" : "it"} to "${forType}" — ${why} — so do not reinstall ` +
    `${plural ? "them" : "it"} expecting "${forType}" to appear. ` +
    // #775's advice is still owed to the reader — a failed import is a real fault
    // whoever hits this should fix, and re-installing is a dead end for it whether
    // or not it owns the type they asked for. Demoting the CAUSAL claim must not
    // quietly drop the remedy that made the note worth writing.
    `${plural ? "Those failures are" : "That failure is"} still worth fixing on ${
      plural ? "their" : "its"
    } own: a pack that fails to import registers NONE of its nodes, and installing ` +
    `${plural ? "them" : "it"} again will not help. ` +
    howToReadTheLog(relevant.length)
  );
}
