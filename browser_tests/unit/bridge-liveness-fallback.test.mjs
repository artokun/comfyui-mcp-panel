// comfyui-mcp#1136 — the status chip read "disconnected" on a working session.
//
// Measured: 9180 LISTENING (HTTP 426 Upgrade Required, the live single-port bridge)
// while comfyui-mcp.bridgeUrl.claude = ws://127.0.0.1:52727 was ECONNREFUSED. With
// defaultBackend "claude" the panel dialed 52727 forever.
//
// Two provenance-based fixes were refused by review before this one: they tried to work
// out WHO chose the URL, and that is not recoverable from what the panel stores. This
// tests the liveness approach — honour the configured URL, and when it will not connect,
// try the bridge that should be there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  bridgeFallbackPlan,
  bridgeFallbackNotice,
  sameBridge,
} from "../../web/js/lib/bridge-liveness-fallback.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEAD = "ws://127.0.0.1:52727";
const LIVE = "ws://127.0.0.1:9180";

test("#1136 the reporter's dead port falls back to the live bridge", () => {
  const plan = bridgeFallbackPlan({ configured: DEAD, fallback: LIVE, attempted: new Set() });
  assert.ok(plan, "a fallback must be offered");
  assert.equal(plan.url, LIVE);
});

test("#1136 it does NOT redial the address that just refused", () => {
  // Would loop, and gains nothing.
  assert.equal(
    bridgeFallbackPlan({ configured: LIVE, fallback: LIVE, attempted: new Set() }),
    null,
  );
  // Trailing-slash and whitespace variants are the same address.
  assert.equal(
    bridgeFallbackPlan({ configured: `${LIVE}/`, fallback: ` ${LIVE} `, attempted: new Set() }),
    null,
  );
});

test("#1136 two dead ports cannot loop", () => {
  // Once we have fallen back to an address, it is never offered again this session.
  const attempted = new Set();
  const first = bridgeFallbackPlan({ configured: DEAD, fallback: LIVE, attempted });
  assert.ok(first);
  attempted.add(first.key);
  assert.equal(bridgeFallbackPlan({ configured: DEAD, fallback: LIVE, attempted }), null);
});

test("#1136 no fallback is invented when none is known", () => {
  for (const fallback of [undefined, null, "", "   "]) {
    assert.equal(bridgeFallbackPlan({ configured: DEAD, fallback, attempted: new Set() }), null);
  }
});

test("#1136 attempted accepts an array as well as a Set", () => {
  assert.equal(
    bridgeFallbackPlan({ configured: DEAD, fallback: LIVE, attempted: [LIVE] }),
    null,
  );
});

test("#1136 the notice names both addresses and explains WHY a URL goes stale", () => {
  const n = bridgeFallbackNotice(DEAD, LIVE);
  assert.match(n, /52727/);
  assert.match(n, /9180/);
  // Without the cause, a bare "trying something else" reads as the panel being flaky.
  assert.match(n, /outlive the process that\s+owned it/);
  assert.match(n, /external-orchestrator mode nothing corrects it/);
});

test("#1136 the notice promises nothing and rewrites nothing", () => {
  const n = bridgeFallbackNotice(DEAD, LIVE);
  // A setting that changes itself is its own bug; say plainly that it did not.
  assert.match(n, /has NOT been changed/);
  assert.match(n, /update it in Settings/);
  // It must not claim the fallback works — it has not been tried yet.
  assert.doesNotMatch(n, /now connected|reconnected successfully/i);
});

test("#1136 sameBridge compares addresses, not strings", () => {
  assert.equal(sameBridge(LIVE, ` ${LIVE}/ `), true);
  assert.equal(sameBridge(LIVE, DEAD), false);
  assert.equal(sameBridge("", ""), false);
  assert.equal(sameBridge(undefined, LIVE), false);
});

test("#1136 WIRING: the fallback runs where liveness is already known", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(
    src,
    /import \{ bridgeFallbackPlan \} from "\.\/lib\/bridge-liveness-fallback\.js";/,
  );
  const at = src.indexOf("function showExternalHintOnce()");
  assert.ok(at > 0, "showExternalHintOnce must exist");
  const body = src.slice(at, at + 2800);
  // It runs precisely because the dial failed — no separate liveness probe needed.
  assert.match(body, /bridgeFallbackPlan\(\{/);
  // The fallback must NOT persist: setUrl saves the URL as the bridge default unless
  // told otherwise, which would both falsify the notice and write the fallback in as a
  // new default that can go stale in turn. Found by review, which asked whether setUrl
  // persists — it does.
  assert.match(body, /client\.setUrl\(plan\.url, \{ persist: false \}\)/);
  assert.match(body, /bridgeFallbacksTried\.add\(plan\.key\)/);
});

test("#1136 WIRING: the 'nobody is listening' hint waits for the fallback to fail too", () => {
  // Telling the user no agent is listening while a fallback is about to be tried is
  // the same over-claim class as the bug: reporting a conclusion before it is earned.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const at = src.indexOf("function showExternalHintOnce()");
  const body = src.slice(at, at + 2800);
  const planAt = body.indexOf("bridgeFallbackPlan({");
  const latchAt = body.indexOf("externalHintShown = true;");
  assert.ok(planAt > -1 && latchAt > -1);
  assert.ok(planAt < latchAt, "the fallback must be attempted before the hint latches");
  assert.match(body, /return; \/\/ the hint is only true once the fallback has failed too/);
});

test("#1136 the notice's promise matches what the code does", () => {
  // The notice says the configured URL was not changed. That is only true because the
  // switch passes { persist: false }; without it setUrl calls saveBridgeUrl and the
  // message becomes a lie — the same defect class as the bug being fixed.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const n = bridgeFallbackNotice(DEAD, LIVE);
  assert.match(n, /has NOT been changed/);
  assert.match(src, /client\.setUrl\(plan\.url, \{ persist: false \}\)/);
});

test("#1136 WIRING: the refuted provenance rule is gone", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.equal((src.match(/isManualBridgeOverride/g) ?? []).length, 0);
  // A saved 9180 is the old compiled default, not a pin — both override sites
  // use isDefaultBridgeUrl so it migrates rather than locking the tab to 9180.
  const rule =
    src.match(/!!wanted && !isDefaultBridgeUrl\(wanted\) && wanted !== lastAutoUrl/g) ??
    [];
  assert.equal(rule.length, 2, "both override sites treat 9180 as default, not a pin");
});
