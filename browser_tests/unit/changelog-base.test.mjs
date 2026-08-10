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
import { RELEASE_SUBJECT_ERE, isReleaseSubject } from "../../scripts/lib/changelog-match.mjs";

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

test("#932: the grep the base search uses is the same rule, in ERE", () => {
  // prevTag() hands this to `git log -E --grep`. If it drifts from isReleaseSubject, the
  // base commit and the commits excluded from the entry disagree — which is exactly the
  // silent, plausible-looking corruption this issue is about.
  const ere = new RegExp(RELEASE_SUBJECT_ERE);
  for (const s of ["0.11.75 — a thing (#920)", "0.11.40 (#656)", "v1.2.3"]) {
    assert.equal(ere.test(s), true, `grep must match ${s}`);
  }
  for (const s of ["fix(x): not a release", "feat: support 1.2.3 style ids"]) {
    assert.equal(ere.test(s), false, `grep must not match ${s}`);
  }
  // A version must not anchor on a LONGER one: 0.11.7 is not 0.11.75.
  assert.equal(new RegExp("^v?0\\.11\\.7([^0-9]|$)").test("0.11.75 — x"), false);
});
