// panel#771 — ComfyUI knows why a save failed and tells its log, not the client.
//
// `post_userdata` answers EVERY OSError with one 400 whose reason is a fixed
// string blaming the filename, then logs the real cause:
//
//     logging.warning(f"Error saving file '{path}': {e}")
//
// The reporter's name was `wan22_flf_seg1_alone_to_reaching` — not a special
// character in it — and they were told to avoid special characters.
//
// The fixtures below are REAL. Captured from the live rig (ComfyUI 0.30.2) by
// provoking a genuine OSError (a path too long for the filesystem, which ComfyUI
// cleans up after itself), then reading /internal/logs/raw.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  extractSaveFailureCause,
  readSaveFailureCause,
  describeSaveFailureCause,
} from "../../web/js/lib/userdata-failure-cause.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

// ESC is built from its code point, never written as an escape sequence. An
// earlier revision of this file had its escapes mangled in transit: the regex
// collapsed to an empty `//` — which matches everything, so the assertion proved
// nothing — and literal 0x1B bytes were written into the source. Neither is
// visible in a diff, and the tests still passed.
const ESC = String.fromCharCode(27);

/** Exactly what the rig logged, colour codes and all. */
const REAL_LINE =
  `${ESC}[1m${ESC}[33m[WARNING]${ESC}[0m Error saving file ` +
  "'C:\\Users\\Artokun\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\user\\default\\workflows\\report.json': " +
  "[WinError 3] The system cannot find the path specified: 'C:\\Users\\Artokun\\tmp9xk'";

test("#771 the real cause is pulled out of the real log line", () => {
  const cause = extractSaveFailureCause(REAL_LINE, "workflows/report.json");
  assert.match(cause, /\[WinError 3\] The system cannot find the path specified/);
  // The 400's own reason must not leak in — that is the misleading part.
  assert.doesNotMatch(cause, /Invalid filename/);
});

test("#771 colour codes do not defeat the match, or leak into the cause", () => {
  // On the rig the reset lands before the message, so FINDING the line survives
  // without stripping — but the escape a colouriser puts at the END of the record
  // lands INSIDE the extracted cause and would be shown to the reader as part of
  // the server's reason. Found by mutation: removing the strip killed nothing
  // until this case existed.
  assert.ok(extractSaveFailureCause(REAL_LINE, "workflows/report.json"));

  const trailing =
    `${ESC}[33m[WARNING]${ESC}[0m Error saving file '/u/workflows/r.json': ` +
    `[Errno 28] No space left on device${ESC}[0m`;
  const cause = extractSaveFailureCause(trailing, "workflows/r.json");
  assert.equal(cause, "[Errno 28] No space left on device", "no escape bytes in what we print");
  assert.ok(!cause.includes(ESC), "an escape byte must never reach the reader");
});

test("#771 the SEPARATOR does not matter — the server logs an absolute native path", () => {
  const posix =
    "[WARNING] Error saving file '/home/u/ComfyUI/user/default/workflows/a b.json': " +
    "[Errno 28] No space left on device";
  assert.match(extractSaveFailureCause(posix, "workflows/a b.json"), /No space left on device/);
  // A Windows path matched against a posix-style relative path, and vice versa.
  assert.ok(extractSaveFailureCause(REAL_LINE, "workflows\\report.json"));
});

test("#771 a line for a DIFFERENT file is never attributed to this save", () => {
  // The log is a shared ring. A wrong cause is worse than no cause, because it
  // will be acted on — someone would go free up disk over another tab's failure.
  const other =
    "[WARNING] Error saving file '/home/u/user/default/workflows/somebody-else.json': " +
    "[Errno 28] No space left on device";
  assert.equal(extractSaveFailureCause(other, "workflows/report.json"), null);
});

test("#771 the LAST matching line wins", () => {
  // A retry logs again; the newest entry describes the attempt just made.
  const log = [
    "[WARNING] Error saving file '/u/workflows/r.json': [Errno 13] Permission denied",
    "[WARNING] Error saving file '/u/workflows/r.json': [Errno 28] No space left on device",
  ].join("\n");
  assert.match(extractSaveFailureCause(log, "workflows/r.json"), /No space left/);
});

test("#771 nothing to find returns null, and null is NOT a verdict", () => {
  assert.equal(extractSaveFailureCause("", "workflows/r.json"), null);
  assert.equal(extractSaveFailureCause("some unrelated log\n", "workflows/r.json"), null);
  assert.equal(extractSaveFailureCause(REAL_LINE, ""), null);
  assert.equal(extractSaveFailureCause(null, "workflows/r.json"), null);
  // A line with an empty cause is not an answer either.
  assert.equal(
    extractSaveFailureCause("Error saving file '/u/workflows/r.json': ", "workflows/r.json"),
    null,
  );
});

test("#771 a partial suffix must not match a different file", () => {
  // "report.json" must not be satisfied by "big-report.json".
  const log = "[WARNING] Error saving file '/u/workflows/big-report.json': [Errno 28] full";
  assert.equal(extractSaveFailureCause(log, "workflows/report.json"), null);
});

test("#771 readSaveFailureCause reads the log WITHOUT the /api prefix", async () => {
  // The transport was the bug. api.fetchApi prefixes /api and this endpoint is
  // not there, so this feature was a silent no-op in every real browser — the
  // message always said "the server-side reason could NOT be read" — while these
  // tests passed against an injected fake that did no URL rewriting.
  const calls = [];
  const realFetch = globalThis.fetch;
  const api = { fileURL: (r) => `/base${r}` };
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ entries: [{ m: REAL_LINE }] }) };
    };
    assert.match(await readSaveFailureCause("workflows/report.json", api), /WinError 3/);
    assert.deepEqual(calls, ["/base/internal/logs/raw"], "fileURL is honoured");
    assert.ok(!calls[0].includes("/api/"), "the /api prefix is what 404s");

    // Every failure mode still yields null rather than throwing — this runs on
    // the way out of an already-failed save.
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await readSaveFailureCause("workflows/report.json", api), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await readSaveFailureCause("workflows/report.json", api), null);
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error("bad"); } });
    assert.equal(await readSaveFailureCause("workflows/report.json", api), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(await readSaveFailureCause("workflows/report.json", undefined), null);
});

test("#771 with a cause, the message says the filename advice was wrong", () => {
  const note = describeSaveFailureCause("[Errno 28] No space left on device");
  assert.match(note, /THE SERVER'S OWN REASON/);
  assert.match(note, /No space left on device/);
  assert.match(note, /fixed string ComfyUI returns for every filesystem error/);
});

test("#771 WITHOUT a cause it says so, and does NOT blame the filename", () => {
  // The whole point of the issue: not finding the reason is not evidence about
  // the name. This is the sentence that has to stay honest.
  for (const empty of [null, undefined, "", "   "]) {
    const note = describeSaveFailureCause(empty);
    assert.match(note, /could NOT be read/);
    assert.match(note, /not evidence the filename is at fault/);
    assert.doesNotMatch(note, /THE SERVER'S OWN REASON/);
    // Every mention of fault must be the NEGATED one. Found by mutation: adding a
    // "The filename is at fault." sentence left both assertions above passing,
    // which is the exact wrong answer this issue exists to stop.
    for (const m of note.matchAll(/filename is at fault/g)) {
      const before = note.slice(Math.max(0, m.index - 20), m.index);
      assert.match(before, /not evidence the $/, `unqualified fault claim in: ${note}`);
    }
  }
});

test("#771 WIRING: the panel supplies the reader over its own api", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ readSaveFailureCause \} from "\.\/lib\/userdata-failure-cause\.js"/);
  assert.match(src, /readSaveFailureCause: \(path\) => readSaveFailureCause\(path, api\)/);
});
