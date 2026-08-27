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

// ---------------------------------------------------------------------------
// #1919 — a token COUNT is a generation control, not a credential.
//
// `max_tokens` normalizes to `max_tokens`, which the #1729 TOKEN name pattern matches
// on its `_tokens` ending, so an ordinary numeric setting came back as [REDACTED] and
// could not be inspected or validated.
//
// The relaxation is keyed on the NAME, not the value's type, and is an allow-list of
// quantity qualifiers so it fails CLOSED. Both properties are pinned below, because
// both are ways this fix could have gone wrong in the direction that leaks.
// ---------------------------------------------------------------------------

test("#1919 token COUNT widgets are visible, whatever type they hold", () => {
  for (const name of [
    "max_tokens",
    "maxTokens",
    "max_new_tokens",
    "min_tokens",
    "num_tokens",
    "n_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "context_tokens",
    "budget_tokens",
  ]) {
    assert.equal(redactWidgetValue(name, 256), 256, `${name} (number) must stay visible`);
    // The reported fix keyed on the value being numeric, which left this case redacted.
    assert.equal(redactWidgetValue(name, "256"), "256", `${name} (string) must stay visible`);
  }
});

test("#1919 FAILS CLOSED: an unqualified token name is still redacted", () => {
  // The qualifier list is an allow-list. A token field it does not name stays secret --
  // including one holding a bare number, which a type-based rule would have revealed.
  for (const [name, value] of [
    ["token", 12345],
    ["token", "sk-abc"],
    ["tokens", 100],
    ["token_value", 5],
    ["token_header", 7],
    ["session_tokens", 42],
  ]) {
    assert.equal(
      redactWidgetValue(name, value),
      REDACTED_WIDGET_VALUE,
      `${name} is not a counted quantity and must stay redacted`,
    );
  }
});

test("#1919 credential names are redacted no matter what qualifies them", () => {
  // SENSITIVE_WIDGET_NAME_RE is tested FIRST and is never relaxed, so a qualifier that
  // would otherwise read as a count cannot unlock a real credential.
  for (const [name, value] of [
    ["access_token", 12345],
    ["refresh_token", 1],
    ["auth_token", 999],
    ["max_access_token", 5],
    ["num_auth_tokens", 3],
    // These match the COUNT allow-list AND the credential list at the same time
    // (`max_token_...` satisfies `<qualifier>_token`). 1152 such names exist over this
    // module`s own vocabulary. They are the ONLY thing that proves the credential check
    // runs FIRST: with the two clauses swapped every one of them is revealed, and every
    // other case in this file passes unchanged.
    ["max_token_api_key", "s3cret"],
    ["max_token_access_token", "s3cret"],
    ["num_tokens_password", "s3cret"],
    ["limit_token_client_secret", "s3cret"],
    ["api_key", 42],
    ["password", 1234],
    ["client_secret", 7],
  ]) {
    assert.equal(
      redactWidgetValue(name, value),
      REDACTED_WIDGET_VALUE,
      `${name} must stay redacted`,
    );
  }
});

test("#1919 ordinary widgets are untouched", () => {
  assert.equal(redactWidgetValue("seed", 12345), 12345);
  assert.equal(redactWidgetValue("steps", 20), 20);
  assert.equal(redactWidgetValue("text", "a prompt about tokens"), "a prompt about tokens");
});
