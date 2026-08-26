/** Decide the one-time provider action after authoritative discovery. */
export function providerDiscoveryDecision({
  backends,
  selectedBackend,
  hasSavedChoice,
  discoveryComplete,
  enabled = () => true,
} = {}) {
  if (discoveryComplete !== true || !Array.isArray(backends)) {
    return { action: "wait", candidates: [] };
  }
  // OFFERABLE and REACHABLE are separated on purpose — they answer different
  // questions, and #1818 is what happens when one answer is used for both.
  // Offerable = "may this provider be put in front of the user at all": not
  // experimental (copilot is opt-in ToS-risk and must never be auto-picked),
  // not hidden, not switched off in Settings. None of those can change behind
  // the user's back, so they gate every path below without exception.
  const offerable = backends.filter((entry) => {
    if (!entry || typeof entry.backend !== "string") return false;
    return !entry.experimental && !entry.hidden && enabled(entry.backend);
  });
  // Reachable = "can the host see it working RIGHT NOW". `available` is the
  // orchestrator's live probe and outranks the static `ready` snapshot when it
  // is present; an older orchestrator sends no `available` at all, hence the
  // fallback.
  const reachable = (entry) =>
    entry.available === undefined ? entry.ready === true : entry.available === true;
  // #1818 — A CHOICE THE USER ALREADY MADE IS NOT A CANDIDATE TO RE-DECIDE.
  //
  // This used to look the saved provider up in the reachable-only list, so a
  // saved provider the live probe could not see was not merely absent from the
  // card — it could not reach the `keep` branch that suppresses the card. Both
  // halves of #1818 came out of that one lookup: the picker reappeared on every
  // ComfyUI restart BECAUSE the provider it should have kept was filtered out
  // of the list it was searched in, and the same filter left `selected:` null.
  //
  // Claude is the case that exposed it. `backendReadiness()` reports claude
  // `ready: true` unconditionally and says why — the orchestrator IS the Agent
  // SDK host, there is no CLI to find. `allBackendReadiness()` then overwrites
  // `available` with `claudeCredentialPresent()`, a check for one exact file
  // (`~/.claude/.credentials.json`). A macOS install keeps that OAuth in the
  // Keychain and never writes the file, and so do `CLAUDE_CODE_OAUTH_TOKEN`,
  // `ANTHROPIC_API_KEY` and Bedrock/Vertex. The provider serving the session
  // reports `ready: true, available: false`, and the picker dropped it.
  //
  // So the saved provider is held on `ready` (installed / configured / hosted)
  // rather than on `available` (answering on localhost this second). The live
  // probe still decides who is OFFERED; it no longer overturns a decision the
  // user has already made. A provider that is genuinely gone reports
  // `ready: false` — an uninstalled codex, a signed-out gemini — and still
  // falls through to the select/choose paths below, so "your provider
  // disappeared" keeps working.
  //
  // NOT keyed on the live handshake (`connectedBackend`). That value arrives on
  // the `models` frame, which the orchestrator pushes only after awaiting an
  // uncached SDK model probe, while `discovery_complete: true` arrives after
  // three localhost fetches that fail instantly when nothing is listening. On
  // the cold ComfyUI restart this issue is about, discovery normally wins that
  // race and the handshake has landed nothing yet. `selectedBackend` and
  // `hasSavedChoice` are both read from localStorage at mount, before any frame
  // arrives, so they are the state that is actually there when this runs.
  const saved =
    hasSavedChoice === true
      ? offerable.find(
          (entry) =>
            entry.backend === selectedBackend && (reachable(entry) || entry.ready === true),
        )
      : undefined;
  // The saved provider rejoins the list it was dropped from, so `keep` reports
  // the set the user actually has rather than the set the probe could see.
  const candidates = offerable.filter((entry) => reachable(entry) || entry === saved);
  if (saved) return { action: "keep", candidates };
  if (candidates.length === 0) return { action: "none", candidates };
  if (candidates.length === 1) {
    return { action: "select", backend: candidates[0].backend, candidates };
  }
  return { action: "choose", candidates };
}
