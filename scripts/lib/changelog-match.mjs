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
