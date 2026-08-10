/**
 * How a release commit is recognised (#932).
 *
 * This lives in its own module for one reason: `gen-changelog.mjs` runs git and REWRITES
 * CHANGELOG.md at import time, so a test cannot import it. The first version of the #932
 * test worked around that by re-declaring the predicate in the test file — which asserted
 * against its own copy and passed happily with the broken original still shipped. A test
 * that cannot fail is worse than no test, because it reads like coverage.
 *
 * So the matching rules live here, imported by both the generator and its tests, and there
 * is exactly one copy to be wrong.
 */

/**
 * The `git log --grep` pattern (POSIX ERE, for `-E`) that finds the previous release commit.
 *
 * Releases in this repo are squash merges titled `0.11.75 — <description> (#920) (#928)`.
 * The generator used to grep for `^release:` / `^chore(release):`, which matched NONE of
 * them, so every run fell through to `rev-list --max-parents=0` — the first commit — and
 * regenerated the entire history into each entry.
 *
 * The anchor is a version at the START of the subject. `([^0-9]|$)` stops `0.11.7` from
 * anchoring on `0.11.75`.
 */
export const RELEASE_SUBJECT_ERE = "^v?[0-9]+\\.[0-9]+\\.[0-9]+([^0-9]|$)";

/**
 * True when a commit subject announces a release, in every shape this repo produces:
 * `release: 0.11.40`, the bare squash form `0.11.40 (#656)`, and the current
 * `0.11.75 — <description> (#920) (#928)`.
 *
 * Deliberately anchored at the start and followed by a non-digit, so ordinary commits that
 * merely CONTAIN a version — `docs(changelog): 0.11.75 said the wrong thing`, `feat:
 * support 1.2.3 style ids` — are not swallowed. That direction is the dangerous one: it
 * silently drops real changes out of the entry rather than adding noise to it.
 */
export const isReleaseSubject = (s) =>
  /^release:/i.test(String(s ?? "")) || /^v?\d+\.\d+\.\d+([^0-9]|$)/.test(String(s ?? ""));
