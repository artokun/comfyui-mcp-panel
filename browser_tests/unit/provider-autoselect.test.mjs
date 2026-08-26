import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---------------------------------------------------------------------------
// #1818 — the picker reappeared on every ComfyUI restart AND omitted the
// provider that was actively serving the session (Claude, on macOS).
//
// One cause, both symptoms: the saved provider was looked up in the
// reachable-only list, so a provider the host probe could not see could not
// reach the `keep` branch that suppresses the card.
//
// `readiness` below is the frame the orchestrator ACTUALLY sends for claude on
// a macOS install: `backendReadiness()` returns `ready: true` unconditionally
// (the orchestrator is the Agent SDK host, there is no CLI), and
// `allBackendReadiness()` then sets `available` from `claudeCredentialPresent()`
// — a check for `~/.claude/.credentials.json`, which a Keychain login never
// writes. Do not "simplify" these to the `provider()` helper above: that helper
// ties `ready` and `available` together, which is the one shape that cannot
// reproduce this bug.
const readiness = (backend, { ready, available, ...extra }) => ({
  backend,
  ready,
  ...(available === undefined ? {} : { available }),
  ...extra,
});

const CLAUDE_ON_MACOS = readiness("claude", { ready: true, available: false });
const OLLAMA_RUNNING = readiness("ollama", { ready: true, available: true });

test("#1818 a saved provider the host probe cannot see is kept, not re-decided", () => {
  const result = providerDiscoveryDecision({
    backends: [CLAUDE_ON_MACOS, OLLAMA_RUNNING],
    selectedBackend: "claude",
    hasSavedChoice: true,
    discoveryComplete: true,
  });
  // Symptom 1: no card. `choose` here is the bug.
  assert.equal(result.action, "keep");
  // Symptom 2: the active provider is in the list, not filtered out of it.
  assert.deepEqual(
    result.candidates.map((entry) => entry.backend),
    ["claude", "ollama"],
  );
});

test("#1818 the keep decision does not depend on a live handshake", () => {
  // `connectedBackend` is set from the `models` frame, which the orchestrator
  // pushes only after an uncached SDK model probe; `discovery_complete: true`
  // arrives after three localhost fetches that fail instantly when nothing is
  // listening. On the cold restart this issue is about, discovery wins that race
  // and no handshake has landed. Nothing about the connected backend is passed
  // in here on purpose — `selectedBackend`/`hasSavedChoice` come from
  // localStorage at mount and are present before any frame arrives.
  const result = providerDiscoveryDecision({
    backends: [CLAUDE_ON_MACOS, OLLAMA_RUNNING],
    selectedBackend: "claude",
    hasSavedChoice: true,
    discoveryComplete: true,
  });
  assert.equal(result.action, "keep");
  // And it must NOT quietly move the user onto the one provider the probe CAN
  // see — the reporter's Ollama was not even reachable.
  assert.equal(result.backend, undefined);
});

test("#1818 restarting again re-reads the same state and still does not re-prompt", () => {
  // The reported loop: same localStorage, same frame, card every single time.
  const mount = () =>
    providerDiscoveryDecision({
      backends: [CLAUDE_ON_MACOS, OLLAMA_RUNNING],
      selectedBackend: "claude",
      hasSavedChoice: true,
      discoveryComplete: true,
    }).action;
  assert.deepEqual([mount(), mount(), mount()], ["keep", "keep", "keep"]);
});

test("#1818 a saved provider that is genuinely gone still falls through", () => {
  // An uninstalled codex / signed-out gemini reports ready:false. That is the
  // signal that survives the fix — "your provider disappeared" must keep working,
  // or this change would strand the user on a backend that cannot start.
  const result = providerDiscoveryDecision({
    backends: [readiness("codex", { ready: false, available: false }), OLLAMA_RUNNING],
    selectedBackend: "codex",
    hasSavedChoice: true,
    discoveryComplete: true,
  });
  assert.deepEqual({ action: result.action, backend: result.backend }, {
    action: "select",
    backend: "ollama",
  });
});

test("#1818 an unreachable provider with NO saved choice stays out of the list", () => {
  // The reachability filter is untouched for everyone else: a first run must not
  // start offering installed-but-stopped local daemons. Only an explicit prior
  // choice outranks the probe.
  const result = providerDiscoveryDecision({
    backends: [CLAUDE_ON_MACOS, OLLAMA_RUNNING],
    hasSavedChoice: false,
    discoveryComplete: true,
  });
  assert.deepEqual({ action: result.action, backend: result.backend }, {
    action: "select",
    backend: "ollama",
  });
});

test("#1818 a saved provider the user turned OFF, hid, or that is experimental is not kept", () => {
  // Offerability is absolute — the saved-choice escape hatch is scoped to
  // reachability and must not reach around a Settings opt-out or the
  // never-auto-pick rule that covers copilot.
  const disabled = providerDiscoveryDecision({
    backends: [CLAUDE_ON_MACOS, OLLAMA_RUNNING],
    selectedBackend: "claude",
    hasSavedChoice: true,
    discoveryComplete: true,
    enabled: (id) => id !== "claude",
  });
  assert.equal(disabled.action, "select");
  assert.equal(disabled.backend, "ollama");

  for (const flag of ["hidden", "experimental"]) {
    const result = providerDiscoveryDecision({
      backends: [
        readiness("claude", { ready: true, available: false, [flag]: true }),
        OLLAMA_RUNNING,
      ],
      selectedBackend: "claude",
      hasSavedChoice: true,
      discoveryComplete: true,
    });
    assert.equal(result.action, "select", `${flag} must not be kept`);
    assert.equal(result.backend, "ollama");
  }
});

test("#1818 an older orchestrator that sends no `available` is unaffected", () => {
  const result = providerDiscoveryDecision({
    backends: [readiness("claude", { ready: false }), readiness("codex", { ready: true })],
    selectedBackend: "claude",
    hasSavedChoice: true,
    discoveryComplete: true,
  });
  assert.deepEqual({ action: result.action, backend: result.backend }, {
    action: "select",
    backend: "codex",
  });
});

// ---------------------------------------------------------------------------
// The call site. A helper-level test proves the decision is right; it cannot
// prove production reaches it with the persisted state, which is the whole
// point of not keying this on the handshake. Assert the wiring in the source.
test("#1818 the panel feeds the decision its PERSISTED choice, and opens no card on keep", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

  const call = src.match(
    /const decision = providerDiscoveryDecision\(\{[\s\S]{0,400}?\n\s*\}\);/,
  );
  assert.ok(call, "the discovery decision call site moved — re-point this test");
  assert.match(call[0], /\n\s*selectedBackend,/, "must pass the restored selection");
  assert.match(
    call[0],
    /\n\s*hasSavedChoice: hasSavedProviderChoice,/,
    "must pass the persisted confirmation, not a live-handshake proxy",
  );

  // Both inputs are restored from localStorage at mount, so they are populated
  // before any bridge frame lands.
  assert.match(
    src,
    /let selectedBackend = savedBackendAtMount \|\| "claude";/,
    "selectedBackend must still be restored at mount",
  );
  assert.match(
    src,
    /let hasSavedProviderChoice = !!lsGet\(PROVIDER_CHOICE_CONFIRMED_KEY\);/,
    "hasSavedProviderChoice must still be restored at mount",
  );

  // `keep` must reach no modal: the handler returns for every action that is
  // not `choose`, so a kept provider cannot re-prompt.
  assert.match(
    src,
    /if \(decision\.action !== "choose"\) return;/,
    "only the choose action may open the provider card",
  );
});
