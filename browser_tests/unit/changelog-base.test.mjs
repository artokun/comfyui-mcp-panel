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

test("#932: an ordinary subject is never chosen as the release boundary", () => {
  // Scope, stated honestly (codex): this feeds SUBJECTS, so it cannot prove git has
  // stopped searching bodies, and it would NOT catch a future rewrite of prevTag() back
  // to `--grep`. Catching that automatically needs a fixture repository, which this does
  // not have. What it does pin is the selection rule itself.
  //
  // The hazard it descends from is real and live: `--grep "^<version>"` matches per line
  // over the WHOLE message, and in this repo's own history it selects 7521519, whose
  // subject is `fix(subgraph): …` and which matched on a body line. Reading %s is what
  // keeps a body away from the predicate.
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

// ---------------------------------------------------------------------------
// #1191 — and this file's own header is the reason it needed writing.
//
// #932 above says both matchers "were written for shapes it has never produced". Its fix
// then taught the predicate the shape of 2026's releases and left it blind to the shape
// that replaced them: measured over all 1124 subjects in history, 79 begin
// `chore(release):` and the shipped predicate matched ZERO of them. Nine consecutive
// releases re-listed everything back to v0.14.18.
//
// The lesson is narrow and worth stating: #932's tests asserted the shapes it was FIXING
// and never asserted the shapes the repo would go on to produce. So these name the current
// shape literally, and the negative set names the specific near-misses a looser fix would
// have let through.

test("#1191: the CURRENT release shape is recognised — `chore(release): …`", () => {
  for (const s of [
    "chore(release): 0.14.28 (#1195)",
    "chore(release): 0.14.26 (#1185)",
    "chore(release): 0.14.19", // the pre-squash branch tip: no PR number
    "chore(release): panel 0.4.9 — x",
    "chore(release): comfyui-agent-panel v0.1.2 — streaming UI",
  ]) {
    assert.equal(isReleaseSubject(s), true, JSON.stringify(s));
  }
});

test("#1191: the broadening stops well short of `^chore(release)`", () => {
  // The dangerous direction, and these are not hypothetical shapes — they are the ones a
  // `(?:\S+\s+)?` wildcard accepts. A false positive here silently truncates the range and
  // drops real work out of the entry.
  for (const s of [
    "chore(release): revert 1.2.3 rollout",
    "chore(release): fix the script",
    "chore(release): sync PANEL_VERSION to 0.9.0", // real subject; not a release boundary
    "chore(release): prepare for 2.0",
  ]) {
    assert.equal(isReleaseSubject(s), false, JSON.stringify(s));
  }
});

test("#1191: a `chore(release)` commit beats an older `release:` one as the base", () => {
  // THE ASSERTION THAT FAILED BEFORE THE FIX. The shipped predicate skipped every
  // `chore(release):` line and returned the ancient `release:` sha, which is precisely what
  // widened the range: that commit is an ancestor of the newest tag, so prevTag()'s
  // ancestry check threw and the base fell back to the tag.
  const sha = pickReleaseSha(
    [
      logLine("aaaaaaaa", "fix(1180): bound the sibling getNodeDefs call sites (#1186)"),
      logLine("bbbbbbbb", "chore(release): 0.14.27 (#1190)"),
      logLine("cccccccc", "feat: something older"),
      logLine("dddddddd", "release: panel 0.14.0 — the panel speaks 12 languages"),
    ].join("\n"),
  );
  assert.equal(sha, "bbbbbbbb", "the newest release is the chore(release) commit, not the ancient release: one");
});

test("#1191: release commits are excluded from the entry they announce", () => {
  // The second symptom, same predicate. Unskipped, `chore(release):` subjects were parsed
  // as ordinary commits; `chore` is not a known type but the subject carries a PR, so they
  // were filed under "Changed" — which is why 0.14.25 and 0.14.26 each shipped a list of
  // the releases that preceded them.
  assert.equal(isReleaseSubject("chore(release): 0.14.25 (#1182)"), true, "…so the parser skips it");
});

// ---------------------------------------------------------------------------
// #1882 — the CURRENT cut shape is `chore: release v0.15.115`, and tags lag it.
//
// #1191 taught the predicate `chore(release):` and then the repo changed spelling
// again. Every release from 0.15.97 through 0.15.115 uses `chore: release vX.Y.Z`,
// which matched none of the three arms. Combined with missing tags (0.15.97,
// 0.15.111–0.15.113), prevTag() cannot fall back to the release commit and bounds
// at the previous tag — the next cut re-lists everything in between.
// ---------------------------------------------------------------------------

test("#1882: the CURRENT release shape is recognised — `chore: release vX.Y.Z`", () => {
  for (const s of [
    "chore: release v0.15.115 (#1945)",
    "chore: release v0.15.114 (#1940)",
    "chore: release v0.15.113 — first release at ZERO registry findings",
    "chore: release v0.15.112 — bound panel search replies (#1908)",
    "chore: release v0.15.111",
    "chore: release 0.15.97",
  ]) {
    assert.equal(isReleaseSubject(s), true, JSON.stringify(s));
  }
});

test("#1882: `chore: release` without a version is not a release boundary", () => {
  for (const s of [
    "chore: release notes for later",
    "chore: release the kraken",
    "chore: bump deps",
    "fix: chore: release v0.15.115 is quoted in the body",
  ]) {
    assert.equal(isReleaseSubject(s), false, JSON.stringify(s));
  }
});

test("#1882: a `chore: release` commit beats an older tagged `chore(release):` as the base", () => {
  const sha = pickReleaseSha(
    [
      logLine("aaaaaaaa", "fix(1927): re-vendor the tool vocabulary (#1930)"),
      logLine("bbbbbbbb", "chore: release v0.15.115 (#1945)"),
      logLine("cccccccc", "chore(release): 0.14.28 (#1195)"),
    ].join("\n"),
  );
  assert.equal(sha, "bbbbbbbb", "the newest release is the untagged chore: release commit");
});
