#!/usr/bin/env node
/**
 * Check the release section that is about to ship.
 *
 *   node scripts/check-changelog.mjs [version] [--ref v0.15.108]
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
const explicitRef = refIndex >= 0 ? args[refIndex + 1] : null;
const versionArg = args.find((arg) => /^v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(arg));

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

function releaseVersion(version) {
  return String(version ?? "").replace(/^v/, "");
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

function allCommits() {
  return parseCommitSubjects(git("log", "--all", "--format=%H%x1f%s%x1e"));
}

export function auditReleaseSection({ markdown, version, commits, targetRef, isAncestor }) {
  const normalizedVersion = releaseVersion(version);
  const section = parseReleaseSections(markdown).find((item) => item.version === normalizedVersion);
  if (!section) return [`CHANGELOG.md has no [${normalizedVersion}] release section.`];

  const { headings, entries } = parseReleaseBody(section.lines);
  const violations = [];

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
  const markdown = readFileSync(CHANGELOG, "utf8");
  const version = releaseVersion(
    versionArg || parseReleaseSections(markdown).find((section) => /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(section.version))?.version,
  );
  if (!version) {
    console.error("usage: node scripts/check-changelog.mjs [version] [--ref <git-ref>]");
    process.exit(2);
  }
  const targetRef = targetRefFor(version, explicitRef);
  let commits;
  try {
    git("rev-parse", "--verify", `${targetRef}^{commit}`);
    commits = allCommits();
  } catch (error) {
    console.error(`changelog: could not read ${targetRef}: ${error.message.split("\n")[0]}`);
    process.exit(1);
  }
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
