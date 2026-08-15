import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyManager404, summarizeManagerBody } from "../../web/js/lib/manager-404.js";

/**
 * #706 — a Manager 404 means one of two OPPOSITE things and the panel reported
 * both as "not reachable". The wrong-answer half is bad; the wrong-authorization
 * half is worse (see the module header).
 */

test("the security refusal is NOT classified as route-missing (the #605 re-send guard)", () => {
  // This is the load-bearing assertion of the whole change. `routeMissing` is
  // what authorizes the #605 mutation self-heal to re-send. A security refusal
  // ran a handler, so re-sending would hand the Manager an install it already
  // processed and rejected.
  const r = classifyManager404("A security error has occurred. Please check the terminal logs");
  assert.equal(r.routeMissing, false, "a refusal must never authorize a re-send");
});

test("the security refusal says the Manager IS reachable, and why it declined", () => {
  const r = classifyManager404("A security error has occurred. Please check the terminal logs");
  // The exact failure reported in #706: the user was told the Manager was
  // unreachable while /manager/version answered V3.41 at the same moment.
  assert.ok(!/not reachable/i.test(r.message), "must not claim unreachability");
  assert.match(r.message, /security gate/i);
  assert.match(r.message, /running and reachable/i);
  // The upstream cause must survive into the message — discarding it is the bug.
  assert.match(r.message, /A security error has occurred/);
});

test("a genuine route-missing 404 keeps the old message AND the old flag", () => {
  for (const body of ["", "Not Found", "<html><body>404</body></html>", null, undefined]) {
    const r = classifyManager404(body);
    assert.equal(r.routeMissing, true, `body ${JSON.stringify(body)} must stay route-missing`);
    assert.equal(r.message, "ComfyUI-Manager not reachable (is the built-in Manager enabled?)");
  }
});

test("an unreadable body falls back to route-missing rather than inventing a refusal", () => {
  // Failing back to the conservative pre-#706 classification: we may not claim a
  // security refusal we cannot evidence.
  assert.equal(classifyManager404("").routeMissing, true);
  assert.equal(classifyManager404(123).routeMissing, true);
});

test("matches the phrasing loosely enough to survive 3.x wording drift", () => {
  for (const body of [
    "A security error has occurred. Please check the terminal logs",
    "security error",
    "ERROR: A Security Error Has Occurred",
    "{\"error\":\"a security error has occurred\"}",
  ]) {
    assert.equal(classifyManager404(body).routeMissing, false, body);
  }
});

test("an untrusted body is flattened and capped before it reaches the UI", () => {
  const huge = "security error " + "x".repeat(5000);
  const r = classifyManager404(huge);
  assert.equal(r.routeMissing, false);
  assert.ok(r.message.length < 1200, `message should be bounded, got ${r.message.length}`);
  assert.ok(!/\n/.test(r.message), "must be single-line — no raw newlines from an HTML page");
});

test("summarizeManagerBody collapses whitespace and caps length", () => {
  assert.equal(summarizeManagerBody("  a\n\n  b \t c "), "a b c");
  assert.equal(summarizeManagerBody(""), "");
  assert.equal(summarizeManagerBody(null), "");
  assert.ok(summarizeManagerBody("y".repeat(5000)).endsWith("…"));
});
