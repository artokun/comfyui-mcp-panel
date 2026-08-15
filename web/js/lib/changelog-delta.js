/**
 * #758 — what changed since the version the user was previously on.
 *
 * The panel updates from the Comfy Registry and the orchestrator runs
 * `npx comfyui-mcp@latest`, so the version moves without the user doing anything. The first
 * signal that something changed is usually behaviour they did not expect, which reads as a
 * bug rather than a release. The delta is the useful unit — not the whole file, and not
 * just the newest entry, because an install can jump several versions at once.
 */

/** Compare two dotted versions numerically. Returns <0, 0, >0. */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((p) => Number.parseInt(p, 10));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    // A missing or unparseable segment is 0, so "0.11" sorts below "0.11.1" rather than
    // making the whole comparison unusable.
    const dx = Number.isFinite(x[i]) ? x[i] : 0;
    const dy = Number.isFinite(y[i]) ? y[i] : 0;
    if (dx !== dy) return dx - dy;
  }
  return 0;
}

/**
 * The releases to show: everything newer than `lastSeen`, up to and including `current`.
 *
 * Bounded at the top by `current` deliberately. `web/changelog.json` is generated from the
 * repo, and a dev running from a checkout can have entries for versions their running panel
 * does not contain — announcing those as "what changed in your install" would be false.
 */
export function releasesSince(releases, { lastSeen, current, max = 12 } = {}) {
  if (!Array.isArray(releases)) return [];
  const withinCurrent = (v) => !current || compareVersions(v, current) <= 0;
  const newerThanSeen = (v) => !lastSeen || compareVersions(v, lastSeen) > 0;
  const picked = releases.filter((r) => r && typeof r.version === "string" && withinCurrent(r.version) && newerThanSeen(r.version));
  picked.sort((a, b) => compareVersions(b.version, a.version));
  return Number.isFinite(max) && max > 0 ? picked.slice(0, max) : picked;
}

/**
 * Should the panel announce an update at all, and how loudly?
 *
 * `"none"` on a FIRST run — a `lastSeen` we have never recorded means either a fresh
 * install or a user who predates this feature, and greeting them with a wall of history
 * they did not ask for is the opposite of the point. It records the version silently and
 * announces the NEXT change, which is the first one it can honestly call a change.
 *
 * `"none"` also when nothing is newer, including a DOWNGRADE: rolling back is a deliberate
 * act, and reporting the release notes of versions the user just left would be noise.
 *
 * `"major"` when the minor component moved (0.11.x -> 0.12.x) or several releases landed at
 * once — the case the issue is really about, where a tool surface consolidates or a default
 * flips and the user needs to know it was intentional. `"patch"` otherwise: worth a quiet
 * line, not a banner.
 */
export function updateAnnouncement({ lastSeen, current, releaseCount = 0 } = {}) {
  if (!current) return "none";
  if (!lastSeen) return "none";
  if (compareVersions(current, lastSeen) <= 0) return "none";
  const majorOf = (v) => String(v).replace(/^v/i, "").split(".").slice(0, 2).join(".");
  if (majorOf(current) !== majorOf(lastSeen)) return "major";
  return releaseCount >= 5 ? "major" : "patch";
}

/**
 * Flatten the picked releases into lines for display.
 *
 * `Fixed` is separated from `Changed` because they answer different questions, and the
 * issue names that distinction as the point: "this used to work differently on purpose" is
 * the message a user needs when a default flips, and it is not the same as "this was
 * broken and now is not".
 */
export function summarizeReleases(releases, { maxEntries = 12 } = {}) {
  const out = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    for (const [section, entries] of Object.entries(release?.sections || {})) {
      for (const text of Array.isArray(entries) ? entries : []) {
        if (typeof text === "string" && text.trim()) {
          out.push({ version: release.version, section, text: text.trim() });
        }
      }
    }
  }
  return Number.isFinite(maxEntries) && maxEntries > 0 ? out.slice(0, maxEntries) : out;
}
