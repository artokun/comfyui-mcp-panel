import test from "node:test";
import assert from "node:assert/strict";

import {
  redactWidgetValue,
  REDACTED_WIDGET_VALUE,
} from "../../web/js/lib/widget-secret-redaction.js";

test("#1729 redacts conventional credential widget names", () => {
  for (const name of ["api_key", "openaiApiKey", "access-token", "bearer", "token"]) {
    assert.equal(redactWidgetValue(name, "credential-value"), REDACTED_WIDGET_VALUE, name);
  }
  assert.equal(redactWidgetValue("api_key", ""), "", "an unconfigured key stays visibly empty");
  assert.equal(redactWidgetValue("token_count", 128), 128, "ordinary token counters remain visible");
});

test("#1729 redacts unmistakable key/header values even under an ordinary widget name", () => {
  assert.equal(
    redactWidgetValue("provider", "sk-proj-1234567890123456"),
    REDACTED_WIDGET_VALUE,
  );
  assert.equal(
    redactWidgetValue("header", "Bearer abcdefghijklmnop"),
    REDACTED_WIDGET_VALUE,
  );
});

test("#1729 preserves ordinary visible widget values and does not mutate them", () => {
  const value = "Use the phrase 'api_key' in the prompt; this is not a credential.";
  assert.equal(redactWidgetValue("prompt", value), value);
  const object = { toggled: true };
  assert.equal(redactWidgetValue("toggle", object), object);
});
