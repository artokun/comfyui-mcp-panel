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

/**
 * What to add to a missing-node message once the import failures are known.
 *
 * Empty when nothing failed — then "install the pack" really is the best advice
 * available, and adding a hedge would only dilute it.
 */
export function importFailureNote(failed) {
  if (!Array.isArray(failed) || failed.length === 0) return "";
  const list = failed.join(", ");
  const plural = failed.length > 1;
  return (
    ` BEFORE INSTALLING ANYTHING: ComfyUI reported that ${plural ? "these packs" : "this pack"} ` +
    `FAILED TO IMPORT at startup — ${list}. A pack that fails to import registers NONE of its ` +
    `nodes, so its node types are missing exactly as if it were not installed, and installing it ` +
    `again will not help. Check the server log (get_system_stats action:"logs") for the ` +
    `ImportError above ${plural ? "those lines" : "that line"} — it is usually a version mismatch ` +
    `between the pack and ComfyUI. This does not prove ${plural ? "they own" : "it owns"} the ` +
    `missing types; it is the first thing to rule out.`
  );
}
