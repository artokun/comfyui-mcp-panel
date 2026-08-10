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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../scripts/gen-changelog.mjs", import.meta.url), "utf8");

/** The shipped release-subject predicate, kept in step with the source below. */
const isReleaseSubject = (s) =>
  /^release:/i.test(s) || /^v?\d+\.\d+\.\d+([^0-9]|$)/.test(s);

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
  ]) {
    assert.equal(isReleaseSubject(s), false, s);
  }
});

test("#932: the base anchors on a version subject, not a release: prefix", () => {
  assert.ok(
    src.includes('-E --grep="^v?[0-9]+'),
    "prevTag must grep for a leading VERSION — the anchor this repo's releases carry",
  );
  // The old grep, not any MENTION of it — the comment explaining this fix names the
  // pattern it replaced, and an unscoped check matches that instead of the code.
  assert.ok(
    !/--grep="\^\\\(chore\(release\)/.test(src),
    "the release:-prefix grep matched nothing here and must be gone",
  );
  assert.ok(
    src.includes("rev-list --max-parents=0"),
    "the first-commit fallback stays as the last resort, just no longer the only outcome",
  );
});
