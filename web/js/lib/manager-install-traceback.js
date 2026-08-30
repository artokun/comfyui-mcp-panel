import { readComfyLogText } from "./comfy-log.js";

/**
 * #2012 — `panel_install_node` hid the Manager install cause behind a
 * generic sentence.
 *
 * ComfyUI-Manager's `do_install` (glob/manager_server.py) has two failure
 * arms that leave the HTTP history almost empty:
 *
 *   * ManagedResult failure logs
 *     `[ComfyUI-Manager] Installation failed:\n{res.msg}`
 *     and returns `res.msg`. When `res.msg` itself is empty or just
 *     "Installation failed", the task result is that one-liner.
 *   * Exception path calls `traceback.print_exc()` and returns
 *     `Installation failed:\n{node_spec_str}` — the spec is the pack id,
 *     not the cause. The traceback is the whole record.
 *
 * The task-history helpers in manager-install.js correctly surface whatever
 * the Manager stored. That store is the generic sentence. This module reads
 * `/internal/logs/raw` (same transport as #1320/#771/#775) and pulls out the
 * traceback / `res.msg` so the tool result is the evidence, not a pointer
 * to the log.
 *
 * Never throws. A miss is `null` / `""`, which the caller reports as "we
 * could not find a traceback" rather than inventing a cause.
 */

// Built from the code point, never written as a literal escape. Same reason
// as pack-import-failures.js / userdata-failure-cause.js / manager-update-traceback.js:
// a raw 0x1B in the source is invisible in a diff and one mangling edit away
// from matching nothing.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/** Caps so a noisy log cannot overflow the tool result. Fixed; no parameter
 *  raises them. The full traceback remains in the ComfyUI server console. */
export const INSTALL_TRACEBACK_MAX_LINES = 40;
export const INSTALL_TRACEBACK_LINE_CAP = 500;

/**
 * Is this the one-liner Manager stores as the task result — i.e. the case
 * where the real evidence is only in the server log?
 *
 * Matches "Installation failed" alone, or with only a node spec after the
 * colon (`rgthree-comfy`, `rgthree-comfy@nightly`). A sentence that already
 * carries a cause ("Installation failed: Failed to clone repo: …") is NOT
 * generic — fetching the log would only add latency.
 */
export function isGenericManagerInstallError(reason) {
  if (typeof reason !== "string" || !reason) return false;
  const s = reason.trim();
  if (/^installation failed(?:\s*:\s*[\w.@/-]+)?\.?$/i.test(s)) return true;
  return /reported the task as failed \(no detail provided\)/i.test(s);
}

function stripAnsi(line) {
  return typeof line === "string" ? line.replace(ANSI, "") : "";
}

function isTracebackStart(line) {
  return /Traceback \(most recent call last\):/.test(line);
}

/** A line that continues a Python traceback (indented frames, chained-exception
 *  markers, or the `SomeError: message` terminator). Deliberately does NOT
 *  match Manager's `ERROR: … Installation failed` log line — that is a logging
 *  level, not a Python exception type (`Error` vs `ERROR`). */
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
  const sliced = raw.length > INSTALL_TRACEBACK_MAX_LINES ? raw.slice(-INSTALL_TRACEBACK_MAX_LINES) : raw;
  const lines = sliced.map((l) =>
    l.length > INSTALL_TRACEBACK_LINE_CAP ? `${l.slice(0, INSTALL_TRACEBACK_LINE_CAP)}…` : l,
  );
  let out = lines.join("\n").trim();
  if (!out) return null;
  if (raw.length > INSTALL_TRACEBACK_MAX_LINES) {
    out = `(traceback truncated to last ${INSTALL_TRACEBACK_MAX_LINES} lines)\n${out}`;
  }
  return out;
}

function mentionsPack(block, packId) {
  // Quoted (`KeyError: 'pack'`), a node spec (`pack@nightly`), or a path
  // segment. A bare substring would attribute `rgthree-comfy-extra`'s crash
  // to a pack named `rgthree`.
  const id = packId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:['"\`]${id}(?:@[\\w.-]+)?['"\`]|[\\\\/]${id}(?:[\\\\/.'"\`]|$)|\\b${id}@)`,
    "i",
  ).test(Array.isArray(block) ? block.join("\n") : String(block ?? ""));
}

function mentionsInstallHandler(block) {
  return /\bdo_install\b|\binstall_by_id\b/.test(
    Array.isArray(block) ? block.join("\n") : String(block ?? ""),
  );
}

function isInstallFailedLine(line) {
  const s = stripAnsi(line);
  return /\[ComfyUI-Manager\]\s*Installation failed/i.test(s) ||
    /(?:^|\bERROR:)\s*.*Installation failed/i.test(s);
}

/** The ERROR line plus the `res.msg` Manager logged on the following lines. */
function collectFailedBlock(lines, start) {
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && i <= start + 15; i++) {
    const s = stripAnsi(lines[i]);
    if (isTracebackStart(s)) break;
    if (isInstallFailedLine(s)) break;
    if (/^\s*(?:\d{4}-\d{2}-\d{2}.+)?(?:ERROR|WARNING|INFO|DEBUG)\b/.test(s) &&
      !/Installation failed/i.test(s)) break;
    if (/\[ComfyUI-Manager\]/.test(s) && !/Installation failed/i.test(s)) break;
    out.push(lines[i]);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * The last traceback / Installation-failed block in `logText` that belongs
 * to an install of `packId`.
 *
 * Correlation, in order:
 *   1. The last `[ComfyUI-Manager] Installation failed` line whose following
 *      `res.msg` lines (or a traceback immediately above) NAME this pack.
 *      Keep the traceback and the failed block — the block carries `res.msg`.
 *   2. Otherwise the last traceback that NAMES this pack (quoted, as a path
 *      segment, or as `pack@version`). A frame that merely says `do_install`
 *      is not enough — that would steal a neighbour's crash.
 *
 * @param {string} logText raw /internal/logs feed
 * @param {string} packId the pack we asked Manager to install
 * @returns {string|null}
 */
export function extractInstallTraceback(logText, packId) {
  if (typeof logText !== "string" || !logText) return null;
  if (typeof packId !== "string" || !packId) return null;

  const lines = logText.split(/\r?\n/).map(stripAnsi);

  let anchor = -1;
  let anchorTbStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isInstallFailedLine(lines[i])) continue;
    const block = collectFailedBlock(lines, i);
    let tbStart = -1;
    for (let j = i; j >= 0 && j >= i - 80; j--) {
      if (isTracebackStart(lines[j])) {
        tbStart = j;
        break;
      }
    }
    const tb = tbStart >= 0 ? collectTracebackAt(lines, tbStart) : null;
    // The ERROR line itself does not name the pack (unlike do_update). A
    // nearby traceback that does not name it either is somebody else's.
    if (mentionsPack(block, packId) || (tb && mentionsPack(tb, packId))) {
      anchor = i;
      anchorTbStart = tb && (mentionsPack(tb, packId) || mentionsInstallHandler(tb) || tbStart >= i - 15)
        ? tbStart
        : -1;
    }
  }

  if (anchor >= 0) {
    const parts = [];
    if (anchorTbStart >= 0) {
      const block = collectTracebackAt(lines, anchorTbStart);
      if (block) parts.push(block.join("\n").trimEnd());
    }
    const failed = collectFailedBlock(lines, anchor);
    const detail = failed.join("\n").trim();
    if (detail && !parts.some((p) => p.includes(detail))) parts.push(detail);
    return boundTraceback(parts.join("\n"));
  }

  let last = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isTracebackStart(lines[i])) continue;
    const block = collectTracebackAt(lines, i);
    // No Installation-failed line for THIS pack: only a traceback that NAMES
    // the pack is ours. Matching any do_install frame would steal a neighbour's
    // crash (the exception arm prints the pack in the KeyError / fail text
    // when it has one).
    if (block && mentionsPack(block, packId)) last = block;
  }
  return last ? boundTraceback(last.join("\n")) : null;
}

/**
 * Fetch the log and pull out this pack's install traceback. Never throws.
 *
 * @param {string} packId
 * @param {{ fileURL?: (route: string) => string }} api
 * @returns {Promise<string|null>}
 */
export async function readInstallTraceback(packId, api) {
  const text = await readComfyLogText(api);
  if (!text) return null;
  return extractInstallTraceback(text, packId);
}
