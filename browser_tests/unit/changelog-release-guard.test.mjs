// #1891 — exercise the actual release generator and the guard against a small
// repository history, rather than testing a copy of either production path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATOR = join(HERE, "..", "..", "scripts", "gen-changelog.mjs");
const GUARD = join(HERE, "..", "..", "scripts", "check-changelog.mjs");
const PUBLISH_WORKFLOW = join(HERE, "..", "..", ".github", "workflows", "publish_action.yml");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runGuard(cwd, version = "1.1.0", ref = "v1.1.0", extraArgs = []) {
  const args = [GUARD];
  if (version) args.push(version);
  if (ref) args.push("--ref", ref);
  args.push(...extraArgs);
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CHANGELOG_ROOT: cwd },
  });
}

test("#1891: release generation merges headings and issue/PR aliases", () => {
  const cwd = mkdtempSync(join(tmpdir(), "panel-changelog-"));
  try {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "user.name", "Changelog Test");
    writeFileSync(
      cwd + "/CHANGELOG.md",
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.0.0] - 2026-08-26",
        "",
        "### Fixed",
        "- initial fix (#90)",
        "- second fix (#91)",
        "",
      ].join("\n"),
      "utf8",
    );
    git(cwd, "add", "CHANGELOG.md");
    git(cwd, "commit", "-m", "0.1.0 — initial release");
    git(cwd, "commit", "--allow-empty", "-m", "fix: initial fix (#90)");
    git(cwd, "commit", "--allow-empty", "-m", "fix: second fix (#91)");
    git(cwd, "tag", "v1.0.0");

    // A future branch must not feed alias discovery for the current release either. Its
    // #200/#103 spelling is intentionally related to a current PR so an unscoped `git
    // log --all` would incorrectly deduplicate the current change.
    git(cwd, "checkout", "-b", "future");
    git(cwd, "commit", "--allow-empty", "-m", "fix(200): unrelated future alias (#103)");
    git(cwd, "checkout", "main");

    git(cwd, "commit", "--allow-empty", "-m", "fix(100): one change, issue spelling (#101)");
    git(cwd, "commit", "--allow-empty", "-m", "fix: a supporting fix (#102)");
    git(cwd, "commit", "--allow-empty", "-m", "fix: an independent fix (#103)");
    writeFileSync(
      cwd + "/CHANGELOG.md",
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Fixed",
        "- hand-written issue spelling (#100)",
        "",
        "### Fixed",
        "- hand-written PR spelling (#101)",
        "- hand-written future issue (#200) (#102)",
        "",
      ].join("\n"),
      "utf8",
    );

    execFileSync(process.execPath, [GENERATOR, "1.1.0"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CHANGELOG_ROOT: cwd },
    });
    const generated = readFileSync(cwd + "/CHANGELOG.md", "utf8");
    assert.equal((generated.match(/^### Fixed$/gm) ?? []).length, 1);
    assert.equal((generated.match(/#100/g) ?? []).length, 1);
    assert.equal((generated.match(/#101/g) ?? []).length, 0);
    assert.equal((generated.match(/#102/g) ?? []).length, 1);
    assert.equal((generated.match(/#103/g) ?? []).length, 1);
    assert.equal((generated.match(/#200/g) ?? []).length, 1);

    git(cwd, "add", "CHANGELOG.md");
    git(cwd, "commit", "-m", "1.1.0 — release");
    git(cwd, "tag", "v1.1.0");
    const healthy = runGuard(cwd);
    assert.equal(healthy.status, 0, healthy.stderr);

    // Explicit refs must supply the audited file too. Remove the checkout's
    // current file, then audit the intact historical tag; the tag's blob must win.
    rmSync(cwd + "/CHANGELOG.md");
    const historicalTag = runGuard(cwd, "1.0.0", "v1.0.0");
    assert.equal(historicalTag.status, 0, historicalTag.stderr);
    const inferredHistoricalTag = runGuard(cwd, null, "v1.0.0");
    assert.equal(inferredHistoricalTag.status, 0, inferredHistoricalTag.stderr);

    for (const malformed of ["1.1", "1.1.0; touch pwned", "1.1.0\ninjected", "--bad-version"]) {
      const result = runGuard(cwd, malformed, "v1.0.0");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid release version/);
      assert.doesNotMatch(result.stderr, /has no \[/);
    }
    assert.equal(existsSync(join(cwd, "pwned")), false);

    // Passing a version explicitly makes a missing current-version section fatal;
    // inference from another section must not let a publish proceed.
    const missingVersion = runGuard(cwd, "1.1.0", "v1.0.0");
    assert.notEqual(missingVersion.status, 0);
    assert.match(missingVersion.stderr, /has no \[1\.1\.0\] release section/);

    writeFileSync(cwd + "/CHANGELOG.md", generated, "utf8");
    const candidate = generated.replace("[1.1.0]", "[1.2.0]");
    writeFileSync(cwd + "/CHANGELOG.md", candidate, "utf8");
    const workingTree = runGuard(cwd, "1.2.0", null, ["--working-tree"]);
    assert.equal(workingTree.status, 0, workingTree.stderr);
    writeFileSync(cwd + "/CHANGELOG.md", generated, "utf8");

    writeFileSync(
      cwd + "/CHANGELOG.md",
      generated.replace("- an independent fix (#103)", "- duplicate alias (#101)\n- an independent fix (#103)"),
      "utf8",
    );
    const duplicateAlias = runGuard(cwd, "1.1.0", null, ["--working-tree"]);
    assert.notEqual(duplicateAlias.status, 0);
    assert.match(duplicateAlias.stderr, /repeats issue\/PR identity/);

    writeFileSync(cwd + "/CHANGELOG.md", generated.replace("### Fixed\n", "### Fixed\n\n### Fixed\n"), "utf8");
    const duplicateHeading = runGuard(cwd, "1.1.0", null, ["--working-tree"]);
    assert.notEqual(duplicateHeading.status, 0);
    assert.match(duplicateHeading.stderr, /repeats heading/);

    const releaseIndex = generated.indexOf("## [1.1.0]");
    const releaseBlock = generated.slice(releaseIndex).trimEnd();
    writeFileSync(
      cwd + "/CHANGELOG.md",
      `${generated.slice(0, releaseIndex)}${releaseBlock}\n\n${releaseBlock}\n`,
      "utf8",
    );
    const duplicateRelease = runGuard(cwd, "1.1.0", null, ["--working-tree"]);
    assert.notEqual(duplicateRelease.status, 0);
    assert.match(duplicateRelease.stderr, /repeats \[1\.1\.0\] release section/);

    writeFileSync(
      cwd + "/CHANGELOG.md",
      ["# Changelog", "", "## [Unreleased]", "", "## [1.1.0] - 2026-08-26", ""].join("\n"),
      "utf8",
    );
    const emptyRelease = runGuard(cwd, "1.1.0", null, ["--working-tree"]);
    assert.notEqual(emptyRelease.status, 0);
    assert.match(emptyRelease.stderr, /\[1\.1\.0\] release section is empty/);

    writeFileSync(cwd + "/CHANGELOG.md", generated.replace("#102", "#999"), "utf8");
    const unreachableEntry = runGuard(cwd, "1.1.0", null, ["--working-tree"]);
    assert.notEqual(unreachableEntry.status, 0);
    assert.match(unreachableEntry.stderr, /no reachable commit subject/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("#1882: changelog generation bounds at an untagged `chore: release` commit", () => {
  // Tags lag this repo's cuts. If the generator only recognises `chore(release):` /
  // `release:` / a bare version, prevTag() falls back to the previous TAG and the
  // next cut re-lists everything since — the 0.15.111–0.15.113 shape in #1882.
  const cwd = mkdtempSync(join(tmpdir(), "panel-changelog-untagged-"));
  try {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "user.name", "Changelog Test");
    writeFileSync(
      cwd + "/CHANGELOG.md",
      ["# Changelog", "", "## [Unreleased]", "", "## [1.0.0] - 2026-08-26", "", "### Fixed", "- initial fix (#90)", ""].join(
        "\n",
      ),
      "utf8",
    );
    git(cwd, "add", "CHANGELOG.md");
    git(cwd, "commit", "-m", "1.0.0 — initial release");
    git(cwd, "tag", "v1.0.0");
    git(cwd, "commit", "--allow-empty", "-m", "fix: shipped only in 1.1.0 (#201)");
    git(cwd, "commit", "--allow-empty", "-m", "chore: release v1.1.0 (#202)");
    git(cwd, "commit", "--allow-empty", "-m", "fix: shipped only in 1.2.0 (#203)");

    execFileSync(process.execPath, [GENERATOR, "1.2.0"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CHANGELOG_ROOT: cwd },
    });
    const generated = readFileSync(cwd + "/CHANGELOG.md", "utf8");
    const section12 = generated.slice(generated.indexOf("## [1.2.0]"));
    const nextRelease = section12.search(/\n## \[/);
    const body12 = nextRelease >= 0 ? section12.slice(0, nextRelease) : section12;
    assert.match(body12, /#203/, "the new cut must include its own commit");
    assert.doesNotMatch(body12, /#201/, "an untagged previous release must still bound the range");
    assert.doesNotMatch(body12, /#202/, "the previous release commit is not filed as a change");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("#1891: publish guard receives pyproject version before checking changelog", () => {
  const workflow = readFileSync(PUBLISH_WORKFLOW, "utf8");
  const versionStep = workflow.indexOf("id: release-version");
  const guardStep = workflow.indexOf('node scripts/check-changelog.mjs "$RELEASE_VERSION" --ref "$RELEASE_REF"');
  const versionValidation = workflow.indexOf("semver.fullmatch(version) is None");
  const outputWrite = workflow.indexOf('Path(output).open("a", encoding="utf-8", newline="")');
  assert.notEqual(versionStep, -1);
  assert.notEqual(guardStep, -1);
  assert.notEqual(versionValidation, -1);
  assert.notEqual(outputWrite, -1);
  assert.ok(versionStep < guardStep);
  assert.ok(versionValidation < outputWrite);
  assert.ok(guardStep < workflow.indexOf("- name: Publish custom node"));
  assert.match(workflow, /shell: python/);
  assert.match(workflow, /re\.compile\(/);
  assert.match(workflow, /RELEASE_VERSION: \$\{\{ steps\.release-version\.outputs\.version \}\}/);
  assert.match(workflow, /version="\$RELEASE_VERSION"/);
  assert.doesNotMatch(workflow, /version="\$\{\{ steps\.release-version\.outputs\.version \}\}"/);
  assert.doesNotMatch(workflow, /echo "version=\$version"/);
});
