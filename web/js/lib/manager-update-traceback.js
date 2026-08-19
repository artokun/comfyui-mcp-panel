import { readComfyLogText } from "./comfy-log.js";

/**
 * #1320 — `panel_update_node` hid the Manager update traceback behind a
 * generic sentence.
 *
 * ComfyUI-Manager's `do_update` (glob/manager_server.py) has two failure
 * arms, and BOTH return the same one-liner as the task result:
 *
 *     "An error occurred while updating '<pack>'."
 *
 * The real evidence is written only to the server log:
 *
 *   * ManagedResult failure (`res.result` is false) logs
 *     `ERROR: An error occurred while updating 'X'. (res.result=..., res.action=...)`
 *     — the action is the one extra fact the HTTP history never carries.
 *   * Exception path calls `traceback.print_exc()` and does not even log the
 *     generic sentence. The traceback is the whole record.
 *
 * The task-history helpers in manager-install.js correctly surface whatever
 * the Manager stored. That store is the generic sentence. This module reads
 * `/internal/logs/raw` (same transport as #771/#775) and pulls out the
 * traceback / detailed ERROR line so the tool result is the evidence, not a
 * pointer to the log.
 *
 * Never throws. A miss is `null` / `""`, which the caller reports as "we
 * could not find a traceback" rather than inventing a cause.
 */

// Built from the code point, never written as a literal escape. Same reason
// as pack-import-failures.js / userdata-failure-cause.js: a raw 0x1B in the
// source is invisible in a diff and one mangling edit away from matching
// nothing.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

const GENERIC_UPDATE = /An error occurred while updating\s+'([^']+)'/i;

/** Caps so a noisy log cannot overflow the tool result. Fixed; no parameter
 *  raises them. The full traceback remains in the ComfyUI server console. */
export const UPDATE_TRACEBACK_MAX_LINES = 40;
export const UPDATE_TRACEBACK_LINE_CAP = 500;

/**
 * Is this the one-liner Manager stores as the task result — i.e. the case
 * where the real evidence is only in the server log?
 */
export function isGenericManagerUpdateError(reason) {
  if (typeof reason !== "string" || !reason) return false;
  if (GENERIC_UPDATE.test(reason)) return true;
  return /reported the task as failed \(no detail provided\)/i.test(reason);
}

function stripAnsi(line) {
  return typeof line === "string" ? line.replace(ANSI, "") : "";
}

function samePack(captured, packId) {
  return captured.toLowerCase() === packId.toLowerCase();
}

function isTracebackStart(line) {
  return /Traceback \(most recent call last\):/.test(line);
}

/** A line that continues a Python traceback (indented frames, chained-exception
 *  markers, or the `SomeError: message` terminator). Deliberately does NOT
 *  match Manager's `ERROR: An error occurred while updating ...` log line —
 *  that is a logging level, not a Python exception type (`Error` vs `ERROR`). */
function isTracebackContinuation(line) {
  const s = stripAnsi(line);
  if (!s.trim()) return true;
  if (/^\s/.test(s)) return true;
  if (isTracebackStart(s)) return true;
  if (/During handling of the above exception/.test(s)) return true;
  if (/The above exception was the direct cause/.test(s)) return true;
  return /^[A-Za-z_][\w.]*(Error|Exception|Exit|Warning|Interrupt):/.test(s.trim());
}

function collectTracebackAt(lines, start) {
  if (start < 0 || start >= lines.length || !isTracebackStart(lines[start])) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (!isTracebackContinuation(lines[i])) break;
    out.push(lines[i]);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out : null;
}

function boundTraceback(text) {
  const raw = text.split(/\r?\n/);
  const sliced = raw.length > UPDATE_TRACEBACK_MAX_LINES ? raw.slice(-UPDATE_TRACEBACK_MAX_LINES) : raw;
  const lines = sliced.map((l) =>
    l.length > UPDATE_TRACEBACK_LINE_CAP ? `${l.slice(0, UPDATE_TRACEBACK_LINE_CAP)}…` : l,
  );
  let out = lines.join("\n").trim();
  if (!out) return null;
  if (raw.length > UPDATE_TRACEBACK_MAX_LINES) {
    out = `(traceback truncated to last ${UPDATE_TRACEBACK_MAX_LINES} lines)\n${out}`;
  }
  return out;
}

function mentionsPack(block, packId) {
  // Quoted (`KeyError: 'pack'`) or a path segment — a bare substring would
  // attribute `seedvr2_videoupscaler`'s crash to a pack named `seed`.
  const id = packId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:['"\`]${id}['"\`]|[\\\\/]${id}(?:[\\\\/.'"\`]|$))`, "i").test(
    block.join("\n"),
  );
}

function mentionsUpdateHandler(block) {
  return /\bdo_update\b|\bunified_update\b|\brepo_update\b/.test(block.join("\n"));
}

/**
 * The last traceback / detailed ERROR line in `logText` that belongs to an
 * update of `packId`.
 *
 * Correlation, in order:
 *   1. The last `An error occurred while updating '<packId>'` line (Manager's
 *      own log of this failure). Prefer the traceback immediately above it,
 *      and always keep that line itself — it carries `res.action`.
 *   2. Otherwise the last traceback that NAMES this pack (quoted or as a
 *      path segment). A frame that merely says `do_update` is not enough —
 *      that would steal a neighbour's crash.
 *
 * @param {string} logText raw /internal/logs feed
 * @param {string} packId the pack we asked Manager to update
 * @returns {string|null}
 */
export function extractUpdateTraceback(logText, packId) {
  if (typeof logText !== "string" || !logText) return null;
  if (typeof packId !== "string" || !packId) return null;

  const lines = logText.split(/\r?\n/).map(stripAnsi);

  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = GENERIC_UPDATE.exec(lines[i]);
    if (m && samePack(m[1], packId)) anchor = i;
  }

  if (anchor >= 0) {
    let tbStart = -1;
    for (let i = anchor; i >= 0 && i >= anchor - 80; i--) {
      if (isTracebackStart(lines[i])) {
        tbStart = i;
        break;
      }
    }
    const parts = [];
    if (tbStart >= 0) {
      const block = collectTracebackAt(lines, tbStart);
      // Keep a nearby traceback even if the frames do not name the pack
      // (GitCommandError often does not). A traceback 80 lines back that
      // names neither the pack nor do_update is somebody else's.
      if (
        block &&
        (mentionsPack(block, packId) || mentionsUpdateHandler(block) || tbStart >= anchor - 15)
      ) {
        parts.push(block.join("\n").trimEnd());
      }
    }
    const detail = lines[anchor].trim();
    if (detail && !parts.some((p) => p.includes(detail))) parts.push(detail);
    return boundTraceback(parts.join("\n")) ;
  }

  let last = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isTracebackStart(lines[i])) continue;
    const block = collectTracebackAt(lines, i);
    // No generic ERROR line for THIS pack: only a traceback that NAMES the
    // pack is ours. Matching any do_update frame would steal a neighbour's
    // crash (the exception arm prints the pack in the KeyError / fail text
    // when it has one).
    if (block && mentionsPack(block, packId)) last = block;
  }
  return last ? boundTraceback(last.join("\n")) : null;
}

/**
 * Fetch the log and pull out this pack's update traceback. Never throws.
 *
 * @param {string} packId
 * @param {{ fileURL?: (route: string) => string }} api
 * @returns {Promise<string|null>}
 */
export async function readUpdateTraceback(packId, api) {
  const text = await readComfyLogText(api);
  if (!text) return null;
  return extractUpdateTraceback(text, packId);
}
