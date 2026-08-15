// #1188 — the credentials console's three requests, bounded.
//
// Same failure as #1161 and #1180: after a ComfyUI or orchestrator restart the tab can hold
// a half-open connection where a request neither answers nor fails, so there is nothing for
// `try/catch` to catch. Here it wedges the UI rather than a command — the button stays
// disabled reading "Saving…" forever, and because the panel only re-enables it in the
// catch, the user cannot retry without reopening the frame.
//
// These are SOURCE assertions. The credentials frame is built inside the 1.7MB panel IIFE
// from DOM handlers that cannot be constructed here, so what is pinned is the shape the
// runtime behaviour depends on. Each assertion below corresponds to a mutation that passed
// before it existed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

/** The helper's body, anchored at both ends so prose cannot drift the window. */
function helperBody() {
  const at = SRC.indexOf("async function cmcpSecretsRequest(init) {");
  assert.ok(at > 0, "cmcpSecretsRequest must be findable");
  const end = SRC.indexOf("\n}", at);
  assert.ok(end > at, "…and terminated");
  // CODE ONLY. The comments in this helper NAME the calls they explain — `resp.json()`,
  // `withTimeout`, `throw` — so a raw scan matches the prose and a mutation that moves real
  // code into a comment slips through. One did: replacing the throw with a return while
  // leaving `// was: throw new Error(` behind passed every assertion.
  return SRC.slice(at, end)
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith("//"))
    .join(String.fromCharCode(10));
}

test("#1188 no credentials request bypasses the bounded helper", () => {
  // The whole fix in one line: if a raw fetch to that endpoint survives anywhere, the site
  // it is on is still unbounded no matter how good the helper is.
  const raw = SRC.split("\n").filter(
    (l) => !l.trim().startsWith("//") && /await\s+fetch\(cmcpApiBase\(\)/.test(l),
  );
  assert.deepEqual(raw, [], `these call sites still bypass the bound:\n${raw.join("\n")}`);
  // …and all three go through it.
  const uses = (SRC.match(/await cmcpSecretsRequest\(/g) || []).length;
  assert.equal(uses, 3, `expected the save, clear and load sites to be bounded, saw ${uses}`);
});

test("#1188 the bound covers the BODY, not just the response head", () => {
  // `fetch` resolves as soon as the head arrives; the bytes stream afterwards inside
  // `json()`. Bounding the request alone leaves the part that actually waits unbounded —
  // which is exactly what shipped in #1180's first attempt at the log read, and passed its
  // tests because they stalled the handshake rather than the body.
  const body = helperBody();
  assert.match(
    body,
    /const resp = await \(init \? fetch\(cmcpApiBase\(\), init\) : fetch\(cmcpApiBase\(\)\)\);\s*\n\s*return \{ resp, body: await resp\.json\(\) \};/,
    "the response read must sit INSIDE the bounded promise, alongside the request",
  );
  const wrapped = body.indexOf("withTimeout(");
  const json = body.indexOf("resp.json()");
  assert.ok(wrapped >= 0 && wrapped < json, "…and withTimeout must enclose it, not follow it");
});

test("#1188 the bound is a real, named, positive number", () => {
  // `withTimeout` treats a non-positive ms as NO bound and returns the promise unchanged, so
  // passing 0 here silently restores the hang while every other assertion still holds. That
  // exact mutation survived on #1180 until it was asserted for.
  assert.match(
    helperBody(),
    /CMCP_SECRETS_TIMEOUT_MS,/,
    "the bound must be the named constant — an inline 0 arms no timer at all",
  );
  const ms = Number((SRC.match(/const CMCP_SECRETS_TIMEOUT_MS = (\d+);/) || [])[1]);
  assert.ok(ms > 0, "a non-positive bound is the same as no bound");
  // A user-initiated write to a possibly-remote console: long enough not to refuse work that
  // would have succeeded, short enough that a wedged console does not look like a dead panel.
  assert.ok(ms >= 3000 && ms <= 15000, `${ms}ms is outside the range this call was sized for`);
});

test("#1188 a timeout REJECTS, so it lands in the handler that re-enables the button", () => {
  // The reason nothing new had to be written in the UI: both call sites already catch, show
  // the message and restore the button. Resolving a sentinel instead would fall through to
  // `!resp.ok` on an undefined `resp` and throw a TypeError whose text is meaningless to a
  // user — a worse message than the one it replaced.
  const body = helperBody();
  assert.match(body, /if \(settled === CMCP_SECRETS_NO_ANSWER\) \{[\s\S]{0,600}?throw new Error\(/, "a stall must throw");
  assert.match(body, /if \("err" in settled\) throw settled\.err;/, "a real failure must keep its own cause");
  // The sentinel must be a Symbol: a string or object could collide with a real body.
  assert.match(SRC, /const CMCP_SECRETS_NO_ANSWER = Symbol\(/, "the sentinel must be unforgeable");
});

test("#1188 the stall message does not mint a catalog key", () => {
  // The English catalog is frozen (#1135) and English is GENERATED from the code, so a new
  // `tr()` key means a pass over eleven locale files. This path already renders the
  // orchestrator's own untranslated `d.error` text through the same `showErr`, so a plain
  // English sentence is consistent with what ships today rather than a coverage regression.
  const body = helperBody();
  assert.doesNotMatch(body, /\btr\(\s*"panel\./, "no new catalog key may be introduced here");
  assert.match(body, /did not respond/, "…but the user must still be told what happened");
});
