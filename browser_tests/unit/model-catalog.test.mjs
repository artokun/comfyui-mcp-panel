/**
 * Unit tests for web/js/lib/model-catalog.js — run with `node --test`.
 *
 * Guards #377: the model picker must track the AUTHORITATIVE advertised model
 * ids, not assume a stale `opus` alias is the current Opus.
 *
 * The running orchestrator (old SDK) advertises the `opus` alias resolved to the
 * previous claude-opus-4-8, plus the newer claude-opus-5 as a separate pinned id
 * with no friendly displayName. Pre-fix the picker showed the stale 4.8 alias as
 * the headline "Opus" and rendered claude-opus-5 as a raw-id "Custom model" row.
 * presentableModels now collapses each Claude family to its newest advertised
 * version and derives a clean "Opus 5" label from the pinned id — all from the
 * advertised ids, with no hardcoded model->label map.
 *
 * Also pins the #70 regression (Fable, advertised only as a pinned
 * claude-fable-5[1m] with no alias, must survive) and the up-to-date-SDK path
 * (an `opus` alias already resolving to the newest model keeps the alias and
 * drops the pinned duplicate).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseClaudeModel,
  cmpVersion,
  deriveClaudeLabel,
  normalizeModels,
  presentableModels,
  pickDefaultModel,
  modelLabel,
} from "../../web/js/lib/model-catalog.js";

// The exact list the issue reports the running orchestrator advertising.
function advertisedStaleOpus() {
  return normalizeModels([
    { value: "opus[1m]", displayName: "Opus", description: "Opus 4.8 with 1M context", resolvedModel: "claude-opus-4-8", supportsEffort: true },
    { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5 · Most capable", resolvedModel: "claude-fable-5", supportsEffort: true },
    { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Efficient", resolvedModel: "claude-sonnet-5", supportsEffort: true },
    { value: "haiku", displayName: "Haiku", description: "Haiku 4.5 · Fastest", resolvedModel: "claude-haiku-4-5", supportsEffort: true },
    // The newer Opus, advertised as a bare pinned id the orchestrator can't name.
    { value: "claude-opus-5", description: "Custom model", supportsEffort: true },
  ]);
}

test("parseClaudeModel reads family + version from pinned ids and aliases", () => {
  assert.deepEqual(parseClaudeModel("claude-opus-5", undefined), { family: "opus", version: [5], alias: false });
  assert.deepEqual(parseClaudeModel("claude-opus-4-8", undefined), { family: "opus", version: [4, 8], alias: false });
  assert.deepEqual(parseClaudeModel("claude-fable-5[1m]", undefined), { family: "fable", version: [5], alias: false });
  // Alias reads its effective version from the resolved concrete id.
  assert.deepEqual(parseClaudeModel("opus[1m]", "claude-opus-4-8"), { family: "opus", version: [4, 8], alias: true });
  assert.deepEqual(parseClaudeModel("opus", undefined), { family: "opus", version: null, alias: true });
  assert.equal(parseClaudeModel("gpt-5.6", undefined), null);
  assert.equal(parseClaudeModel("llama3", undefined), null);
});

test("cmpVersion orders versions, null lowest", () => {
  assert.ok(cmpVersion([5], [4, 8]) > 0); // 5 > 4.8
  assert.ok(cmpVersion([4, 8], [4, 7]) > 0);
  assert.equal(cmpVersion([5], [5]), 0);
  assert.ok(cmpVersion(null, [1]) < 0);
  assert.ok(cmpVersion([1], null) > 0);
});

test("deriveClaudeLabel builds a clean id-derived family label", () => {
  assert.equal(deriveClaudeLabel("opus", [5]), "Opus 5");
  assert.equal(deriveClaudeLabel("opus", [4, 8]), "Opus 4.8");
  assert.equal(deriveClaudeLabel("fable", [5]), "Fable 5");
  assert.equal(deriveClaudeLabel("opus", null), "Opus");
});

test("#377: newer pinned claude-opus-5 becomes the first-class 'Opus 5'; stale 4.8 alias is dropped", () => {
  const rows = presentableModels(advertisedStaleOpus());
  const ids = rows.map((r) => r.id);
  // The newer Opus survives; the stale alias resolving to 4.8 is gone.
  assert.ok(ids.includes("claude-opus-5"), "claude-opus-5 must be present");
  assert.ok(!ids.includes("opus[1m]"), "stale opus->4.8 alias must be dropped");

  const opus5 = rows.find((r) => r.id === "claude-opus-5");
  assert.equal(opus5.label, "Opus 5", "raw-id row is relabeled from its id, not left as 'Custom model'");
  assert.notEqual(opus5.small, "Custom model", "generic 'Custom model' tag is dropped");

  // The rest of the families survive with their curated labels intact.
  assert.ok(ids.includes("sonnet"));
  assert.ok(ids.includes("haiku"));
  assert.ok(ids.includes("claude-fable-5[1m]"));
  assert.equal(rows.find((r) => r.id === "claude-fable-5[1m]").label, "Fable");
});

test("#377: pickDefaultModel selects the newest Opus, never the stale alias", () => {
  const rows = presentableModels(advertisedStaleOpus());
  assert.equal(pickDefaultModel(rows), "claude-opus-5");
  // Even against the raw (un-collapsed) list, version-awareness wins.
  assert.equal(pickDefaultModel(advertisedStaleOpus()), "claude-opus-5");
});

test("up-to-date SDK: an `opus` alias already at the newest model keeps the alias, drops the pinned duplicate", () => {
  const rows = presentableModels(
    normalizeModels([
      { value: "opus", displayName: "Opus", description: "most capable", resolvedModel: "claude-opus-5", supportsEffort: true },
      { value: "claude-opus-5", resolvedModel: "claude-opus-5", supportsEffort: true },
      { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true },
    ]),
  );
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("opus"), "the clean alias is kept when it is the newest");
  assert.ok(!ids.includes("claude-opus-5"), "the pinned duplicate of the alias is dropped");
});

test("versionless alias (no resolvedModel) is NOT dropped just because a newer pinned sibling exists", () => {
  // Codex self-gate catch: without a resolvedModel we have no evidence the `opus`
  // alias is older than claude-opus-5, so it must survive (don't hide a usable row).
  const rows = presentableModels(
    normalizeModels([
      { value: "opus", displayName: "Opus", description: "most capable", supportsEffort: true }, // no resolvedModel
      { value: "claude-opus-5", description: "Custom model", supportsEffort: true },
    ]),
  );
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("opus"), "versionless alias must be kept (no proof it's stale)");
  assert.ok(ids.includes("claude-opus-5"), "the newer pinned id is also kept and relabeled");
  assert.equal(rows.find((r) => r.id === "claude-opus-5").label, "Opus 5");
});

test("a `-fast` speed variant is a distinct model — never collapsed into its base version", () => {
  // Codex self-gate catch: claude-opus-5-fast must survive alongside claude-opus-5.
  const rows = presentableModels(
    normalizeModels([
      { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5", supportsEffort: true },
      { value: "claude-opus-5", resolvedModel: "claude-opus-5", supportsEffort: true },
      { value: "claude-opus-5-fast", displayName: "Opus 5 (fast)", resolvedModel: "claude-opus-5-fast", supportsEffort: true },
    ]),
  );
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("opus"), "the alias at the newest version is kept");
  assert.ok(!ids.includes("claude-opus-5"), "the pinned duplicate of the alias is dropped");
  assert.ok(ids.includes("claude-opus-5-fast"), "the -fast variant is a distinct model, kept");
  assert.equal(rows.find((r) => r.id === "claude-opus-5-fast").label, "Opus 5 (fast)");
});

test("#70 regression: Fable advertised only as a pinned id (no alias) survives", () => {
  const rows = presentableModels(
    normalizeModels([
      { value: "default" },
      { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5", supportsEffort: true },
      { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5", supportsEffort: true },
    ]),
  );
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes("default"), "synthetic default is dropped");
  assert.ok(ids.includes("claude-fable-5[1m]"), "Fable pinned id must survive");
});

test("bare family aliases with no version info and non-Claude rows pass through untouched", () => {
  const rows = presentableModels(
    normalizeModels([
      { value: "sonnet", displayName: "Sonnet", supportsEffort: true }, // no resolvedModel
      { value: "haiku", displayName: "Haiku", supportsEffort: true },
      { value: "qwen3:4b", displayName: "Qwen3 4B" }, // Ollama — not Claude
    ]),
  );
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, ["sonnet", "haiku", "qwen3:4b"]);
});

test("modelLabel resolves a presented id to its label, else the id", () => {
  const rows = presentableModels(advertisedStaleOpus());
  assert.equal(modelLabel(rows, "claude-opus-5"), "Opus 5");
  assert.equal(modelLabel(rows, "sonnet"), "Sonnet");
  assert.equal(modelLabel(rows, "nope"), "nope");
});
