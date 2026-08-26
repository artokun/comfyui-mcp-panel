/**
 * Fail a release when the git tag and the version in the tree disagree — in
 * EITHER direction.
 *
 *   node scripts/check-release-tag.mjs v0.15.105     # audit one tag
 *   GITHUB_REF_NAME=v0.15.105 node scripts/check-release-tag.mjs
 *
 * WHY. "Was version X released?" is answered from `git tag`, and that operand
 * has been wrong both ways on this repo (#1882):
 *
 *   tag exists, tree stale  → v0.15.86..v0.15.96 all declare version "0.15.85"
 *                             in their own pyproject.toml. `publish_action.yml`
 *                             fires on `paths: [pyproject.toml]`, so for the
 *                             tagged commits that never touched that file the
 *                             workflow NEVER RAN — no job, no red X, nothing in
 *                             the Actions tab. Ten consecutive versions were
 *                             silently never published, and `latest_version` on
 *                             the Registry still reads 0.15.85.
 *
 *   tree shipped, no tag    → 0.15.97 is live on the Registry (created
 *                             2026-08-26T03:01:45Z) from commit cd50f093
 *                             "chore: release v0.15.97". There is no v0.15.97
 *                             tag. Two reporters on #1859 and #1860 were told
 *                             0.15.97 "was never released" because the tag list
 *                             said so.
 *
 * WHY THE CHECK LIVES ON THE TAG PUSH AND NOT IN THE PUBLISH JOB. The publish
 * job is the wrong place for the first failure mode, because the whole failure
 * IS that the publish job did not execute. A guard inside a workflow that never
 * runs is not a guard. The tag push is an event that did occur every one of
 * those ten times.
 *
 * TWO RULES, and the second is what lets a tag-only trigger see the untagged
 * direction at all:
 *
 *   1. TREE MATCHES TAG. At tag `v<X>`, pyproject.toml, package.json and the
 *      panel's PANEL_VERSION constant must all read exactly `<X>`. All three,
 *      because pyproject and PANEL_VERSION are written by the same script
 *      (scripts/set-version.mjs) and therefore cannot disagree when that script
 *      is simply never run — package.json is the independent witness. This
 *      mirrors ci.yml's three-way gate but anchors it to the TAG, which ci.yml
 *      cannot see.
 *
 *   2. NO PUBLISHED VERSION WAS SKIPPED. Walk first-parent from the previous
 *      reachable tag to this one. Every commit in that range whose pyproject
 *      version differs from its parent's is a commit that triggered a publish,
 *      i.e. a version that shipped — so it must have a tag of its own. Pushing
 *      v0.15.98 today would go red naming cd50f093 / 0.15.97.
 *
 *      This direction has no race. It only ever looks at versions that shipped
 *      STRICTLY BEFORE the tag being pushed, so a tag pushed minutes after its
 *      own release commit is never in its own scan. Asserting "a tag exists at
 *      the SHA I am publishing" from inside the publish job would be racy for
 *      exactly that reason, and would abort a legitimate release over a tag that
 *      is seconds away.
 *
 *      It is also self-bounding: the range starts at the previous reachable tag,
 *      so this never re-litigates the whole history and cannot become
 *      permanently red over a historical gap nobody intends to backfill.
 *
 * PUSHING A TAG DOES NOT PUBLISH. `publish_action.yml` filters `on.push` by
 * `branches: [main]`, and GitHub does not run a `branches`-filtered push
 * workflow for a tag ref. So this guard can be added, and a missing historical
 * tag can be created, without re-publishing anything to the Registry.
 */
import { execFileSync } from "node:child_process";

/** `version = "0.15.97"` out of a pyproject.toml — the [project] table only. */
export function pyprojectVersion(text) {
  if (typeof text !== "string") return null;
  // Split on table headers so a `version` under e.g. [tool.something] cannot win.
  const project = text.split(/^\[/m).find((chunk) => chunk.startsWith("project]"));
  if (!project) return null;
  const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(project);
  return m ? m[1] : null;
}

export function packageJsonVersion(text) {
  try {
    const v = JSON.parse(text)?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function panelVersion(text) {
  if (typeof text !== "string") return null;
  const m = /const PANEL_VERSION = "([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

/** `v0.15.97` -> `0.15.97`. Anything else -> null (not a release tag). */
export function versionOfTag(tag) {
  const m = /^v(\d+\.\d+\.\d+.*)$/.exec(String(tag ?? ""));
  return m ? m[1] : null;
}

/**
 * The pure core. Everything git-shaped is injected, so the rules are testable
 * without fabricating a repository and can be exercised against the exact
 * historical shapes from #1882.
 *
 * @param {object} o
 * @param {string} o.tag  tag being audited, e.g. "v0.15.105"
 * @param {{pyproject:string|null, packageJson:string|null, panelJs:string|null}} o.treeAtTag
 * @param {Array<{sha:string, subject:string, version:string|null, parentVersion:string|null}>} o.range
 *        first-parent commits from the previous reachable tag (exclusive) to the
 *        tag (inclusive). Order is not used.
 * @param {(version:string)=>boolean} o.hasTagFor  does a tag exist for this version?
 * @returns {string[]} violations; empty means the release is coherent.
 */
export function auditTag({ tag, treeAtTag, range = [], hasTagFor }) {
  const violations = [];
  const expected = versionOfTag(tag);
  if (!expected) {
    return [`"${tag}" is not a v<major>.<minor>.<patch> release tag — nothing to audit.`];
  }

  // ---- Rule 1: the tree at the tag declares the tag's version, three ways.
  const seen = {
    "pyproject.toml": pyprojectVersion(treeAtTag?.pyproject),
    "package.json": packageJsonVersion(treeAtTag?.packageJson),
    PANEL_VERSION: panelVersion(treeAtTag?.panelJs),
  };
  for (const [where, got] of Object.entries(seen)) {
    if (got === null) {
      violations.push(`${tag}: could not read a version from ${where}.`);
    } else if (got !== expected) {
      violations.push(
        `${tag}: ${where} declares ${got}, but the tag says ${expected}. The tagged ` +
          `tree is not the version it claims to be — this is the v0.15.86..v0.15.96 ` +
          `shape, where publish_action.yml never ran at all because pyproject.toml ` +
          `never changed. Run "node scripts/set-version.mjs ${expected}" and re-tag.`,
      );
    }
  }

  // ---- Rule 2: nothing shipped between the previous tag and this one untagged.
  for (const c of range) {
    const v = c?.version;
    if (!v || v === c.parentVersion) continue; // pyproject touched, version unchanged
    if (v === expected) continue; // this tag's own release commit
    if (hasTagFor(v)) continue;
    const short = String(c.sha).slice(0, 8);
    violations.push(
      `${v} was published by ${short} ("${c.subject}") — that commit changed ` +
        `pyproject.toml's version, which is what triggers publish_action.yml — but ` +
        `no v${v} tag exists. The Registry has a release "git tag" cannot see ` +
        `(#1882). Create it with: git tag -a v${v} ${short} -m "release v${v}" && ` +
        `git push origin v${v} — a tag push does not re-trigger the publish workflow.`,
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// git-backed shell
// ---------------------------------------------------------------------------

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const showOrNull = (rev, path) => {
  try {
    return git("show", `${rev}:${path}`);
  } catch {
    return null;
  }
};

export function collectFromGit(tag) {
  const treeAtTag = {
    pyproject: showOrNull(tag, "pyproject.toml"),
    packageJson: showOrNull(tag, "package.json"),
    panelJs: showOrNull(tag, "web/js/comfyui-mcp-panel.js"),
  };

  // Previous reachable tag. When tags are missing this walks further back, which
  // is exactly what rule 2 needs: a gap widens the window that finds it.
  let previousTag = null;
  try {
    previousTag = git("describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`).trim();
  } catch {
    previousTag = null; // first tag in history, or no earlier tag fetched
  }

  const spec = previousTag ? `${previousTag}..${tag}` : tag;
  let range = [];
  try {
    range = git("rev-list", "--first-parent", "--format=%H%x00%s", spec)
      .split("\n")
      .filter((l) => l && !l.startsWith("commit "))
      .map((line) => {
        const [sha, subject] = line.split("\0");
        return {
          sha,
          subject: subject ?? "",
          version: pyprojectVersion(showOrNull(sha, "pyproject.toml")),
          parentVersion: pyprojectVersion(showOrNull(`${sha}^`, "pyproject.toml")),
        };
      });
  } catch {
    range = [];
  }

  const tags = new Set(
    git("tag", "--list", "v*")
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  return { treeAtTag, range, hasTagFor: (v) => tags.has(`v${v}`), previousTag };
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check-release-tag.mjs");

if (invokedDirectly) {
  const tag = (process.argv[2] || process.env.GITHUB_REF_NAME || "").trim();
  if (!tag) {
    console.error("usage: node scripts/check-release-tag.mjs <tag>   (or set GITHUB_REF_NAME)");
    process.exit(2);
  }
  const { treeAtTag, range, hasTagFor, previousTag } = collectFromGit(tag);
  const violations = auditTag({ tag, treeAtTag, range, hasTagFor });
  console.error(
    `auditing ${tag} against ${previousTag ?? "(no earlier tag)"} — ` +
      `${range.length} first-parent commit(s) in range`,
  );
  for (const v of violations) console.log(`::error::${v}`);
  if (!violations.length) {
    console.log(`release ${tag} is coherent: tree, tag and prior releases all agree.`);
  }
  process.exit(violations.length ? 1 : 0);
}
