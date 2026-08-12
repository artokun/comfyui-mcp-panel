// #1083 — a less complete provider snapshot must never SHRINK an authoritative one.
//
// The panel learns its provider list from two places, and they do not carry the same
// truth:
//
//   * the ORCHESTRATOR, over the bridge. It runs on the machine that actually hosts the
//     agents, so it knows about `lmstudio`, `llamacpp`, a configured `custom` endpoint and
//     `copilot`. The panel already treats it as authoritative for readiness, for the reason
//     written at `applyReadiness`: a later host probe must not downgrade a provider that is
//     connected and working.
//   * the ComfyUI HOST, over `GET /comfyui_mcp_panel/backends`. Its `_BACKEND_PORTS` map
//     ends at `openrouter` and knows nothing about the four above.
//
// `renderBackendChips` assigns `knownBackends = list` wholesale, and the model popup
// rebuilds its Provider section from `knownBackends`. So when the host probe landed after
// the orchestrator had already spoken, it REPLACED the authoritative list with its own
// shorter one and the four providers vanished from the picker — with no UI path back to a
// configured Custom endpoint. `applyReadiness` refuses that probe correctly, but it runs
// one line too late to matter: the list is already gone.
//
// WHY A MERGE RATHER THAN SKIPPING THE REPAINT. The one-line fix is to not repaint at all
// once the orchestrator has spoken. That does stop the truncation, but the host probe is
// also how a chip's live `running` state refreshes, so ignoring it outright trades a
// disappearing provider for a permanently stale one. Merging keeps both.
//
// WHAT THE PROBE MAY AND MAY NOT DO, once an authoritative snapshot exists:
//   * it may ADD a provider the authoritative snapshot did not mention — additive, and it
//     cannot make the list shorter;
//   * it may NOT remove one, and it may NOT overwrite the fields of one. That second
//     restriction is the same ruling `applyReadiness` already makes: the probe cannot see
//     the agent machine, so its `ready`/`running` for a provider it half-knows is not an
//     improvement on what the orchestrator said.
//
// With NO authoritative snapshot yet, the probe is all there is and is used as-is —
// unchanged behaviour for a panel that has not connected.
//
// Pure and dependency-free (no DOM), so the ordering bug this fixes is unit-testable.

/** A usable provider entry: an object naming a non-empty `backend` id. */
function isProviderEntry(entry) {
  return !!entry && typeof entry === "object" && typeof entry.backend === "string" && !!entry.backend;
}

/**
 * @param {{ authoritative?: unknown, probe?: unknown }} input
 * @returns {Array<object>} the list to render
 *
 * `authoritative` is the current known-good snapshot (the orchestrator's), or empty/absent
 * when none has arrived. `probe` is the host response.
 */
export function mergeProviderSnapshots({ authoritative, probe } = {}) {
  const auth = Array.isArray(authoritative) ? authoritative.filter(isProviderEntry) : [];
  const host = Array.isArray(probe) ? probe.filter(isProviderEntry) : [];
  // Nothing authoritative to protect — the probe is the only source of truth there is.
  if (!auth.length) return host;

  const authIds = new Set();
  const merged = [];
  for (const entry of auth) {
    // First writer wins on a duplicated id, so a malformed authoritative snapshot cannot
    // produce two chips for one provider.
    if (authIds.has(entry.backend)) continue;
    authIds.add(entry.backend);
    merged.push(entry);
  }
  for (const entry of host) {
    if (authIds.has(entry.backend)) continue; // never overwrite, never remove
    authIds.add(entry.backend);
    merged.push(entry);
  }
  return merged;
}
