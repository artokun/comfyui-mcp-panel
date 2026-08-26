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
  //
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
  // #1818 — THE SAVED PROVIDER IS ALWAYS A CANDIDATE, EVEN WHEN THE PROBE
  // CANNOT SEE IT.
  //
  // It used to be looked up in the reachable-only list, so a saved provider the
  // probe missed was not merely absent from the card — it could not reach the
  // `keep` branch that suppresses the card. Both halves of #1818 came out of
  // that one lookup: the picker reappeared on every ComfyUI restart BECAUSE the
  // provider it should have kept had been filtered out of the list it was
  // searched in, and the same filter left `selected:` null so nothing was
  // pre-selected.
  //
  // Claude is the case that exposed it. `backendReadiness()` reports claude
  // `ready: true` unconditionally and says why — the orchestrator IS the Agent
  // SDK host, there is no CLI to find. `allBackendReadiness()` then overwrites
  // `available` with `claudeCredentialPresent()`, a check for one exact file
  // (`~/.claude/.credentials.json`). A macOS install keeps that OAuth in the
  // Keychain and never writes the file, and neither do `CLAUDE_CODE_OAUTH_TOKEN`,
  // `ANTHROPIC_API_KEY` or Bedrock/Vertex. The provider actually serving the
  // session arrives as `ready: true, available: false`.
  // `ready` is still required. It is the signal that separates "the probe cannot
  // see it" from "it is genuinely gone" — an uninstalled codex or a signed-out
  // gemini reports `ready: false`, and those must keep falling through to the
  // select/choose paths below rather than being offered a seat they cannot fill.
  // Dropping this condition re-offers dead providers; the pre-existing
  // "keeps a saved provider only while it remains available" case catches it.
  const savedEntry =
    hasSavedChoice === true
      ? offerable.find(
          (entry) =>
            entry.backend === selectedBackend && (reachable(entry) || entry.ready === true),
        )
      : undefined;
  const candidates = offerable.filter((entry) => reachable(entry) || entry === savedEntry);
  // Reachable AND chosen — nothing to decide, and no card.
  if (savedEntry && reachable(savedEntry)) return { action: "keep", candidates };
  if (candidates.length === 0) return { action: "none", candidates };
  // Exactly one option left. When that one option IS the saved provider (the
  // macOS-Claude shape, with nothing else offerable), this resolves to the
  // provider the user already had and still shows no card.
  if (candidates.length === 1) {
    return { action: "select", backend: candidates[0].backend, candidates };
  }
  // MORE THAN ONE OPTION, AND THE PROBE DISAGREES WITH THE SAVED CHOICE.
  //
  // Deliberately `choose` rather than `keep`. The panel cannot tell the two
  // kinds of `available: false` apart, and the frame carries nothing that would
  // let it: `BackendReadiness` is `{backend, cli, auth, ready, experimental?,
  // available?}`, and an installed-but-stopped ollama and a Keychain-authed
  // claude are byte-identical in it — both `cli: true, auth: true, ready: true,
  // available: false`. So holding the saved provider outright would be right for
  // claude and wrong for a local daemon that really is down, with no way to know
  // which one this is.
  //
  // What CAN be fixed without guessing is the part that was never defensible:
  // the saved provider is in `candidates` now, so the card lists it and the call
  // site pre-selects it instead of resolving `selected:` to null. And the old
  // silent `select` past a live saved choice is gone — with the saved entry
  // present there is more than one candidate, so the user is asked rather than
  // relocated behind their back. That silent relocation is what put an actively
  // working Claude session onto an unreachable Ollama in the report.
  //
  // The residue — one pre-selected click after a restart rather than none — is
  // the outcome the reporter named as acceptable ("still pre-select the previous
  // choice so it is one click, not a re-decision"). Removing that click for good
  // means fixing `staticAvailability` upstream so claude stops reporting
  // `available: false`, which is the actual defect and lives in comfyui-mcp.
  return { action: "choose", candidates };
}
