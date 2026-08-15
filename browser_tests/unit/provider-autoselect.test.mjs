import test from "node:test";
import assert from "node:assert/strict";
import { providerDiscoveryDecision } from "../../web/js/lib/provider-autoselect.js";

const provider = (backend, available, extra = {}) => ({
  backend,
  ready: available,
  available,
  ...extra,
});

test("waits for the completed orchestrator discovery snapshot", () => {
  assert.equal(
    providerDiscoveryDecision({
      backends: [provider("codex", true)],
      discoveryComplete: false,
    }).action,
    "wait",
  );
});

test("keeps a saved provider only while it remains available", () => {
  const kept = providerDiscoveryDecision({
    backends: [provider("codex", true), provider("ollama", true)],
    selectedBackend: "codex",
    hasSavedChoice: true,
    discoveryComplete: true,
  });
  assert.equal(kept.action, "keep");

  const gone = providerDiscoveryDecision({
    backends: [provider("codex", false), provider("ollama", true)],
    selectedBackend: "codex",
    hasSavedChoice: true,
    discoveryComplete: true,
  });
  assert.deepEqual({ action: gone.action, backend: gone.backend }, { action: "select", backend: "ollama" });
});

test("selects one candidate and asks for an explicit choice among several", () => {
  const one = providerDiscoveryDecision({
    backends: [provider("codex", false), provider("ollama", true)],
    discoveryComplete: true,
  });
  assert.deepEqual({ action: one.action, backend: one.backend }, { action: "select", backend: "ollama" });

  const many = providerDiscoveryDecision({
    backends: [provider("codex", true), provider("ollama", true)],
    discoveryComplete: true,
  });
  assert.equal(many.action, "choose");
  assert.deepEqual(many.candidates.map((entry) => entry.backend), ["codex", "ollama"]);
});

test("excludes experimental, hidden, disabled, and stopped providers", () => {
  const result = providerDiscoveryDecision({
    backends: [
      provider("copilot", true, { experimental: true }),
      provider("hidden", true, { hidden: true }),
      provider("disabled", true),
      provider("ollama", false, { ready: true }),
    ],
    discoveryComplete: true,
    enabled: (id) => id !== "disabled",
  });
  assert.equal(result.action, "none");
});

test("uses ready as the compatibility fallback only on an explicitly complete frame", () => {
  const result = providerDiscoveryDecision({
    backends: [{ backend: "codex", ready: true }],
    discoveryComplete: true,
  });
  assert.deepEqual({ action: result.action, backend: result.backend }, { action: "select", backend: "codex" });
});
