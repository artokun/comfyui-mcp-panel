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
//   * it may NOT remove one;
//   * it MAY refresh the live fields of one, but NOT its readiness.
//
// That last split is the correction to this helper's first draft, which refused the probe's
// fields wholesale (codex). Refusing everything froze `running` for every provider the two
// sources share — the chip and the model popup both read `b.running`, and the host probe is
// what re-reads it on a timer — so a shared provider such as `claude` would have shown
// whatever liveness it had at the moment the orchestrator frame landed, permanently. That
// is the same freeze the first draft had for host-only providers, one id-set over.
//
// Readiness (`ready`/`cli`/`auth`) is the part that must NOT come from the probe, and only
// that part: the host cannot see the agent machine, so its view would false-flag a
// connected provider as "CLI not installed". This is the same ruling `applyReadiness`
// already makes, and the panel does not actually depend on the entry for it — `notReadyHint`
// reads the durable `backendReady` map FIRST and only falls back to the entry — so holding
// these three keys back is belt-and-braces rather than the load-bearing guard.
//
// With NO authoritative snapshot yet, the probe is all there is and is returned on its own
// — unchanged behaviour for a panel that has not connected. Not literally untouched: both
// snapshots are filtered for a usable `backend` id first, so a malformed entry is dropped
// rather than rendered as a nameless chip.
//
// Pure and dependency-free (no DOM), so the ordering bug this fixes is unit-testable.

/** The fields the ComfyUI host must never supply for a provider the orchestrator described.
 *
 *  `ready`/`cli`/`auth` — readiness, per the note above: the host cannot see the agent
 *  machine, so its view would false-flag a connected provider as "CLI not installed".
 *
 *  `experimental` — a SAFETY DISCLOSURE, not metadata (codex). It is what puts "(experimental)"
 *  in `backendDisplayLabel` and the amber outline plus the "signs in as VS Code, against
 *  GitHub's Copilot API terms" tooltip on the chip, so picking a ToS-risk provider is a
 *  deliberate, informed act. The host's entries are sparse `{backend, running}`, so a
 *  catch-all overlay would silently DELETE the flag on the next probe and quietly remove
 *  that warning.
 *
 *  SCOPE OF THAT GUARANTEE, stated precisely because an earlier version of this comment
 *  overclaimed it (codex): it covers providers the AUTHORITATIVE snapshot describes. A
 *  provider only the probe reports keeps its OWN entry's flag — nothing overrides it — and so
 *  does every entry when there is no authoritative snapshot at all. ("Its own entry" rather
 *  than "verbatim": a probe that names the same id twice still collapses to one chip.) That is deliberate rather
 *  than an oversight — for a provider the orchestrator never described there is no better
 *  claim to fall back on, and of the two ways to be wrong, showing a warning that may not
 *  apply is the safe one and hiding one that does is not. */
const AUTHORITATIVE_ONLY_KEYS = ["ready", "cli", "auth", "experimental"];

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

  const order = [];
  const byId = new Map();
  for (const entry of auth) {
    // First writer wins on a duplicated id, so a malformed authoritative snapshot cannot
    // produce two chips for one provider.
    if (byId.has(entry.backend)) continue;
    byId.set(entry.backend, entry);
    order.push(entry.backend);
  }
  for (const entry of host) {
    const known = byId.get(entry.backend);
    if (!known) {
      // Additive — a provider only the host knows about. It keeps its own entry, so its
      // liveness follows every later probe.
      byId.set(entry.backend, entry);
      order.push(entry.backend);
      continue;
    }
    // Shared id: keep the authoritative entry's membership and position, overlay the
    // probe's live fields, and hold back the authoritative-only keys. Spread first, then
    // restore those keys from the authoritative entry when it actually carried them — and
    // DELETE them when it did not, so a probe can neither blank one nor invent one.
    const refreshed = { ...known, ...entry };
    for (const key of AUTHORITATIVE_ONLY_KEYS) {
      if (key in known) refreshed[key] = known[key];
      else delete refreshed[key];
    }
    byId.set(entry.backend, refreshed);
  }
  return order.map((id) => byId.get(id));
}
