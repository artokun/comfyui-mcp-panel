import { readComfyLogText } from "./comfy-log.js";

/**
 * panel#771 — ComfyUI knows exactly why a save failed and does not tell the
 * client. It tells its own log. So read the log.
 *
 * `app/user_manager.py`, `post_userdata` — the only 400 on the write path:
 *
 *     except OSError as e:
 *         logging.warning(f"Error saving file '{path}': {e}")
 *         return web.Response(
 *             status=400,
 *             reason="Invalid filename. Please avoid special characters like :\/*?\"<>|"
 *         )
 *
 * Any OSError — a full disk, an unwritable directory, a read-only mount, an fd
 * limit — becomes one 400 that blames the FILENAME. The reporter's name was
 * `wan22_flf_seg1_alone_to_reaching`, which has no special character in it, and
 * they were told to avoid special characters.
 *
 * The real cause is one `logging.warning` away, and `/internal/logs/raw` serves
 * it. Verified end to end against the live rig (ComfyUI 0.30.2) by provoking a
 * genuine OSError — a path too long for the filesystem, which ComfyUI cleans up
 * after itself:
 *
 *     HTTP/1.1 400 Invalid filename. Please avoid special characters like :\/*?"<>|
 *     log: Error saving file 'C:\…\workflows\wwww….json': [WinError 3] The system
 *          cannot find the path specified: 'C:\…'
 *
 * READING IS NOT KNOWING. If the log cannot be fetched, does not go back far
 * enough, or holds no line for THIS file, that is "I could not find out" and it
 * is reported as such — never as "there was no reason". The 400 still surfaces
 * with the standing explanation either way; this only ever adds an observation.
 */

/** ComfyUI colourises its log; the raw feed carries the escape codes. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The last `Error saving file '<path>': <cause>` line that refers to THIS file.
 *
 * Matched on the file path rather than on recency alone: the log is a shared
 * ring, and a warning from an unrelated save would otherwise be attributed to
 * this one — a wrong cause is worse than no cause, because it will be acted on.
 *
 * @param {string} logText the raw log feed
 * @param {string} relPath e.g. "workflows/name.json" — the server logs an
 *   ABSOLUTE path, so this is matched as a suffix with either separator
 * @returns {string|null} the cause exactly as the server wrote it
 */
export function extractSaveFailureCause(logText, relPath) {
  if (typeof logText !== "string" || !logText) return null;
  if (typeof relPath !== "string" || !relPath) return null;
  const wanted = relPath.replace(/^[/\\]+/, "").replace(/\\/g, "/").toLowerCase();
  if (!wanted) return null;

  let found = null;
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    const at = line.indexOf("Error saving file '");
    if (at === -1) continue;
    const rest = line.slice(at + "Error saving file '".length);
    const close = rest.indexOf("':");
    if (close === -1) continue;
    const loggedPath = rest.slice(0, close).replace(/\\/g, "/").toLowerCase();
    if (!loggedPath.endsWith(wanted)) continue;
    const cause = rest.slice(close + 2).trim();
    // A line with an empty cause is not an answer; keep looking for a real one.
    if (cause) found = cause;
  }
  return found;
}

/**
 * Fetch the log and pull out the cause. Never throws, never blocks a save error.
 *
 * @param {string} relPath
 * @param {(route: string) => Promise<{ status?: number, json?: () => Promise<unknown>, text?: () => Promise<string> }>} fetchApi
 */
export async function readSaveFailureCause(relPath, api) {
  // #775 — the log is NOT under /api; see readComfyLogText. Passing
  // api.fetchApi here is what made this a silent no-op in a real browser.
  const text = await readComfyLogText(api);
  if (!text) return null;
  return extractSaveFailureCause(text, relPath);
}

/**
 * What to append once the cause is known — or once it is known to be unknown.
 *
 * The two sentences are deliberately different in kind. With a cause, the reader
 * is told the server's own words and that the filename advice was wrong. Without
 * one, they are told the lookup did not find anything, which is not the same as
 * the filename being at fault.
 */
export function describeSaveFailureCause(cause) {
  if (typeof cause === "string" && cause.trim()) {
    return (
      ` THE SERVER'S OWN REASON, read from its log: ${cause.trim()} — that is the` +
      ` actual failure. The "invalid filename" text in the 400 is a fixed string ComfyUI` +
      ` returns for every filesystem error, so disregard it unless the line above mentions` +
      ` the name.`
    );
  }
  return (
    ` The server-side reason could NOT be read (its log was unavailable, or holds no` +
    ` "Error saving file" line for this path — the log is a short ring and may have` +
    ` scrolled). That is not evidence the filename is at fault; it means the real cause` +
    ` is still unknown from here.`
  );
}
