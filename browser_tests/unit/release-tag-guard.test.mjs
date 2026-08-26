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
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  auditTag,
  packageJsonVersion,
  panelVersion,
  pyprojectVersion,
  versionOfTag,
} from "../../scripts/check-release-tag.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const treeAt = (v) => ({
  pyproject: `[project]\nname = "comfyui-mcp-panel"\nversion = "${v}"\n`,
  packageJson: JSON.stringify({ name: "comfyui-mcp-panel", version: v }),
  panelJs: `const PANEL_VERSION = "${v}";\n`,
});

const noTags = () => false;
const tagsFor = (...vs) => (v) => vs.includes(v);

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

test("#1882 pyprojectVersion reads [project].version and ignores other tables", () => {
  const toml =
    '[build-system]\nversion = "9.9.9"\n\n[project]\nname = "x"\nversion = "0.15.97"\n\n[tool.comfy]\nversion = "1.2.3"\n';
  assert.equal(pyprojectVersion(toml), "0.15.97");
  assert.equal(pyprojectVersion("[tool.comfy]\nversion = \"1.2.3\"\n"), null);
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
    range: [{ sha: "aaaaaaaa1", subject: "chore: release v0.15.104", version: "0.15.104", parentVersion: "0.15.103" }],
    hasTagFor: tagsFor("0.15.103"),
  });
  assert.deepEqual(violations, []);
});

test("#1882 the v0.15.90 shape is caught: tag says .90, tree still declares 0.15.85", () => {
  // The real historical tree — set-version.mjs was never run, so pyproject and
  // PANEL_VERSION are frozen, while package.json (bumped by npm) moved on. That
  // asymmetry is why all three witnesses are compared and not just two.
  const violations = auditTag({
    tag: "v0.15.90",
    treeAtTag: {
      ...treeAt("0.15.85"),
      packageJson: JSON.stringify({ version: "0.15.90" }),
    },
    range: [],
    hasTagFor: noTags,
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
    hasTagFor: noTags,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /could not read a version from PANEL_VERSION/);
});

test("#1882 a non-release tag is reported rather than silently audited as coherent", () => {
  const violations = auditTag({
    tag: "nightly",
    treeAtTag: treeAt("0.15.104"),
    range: [],
    hasTagFor: noTags,
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
      { sha: "7b477d5500", subject: "Merge pull request #1826 from artokun/release/0.15.97", version: "0.15.97", parentVersion: "0.15.85" },
    ],
    hasTagFor: tagsFor("0.15.96"),
  });
  assert.equal(violations.length, 1, violations.join("\n"));
  assert.match(violations[0], /^0\.15\.97 was published by 7b477d55 /);
  assert.match(violations[0], /no v0\.15\.97 tag exists/);
  // The remedy has to be in the message: the reason this sat unfixed is that
  // pushing the tag was believed to re-publish to the Registry.
  assert.match(violations[0], /git tag -a v0\.15\.97 7b477d55/);
  assert.match(violations[0], /does not re-trigger the publish workflow/);
});

test("#1882 the tag's own release commit is never reported as an untagged gap", () => {
  // At push time this tag legitimately has no *earlier* tag for its own version,
  // and flagging it would make every single release red.
  const violations = auditTag({
    tag: "v0.15.105",
    treeAtTag: treeAt("0.15.105"),
    range: [{ sha: "abcabcabc", subject: "chore: release v0.15.105", version: "0.15.105", parentVersion: "0.15.104" }],
    hasTagFor: noTags,
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
    hasTagFor: noTags,
  });
  assert.deepEqual(violations, []);
});

test("#1882 an already-tagged prior release in the range is fine", () => {
  const violations = auditTag({
    tag: "v0.15.105",
    treeAtTag: treeAt("0.15.105"),
    range: [
      { sha: "ffffffff1", subject: "chore: release v0.15.105", version: "0.15.105", parentVersion: "0.15.104" },
      { sha: "ffffffff2", subject: "chore: release v0.15.104", version: "0.15.104", parentVersion: "0.15.103" },
    ],
    hasTagFor: tagsFor("0.15.104"),
  });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// wiring — a correct guard nobody invokes is the bug, not the fix
// ---------------------------------------------------------------------------

test("#1882 the guard is wired to tag pushes and actually invokes the checker", () => {
  const wf = read(".github/workflows/release-tag-guard.yml");
  assert.match(wf, /node scripts\/check-release-tag\.mjs/, "the workflow must run the checker");
  assert.match(wf, /on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- "v\*"/, "must trigger on v* tag pushes");
  // fetch-depth: 0 is load-bearing, not hygiene. On a shallow checkout
  // `git describe` finds no earlier tag, the range collapses, and rule 2
  // degrades to a no-op that still reports success.
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

test("#1882 publish_action.yml stays branches-filtered, so a tag push cannot republish", () => {
  // The whole reason a missing historical tag can be created safely. If someone
  // adds a `tags:` filter here, backfilling a tag would re-publish to the Registry.
  const wf = read(".github/workflows/publish_action.yml");
  const onBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\njobs:"));
  assert.match(onBlock, /branches:\s*\n\s*- main/);
  assert.ok(!/\btags:/.test(onBlock), "publish must never trigger on a tag push");
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
