// #2044 — CivitAI sign-in failed silently.
//
// The popup ends on a bare browser 403 (ComfyUI's `create_origin_only_middleware`
// rejects the cross-site redirect back from CivitAI on the one branch that logs
// NOTHING), and on this side `_oauthPollIv` polled 120 times at 2s and then simply
// stopped. Four minutes, then nothing: no toast, no error, and an empty ComfyUI
// log. The user is left with a raw 403 and no statement that sign-in failed.
//
// The root cause is not fixed here and this file does not pretend otherwise —
// both real fixes are blocked (the loopback-PKCE route needs a CivitAI app
// registration test only the account owner can run; the middleware-insert route
// reaches into core's middleware list and was deliberately not shipped blind).
// What is fixed is the silence.
//
// Pinned on the shipped bundle: the timeout branch is reachable only after 240s of
// real polling, so a behavioural test would have to fake timers through a module
// that owns its own interval. What can be checked without that is that the branch
// EXISTS, says something, and — the part that matters — does not overclaim.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CIVITAI_UI = join(HERE, "../../web/js/cmcp-civitai-ui.js");
const EN = join(HERE, "../../locales/en/main.json");

const src = readFileSync(CIVITAI_UI, "utf8");

test("#2044 the sign-in poll has an else branch at all", () => {
  // The whole defect: `if (state.signedIn) { … }` with nothing after it, so the
  // give-up path was indistinguishable from success.
  const at = src.indexOf("if (state.signedIn || ++tries > 120)");
  assert.ok(at > -1, "the poll's give-up condition moved — re-point this test");
  const branch = src.slice(at, at + 2400);
  assert.ok(branch.includes("} else {"), "the timeout must not fall through silently");
  assert.ok(branch.includes("civitai_ui.sign_in_timed_out"));
});

test("#2044 the message names the remedy that works today", () => {
  const en = JSON.parse(readFileSync(EN, "utf8"));
  const msg = en?.comfyuiMcpPanel?.civitai_ui?.sign_in_timed_out;
  assert.equal(typeof msg, "string", "the key must be in the generated English catalog");
  // The panel already accepts a CivitAI API token server-side, and that path needs
  // no flag and no registration change — so it is the one to point at.
  assert.match(msg, /API token/i);
});

test("#2044 the message does not CLAIM a 403 it never saw", () => {
  // The popup is cross-origin, so this code cannot read its status. Asserting the
  // 403 would be the same overreach as the silence it replaces, pointing the other
  // way — and it would be wrong for every other reason sign-in can fail (the user
  // closing the popup, declining consent, a network drop).
  const en = JSON.parse(readFileSync(EN, "utf8"));
  const msg = en.comfyuiMcpPanel.civitai_ui.sign_in_timed_out;
  assert.ok(/if the popup showed a 403/i.test(msg), "the cause must be offered conditionally");
  assert.ok(
    !/blocked by comfyui's cross-site protection\./i.test(msg.split("If the popup")[0]),
    "nothing before the conditional may state the cause as fact",
  );
});
