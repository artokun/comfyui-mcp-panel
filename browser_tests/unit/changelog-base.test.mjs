// #932 — gen-changelog must anchor on the previous RELEASE, not the first commit.
//
// Cutting a release regenerated ~200 commits of already-shipped work into one entry. The
// cause is that this repo's releases are squash merges titled
//
//     0.11.75 — installing a custom node from a GitHub URL clones it again (#920) (#928)
//
// and BOTH matchers were written for shapes it has never produced:
//
//   * prevTag() grepped for `^release:` / `^chore(release):`, matched nothing, and fell
//     through to `rev-list --max-parents=0` — the FIRST COMMIT;
//   * isReleaseSubject() required the version to be the whole subject, so release commits
//     were also written INTO the entries announcing them.
//
// Both failure directions produce a plausible file — too wide misattributes shipped work,
// too narrow silently drops the release's own changes — which is why this is pinned.
//
// These import the SHIPPED predicate. The first version of this file re-declared it
// locally, so it asserted against its own copy: reverting the source to the broken
// original left all three tests green. That is why the rules were moved into
// scripts/lib/changelog-match.mjs — gen-changelog.mjs rewrites CHANGELOG.md at import
// time and cannot be imported by a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEP, isReleaseSubject, pickReleaseSha } from "../../scripts/lib/changelog-match.mjs";

test("#932: this repo's own release subjects are recognised", () => {
  // The shape every release here actually has. The old predicate matched none of them.
  for (const s of [
    "0.11.75 — installing a custom node from a GitHub URL clones it again (#920) (#928)",
    "0.11.76 — a rail id is not a missing node (comfyui-mcp#1294)",
    "0.11.40 (#656)",
    "release: 0.11.40",
    "v1.2.3",
  ]) {
    assert.equal(isReleaseSubject(s), true, s);
  }
});

test("#932: ordinary commits are not mistaken for releases", () => {
  // Broadening the match must not start swallowing real changes — that is the
  // too-narrow direction, which silently drops the release's own content.
  for (const s of [
    "fix(x): not a release",
    "docs(changelog): 0.11.75 said the wrong thing",
    "feat: support 1.2.3 style ids",
    "chore: bump deps",
    "",
    "0.11", // not a version
  ]) {
    assert.equal(isReleaseSubject(s), false, JSON.stringify(s));
  }
});

/** One `--pretty=format:%H%x1f%s` line. */
const logLine = (sha, subject) => `${sha}${SEP}${subject}`;

test("#932: the base is the most recent release commit", () => {
  const sha = pickReleaseSha(
    [
      logLine("aaaaaaa1", "fix(save): report the workflow instance a save leaves active (#800)"),
      logLine("bbbbbbb2", "0.11.76 — a rail id is not a missing node (comfyui-mcp#1294) (#931)"),
      logLine("ccccccc3", "0.11.75 — installing a custom node clones it again (#920) (#928)"),
    ].join("\n"),
  );
  assert.equal(sha, "bbbbbbb2", "the FIRST release in log order — git logs newest first");
});

test("#932: a version at the start of a commit BODY is not a release boundary", () => {
  // The hazard that made `git log --grep` wrong (codex): --grep searches the whole message
  // and matches per line, so `^<version>` fires on body lines too. Reading %s only is what
  // makes this safe — and the commits in this very fix have bodies quoting versions.
  //
  // The body cannot even reach the predicate now, so this asserts the SHAPE that keeps it
  // that way: a line whose subject is ordinary is skipped no matter what follows it, and
  // the real release below it is the one selected.
  const sha = pickReleaseSha(
    [
      logLine("aaaaaaa1", "docs(release): quote the release titles we produce"),
      // If a body ever leaked into the subject field, it would arrive looking like this —
      // and must still not win, because the subject is what is tested.
      logLine("bbbbbbb2", "fix(changelog): anchor on the previous release (#932)"),
      logLine("ccccccc3", "0.11.76 — a rail id is not a missing node (#931)"),
    ].join("\n"),
  );
  assert.equal(sha, "ccccccc3", "an ordinary subject must never become the release anchor");
});

test("#932: no release in history falls back to the caller's first-commit path", () => {
  assert.equal(pickReleaseSha([logLine("aaaaaaa1", "feat: initial commit")].join("\n")), null);
  assert.equal(pickReleaseSha(""), null);
  // Malformed lines must be skipped, not crash a release.
  assert.equal(pickReleaseSha("garbage\nnot-a-sha\x1f0.11.76 — x"), null);
});
