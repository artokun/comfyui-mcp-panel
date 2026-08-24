import test from "node:test";
import assert from "node:assert/strict";

import {
  redactWidgetValue,
  REDACTED_WIDGET_VALUE,
} from "../../web/js/lib/widget-secret-redaction.js";

test("#1729 redacts conventional credential widget names", () => {
  for (const name of [
    "credential",
    "credentials",
    "credentialValue",
    "secret_key",
    "secretKey",
    "private_key",
    "privateKey",
    "api_key",
    "apiKeys",
    "openaiApiKey",
    "access-token",
    "bearer",
    "token",
  ]) {
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
  assert.deepEqual(redactWidgetValue("toggle", object), object);
  assert.deepEqual(object, { toggled: true });
});

test("#1729 recursively redacts nested credential keys and secret-shaped scalars", () => {
  const value = {
    prompt: "visible prompt",
    nested: {
      credential: "credential-value",
      secretKey: "secret-value",
      private_key: "private-value",
      apiKeys: ["api-key-value"],
      token_count: 3,
      request: [
        { label: "visible label", api_key: "nested-api-key" },
        { label: "visible provider", value: "sk-proj-1234567890123456" },
        "Bearer abcdefghijklmnop",
      ],
    },
  };
  const before = JSON.stringify(value);
  const safe = redactWidgetValue("config", value);

  assert.deepEqual(safe, {
    prompt: "visible prompt",
    nested: {
      credential: REDACTED_WIDGET_VALUE,
      secretKey: REDACTED_WIDGET_VALUE,
      private_key: REDACTED_WIDGET_VALUE,
      apiKeys: [REDACTED_WIDGET_VALUE],
      token_count: 3,
      request: [
        { label: "visible label", api_key: REDACTED_WIDGET_VALUE },
        { label: "visible provider", value: REDACTED_WIDGET_VALUE },
        REDACTED_WIDGET_VALUE,
      ],
    },
  });
  assert.equal(JSON.stringify(value), before, "redaction must not mutate the live widget value");
});

test("#1729 does not reuse an ordinary alias for a sensitive-key alias", () => {
  // The ordinary traversal reaches this object first. The sensitive traversal must
  // still get its own context, or shared.value crosses the api_key boundary raw.
  const shared = { value: "SECRET" };
  const safe = redactWidgetValue("config", { ordinary: shared, api_key: shared });

  assert.equal(safe.ordinary.value, "SECRET", "ordinary visible values remain intact");
  assert.equal(safe.api_key.value, REDACTED_WIDGET_VALUE, "the sensitive alias is redacted");
  assert.notStrictEqual(safe.ordinary, safe.api_key, "different redaction contexts cannot share output");
  assert.equal(shared.value, "SECRET", "the live aliased value is not mutated");
});

test("#1729 preserves aliases and cycles within one redaction context", () => {
  const shared = { value: "visible" };
  const cycle = { value: "visible" };
  cycle.self = cycle;
  const safe = redactWidgetValue("config", { left: shared, right: shared, cycle });

  assert.strictEqual(safe.left, safe.right, "same-context aliases remain aliases");
  assert.strictEqual(safe.cycle.self, safe.cycle, "same-context cycles remain finite and cyclic");
});
