// comfyui-mcp#1571, second half — `panel_run { to_node_id: 183 }` refused with:
//
//   "run-to-node scope for node 183 cannot be dispatched safely: the prompt could not be
//    fingerprinted (graphToPrompt failed)"
//
// The refusal is correct: no fingerprint means the panel cannot tell its own dispatch from
// unrelated queue traffic, so it fails closed (#556). What was wrong is that it threw the
// reason away. `dispatchScopedRun` wrapped `app.graphToPrompt()` in `try { … } catch { }`
// with an empty binding, so ComfyUI's own `InvalidLinkError: No link found in parent graph
// for id [302:192] slot [0] conditioning` — which names the offending node outright — was
// caught and discarded one line before the message that needed it.
//
// The cost is visible in the report itself: the reporter titled it "nested run-to-node
// cannot fingerprint" and asked for "fingerprinting nested output targets" to be
// supported. Nesting was never involved. Their graph had been left unserializable by a
// subgraph conversion, and a FULL `panel_run` on the same graph failed the same way.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  scopeUnattributableError,
  describeFingerprintFailure,
} from "../../web/js/lib/run-scope-guard.js";

/** The error ComfyUI_frontend 1.48.7 actually throws for the reported graph. */
const INVALID_LINK = new Error(
  "No link found in parent graph for id [302:192] slot [0] conditioning",
);
INVALID_LINK.name = "InvalidLinkError";

test("#1571 the serializer's own message reaches the caller", () => {
  const msg = scopeUnattributableError({ toNodeId: 183, cause: INVALID_LINK });
  assert.match(msg, /No link found in parent graph for id \[302:192\] slot \[0\] conditioning/);
  // …and the refusal it is embedded in is unchanged: still fail-closed, still #556.
  assert.match(msg, /run-to-node scope for node 183 cannot be dispatched safely/);
  assert.match(msg, /Nothing was queued/);
  assert.match(msg, /#556/);
});

test("#1571 the quote is attributed, so it does not read as the panel's own diagnosis", () => {
  const msg = scopeUnattributableError({ toNodeId: 183, cause: INVALID_LINK });
  assert.match(msg, /ComfyUI's serializer failed with/);
  assert.match(msg, /the frontend's own error, not the panel's diagnosis/);
});

test("#1571 the refusal contradicts the theory the silence created", () => {
  // The reporter's conclusion was that run-to-node cannot handle NESTED targets. Whatever
  // else this message says, it has to say that much is not the cause.
  const msg = scopeUnattributableError({ toNodeId: 183, cause: INVALID_LINK });
  assert.match(msg, /not specific to run-to-node or to nesting/);
});

test("#1571 with nothing thrown, no cause is invented", () => {
  // This path also fires when nothing threw at all — a frontend with no `graphToPrompt`,
  // or a prompt that canonicalizes to nothing. Attaching a cause there would be the same
  // defect pointed the other way: a reporter sent to fix a graph that is fine.
  for (const nothing of [undefined, null, "", "   ", new Error(""), 42, {}]) {
    const msg = scopeUnattributableError({ toNodeId: 7, cause: nothing });
    assert.match(msg, /could not be fingerprinted/, String(nothing));
    assert.doesNotMatch(msg, /ComfyUI's serializer failed with/, String(nothing));
    assert.doesNotMatch(msg, /No link found/, String(nothing));
  }
  // The historical call shape — no argument at all — must still produce the old message.
  assert.match(scopeUnattributableError({ toNodeId: 7 }), /cannot be dispatched safely/);
  assert.doesNotMatch(scopeUnattributableError({ toNodeId: 7 }), /serializer failed with/);
});

test("#1571 a string cause is accepted as well as an Error", () => {
  // Not every layer that can fail here throws an Error object.
  assert.match(describeFingerprintFailure("boom from an extension"), /boom from an extension/);
});

test("#1571 a runaway serializer message cannot bury the instruction", () => {
  const huge = new Error("x".repeat(5000));
  const msg = scopeUnattributableError({ toNodeId: 1, cause: huge });
  assert.ok(msg.length < 1500, `refusal must stay readable, was ${msg.length} chars`);
  assert.match(msg, /…/, "a truncated quote must show that it was truncated");
  assert.match(msg, /Nothing was queued/, "the instruction must survive the quote");
});

test("#1571 a multi-line stack-ish message is flattened, not pasted raw", () => {
  const cause = new Error("InvalidLinkError:\n  at resolveInput\n\n  at getInnerNodes");
  const msg = describeFingerprintFailure(cause);
  assert.doesNotMatch(msg, /\n/);
  assert.match(msg, /InvalidLinkError: at resolveInput at getInnerNodes/);
});

// ── WIRING. `describeFingerprintFailure` is inert unless the catch that swallows the error
//    actually binds it and passes it on. That is a `catch {` → `catch (err) {` change and a
//    single argument — invisible to every assertion above.

const guardSrc = () =>
  readFileSync(new URL("../../web/js/lib/run-scope-guard.js", import.meta.url), "utf8");

test("#1571 the fingerprint catch BINDS what was thrown", () => {
  const s = guardSrc();
  const at = s.indexOf("contentCanon = canonicalizePrompt((await app.graphToPrompt())?.output");
  assert.ok(at > 0, "the fingerprint call must still be recognisable");
  // Bounded by the refusal it feeds, not by a byte count (#1472/#1460/#1582: fixed windows
  // in this repo have reported missing wiring that was present three separate times).
  const end = s.indexOf("scopeUnattributableError({", at);
  assert.ok(end > at, "the unattributable refusal must still follow the fingerprint");
  const block = s.slice(at, end);
  assert.doesNotMatch(block, /\}\s*catch\s*\{/, "the catch must not discard the error again");
  assert.match(block, /catch \(err\) \{/);
  assert.match(block, /fingerprintCause = err;/);
});

test("#1571 the bound error is PASSED to the refusal", () => {
  // Capturing it and not forwarding it is the same as not capturing it.
  assert.match(guardSrc(), /scopeUnattributableError\(\{ toNodeId, cause: fingerprintCause \}\)/);
});
