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
 *                             2026-08-26T03:01:45Z) from the merge of
 *                             release/0.15.97. There is no v0.15.97 tag. Two
 *                             reporters on #1859 and #1860 were told 0.15.97
 *                             "was never released" because the tag list said so.
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
 *   2. EVERY VERSION CUT IN THE RANGE IS LABELLED BY ITS OWN TAG. Walk
 *      first-parent from the previous reachable tag to this one. Every commit in
 *      that range whose pyproject version differs from its parent's cut a
 *      version, so the tag for `<v>` must resolve to THAT COMMIT, not merely
 *      exist. A tag is a movable label; crediting one by name alone would let
 *      `v0.15.97` sit on an unrelated commit while the commit that actually
 *      published 0.15.97 stayed untagged, which is the very confusion this guard
 *      exists to end.
 *
 *      The tag being pushed is NOT exempt from that. Rule 1 only proves the tree
 *      AT the tag declares `<X>`; it cannot see a tag moved off the commit that
 *      cut `<X>` onto a later commit carrying the same version — a tag labelling
 *      a different build than the one that publishes.
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
 * IT FAILS CLOSED, AT EVERY GRAIN. Every git lookup this needs can fail — a
 * shallow clone, tags that were never fetched, an unreadable blob on one commit.
 * The first draft turned each of those into "nothing to see": a missing range, or
 * a commit whose version read back `null` and was skipped as "not a release".
 * Both made the scan silently vacuous while the job still reported success, which
 * is the identical shape as the stale pack-contents entry this change also
 * removes. Unreadable history is a violation here, never a pass.
 *
 * WHAT A TAG PUSH DOES AND DOES NOT RUN. `publish_action.yml` filters `on.push`
 * by `branches: [main]`, and GitHub does not run a `branches`-filtered push
 * workflow for a tag ref — so pushing a tag, including a backfilled historical
 * one, cannot re-publish to the Registry. Note the converse, which is easy to
 * get backwards: GitHub loads workflow files from the ref the event carries, so
 * a tag pushed at a commit that predates THIS file runs no guard either. A
 * historical backfill is therefore safe but unaudited; audit it after the fact
 * with the workflow's workflow_dispatch input, which runs this file from main.
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

const short = (sha) => String(sha ?? "").slice(0, 8);

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
 * @param {(version:string)=>(string|null)} o.tagTargetFor
 *        commit SHA that `v<version>` resolves to, or null when no such tag exists.
 * @param {string|null} [o.historyError]
 *        set when the range could not be established at all; reported as a
 *        violation so an unrunnable gap scan can never read as a clean one.
 * @returns {string[]} violations; empty means the release is coherent.
 */
export function auditTag({ tag, treeAtTag, range = [], tagTargetFor, historyError = null }) {
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

  // ---- Rule 2 preflight: an unrunnable scan is a violation, never a pass.
  if (historyError) {
    violations.push(
      `${tag}: the untagged-release scan could not run — ${historyError}. Refusing to ` +
        `report this release as coherent on a check that did not execute (#1882).`,
    );
    return violations;
  }

  // ---- Rule 2: every version cut in the range is labelled by its own tag.
  for (const c of range) {
    // A commit whose version could not be READ is not a commit without a release.
    // Skipping it on a null would let one unreadable blob hide exactly the gap
    // this scan exists to find — fail-open at a finer grain than an empty range.
    if (c?.versionError) {
      violations.push(
        `${tag}: ${c.versionError}. Refusing to report this release as coherent with ` +
          `a commit in the range left unaudited (#1882).`,
      );
      continue;
    }

    const v = c?.version;
    if (!v || v === c.parentVersion) continue; // pyproject touched, version unchanged
    const target = typeof tagTargetFor === "function" ? tagTargetFor(v) : null;
    if (target && target === c.sha) continue;

    // The tag being pushed is NOT exempt from the target check. Rule 1 only proves
    // the tree AT the tag declares <X>; it cannot see a tag moved off the commit
    // that cut <X> onto a later commit carrying the same version — a tag labelling
    // a different build than the one that publishes.
    if (v === expected) {
      violations.push(
        `${tag} resolves to ${target ? short(target) : "(no such tag)"}, but ${expected} ` +
          `was cut by ${short(c.sha)} ("${c.subject}"). The tag does not label the commit ` +
          `that changed pyproject.toml to ${expected}, so it points at a different build ` +
          `than the one the Registry publishes (#1882).`,
      );
      continue;
    }

    // A version bump reaching main is what triggers publish_action.yml. It is
    // ALMOST always a version that shipped, but not certainly: the workflow runs
    // once per push against the head commit, so if two bumps land in one push
    // only the later one is published. Both readings are release-record defects
    // worth a red build, and they have different remedies, so name both rather
    // than prescribing a tag that would itself become a false "was released".
    const why =
      target === null
        ? `no v${v} tag exists`
        : `v${v} exists but resolves to ${short(target)}, not the commit that cut ${v}`;
    violations.push(
      `${v} was cut by ${short(c.sha)} ("${c.subject}") — that commit changed ` +
        `pyproject.toml's version, which is what triggers publish_action.yml — but ` +
        `${why}. Either it published and was never tagged (the 0.15.97 case in ` +
        `#1882), or it never shipped because a later bump landed in the same push. ` +
        `If it shipped: git tag -a v${v} ${short(c.sha)} -m "release v${v}" && ` +
        `git push origin v${v} (a tag push cannot re-trigger the publish workflow). ` +
        `If it did not ship, do not tag it — that would recreate the same bad ` +
        `operand in the other direction.`,
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// git-backed shell
// ---------------------------------------------------------------------------

/**
 * git bound to a working directory. `cwd` exists so the walk can be exercised
 * against a purpose-built repository: CI checks this repo out shallow and
 * without tags, so any test keyed on OUR history passes locally and fails on the
 * runner — which is how the first version of these tests went red in CI while
 * green here.
 */
const gitIn =
  (cwd) =>
  (...args) =>
    execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

const git = gitIn(null);

const showOrNull = (rev, path, runGit = git) => {
  try {
    return runGit("show", `${rev}:${path}`);
  } catch {
    return null;
  }
};

/**
 * pyproject's version at one revision, separating the two outcomes a bare
 * try/catch collapses into one:
 *
 *   { version: "0.15.97", error: null }  read it
 *   { version: null, error: "..." }      UNKNOWN — unreadable, missing, or carrying
 *                                        no [project].version. Never "no release".
 *
 * Absence is an error rather than a quiet "nothing shipped here" because
 * pyproject.toml is what publish_action.yml triggers on, and it has existed on
 * this repo since the root commit (4f22ed0f) — a revision without it means the
 * release model changed, not that the revision released nothing.
 */
export function versionAtRev(rev, runGit = git) {
  let text;
  try {
    text = runGit("show", `${rev}:pyproject.toml`);
  } catch (e) {
    return {
      version: null,
      error:
        `pyproject.toml could not be read at ${short(rev)} (${e.message.split("\n")[0]}) — ` +
        `that file is what publish_action.yml triggers on, so this revision cannot be audited`,
    };
  }
  const version = pyprojectVersion(text);
  if (version === null) {
    return { version: null, error: `pyproject.toml at ${short(rev)} has no [project].version` };
  }
  return { version, error: null };
}

/**
 * Resolve a commit's first parent without conflating a failed lookup with a
 * root commit. `rev-parse <rev>^` exits non-zero for both, so its catch block
 * cannot safely decide that the commit is a root. `rev-list --parents`
 * succeeds for a root and gives us an explicit, parseable distinction.
 *
 * @param {string} rev
 * @param {(...args:string[])=>string} [runGit]
 * @returns {{parent:string|null, error:string|null}}
 */
export function firstParentAtRev(rev, runGit = git) {
  let output;
  try {
    output = runGit("rev-list", "--parents", "-n", "1", rev).trim();
  } catch (e) {
    return {
      parent: null,
      error:
        `historical parent lookup for ${short(rev)} failed: ${e.message.split("\n")[0]}`,
    };
  }

  const fields = output.split(/\s+/).filter(Boolean);
  if (!fields.length) {
    return {
      parent: null,
      error: `historical parent lookup for ${short(rev)} returned no commit data`,
    };
  }
  return { parent: fields[1] ?? null, error: null };
}

/**
 * @param {string} tag
 * @param {{
 *   readVersionAt?: (rev:string)=>{version:string|null, error:string|null},
 *   firstParentAt?: (rev:string)=>{parent:string|null, error:string|null},
 *   cwd?: string,
 * }} [deps]
 *        the version reader is injectable ONLY so a test can drive a read failure
 *        through the real range walk. Every commit in this repo's history is
 *        readable, so the failure path cannot be reached from real data — and an
 *        unexercised failure path is how the first two drafts of this guard
 *        shipped fail-open. The parent resolver is injectable for the same reason:
 *        a real repository cannot manufacture a failed lookup on demand. `cwd`
 *        lets tests provide an isolated local history without depending on the
 *        checkout's fetched tags or depth.
 */
export function collectFromGit(
  tag,
  { readVersionAt, firstParentAt, cwd } = {},
) {
  const runGit = cwd ? gitIn(cwd) : git;
  const readVersion = readVersionAt ?? ((rev) => versionAtRev(rev, runGit));
  const firstParent = firstParentAt ?? ((rev) => firstParentAtRev(rev, runGit));
  const treeAtTag = {
    pyproject: showOrNull(tag, "pyproject.toml", runGit),
    packageJson: showOrNull(tag, "package.json", runGit),
    panelJs: showOrNull(tag, "web/js/comfyui-mcp-panel.js", runGit),
  };

  // Fail closed from here down. Each of these can fail on a runner in a way that
  // leaves the tree readable but the history unusable, and a gap scan over an
  // empty range would report success while checking nothing.
  let historyError = null;
  let previousTag = null;
  let range = [];
  const tagTargets = new Map();

  try {
    if (runGit("rev-parse", "--is-shallow-repository").trim() === "true") {
      historyError =
        "this is a shallow clone, so the range cannot be walked (checkout needs fetch-depth: 0)";
    }
  } catch (e) {
    historyError = `git rev-parse --is-shallow-repository failed: ${e.message}`;
  }

  if (!historyError) {
    try {
      // `%(*objectname)` is the peeled target and is non-empty only for annotated
      // tags; lightweight tags report the commit in `%(objectname)`.
      for (const line of runGit(
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)%00%(*objectname)",
        "refs/tags/v*",
      ).split("\n")) {
        if (!line.trim()) continue;
        const [name, objectname, peeled] = line.split("\0");
        tagTargets.set(name.trim(), (peeled || objectname || "").trim());
      }
      if (tagTargets.size === 0) {
        historyError =
          "no v* tags are visible, so no prior release can be credited (checkout needs fetch-tags: true)";
      }
    } catch (e) {
      historyError = `listing v* tags failed: ${e.message}`;
    }
  }

  if (!historyError) {
    // Previous reachable tag. When tags are missing this walks further back,
    // which is exactly what rule 2 needs: a gap widens the window that finds it.
    // Failure here is legitimate for the first tag in history, so it is NOT an
    // error — the range simply starts at the root.
    try {
      previousTag = runGit("describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`).trim();
    } catch {
      previousTag = null;
    }

    try {
      range = runGit(
        "rev-list",
        "--first-parent",
        "--format=%H%x00%s",
        previousTag ? `${previousTag}..${tag}` : tag,
      )
        .split("\n")
        .filter((l) => l && !l.startsWith("commit "))
        .map((line) => {
          const [sha, subject] = line.split("\0");
          const own = readVersion(sha);

          const parentRef = firstParent(sha);
          const parent = parentRef.error
            ? { version: null, error: parentRef.error }
            : parentRef.parent
              ? readVersion(parentRef.parent)
              : { version: null, error: null };
          const versionErrors = [own.error, parent.error].filter(Boolean);

          return {
            sha,
            subject: subject ?? "",
            version: own.version,
            parentVersion: parent.version,
            versionError: versionErrors.length ? versionErrors.join("; ") : null,
          };
        });
    } catch (e) {
      historyError = `walking ${previousTag ?? "(root)"}..${tag} failed: ${e.message}`;
    }
  }

  return {
    treeAtTag,
    range,
    previousTag,
    historyError,
    tagTargetFor: (v) => tagTargets.get(`v${v}`) ?? null,
  };
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
  const collected = collectFromGit(tag);
  const violations = auditTag({ tag, ...collected });
  console.error(
    `auditing ${tag} against ${collected.previousTag ?? "(no earlier tag)"} — ` +
      `${collected.range.length} first-parent commit(s) in range` +
      (collected.historyError ? ` — HISTORY UNAVAILABLE: ${collected.historyError}` : ""),
  );
  for (const v of violations) console.log(`::error::${v}`);
  if (!violations.length) {
    console.log(`release ${tag} is coherent: tree, tag and prior releases all agree.`);
  }
  process.exit(violations.length ? 1 : 0);
}
