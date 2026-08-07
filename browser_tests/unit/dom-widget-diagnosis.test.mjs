import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNonValueBearingWidget } from "../../web/js/lib/widget-write.js";

/**
 * #698 — panel_set_widget on a non-value-bearing DOM widget (PixaromaPrompt's
 * `pix_prompt_ui`) wrote, reverted, and reported "did not retain the requested
 * value" — which reads as transient and retryable when it is structural.
 *
 * The safety property under test is as much about what this does NOT do: it is
 * diagnosis appended to an ALREADY-OBSERVED failure, never a gate. So a plain
 * widget must contribute nothing at all.
 */

test("a plain value widget contributes NO diagnosis (this must never become a gate)", () => {
  // The load-bearing negative. If this ever returns text for an ordinary widget,
  // the message starts blaming DOM-backing for unrelated failures.
  assert.equal(describeNonValueBearingWidget({ name: "seed", value: 5 }), "");
  assert.equal(describeNonValueBearingWidget({ name: "text", value: "", options: {} }), "");
  assert.equal(describeNonValueBearingWidget({ name: "cfg", options: { min: 0, max: 10 } }), "");
});

test("serialize:false alone is NOT treated as non-value-bearing (#715)", () => {
  // LoadImage's `upload` button is serialize:false and perfectly healthy. Gating
  // or blaming on that flag is exactly the false-refusal #715 removed.
  assert.equal(describeNonValueBearingWidget({ name: "upload", serialize: false }), "");
});

test("a DOM-element widget is identified, and the message says retrying will not help", () => {
  const d = describeNonValueBearingWidget({ name: "pix_prompt_ui", element: {} });
  assert.notEqual(d, "");
  assert.match(d, /DOM-backed display widget/i);
  assert.match(d, /Retrying will not help/i);
  // Must point at where the value actually lives — the thing the reporter had to
  // discover by reading the pack's source.
  assert.match(d, /node\.properties/);
});

test("a widget with getValue/setValue accessors is identified even without an element", () => {
  const d = describeNonValueBearingWidget({
    name: "pix_prompt_ui",
    options: { getValue: () => null, setValue: () => {} },
  });
  assert.notEqual(d, "");
  assert.match(d, /getValue\/setValue/);
  assert.match(d, /Retrying will not help/i);
});

test("it never throws on malformed widgets", () => {
  for (const w of [null, undefined, 0, "str", [], { options: null }, { options: 7 }]) {
    assert.doesNotThrow(() => describeNonValueBearingWidget(w));
    assert.equal(typeof describeNonValueBearingWidget(w), "string");
  }
});

test("the diagnosis is a suffix — it never replaces the observed wrote/became facts", () => {
  // The caller appends this to the existing message; it must read as an addition,
  // not as a substitute for the evidence.
  const d = describeNonValueBearingWidget({ name: "x", element: {} });
  assert.ok(d.startsWith(" "), "must append cleanly after the observed-facts sentence");
  assert.ok(!/did not retain/.test(d), "must not restate the observation");
});
