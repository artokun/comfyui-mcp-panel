#!/usr/bin/env node
/**
 * Check the release section that is about to ship.
 *
 *   node scripts/check-changelog.mjs [version] [--ref v0.15.108] [--working-tree]
 *
 * The release generator is deliberately allowed to start from hand-written
 * notes, but the resulting section has one mechanical source of truth: the
 * tree that the release ref can actually reach. This guard catches malformed
 * sections before they become the pack's user-visible changelog.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { canonicalReference, commitReferences, referenceAliases, referenceNumbers } from "./lib/changelog-refs.mjs";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(process.env.CHANGELOG_ROOT || SCRIPT_ROOT);
const CHANGELOG = join(ROOT, "CHANGELOG.md");

const args = process.argv.slice(2);
const refIndex = args.indexOf("--ref");
const refValueIndex = refIndex >= 0 ? refIndex + 1 : -1;
const explicitRef = refIndex >= 0 ? args[refValueIndex] : null;
const workingTree = args.includes("--working-tree");
// Remove only the two supported control flags before selecting the optional version. Keep
// option-shaped values in the candidate list so `--bad-version` is rejected as an invalid
// version instead of being ignored and causing a different changelog section to be inferred.
const versionArgs = args.filter(
  (arg, index) => index !== refIndex && index !== refValueIndex && arg !== "--working-tree",
);
const versionArg = versionArgs.length === 1 ? versionArgs[0] : undefined;

const git = (...gitArgs) =>
  execFileSync("git", ["-C", ROOT, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function parseReleaseSections(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const releases = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(lines[index]);
    if (match) {
      if (current) current.lines = lines.slice(current.start + 1, index);
      current = {
        version: match[1].trim(),
        date: match[2] ?? null,
        start: index,
        lines: [],
      };
      releases.push(current);
    }
  }
  if (current) current.lines = lines.slice(current.start + 1);
  return releases;
}

export function parseReleaseBody(lines) {
  const headings = [];
  const entries = [];
  let section = null;
  let entry = null;

  const flush = () => {
    if (entry) {
      entries.push({ ...entry, text: entry.lines.join("\n").trim() });
      entry = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^(#{3,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      section = {
        level: heading[1].length,
        text: heading[2],
        line: index + 1,
      };
      headings.push(section);
      continue;
    }
    const bullet = /^[-*]\s+/.test(line);
    if (bullet) {
      flush();
      entry = {
        section,
        line: index + 1,
        lines: [line.replace(/^[-*]\s+/, "")],
      };
      continue;
    }
    if (entry && (line.trim() === "" || /^\s+\S/.test(line))) {
      entry.lines.push(line.trim());
    } else if (entry) {
      flush();
    }
  }
  flush();
  return { headings, entries };
}

export function parseCommitSubjects(output) {
  return String(output ?? "")
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\x1f");
      const sha = separator >= 0 ? record.slice(0, separator) : "";
      const subject = separator >= 0 ? record.slice(separator + 1) : record;
      return { sha, subject, refs: commitReferences(subject) };
    });
}

const semverIdentifier = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const strictSemver = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${semverIdentifier}(?:\\.${semverIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function releaseVersion(version) {
  return String(version ?? "").replace(/^v/, "");
}

function isStrictSemver(version) {
  return strictSemver.test(releaseVersion(version));
}

function targetRefFor(version, requestedRef) {
  if (requestedRef) return requestedRef;
  const tag = `v${releaseVersion(version)}`;
  try {
    git("rev-parse", "--verify", `${tag}^{commit}`);
    return tag;
  } catch {
    // set-version runs before the new tag exists; HEAD is the candidate tree.
    return "HEAD";
  }
}

function commitsAtRef(ref) {
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  return parseCommitSubjects(git("log", "--format=%H%x1f%s%x1e", commit));
}

function changelogAtRef(ref) {
  return git("show", `${ref}:CHANGELOG.md`);
}

export function auditReleaseSection({ markdown, version, commits, targetRef, isAncestor }) {
  const normalizedVersion = releaseVersion(version);
  const sections = parseReleaseSections(markdown);
  const violations = [];
  const seenReleaseSections = new Map();
  for (const item of sections) {
    const itemVersion = releaseVersion(item.version);
    if (!isStrictSemver(itemVersion)) continue;
    const line = item.start + 1;
    if (seenReleaseSections.has(itemVersion)) {
      violations.push(
        `CHANGELOG.md repeats [${itemVersion}] release section at lines ` +
          `${seenReleaseSections.get(itemVersion)} and ${line}. Keep one top-level section.`,
      );
    } else {
      seenReleaseSections.set(itemVersion, line);
    }
    if (!item.lines.some((lineText) => lineText.trim())) {
      violations.push(`CHANGELOG.md [${itemVersion}] release section is empty.`);
    }
  }

  const section = sections.find((item) => releaseVersion(item.version) === normalizedVersion);
  if (!section) return [...violations, `CHANGELOG.md has no [${normalizedVersion}] release section.`];
  if (!section.lines.some((lineText) => lineText.trim())) return violations;

  const { headings, entries } = parseReleaseBody(section.lines);

  const seenHeadings = new Map();
  for (const heading of headings) {
    const key = `${heading.level}:${heading.text.toLowerCase()}`;
    if (seenHeadings.has(key)) {
      violations.push(
        `[${normalizedVersion}] repeats heading "${heading.text}" at lines ` +
          `${seenHeadings.get(key)} and ${section.start + heading.line}. Merge the sections.`,
      );
    } else {
      seenHeadings.set(key, section.start + heading.line);
    }
  }

  const aliases = referenceAliases(commits);
  const seenReferences = new Map();
  for (const item of entries) {
    const refs = referenceNumbers(item.text);
    const keys = [...new Set(refs.map((ref) => canonicalReference(ref, aliases)))];
    for (const key of keys) {
      if (seenReferences.has(key)) {
        violations.push(
          `[${normalizedVersion}] repeats issue/PR identity #${key} at lines ` +
            `${seenReferences.get(key)} and ${section.start + item.line}.`,
        );
      } else {
        seenReferences.set(key, section.start + item.line);
      }
    }
  }

  const byRef = new Map();
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref).push(commit);
    }
  }
  for (const item of entries) {
    const refs = referenceNumbers(item.text);
    if (!refs.length) continue; // Legacy prose without a PR cannot be ancestry-checked.
    const pr = refs[refs.length - 1];
    const candidates = byRef.get(pr) ?? [];
    if (!candidates.length) {
      violations.push(
        `[${normalizedVersion}] entry at line ${section.start + item.line} names PR #${pr}, ` +
          `but no reachable commit subject carries that PR reference.`,
      );
      continue;
    }
    const commit = candidates.find((candidate) => isAncestor(candidate.sha, targetRef));
    if (!commit) {
      violations.push(
        `[${normalizedVersion}] entry at line ${section.start + item.line} names PR #${pr}, ` +
          `but no merge candidate is an ancestor of ${targetRef}.`,
      );
    }
  }
  return violations;
}

export function checkChangelog({ markdown, version, commits, targetRef, isAncestor }) {
  return auditReleaseSection({ markdown, version, commits, targetRef, isAncestor });
}

function main() {
  let markdown;
  let targetRef = explicitRef;
  if (versionArgs.length > 1) {
    console.error("changelog: expected at most one release version argument");
    process.exit(2);
  }
  if (refIndex >= 0 && !explicitRef) {
    console.error("changelog: --ref requires a Git commit ref");
    process.exit(2);
  }
  if (explicitRef) {
    try {
      git("rev-parse", "--verify", `${explicitRef}^{commit}`);
    } catch (error) {
      console.error(`changelog: could not read ${explicitRef}: ${error.message.split("\n")[0]}`);
      process.exit(1);
    }
    try {
      markdown = changelogAtRef(explicitRef);
    } catch (error) {
      console.error(`changelog: could not read CHANGELOG.md at ${explicitRef}: ${error.message.split("\n")[0]}`);
      process.exit(1);
    }
  } else {
    markdown = readFileSync(CHANGELOG, "utf8");
  }
  let version;
  if (versionArg !== undefined) {
    version = releaseVersion(versionArg);
    if (!isStrictSemver(version)) {
      console.error(`changelog: invalid release version "${versionArg}"; expected strict SemVer`);
      process.exit(2);
    }
  } else {
    version = releaseVersion(
      parseReleaseSections(markdown).find((section) => isStrictSemver(section.version))?.version,
    );
  }
  if (!version) {
    console.error("usage: node scripts/check-changelog.mjs [version] [--ref <git-ref>] [--working-tree]");
    process.exit(2);
  }
  targetRef ||= workingTree ? "HEAD" : targetRefFor(version, null);
  try {
    git("rev-parse", "--verify", `${targetRef}^{commit}`);
  } catch (error) {
    console.error(`changelog: could not read ${targetRef}: ${error.message.split("\n")[0]}`);
    process.exit(1);
  }
  const commits = commitsAtRef(targetRef);
  const violations = checkChangelog({
    markdown,
    version,
    commits,
    targetRef,
    isAncestor: (sha, ref) => {
      try {
        git("merge-base", "--is-ancestor", sha, ref);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (violations.length) {
    for (const violation of violations) console.error(`changelog: ERROR — ${violation}`);
    process.exit(1);
  }
  console.log(`changelog: [${version}] is structurally unique and reachable from ${targetRef}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
