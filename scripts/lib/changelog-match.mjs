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
 * Field separator for `--pretty=format:%H%x1f%s`.
 *
 * Not a byte git forbids in a subject (codex) — parsing is safe because only the FIRST
 * separator is read, and it always follows the fixed-width SHA. A later one lands
 * harmlessly inside the subject.
 */
export const SEP = "\x1f";

/**
 * True when a commit subject announces a release, in every shape this repo produces:
 * `release: 0.11.40`, the bare squash form `0.11.40 (#656)`, the older
 * `0.11.75 — <description> (#920) (#928)`, and — since #1191 — the CURRENT and by far most
 * common shape, `chore(release): 0.14.28 (#1195)`.
 *
 * #1191 — THE MISSING ARM MATCHED NOTHING THIS REPO HAS SHIPPED IN A YEAR. Measured over
 * all 1124 subjects in history: 79 begin `chore(release):`, and the two-arm predicate
 * matched ZERO of them. Two things broke as a result, both silently:
 *
 *   - `prevTag()` has a documented fallback for exactly this repo's habit of letting tags
 *     lag ("prefer the newest release COMMIT when it is a descendant of the tag"). It could
 *     never fire, because it asks this predicate which commits are releases. So the base
 *     stayed pinned at v0.14.18 and every release since re-listed everything after it —
 *     34 commits at the 0.14.28 cut, including ten language catalogs credited to a release
 *     that did not contain them.
 *   - The same predicate skips release commits when parsing (`release commits describe
 *     themselves`). Unskipped, they were filed as ordinary `Changed` entries, which is why
 *     0.14.25 and 0.14.26 each carry a list of the releases before them.
 *
 * WHY THE PREFIX IS NARROW rather than `(?:\S+\s+)?`. The first token after
 * `chore(release):` was measured across all 79: a bare version (51), `comfyui-agent-panel`
 * (24), `panel` (3), and `sync` (1, from `sync PANEL_VERSION to 0.9.0` — not a release
 * boundary, and it carries no PR so the parser drops it anyway). `[a-z0-9-]*panel` covers
 * both real prefixes with identical coverage while still REJECTING `chore(release): revert
 * 1.2.3 rollout` and `chore(release): fix the script`, which a `\S+` wildcard would accept.
 * Verified: 78 newly matched subjects, every one of them a `chore(release):`, and zero new
 * matches anywhere else in history.
 *
 * Deliberately anchored at the start and followed by a non-digit, so ordinary commits that
 * merely CONTAIN a version — `docs(changelog): 0.11.75 said the wrong thing`, `feat:
 * support 1.2.3 style ids` — are not swallowed. That direction is the dangerous one: it
 * silently drops real changes out of the entry rather than adding noise to it. Which is
 * also the reason this must not be relaxed to a bare `^chore\(release\)` prefix.
 */
export const isReleaseSubject = (s) =>
  /^release:/i.test(String(s ?? "")) ||
  /^chore\(release\):\s*(?:[a-z0-9-]*panel\s+)?v?\d+\.\d+\.\d+([^0-9]|$)/i.test(String(s ?? "")) ||
  /^v?\d+\.\d+\.\d+([^0-9]|$)/.test(String(s ?? ""));

/**
 * Pick the most recent release commit from `git log --pretty=format:%H%x1f%s` output.
 *
 * This exists instead of a `git log --grep` pattern, and the reason is the whole point
 * (codex, #932): **`--grep` searches the entire commit message and matches per LINE**, so a
 * `^`-anchored pattern also fires on BODY lines. An ordinary commit whose body happens to
 * quote a version at the start of a line — which the messages in this very fix do — would
 * be chosen as the release boundary, silently truncating the entry to a few commits. That
 * is the same class of silent wrongness as the bug being fixed, just in the other
 * direction.
 *
 * Matching `%s` in JS also collapses the two spellings of the rule into one. The first fix
 * carried an ERE beside the JS regex, and they had already drifted: the ERE did not accept
 * `release: 0.11.40`, which the predicate does. Two spellings of one rule is a drift
 * waiting to happen, and drift here is invisible in the output.
 *
 * Returns null when no release commit appears — the caller falls back to the first commit.
 */
export function pickReleaseSha(logOutput) {
  for (const line of String(logOutput ?? "").split("\n")) {
    const i = line.indexOf(SEP);
    if (i < 0) continue;
    const sha = line.slice(0, i);
    // Only the subject. Everything after the first separator is `%s`, which git guarantees
    // is a single line — the body never reaches this predicate.
    if (/^[0-9a-f]{7,40}$/.test(sha) && isReleaseSubject(line.slice(i + 1))) return sha;
  }
  return null;
}
