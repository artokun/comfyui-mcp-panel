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

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runGuard(cwd, ref = "v1.1.0") {
  return spawnSync(process.execPath, [GUARD, "1.1.0", "--ref", ref], {
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
    writeFileSync(cwd + "/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n", "utf8");
    git(cwd, "add", "CHANGELOG.md");
    git(cwd, "commit", "-m", "0.1.0 — initial release");
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

    const olderTree = runGuard(cwd, "v1.0.0");
    assert.notEqual(olderTree.status, 0);
    assert.match(olderTree.stderr, /no merge candidate is an ancestor/);

    writeFileSync(
      cwd + "/CHANGELOG.md",
      generated.replace("- an independent fix (#102)", "- duplicate alias (#101)\n- an independent fix (#102)"),
      "utf8",
    );
    const duplicateAlias = runGuard(cwd);
    assert.notEqual(duplicateAlias.status, 0);
    assert.match(duplicateAlias.stderr, /repeats issue\/PR identity/);

    writeFileSync(cwd + "/CHANGELOG.md", generated.replace("### Fixed\n", "### Fixed\n\n### Fixed\n"), "utf8");
    const duplicateHeading = runGuard(cwd);
    assert.notEqual(duplicateHeading.status, 0);
    assert.match(duplicateHeading.stderr, /repeats heading/);

    writeFileSync(cwd + "/CHANGELOG.md", generated.replace("#102", "#999"), "utf8");
    const unreachableEntry = runGuard(cwd);
    assert.notEqual(unreachableEntry.status, 0);
    assert.match(unreachableEntry.stderr, /no reachable commit subject/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
