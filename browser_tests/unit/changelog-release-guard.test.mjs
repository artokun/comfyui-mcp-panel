// #1891 — exercise the actual release generator and the guard against a small
// repository history, rather than testing a copy of either production path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runGuard(cwd, version = "1.1.0", ref = "v1.1.0") {
  const args = [GUARD];
  if (version) args.push(version);
  if (ref) args.push("--ref", ref);
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
        "",
      ].join("\n"),
      "utf8",
    );
    git(cwd, "add", "CHANGELOG.md");
    git(cwd, "commit", "-m", "0.1.0 — initial release");
    git(cwd, "commit", "--allow-empty", "-m", "fix: initial fix (#90)");
    git(cwd, "tag", "v1.0.0");

    git(cwd, "commit", "--allow-empty", "-m", "fix(100): one change, issue spelling (#101)");
    git(cwd, "commit", "--allow-empty", "-m", "fix: an independent fix (#102)");
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

    // Passing a version explicitly makes a missing current-version section fatal;
    // inference from another section must not let a publish proceed.
    const missingVersion = runGuard(cwd, "1.1.0", "v1.0.0");
    assert.notEqual(missingVersion.status, 0);
    assert.match(missingVersion.stderr, /has no \[1\.1\.0\] release section/);

    writeFileSync(cwd + "/CHANGELOG.md", generated, "utf8");
    const candidate = generated.replace("[1.1.0]", "[1.2.0]");
    writeFileSync(cwd + "/CHANGELOG.md", candidate, "utf8");
    const workingTree = runGuard(cwd, "1.2.0", null);
    assert.equal(workingTree.status, 0, workingTree.stderr);
    writeFileSync(cwd + "/CHANGELOG.md", generated, "utf8");

    writeFileSync(
      cwd + "/CHANGELOG.md",
      generated.replace("- an independent fix (#102)", "- duplicate alias (#101)\n- an independent fix (#102)"),
      "utf8",
    );
    const duplicateAlias = runGuard(cwd, "1.1.0", null);
    assert.notEqual(duplicateAlias.status, 0);
    assert.match(duplicateAlias.stderr, /repeats issue\/PR identity/);

    writeFileSync(cwd + "/CHANGELOG.md", generated.replace("### Fixed\n", "### Fixed\n\n### Fixed\n"), "utf8");
    const duplicateHeading = runGuard(cwd, "1.1.0", null);
    assert.notEqual(duplicateHeading.status, 0);
    assert.match(duplicateHeading.stderr, /repeats heading/);

    writeFileSync(cwd + "/CHANGELOG.md", generated.replace("#102", "#999"), "utf8");
    const unreachableEntry = runGuard(cwd, "1.1.0", null);
    assert.notEqual(unreachableEntry.status, 0);
    assert.match(unreachableEntry.stderr, /no reachable commit subject/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("#1891: publish guard receives pyproject version before checking changelog", () => {
  const workflow = readFileSync(PUBLISH_WORKFLOW, "utf8");
  const versionStep = workflow.indexOf("id: release-version");
  const guardStep = workflow.indexOf('node scripts/check-changelog.mjs "$RELEASE_VERSION" --ref "$RELEASE_REF"');
  assert.notEqual(versionStep, -1);
  assert.notEqual(guardStep, -1);
  assert.ok(versionStep < guardStep);
  assert.ok(guardStep < workflow.indexOf("- name: Publish custom node"));
  assert.match(workflow, /tomllib\.load\(Path\("pyproject\.toml"\)\.open\("rb"\)\)/);
  assert.match(workflow, /RELEASE_VERSION: \$\{\{ steps\.release-version\.outputs\.version \}\}/);
});
