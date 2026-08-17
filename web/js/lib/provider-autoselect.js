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
  const candidates = backends.filter((entry) => {
    if (!entry || typeof entry.backend !== "string") return false;
    if (entry.experimental || entry.hidden || !enabled(entry.backend)) return false;
    return entry.available === undefined ? entry.ready === true : entry.available === true;
  });
  if (hasSavedChoice && candidates.some((entry) => entry.backend === selectedBackend)) {
    return { action: "keep", candidates };
  }
  if (candidates.length === 0) return { action: "none", candidates };
  if (candidates.length === 1) {
    return { action: "select", backend: candidates[0].backend, candidates };
  }
  return { action: "choose", candidates };
}
