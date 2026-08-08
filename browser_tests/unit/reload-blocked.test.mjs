// panel#701(2) — a commanded frontend reload that never happens must say so.
//
// Reproduced on released builds: panel_reload({scope:"frontend"}) returned
// "soft reload (frontend) scheduled", the orchestrator logged
// `panel tab disconnected`, the page never navigated (no cmcpReload param), and
// the socket never came back. ComfyUI's unsaved-work beforeunload had cancelled
// the navigation after the browser began tearing the socket down, leaving a modal
// waiting for a click nobody knew about.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  armReloadBlockedNotice,
  reloadBlockedMessage,
  RELOAD_BLOCKED_AFTER_MS,
} from "../../web/js/lib/reload-blocked.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** Capture the scheduled callback instead of waiting on a real clock. */
function fakeTimer() {
  const calls = [];
  return { setTimer: (fn, ms) => (calls.push({ fn, ms }), calls.length), calls };
}

test("#701 the notice fires only if the page SURVIVED the deadline", () => {
  const said = [];
  const t = fakeTimer();
  armReloadBlockedNotice({ notify: (m) => said.push(m), setTimer: t.setTimer });
  assert.equal(said.length, 0, "nothing is said at arm time");
  assert.equal(t.calls[0].ms, RELOAD_BLOCKED_AFTER_MS);
  t.calls[0].fn();
  assert.equal(said.length, 1, "surviving the deadline is the evidence");
});

test("#701 a successful reload says NOTHING — the page is gone", () => {
  // The real mechanism: the document is destroyed and the callback never runs.
  // Modelled by a stillHere that reports the page died, which is also the guard
  // against speaking about a page that no longer exists.
  const said = [];
  const t = fakeTimer();
  armReloadBlockedNotice({ notify: (m) => said.push(m), stillHere: () => false, setTimer: t.setTimer });
  t.calls[0].fn();
  assert.equal(said.length, 0);
});

test("#701 it says NOT YET rather than declaring failure", () => {
  // The one false-positive risk is a navigation slower than the deadline. The
  // wording has to survive that case being wrong.
  const msg = reloadBlockedMessage();
  assert.match(msg, /has NOT happened yet/);
  assert.doesNotMatch(msg, /reload failed|could not reload|reload was refused/i);
});

test("#701 it names the likely cause WITHOUT asserting it", () => {
  // This code cannot see which handler cancelled the unload — another pack or a
  // browser extension can register one too. Unsaved work is by far the likeliest
  // and is named as such, not as fact.
  const msg = reloadBlockedMessage();
  assert.match(msg, /almost certainly/);
  assert.match(msg, /unsaved workflows/);
  assert.doesNotMatch(msg, /because you have unsaved work\b/i);
});

test("#701 it tells the reader what to DO, in the browser", () => {
  const msg = reloadBlockedMessage();
  assert.match(msg, /Check the ComfyUI tab/);
  assert.match(msg, /confirm the prompt|confirm\s+the prompt/i);
  assert.match(msg, /save the modified workflows/);
});

test("#701 it warns that the connection may ALREADY have dropped", () => {
  // The socket teardown begins before the dialog resolves, so "the agent looks
  // disconnected" is expected here and would otherwise read as a second fault.
  assert.match(reloadBlockedMessage(), /may already have dropped/);
});

test("#701 a missing notify sink is a no-op, never a throw", () => {
  // This runs on the way out of the page; throwing here would be the worst
  // possible place to fail.
  assert.equal(armReloadBlockedNotice({}), null);
  assert.equal(armReloadBlockedNotice({ notify: "not a function" }), null);
});

test("#701 WIRING: armed BEFORE the navigation, in the frontend branch", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("armReloadBlockedNotice({ notify:");
  const j = src.indexOf('u.searchParams.set("cmcpReload"', i);
  assert.ok(i !== -1, "the notice must be armed in the shipped source");
  assert.ok(j > i, "…and armed BEFORE location.replace, or the page may die first");
  assert.match(src, /import \{ armReloadBlockedNotice \} from "\.\/lib\/reload-blocked\.js"/);
});
