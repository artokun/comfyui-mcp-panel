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
 * #1447 — a pack that currently PROVIDES types cannot be the reason a different
 * type is missing. ReActorFaceSwap had just been added when `panel_add_node`
 * VideoToImages appended "comfyui-reactor-node FAILED TO IMPORT". That sentence
 * is only true of a pack that registered NONE of its nodes; a live
 * `python_module` on /object_info is the proof it did. Drop those before naming
 * them. Remaining failures still do not prove ownership of the requested type,
 * so the note says so in the type's own words.
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

/**
 * What to add to a missing-node message once the import failures are known.
 *
 * Empty when nothing failed — then "install the pack" really is the best advice
 * available, and adding a hedge would only dilute it.
 *
 * `opts.liveDefs` drops packs that currently provide types (#1447).
 * `opts.forType` names the missing class so a leftover failure is labelled
 * unrelated rather than read as its cause.
 */
export function importFailureNote(failed, opts = {}) {
  const relevant = dropLivePackImportFailures(
    failed,
    opts && typeof opts === "object" ? opts.liveDefs : undefined,
  );
  if (relevant.length === 0) return "";
  const list = relevant.join(", ");
  const plural = relevant.length > 1;
  const forType = opts && typeof opts.forType === "string" ? opts.forType.trim() : "";
  const ownership = forType
    ? ` This does not prove ${plural ? "they provide" : "it provides"} "${forType}" — ` +
      `the failure may be unrelated.`
    : ` This does not prove ${plural ? "they own" : "it owns"} the ` +
      `missing types; it is the first thing to rule out.`;
  return (
    ` BEFORE INSTALLING ANYTHING: ComfyUI reported that ${plural ? "these packs" : "this pack"} ` +
    `FAILED TO IMPORT at startup — ${list}. A pack that fails to import registers NONE of its ` +
    `nodes, so its node types are missing exactly as if it were not installed, and installing it ` +
    `again will not help. Check the server log (get_system_stats action:"logs") for the ` +
    `ImportError above ${plural ? "those lines" : "that line"} — it is usually a version mismatch ` +
    `between the pack and ComfyUI.` +
    ownership
  );
}
