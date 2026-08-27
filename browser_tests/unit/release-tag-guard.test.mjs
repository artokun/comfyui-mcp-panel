/**
 * #1882 — `git tag` is used as the "was this released?" operand and has been
 * wrong in both directions.
 *
 *   * v0.15.86..v0.15.96 are tagged, and every one of those trees declares
 *     version "0.15.85". publish_action.yml fires on `paths: [pyproject.toml]`,
 *     so on tagged commits that never touched that file it never ran — ten
 *     versions silently never shipped, with nothing in the Actions tab.
 *   * 0.15.97 shipped to the Registry and has no tag at all, so two reporters
 *     were told it "was never released".
 *
 * These lock the two rules in scripts/check-release-tag.mjs against the exact
 * historical shapes, and — separately — lock the WIRING, because a guard that is
 * correct but never invoked is the failure this issue is about. The last test
 * covers a second instance of the same class the owner found in the same file:
 * the pack-contents gate still listed web/js/vendor/a2ui-lit.bundle.js after
 * #1865 deleted it, and a listed-but-missing path passes `check-ignore`
 * trivially, so the entry read as coverage while asserting nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  auditPublishedVersion,
  auditTag,
  collectFromGit,
  collectPublishedFromGit,
  ensurePublishedTag,
  firstParentAtRev,
  packageJsonVersion,
  panelVersion,
  pyprojectVersion,
  versionAtRev,
  versionOfTag,
} from "../../scripts/check-release-tag.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/**
 * The hosted unit job intentionally uses a shallow checkout. Keep tests that
 * exercise the git-backed collector independent of the panel repository's
 * fetched tags by creating the smallest real history the collector needs.
 * This still runs the production `git show`, `git describe`, `git rev-list`,
 * and `git for-each-ref` calls; it only makes their inputs deterministic.
 */
function withReleaseHistory(callback) {
  const fixture = mkdtempSync(join(tmpdir(), "panel-release-tag-guard-"));
  const runGit = (...args) =>
    execFileSync("git", args, { cwd: fixture, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  const writeVersion = (version) => {
    writeFileSync(
      join(fixture, "pyproject.toml"),
      `[project]\nname = "release-tag-guard-fixture"\nversion = "${version}"\n`,
    );
    writeFileSync(join(fixture, "package.json"), `${JSON.stringify({ version })}\n`);
    mkdirSync(join(fixture, "web", "js"), { recursive: true });
    writeFileSync(join(fixture, "web", "js", "comfyui-mcp-panel.js"), `const PANEL_VERSION = "${version}";\n`);
  };

  try {
    runGit("init", "--initial-branch=main");
    runGit("config", "user.email", "release-tag-guard-fixture@example.invalid");
    runGit("config", "user.name", "release-tag-guard-fixture");

    writeVersion("0.15.103");
    runGit("add", ".");
    runGit("commit", "-m", "chore: fixture release v0.15.103");
    runGit("tag", "v0.15.103");

    writeVersion("0.15.104");
    runGit("add", ".");
    runGit("commit", "-m", "chore: fixture release v0.15.104");
    runGit("tag", "v0.15.104");

    return callback(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const treeAt = (v) => ({
  pyproject: `[project]\nname = "comfyui-mcp-panel"\nversion = "${v}"\n`,
  packageJson: JSON.stringify({ name: "comfyui-mcp-panel", version: v }),
  panelJs: `const PANEL_VERSION = "${v}";\n`,
});

const noTags = () => null;
/** version -> the commit its tag resolves to. */
const tagsAt = (map) => (v) => map[v] ?? null;

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

test("#1882 pyprojectVersion reads [project].version and ignores other tables", () => {
  const toml =
    '[build-system]\nversion = "9.9.9"\n\n[project]\nname = "x"\nversion = "0.15.97"\n\n[tool.comfy]\nversion = "1.2.3"\n';
  assert.equal(pyprojectVersion(toml), "0.15.97");
  assert.equal(pyprojectVersion('[tool.comfy]\nversion = "1.2.3"\n'), null);
  assert.equal(pyprojectVersion(null), null);
});

test("#1882 the other two version witnesses parse, and fail closed", () => {
  assert.equal(packageJsonVersion('{"version":"0.15.97"}'), "0.15.97");
  assert.equal(packageJsonVersion("not json"), null);
  assert.equal(panelVersion('const PANEL_VERSION = "0.15.97";'), "0.15.97");
  assert.equal(panelVersion("const PANEL_VERSION = 1;"), null);
  assert.equal(versionOfTag("v0.15.97"), "0.15.97");
  assert.equal(versionOfTag("release-0.15.97"), null);
});

// ---------------------------------------------------------------------------
// rule 1 — the tagged tree declares the tag's own version
// ---------------------------------------------------------------------------

test("#1882 a coherent release passes", () => {
  const violations = auditTag({
    tag: "v0.15.104",
    treeAtTag: treeAt("0.15.104"),
    range: [
      { sha: "aaaaaaaa1", subject: "chore: release v0.15.104", version: "0.15.104", parentVersion: "0.15.103" },
    ],
    tagTargetFor: tagsAt({ "0.15.104": "aaaaaaaa1", "0.15.103": "zzzzzzzz9" }),
  });
  assert.deepEqual(violations, []);
});

test("#1882 the v0.15.90 shape is caught: tag says .90, tree still declares 0.15.85", () => {
  // The real historical tree — set-version.mjs was never run, so pyproject and
  // PANEL_VERSION are frozen, while package.json (bumped by npm) moved on. That
  // asymmetry is why all three witnesses are compared and not just two.
  const violations = auditTag({
    tag: "v0.15.90",
    treeAtTag: { ...treeAt("0.15.85"), packageJson: JSON.stringify({ version: "0.15.90" }) },
    range: [],
    tagTargetFor: noTags,
  });
  assert.equal(violations.length, 2, violations.join("\n"));
  assert.ok(violations.some((v) => v.includes("pyproject.toml declares 0.15.85")));
  assert.ok(violations.some((v) => v.includes("PANEL_VERSION declares 0.15.85")));
  assert.ok(!violations.some((v) => v.includes("package.json declares")));
});

test("#1882 an unreadable version witness is a violation, not a silent pass", () => {
  const violations = auditTag({
    tag: "v0.15.104",
    treeAtTag: { ...treeAt("0.15.104"), panelJs: "// PANEL_VERSION constant removed\n" },
    range: [],
    tagTargetFor: noTags,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not read a version from PANEL_VERSION/);
});

test("#1882 a non-release tag is reported rather than silently audited as coherent", () => {
  const violations = auditTag({
    tag: "nightly",
    treeAtTag: treeAt("0.15.104"),
    range: [],
    tagTargetFor: noTags,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /not a v<major>\.<minor>\.<patch> release tag/);
});

// ---------------------------------------------------------------------------
// rule 2 — nothing that shipped before this tag went untagged
// ---------------------------------------------------------------------------

test("#1882 the v0.15.98 shape is caught: 0.15.97 shipped in the range with no tag", () => {
  const violations = auditTag({
    tag: "v0.15.98",
    treeAtTag: treeAt("0.15.98"),
    range: [
      { sha: "1111111111", subject: "chore: release v0.15.98", version: "0.15.98", parentVersion: "0.15.97" },
      { sha: "2222222222", subject: "fix: something", version: "0.15.97", parentVersion: "0.15.97" },
      {
        sha: "7b477d5500",
        subject: "Merge pull request #1826 from artokun/release/0.15.97",
        version: "0.15.97",
        parentVersion: "0.15.85",
      },
    ],
    tagTargetFor: tagsAt({ "0.15.98": "1111111111", "0.15.96": "9999999999" }),
  });
  assert.equal(violations.length, 1, violations.join("\n"));
  assert.match(violations[0], /^0\.15\.97 was cut by 7b477d55 /);
  assert.match(violations[0], /no v0\.15\.97 tag exists/);
  // The remedy has to be in the message: the reason this sat unfixed is that
  // pushing the tag was believed to re-publish to the Registry.
  assert.match(violations[0], /git tag -a v0\.15\.97 7b477d55/);
  assert.match(violations[0], /cannot re-trigger the publish workflow/);
  // ...and the message must NOT prescribe tagging unconditionally, because a
  // version that was cut but never shipped would then get a tag asserting it was.
  assert.match(violations[0], /If it did not ship, do not tag it/);
});

test("#1882 a tag is credited only when it resolves to the commit that cut the version", () => {
  // A tag is a movable label. Crediting v0.15.97 by NAME would let it sit on an
  // unrelated commit while the commit that actually published 0.15.97 stayed
  // untagged — the same confusion the guard exists to end.
  const range = [
    { sha: "1111111111", subject: "chore: release v0.15.98", version: "0.15.98", parentVersion: "0.15.97" },
    { sha: "7b477d5500", subject: "chore: release v0.15.97", version: "0.15.97", parentVersion: "0.15.85" },
  ];
  const wrongTarget = auditTag({
    tag: "v0.15.98",
    treeAtTag: treeAt("0.15.98"),
    range,
    tagTargetFor: tagsAt({ "0.15.98": "1111111111", "0.15.97": "deadbeef00" }),
  });
  assert.equal(wrongTarget.length, 1, wrongTarget.join("\n"));
  assert.match(wrongTarget[0], /v0\.15\.97 exists but resolves to deadbeef, not the commit that cut 0\.15\.97/);

  const rightTarget = auditTag({
    tag: "v0.15.98",
    treeAtTag: treeAt("0.15.98"),
    range,
    tagTargetFor: tagsAt({ "0.15.98": "1111111111", "0.15.97": "7b477d5500" }),
  });
  assert.deepEqual(rightTarget, []);
});

test("#1882 the tag's own release commit is not reported as a gap when the tag sits on it", () => {
  // The ordinary release: the tag labels the commit that cut its version. Flagging
  // this would make every single release red.
  const violations = auditTag({
    tag: "v0.15.105",
    treeAtTag: treeAt("0.15.105"),
    range: [
      { sha: "abcabcabc", subject: "chore: release v0.15.105", version: "0.15.105", parentVersion: "0.15.104" },
    ],
    tagTargetFor: tagsAt({ "0.15.105": "abcabcabc" }),
  });
  assert.deepEqual(violations, []);
});

test("#1882 a pyproject.toml edit that leaves the version alone is not a release", () => {
  const violations = auditTag({
    tag: "v0.15.105",
    treeAtTag: treeAt("0.15.105"),
    range: [
      { sha: "ddddddddd", subject: "chore: release v0.15.105", version: "0.15.105", parentVersion: "0.15.104" },
      { sha: "eeeeeeeee", subject: "chore: widen a dependency pin", version: "0.15.104", parentVersion: "0.15.104" },
    ],
    tagTargetFor: tagsAt({ "0.15.105": "ddddddddd" }),
  });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// fail closed — an unrunnable scan must never read as a clean one
// ---------------------------------------------------------------------------

test("#1882 unavailable history is a violation, not an empty range that passes", () => {
  // The first draft turned every git failure into `range = []`, so a shallow
  // clone or unfetched tags made rule 2 silently vacuous while the job still
  // reported success — the same "guard that isn't a guard" shape as the stale
  // pack-contents entry.
  const violations = auditTag({
    tag: "v0.15.98",
    treeAtTag: treeAt("0.15.98"),
    range: [],
    tagTargetFor: noTags,
    historyError: "this is a shallow clone, so the range cannot be walked",
  });
  assert.equal(violations.length, 1, violations.join("\n"));
  assert.match(violations[0], /untagged-release scan could not run/);
  assert.match(violations[0], /shallow clone/);
});

test("#1882 a commit whose version could not be read is reported, never skipped", () => {
  // Fail-open at a finer grain than an empty range: `git show <sha>:pyproject.toml`
  // failing used to read back null, and null was treated as "not a release", so one
  // unreadable blob could hide the very gap the scan exists to find.
  const violations = auditTag({
    tag: "v0.15.98",
    treeAtTag: treeAt("0.15.98"),
    range: [
      { sha: "1111111111", subject: "chore: release v0.15.98", version: "0.15.98", parentVersion: "0.15.97" },
      {
        sha: "7b477d5500",
        subject: "chore: release v0.15.97",
        version: null,
        parentVersion: null,
        versionError: "pyproject.toml exists at 7b477d55 but could not be read: EIO",
      },
    ],
    tagTargetFor: tagsAt({ "0.15.98": "1111111111" }),
  });
  assert.equal(violations.length, 1, violations.join("\n"));
  assert.match(violations[0], /could not be read/);
  assert.match(violations[0], /left unaudited/);
});

test("#1882 versionAtRev itself returns an error, never a bare null, on an unreadable rev", () => {
  // Drives the git-backed reader directly. The previous version of this test
  // re-implemented the git calls instead of calling versionAtRev, so reverting
  // the reader to `catch { return null }` left the suite green — the exact
  // "green suite proves nothing" trap this whole issue is about.
  const good = versionAtRev("HEAD");
  assert.equal(good.error, null);
  assert.match(good.version, /^\d+\.\d+\.\d+/);

  // A syntactically valid SHA that resolves to nothing: `git show` fails, and the
  // reader must say UNKNOWN rather than "this revision released no version".
  const bad = versionAtRev("0".repeat(40));
  assert.equal(bad.version, null);
  assert.ok(bad.error, "an unreadable rev must carry an error, not a bare null");
  assert.match(bad.error, /could not be read/);
});

test("#1882 a reader failure reaches auditTag as a violation through the real range walk", () => {
  withReleaseHistory((cwd) => {
    // End-to-end over an isolated real history: collectFromGit walks
    // v0.15.104 for real and the injected reader fails on every commit, so the
    // wiring — reader -> versionError -> auditTag -> violation — is exercised
    // rather than assumed. With the real reader the same tag is clean, which
    // is asserted second so a broken walk cannot make this test pass vacuously.
    const failing = collectFromGit("v0.15.104", {
      cwd,
      readVersionAt: (rev) => ({ version: null, error: `simulated unreadable blob at ${rev}` }),
    });
    assert.equal(failing.historyError, null, "the range itself must still walk");
    assert.ok(failing.range.length > 0, "expected commits in v0.15.103..v0.15.104");
    assert.ok(failing.range.every((c) => c.versionError), "every entry must carry the read failure");

    const violations = auditTag({
      tag: "v0.15.104",
      treeAtTag: failing.treeAtTag,
      range: failing.range,
      tagTargetFor: failing.tagTargetFor,
    });
    assert.ok(violations.length > 0, "a range of unreadable commits must not audit as coherent");
    assert.ok(violations.every((v) => /left unaudited/.test(v)));

    const real = collectFromGit("v0.15.104", { cwd });
    assert.equal(real.historyError, null);
    assert.deepEqual(
      auditTag({
        tag: "v0.15.104",
        treeAtTag: real.treeAtTag,
        range: real.range,
        tagTargetFor: real.tagTargetFor,
      }),
      [],
    );
  });
});

test("#1882 a failed historical parent lookup is a violation, never a root commit", () => {
  withReleaseHistory((cwd) => {
    // Keep the real collectFromGit -> versionAtRev walk, but make the
    // underlying parent lookup fail through the production helper. The old
    // rev-parse catch converted this exact failure into `hasParent = false`,
    // which made the range look auditable and could let this release pass.
    const failing = collectFromGit("v0.15.104", {
      cwd,
      firstParentAt: (rev) =>
        firstParentAtRev(rev, () => {
          throw new Error(`simulated historical parent lookup failure for ${rev}`);
        }),
    });
    assert.equal(failing.historyError, null, "the commit range itself must still walk");
    assert.ok(failing.range.length > 0, "expected commits in v0.15.103..v0.15.104");
    assert.ok(
      failing.range.every((c) => /historical parent lookup .* failed/.test(c.versionError ?? "")),
      "every historical parent lookup failure must be carried into the range entry",
    );

    const violations = auditTag({ tag: "v0.15.104", ...failing });
    assert.ok(violations.length > 0, "a failed parent lookup must not audit as coherent");
    assert.ok(violations.every((v) => /left unaudited/.test(v)));
  });
});

test("#1882 the tag being pushed is not exempt from the target check", () => {
  // Rule 1 only proves the TREE at the tag says 0.15.106. A tag force-moved off
  // the commit that cut 0.15.106 onto a later commit carrying the same version
  // labels a different build than the one that published — and `v === expected`
  // used to skip the check entirely.
  const range = [
    { sha: "1atercommit", subject: "fix: a later commit, same version", version: "0.15.106", parentVersion: "0.15.106" },
    { sha: "cut0106cut", subject: "chore: release v0.15.106", version: "0.15.106", parentVersion: "0.15.105" },
  ];
  const moved = auditTag({
    tag: "v0.15.106",
    treeAtTag: treeAt("0.15.106"),
    range,
    tagTargetFor: tagsAt({ "0.15.106": "1atercommit" }),
  });
  assert.equal(moved.length, 1, moved.join("\n"));
  assert.match(moved[0], /v0\.15\.106 resolves to 1atercom/);
  assert.match(moved[0], /was cut by cut0106c/);
  assert.match(moved[0], /different build than the one the Registry publishes/);

  const inPlace = auditTag({
    tag: "v0.15.106",
    treeAtTag: treeAt("0.15.106"),
    range,
    tagTargetFor: tagsAt({ "0.15.106": "cut0106cut" }),
  });
  assert.deepEqual(inPlace, []);
});

test("#1882 a published version with no tag is a violation, not a later-tag problem", () => {
  const violations = auditPublishedVersion({
    version: "0.15.111",
    cutSha: "48d655db00",
    cutSubject: "chore: release v0.15.111",
    tagTargetFor: noTags,
  });
  assert.equal(violations.length, 1, violations.join("\n"));
  assert.match(violations[0], /^0\.15\.111 was cut by 48d655db /);
  assert.match(violations[0], /no v0\.15\.111 tag exists/);
  assert.match(violations[0], /git tag -a v0\.15\.111 48d655db/);
  assert.match(violations[0], /cannot re-trigger the publish workflow/);
});

test("#1882 a published-version tag is credited only when it labels the cut", () => {
  const cut = "86fee2f800";
  const wrong = auditPublishedVersion({
    version: "0.15.111",
    cutSha: cut,
    tagTargetFor: tagsAt({ "0.15.111": "deadbeef00" }),
  });
  assert.equal(wrong.length, 1, wrong.join("\n"));
  assert.match(wrong[0], /v0\.15\.111 resolves to deadbeef/);
  assert.match(wrong[0], /was cut by 86fee2f8/);

  const right = auditPublishedVersion({
    version: "0.15.111",
    cutSha: cut,
    tagTargetFor: tagsAt({ "0.15.111": cut }),
  });
  assert.deepEqual(right, []);
});

test("#1882 an unrunnable published-version scan is a violation, not a pass", () => {
  const violations = auditPublishedVersion({
    version: "0.15.115",
    cutSha: "6d08afd900",
    tagTargetFor: noTags,
    historyError: "this is a shallow clone, so the range cannot be walked",
  });
  assert.equal(violations.length, 1, violations.join("\n"));
  assert.match(violations[0], /tag check could not run/);
  assert.match(violations[0], /shallow clone/);
});

test("#1882 collectPublishedFromGit walks back to the cut, not HEAD", () => {
  withReleaseHistory((cwd) => {
    writeFileSync(join(cwd, "note.txt"), "later same version\n");
    execFileSync("git", ["-C", cwd, "add", "note.txt"]);
    execFileSync("git", ["-C", cwd, "commit", "-m", "docs: a later commit at 0.15.104"]);
    const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const cut = execFileSync("git", ["-C", cwd, "rev-parse", "v0.15.104^{commit}"], { encoding: "utf8" }).trim();
    assert.notEqual(head, cut);

    const collected = collectPublishedFromGit("HEAD", { cwd });
    assert.equal(collected.historyError, null, collected.historyError);
    assert.equal(collected.version, "0.15.104");
    assert.equal(collected.cutSha, cut);
    assert.deepEqual(auditPublishedVersion(collected), []);
  });
});

test("#1882 collectPublishedFromGit reports the 0.15.111 shape: tree shipped, no tag", () => {
  withReleaseHistory((cwd) => {
    execFileSync("git", ["-C", cwd, "tag", "-d", "v0.15.104"]);
    const collected = collectPublishedFromGit("HEAD", { cwd });
    assert.equal(collected.historyError, null, collected.historyError);
    assert.equal(collected.version, "0.15.104");
    const violations = auditPublishedVersion(collected);
    assert.equal(violations.length, 1, violations.join("\n"));
    assert.match(violations[0], /no v0\.15\.104 tag exists/);
  });
});

test("#1882 --ensure creates the missing tag on the commit that cut the version", () => {
  withReleaseHistory((cwd) => {
    execFileSync("git", ["-C", cwd, "tag", "-d", "v0.15.104"]);
    const missing = collectPublishedFromGit("HEAD", { cwd });
    const ensured = ensurePublishedTag(missing, { cwd });
    assert.equal(ensured.error, null, ensured.error);
    assert.equal(ensured.created, true);
    assert.equal(ensured.pushed, false);

    const after = collectPublishedFromGit("HEAD", { cwd });
    assert.deepEqual(auditPublishedVersion(after), []);
    const target = execFileSync("git", ["-C", cwd, "rev-parse", "v0.15.104^{commit}"], { encoding: "utf8" }).trim();
    assert.equal(target, missing.cutSha);
  });
});

test("#1882 --ensure will not move a tag that already points at a different commit", () => {
  withReleaseHistory((cwd) => {
    const cut = execFileSync("git", ["-C", cwd, "rev-parse", "v0.15.104^{commit}"], { encoding: "utf8" }).trim();
    const other = execFileSync("git", ["-C", cwd, "rev-parse", "v0.15.103^{commit}"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", cwd, "tag", "-d", "v0.15.104"]);
    execFileSync("git", ["-C", cwd, "tag", "v0.15.104", other]);
    const collected = collectPublishedFromGit("HEAD", { cwd });
    const ensured = ensurePublishedTag(collected, { cwd });
    assert.equal(ensured.created, false);
    assert.match(ensured.error ?? "", /Refusing to move a release tag/);
    const still = execFileSync("git", ["-C", cwd, "rev-parse", "v0.15.104^{commit}"], { encoding: "utf8" }).trim();
    assert.equal(still, other);
    assert.notEqual(still, cut);
  });
});

test("#1882 a history failure still reports the tree-vs-tag mismatch it could check", () => {
  const violations = auditTag({
    tag: "v0.15.90",
    treeAtTag: treeAt("0.15.85"),
    range: [],
    tagTargetFor: noTags,
    historyError: "no v* tags are visible",
  });
  assert.ok(violations.length >= 2, violations.join("\n"));
  assert.ok(violations.some((v) => v.includes("pyproject.toml declares 0.15.85")));
  assert.ok(violations.some((v) => v.includes("untagged-release scan could not run")));
});

// ---------------------------------------------------------------------------
// wiring — a correct guard nobody invokes is the bug, not the fix
// ---------------------------------------------------------------------------

test("#1882 the guard is wired to tag pushes and actually invokes the checker", () => {
  const wf = read(".github/workflows/release-tag-guard.yml");
  assert.match(wf, /node scripts\/check-release-tag\.mjs/, "the workflow must run the checker");
  assert.match(wf, /on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- "v\*"/, "must trigger on v* tag pushes");
  // fetch-depth: 0 is load-bearing, not hygiene. On a shallow checkout the range
  // cannot be walked at all; the checker now reports that rather than passing,
  // so a regression here turns every release red instead of silently vacuous.
  assert.match(wf, /fetch-depth: 0/, "rule 2 needs full history to walk the range");
  assert.match(wf, /fetch-tags: true/, "rule 2 needs the tag list to test against");
});

test("#1882 the tag guard must not adopt a branch trigger — that is what would publish", () => {
  // publish_action.yml is filtered by `branches: [main]`, which is exactly why a
  // tag push cannot fire it. If this guard ever grew a push-to-main trigger it
  // would run on release commits, where the tag does not exist yet.
  const wf = read(".github/workflows/release-tag-guard.yml");
  const onBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("permissions:"));
  assert.ok(!/\bbranches:/.test(onBlock), "the tag guard must stay tag-triggered only");
});

test("#1882 the tag guard also audits HEAD on a schedule, because no tag push may ever come", () => {
  const wf = read(".github/workflows/release-tag-guard.yml");
  assert.match(wf, /schedule:\s*\n\s*- cron:/, "a published-but-untagged tree must not wait for the next tag");
  assert.match(wf, /node scripts\/check-release-tag\.mjs --published/, "the schedule must run the published-version check");
});

test("#1882 publish_action.yml stays branches-filtered, so a tag push cannot republish", () => {
  // The whole reason a missing historical tag can be created safely. If someone
  // adds a `tags:` filter here, backfilling a tag would re-publish to the Registry.
  const wf = read(".github/workflows/publish_action.yml");
  const onBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\njobs:"));
  assert.match(onBlock, /branches:\s*\n\s*- main/);
  assert.ok(!/\btags:/.test(onBlock), "publish must never trigger on a tag push");
});

test("#1882 the publish job tags the cut AFTER a successful Registry publish", () => {
  const wf = read(".github/workflows/publish_action.yml");
  const publish = wf.indexOf("- name: Publish custom node");
  const guard = wf.indexOf("scripts/check-release-tag.mjs --published");
  assert.notEqual(publish, -1, "the publish step is missing");
  assert.notEqual(guard, -1, "the published-version check is missing");
  assert.ok(guard > publish, "tagging a version that failed to publish recreates the stale-tag operand");
  assert.match(wf, /--ensure/, "the path must create the missing tag, not only complain");
  assert.match(wf, /--push/, "a local tag is not the operand `git tag` on a clone sees");
  assert.match(wf, /contents:\s*write/, "pushing the archival tag needs contents: write");
});

// ---------------------------------------------------------------------------
// the same class, second instance: a gate listing a file that no longer exists
// ---------------------------------------------------------------------------

test("#1882 every path in the pack-contents gate exists (a missing one is vacuous)", () => {
  const files = [".github/workflows/ci.yml", ".github/workflows/publish_action.yml"];
  let checked = 0;
  for (const file of files) {
    const src = read(file);
    const block = /for f in \\\r?\n([\s\S]*?)\r?\n\s*; do/.exec(src);
    assert.ok(block, `pack-contents file list not found in ${file}`);
    const paths = block[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/\\\s*$/, "").trim())
      .filter(Boolean);
    assert.ok(paths.length >= 4, `${file}: expected the runtime asset list, got ${paths.length} entries`);
    for (const p of paths) {
      assert.ok(
        existsSync(join(root, p)),
        `${file} asserts ${p} is not .comfyignore'd, but that file does not exist — ` +
          `check-ignore passes trivially on a missing path, so the entry is coverage in name only (#1882)`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});
