#!/usr/bin/env node
// Hybrid changelog generator, wired into the release flow.
//
//   node scripts/gen-changelog.mjs <version>
//
// It stamps a dated section for <version> at the top of CHANGELOG.md by:
//   1. Promoting whatever you hand-wrote under "## [Unreleased]" VERBATIM
//      (your highlights — the rich prose we care about), then
//   2. Appending anything in the git history since the last tag that your
//      highlights didn't already mention (deduped by PR number), grouped into
//      COMPONENT sections (MCP / RunPod image) and Keep-a-Changelog buckets
//      (Added / Fixed / Changed) from the conventional-commit type.
//   3. Resetting "## [Unreleased]" to an empty stub.
//
// So nothing in the history is ever missed, and your hand-written notes are
// never clobbered. Idempotent-ish: safe to re-run before the version is tagged.
//
// Repo config (COMPONENTS) below decides how a commit maps to a section — this
// file is the comfyui-mcp-panel variant (single component).

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isReleaseSubject, pickReleaseSha } from "./lib/changelog-match.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

// ── Repo config ─────────────────────────────────────────────────────────────
// First matching component wins; the last (match:()=>true) is the fallback.
const COMPONENTS = [
  { name: "Panel", match: () => true }, // single component → flat ### Added/Fixed/Changed
];
// conventional-commit type → Keep-a-Changelog bucket. Types not listed are
// dropped from the changelog (chore/ci/test/build/style/docs housekeeping).
const TYPE_SECTION = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Changed",
};
const SECTION_ORDER = ["Added", "Fixed", "Changed"];

// ── helpers ──────────────────────────────────────────────────────────────────
// stderr ignored: several queries (e.g. describe with no tags) fail by design and are try/caught.
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** The ref to diff against = the previous release. Prefer the most recent
 *  version tag (mcp); fall back to the most recent release commit (the panel
 *  has no per-release tags); else the first commit.
 *
 *  MEMOIZED. Five call sites ask for this in one run, and the answer cannot change
 *  between them — but each call re-ran `describe`, a full `git log`, and a `merge-base`.
 *  #1191 made that visible rather than merely wasteful: the range warning below printed
 *  once per call, and a diagnostic that repeats itself reads like several problems. */
let prevTagMemo;
function prevTag() {
  if (prevTagMemo !== undefined) return prevTagMemo;
  prevTagMemo = computePrevTag();
  return prevTagMemo;
}
function computePrevTag() {
  try {
    // --match, because bare `describe --tags` accepts the nearest reachable tag of ANY
    // name — a `backup`, a CI marker, anything — and would silently make it the release
    // base (codex, #932). This repo has no tags today, so this guards the sibling mcp
    // repo and whatever tags land here later, not a present bug.
    //
    // It is a GLOB, not a regex: `[0-9]*` is one digit followed by anything, so a tag like
    // `v1.backup.2.3` still gets through (codex). It rules out the obviously-unrelated
    // names, not every malformed one. Two further limits on a tagged repo, unaddressed
    // because neither can arise here: describe can pick the CURRENT release's tag if
    // generation runs after tagging, yielding an empty range, and nothing validates that
    // the tag is an exact version.
    const t = git('describe --tags --abbrev=0 --match "v[0-9]*.[0-9]*.[0-9]*" --match "[0-9]*.[0-9]*.[0-9]*"');
    if (t) {
      // WHICHEVER IS NEWER, not the tag unconditionally. Tags here lag releases — 0.11.85
      // shipped untagged while v0.11.84 existed — and taking the tag anyway made the base
      // a release too old, so 0.11.86 re-listed #954, which 0.11.85 had already announced.
      // A duplicated entry is the mild version; the same gap re-attributes shipped work to
      // a release that did not contain it.
      //
      // The release commit wins only when it is a DESCENDANT of the tag. Ancestry, not
      // dates: a rebase or an out-of-order merge can leave a commit dated before a tag it
      // sits after, and "which contains which" is the question actually being asked.
      // ONE `git log`, and its failure must not escape past the `return t` below. The first
      // version of the warning re-ran this command outside the guard, so a throw skipped the
      // return, hit the OUTER catch as "no version tags", and dropped the base to
      // `rev-list --max-parents=0` — the first commit. That regenerates the entire history
      // into one entry: the #932/#1191 catastrophe, caused by the diagnostic added to
      // announce it. Not hypothetical either — execSync's default 1 MiB maxBuffer against an
      // output already past 130 KB and growing with every commit, or any transient non-zero
      // exit such as a concurrent gc holding index.lock.
      let newestRelease = null;
      let historyUnreadable = false;
      try {
        newestRelease = pickReleaseSha(git("log --pretty=format:%H%x1f%s"));
      } catch {
        historyUnreadable = true;
      }
      if (newestRelease) {
        try {
          git(`merge-base --is-ancestor ${t} ${newestRelease}`); // throws when NOT an ancestor
          return newestRelease;
        } catch {
          /* the tag is at or ahead of the newest release commit — use the tag */
        }
      }
      // #1191 — SAY SO. Falling back to the tag is legitimate, and it is also exactly what
      // happens when this file has stopped recognising the repo's release commits — which
      // has now shipped twice (#932, #1191), both times silently, and the second time for
      // nine consecutive releases. The generator already refuses to drop a commit without
      // reporting it; the RANGE deserves the same treatment, because a wrong range is the
      // failure that produces a plausible-looking entry crediting a release with work it
      // did not contain.
      //
      // A warning rather than a hard failure: a genuinely fresh tag is the normal case on a
      // repo that tags, and this script also runs inside `set-version.mjs` during a release.
      const detail = historyUnreadable
        ? "the commit history could not be READ, so no release commit could be considered — this is a git failure, not a predicate one"
        : newestRelease
          ? `newest release commit ${newestRelease.slice(0, 8)} is not a descendant of it`
          : "NO commit in history is recognised as a release — the subject predicate may no longer match this repo's release shape (see scripts/lib/changelog-match.mjs)";
      console.error(`changelog: WARNING — bounding the range at tag ${t}; ${detail}.`);
      console.error("changelog: if that is wrong, the entry below will re-list work that already shipped.");
      return t;
    }
  } catch {
    /* no version tags */
  }
  try {
    // #932 — match the shape this repo ACTUALLY produces. Releases here are squash
    // merges titled `<version> — <description> (#N)`, so a grep for `release:` or
    // `chore(release):` never matched one, every run fell through to the first commit,
    // and each entry regenerated the entire history. The anchor is the version at the
    // START of the subject; whatever follows it is free text.
    // Subjects only, matched in JS. NOT `--grep`: that searches the whole message per
    // line, so `^<version>` also fires on a BODY line and an ordinary commit becomes the
    // release boundary — silently truncating the entry (codex, #932).
    const sha = pickReleaseSha(git("log --pretty=format:%H%x1f%s"));
    if (sha) return sha;
  } catch {
    /* no release commit */
  }
  // #1191 — THE SAME WARNING, on the branch that had none. The tag path above announces a
  // fallback; this one reached the FIRST COMMIT in silence, which is the worse outcome of
  // the two: bounding at a stale tag re-lists one release, bounding at the root re-lists
  // every commit in history. A first pass added the warning to the tag branch only, so the
  // untagged repo — which is what this project actually is — kept the original failure.
  //
  // Not a hard failure: a genuinely fresh repository has no release commit and this IS its
  // correct answer. The point is that it should never be reached without saying so.
  const root = git("rev-list --max-parents=0 HEAD").split(/\s+/)[0];
  console.error(
    `changelog: WARNING — no version tag AND no recognisable release commit; bounding at the FIRST commit ${root.slice(0, 8)}.`,
  );
  console.error(
    "changelog: unless this is a brand-new repository, the entry below will re-list the entire history —" +
      " check scripts/lib/changelog-match.mjs still matches this repo's release subjects.",
  );
  return root;
}

// The release-subject rules live in ./lib/changelog-match.mjs so the tests can import the
// SHIPPED predicate. This file rewrites CHANGELOG.md at import time and so is untestable
// directly — the first attempt at a test copied the predicate instead, and passed against
// a copy while the real one stayed broken (#932).

/** Parsed commits since `range`, newest-first, minus noise.
 *
 *  A NON-CONVENTIONAL subject that carries a PR number is INCLUDED, not skipped. The old
 *  code dropped it on the assumption it was "usually already covered by a PR merge" — but
 *  a squash merge's subject IS the PR title, and this project's PR titles are descriptive
 *  prose, not `fix(scope):`. The rule therefore selected against exactly the wrong commits:
 *  a large PR gets a written title and is dropped; a small one gets a prefix and is kept.
 *
 *  That silently omitted the headline entry from three consecutive releases — 0.11.39 lost
 *  #621 (a CRITICAL wrong-graph fix), and 0.11.40 lost three of its four, including the
 *  de-flake that landed as `test:` and was discarded as housekeeping when it was a shipped
 *  change. Each was caught by hand only because someone read the output against the log.
 *
 *  Two rules now, the second mattering as much as the first:
 *   1. anything with a PR number is emitted (defaulting to "Changed" when the type is
 *      unstated) — editing a slightly noisy line is cheap; a missing headline fix is not;
 *   2. NOTHING is dropped silently. Whatever is still skipped is reported on stderr, so a
 *      release always shows what it chose to leave out. A generator whose output looks
 *      complete when it is not is worse than no generator. */
function parseCommits(range) {
  const raw = git(`log ${range} --no-merges --pretty=format:%s`);
  if (!raw) return [];
  const out = [];
  const skipped = [];
  for (const subject of raw.split("\n")) {
    if (isReleaseSubject(subject)) continue; // release commits describe themselves
    const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
    // The LAST `(#N)`, not the first: GitHub appends the PR reference at the end of a
    // squash subject, so anything earlier is an ISSUE the author cited. Both shapes occur —
    // `fix(#584): … (#596)` puts the issue in the scope, and
    // `fix(panel): … (#291) (#633)` puts it inline — and taking the first match attributes
    // the entry to the issue. That also breaks the dedupe against hand-written highlights,
    // which is keyed on the PR number, so a hand-written entry would be duplicated by the
    // auto-generated one instead of suppressed.
    const prIn = (s) => {
      const all = [...s.matchAll(/\(#(\d+)\)/g)];
      return all.length ? all[all.length - 1][1] : null;
    };
    if (!m) {
      const pr = prIn(subject);
      if (pr) {
        out.push({ type: "", scope: "", desc: subject.trim(), section: "Changed", pr });
      } else {
        skipped.push(subject); // a local commit with no PR; a squash supersedes it
      }
      continue;
    }
    const [, type, scope, , desc] = m;
    const pr = prIn(desc);
    // An unmapped type (chore/ci/test/build/style/docs) is housekeeping and stays out — but
    // only when it has no PR number. A `test(…)` or `docs(…)` PR is a real shipped change.
    const section = TYPE_SECTION[type.toLowerCase()] ?? (pr ? "Changed" : null);
    if (!section) {
      skipped.push(subject);
      continue;
    }
    out.push({ type, scope: scope || "", desc: desc.trim(), section, pr });
  }
  if (skipped.length) {
    process.stderr.write(
      `changelog: left out ${skipped.length} commit(s) with no PR number — check none belong:\n` +
        skipped.map((s) => `  · ${s}`).join("\n") +
        "\n",
    );
  }
  return out;
}

function componentOf(scope) {
  return (COMPONENTS.find((c) => c.match(scope)) || COMPONENTS[COMPONENTS.length - 1]).name;
}

/** Build the auto-generated component/section body for commits not already
 *  covered by the hand-written highlights (deduped by PR number). */
function autoBody(commits, coveredPRs) {
  const fresh = commits.filter((c) => !(c.pr && coveredPRs.has(c.pr)));
  if (fresh.length === 0) return "";
  // component -> section -> bullets[]
  const byComp = new Map();
  for (const c of fresh) {
    const comp = componentOf(c.scope);
    if (!byComp.has(comp)) byComp.set(comp, new Map());
    const secs = byComp.get(comp);
    if (!secs.has(c.section)) secs.set(c.section, []);
    secs.get(c.section).push(`- ${c.desc}`);
  }
  // Single-component repos (e.g. the panel) read cleaner with flat `### Added`
  // headers; multi-component repos (mcp) nest `### Component` > `#### Added`.
  const single = COMPONENTS.length === 1;
  const lines = [];
  for (const comp of COMPONENTS.map((c) => c.name)) {
    const secs = byComp.get(comp);
    if (!secs) continue;
    if (!single) lines.push(`### ${comp}`, "");
    for (const section of SECTION_ORDER) {
      const bullets = secs.get(section);
      if (!bullets) continue;
      lines.push(single ? `### ${section}` : `#### ${section}`, ...bullets, "");
    }
  }
  return lines.join("\n").trimEnd();
}

/**
 * The release date, in UTC — ONE source, deliberately.
 *
 * This used to read local calendar fields (`getFullYear`/`getMonth`/`getDate`) while release
 * notes written by hand carried the UTC date. That is how 0.14.31, 0.14.32 and 0.14.33 each
 * ended up with two headings a day apart: the release commits were authored around
 * 23:00-0600, so the generator stamped the 13th while the hand-written half stamped the 14th.
 * The split made the duplication obvious, which was lucky — identical dates would have hidden
 * it for longer.
 *
 * UTC rather than local, because a changelog is read by people in other timezones and by
 * `changelog-delta`, and "the day it shipped" has to mean one thing. `toISOString` is used
 * rather than assembling UTC fields by hand so there is no second way to get this wrong.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── main ─────────────────────────────────────────────────────────────────────
const backfill = process.argv.includes("--backfill");
const version = (process.argv.find((a) => /^v?\d+\.\d+\.\d+/.test(a)) || "").replace(/^v/, "");
if (!backfill && !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`usage: node scripts/gen-changelog.mjs <version> | --backfill`);
  process.exit(1);
}
// Preserve the file's own line-ending convention (mcp is CRLF, panel LF): work
// in LF internally, restore on write so we never spuriously rewrite the whole file.
const rawMd = readFileSync(CHANGELOG, "utf-8");
const EOL = rawMd.includes("\r\n") ? "\r\n" : "\n";
const writeChangelog = (s) => writeFileSync(CHANGELOG, EOL === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

/** Build a dated entry string for `ver` from commits in `range`, folding in any
 *  hand-written highlights (deduped by PR). */
function buildEntry(ver, range, highlights = "") {
  // BARE `#N` ONLY, deliberately — this set is compared against PANEL PR numbers.
  //
  // A first attempt at #1219 widened this to `/\((?:[\w.-]+)?#(\d+)\)/g` so it would also see
  // `(comfyui-mcp#1478)`, on the theory that upstream-first descriptions were failing to
  // suppress their commits. That is wrong twice over. The two ids are different numbers in
  // different namespaces — panel PR #1211 and mcp issue #1478 name the same change — so
  // capturing the upstream number cannot match anything here. And it would be actively
  // dangerous: an upstream issue number that happens to equal an unrelated panel PR number
  // would suppress that PR's commit from the auto body, silently dropping shipped work.
  //
  // Cross-namespace dedupe is not solvable by number, and NOTHING here replaces it. An
  // earlier version of this comment pointed at "the post-write assertion at the bottom of
  // this file" — an assertion that was removed in the same change as unreachable, so the
  // comment claimed a protection that did not exist.
  //
  // Stated accurately: a highlight citing `comfyui-mcp#1478` and a commit carrying panel PR
  // `#1211` for the same change will BOTH be listed, as two bullets in one section.
  // `changelog-integrity.test.mjs` catches duplicate version HEADINGS; it does not compare
  // bullet text, so this particular redundancy is unguarded and is caught only by a human
  // reading the release notes. That is a smaller problem than the duplicate sections this
  // issue was about — a reader sees one release saying a thing twice, not two releases — and
  // fixing it needs an identifier map the repo does not have.
  const covered = new Set([...highlights.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]));
  const commits = parseCommits(range);
  const auto = autoBody(commits, covered);
  const parts = [`## [${ver}] - ${today()}`, ""];
  if (highlights) parts.push(highlights, "");
  if (auto) parts.push(auto, "");
  if (!highlights && !auto) parts.push("_No user-facing changes._", "");
  return { text: parts.join("\n").trimEnd(), commits };
}

const md = rawMd.replace(/\r\n/g, "\n"); // normalized (LF) for matching + building
// Accept both "## [Unreleased]" (panel) and "## Unreleased" (mcp); preserve the
// exact header text so we don't reformat the file's own convention.
const UNREL = /(##[ \t]*(?:\[Unreleased\]|Unreleased))[ \t]*\n([\s\S]*?)(?=\n##[ \t]|\n<!-- end -->|$)/i;
const um = md.match(UNREL);
if (!um) {
  console.error("could not find an '## Unreleased' (or '## [Unreleased]') section in CHANGELOG.md");
  process.exit(1);
}
const unrelHeader = um[1]; // e.g. "## Unreleased" or "## [Unreleased]"
const highlights = um[2].trim();

if (backfill) {
  // One-time repair: emit a dated entry for every tag NEWER than the newest one
  // already in the CHANGELOG, oldest→newest, from the commits between tags.
  const tags = git("tag --sort=creatordate")
    .split("\n")
    .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t));
  // Only catch up the changelog from where it left off — the newest version it
  // already documents. Don't resurrect ancient pre-changelog tags.
  const cmp = (a, b) => {
    const pa = a.split("."), pb = b.split(".");
    for (let i = 0; i < 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
    return 0;
  };
  const documented = [...md.matchAll(/##\s*\[(\d+\.\d+\.\d+)\]/g)].map((m) => m[1]);
  const newest = documented.sort(cmp).pop() || "0.0.0";
  const missing = tags.filter(
    (t) => cmp(t.replace(/^v/, ""), newest) > 0 && !md.includes(`## [${t.replace(/^v/, "")}]`),
  );
  if (missing.length === 0) {
    console.log("backfill: nothing missing.");
    process.exit(0);
  }
  const blocks = [];
  for (let i = 0; i < missing.length; i++) {
    const tag = missing[i];
    const idx = tags.indexOf(tag);
    const prev = tags[idx - 1];
    const range = prev ? `${prev}..${tag}` : tag;
    blocks.push(buildEntry(tag.replace(/^v/, ""), range).text);
  }
  // newest first under Unreleased
  const body = blocks.reverse().join("\n\n");
  const next = md.replace(UNREL, `${unrelHeader}\n\n${body}\n\n`);
  writeChangelog(next);
  console.log(`backfill: added ${missing.length} missing version(s): ${missing.join(", ")}`);
  process.exit(0);
}

if (!version) {
  // REFRESH mode (no version arg): fold commits since the last tag into
  // [Unreleased] without stamping a version — keeps the changelog warm between
  // releases (e.g. after a runpod:release). Idempotent: items already present
  // (by PR number or exact text) are not re-added.
  const covered = new Set([...highlights.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]));
  const commits = parseCommits(`${prevTag()}..HEAD`).filter(
    (c) => !(c.pr && covered.has(c.pr)) && !highlights.includes(c.desc),
  );
  const auto = autoBody(commits, new Set());
  if (!auto) {
    console.log("changelog: [Unreleased] already covers every commit since " + prevTag());
    process.exit(0);
  }
  const body = [highlights, auto].filter(Boolean).join("\n\n");
  writeChangelog(md.replace(UNREL, `${unrelHeader}\n\n${body}\n\n`));
  console.log(`changelog: refreshed [Unreleased] with ${commits.length} new commit(s) since ${prevTag()}`);
  process.exit(0);
}

if (md.includes(`## [${version}]`)) {
  // Exit 0 is deliberate: re-running the generator for an already-released version is a
  // benign no-op and must not fail a release. But #1219 showed this message can also mean
  // something is genuinely wrong — release notes hand-written under a pre-numbered
  // `## [version]` heading instead of under Unreleased — and in that case the notes ship
  // WITHOUT the auto-generated commit body, because this returns before writing it. Say both,
  // so the operator can tell which one they are looking at.
  console.error(
    `CHANGELOG already has a [${version}] section — nothing to do.\n` +
    `  If this is a re-run, that is expected.\n` +
    `  If you just wrote the release notes yourself, they are in the WRONG PLACE: put them under\n` +
    `  "${unrelHeader}" instead. This script promotes whatever is there VERBATIM into the one\n` +
    `  dated section it writes, and appends the commits those notes did not mention. A\n` +
    `  pre-numbered heading skips all of that — and leaves a SECOND heading once this script is\n` +
    `  run again, which is how 0.14.31, 0.14.32 and 0.14.33 each ended up duplicated.`,
  );
  process.exit(0);
}

const { text: entry, commits } = buildEntry(version, `${prevTag()}..HEAD`, highlights);
const next = md.replace(UNREL, `${unrelHeader}\n\n${entry}\n\n`);

// #1219 — NO POST-WRITE ASSERTION HERE, and the reason is worth stating so it is not added.
//
// A first attempt at #1219 put a duplicate-heading check right here, after building `next`.
// It cannot fire. In the ordering that actually produced 0.14.31/32/33, the hand-written
// numbered section was added AFTER this script had already run and exited — so at write time
// there was exactly one heading and the check would have passed. In the opposite ordering the
// pre-write check above returns first, so this point is never reached with a duplicate either.
// Dead code shaped like a guard is worse than no guard: it reads as coverage.
//
// This script cannot defend against an edit made after it exits. The check that DOES catch it
// is `browser_tests/unit/changelog-integrity.test.mjs`, which asserts the shape of the
// committed file and therefore runs on the release PR no matter which step introduced the
// second heading.
writeChangelog(next);

const nComp = new Set(commits.map((c) => componentOf(c.scope))).size;
console.log(
  `changelog: wrote [${version}] — ${highlights ? "kept hand-written highlights + " : ""}${
    commits.length
  } commit(s) across ${nComp} component(s) since ${prevTag()}`,
);
