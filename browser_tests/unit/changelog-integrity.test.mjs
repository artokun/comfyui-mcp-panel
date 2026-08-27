// The CHANGELOG is a SHIPPED ARTEFACT, so its shape is testable and must be tested.
//
// #815 surfaces CHANGELOG.md inside the panel and `changelog-delta` reads it to tell a user
// what changed under them after an unattended update, so a malformed file is not a cosmetic
// problem — it is what the user reads.
//
// This is the fourth pass over this generator, and the first three each produced the next
// defect: #1197 taught it to read this repo's own release commits (which introduced a second
// body per release), #1202 cleaned up data and left six empty section headings behind, #1203
// removed duplicates that its own repair had created. Every one of those was found by a human
// reading the file afterwards. These assertions are the check that would have caught each of
// them on the commit that introduced it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseChangelog } from "../../scripts/gen-changelog-json.mjs";

const MD = readFileSync(fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)), "utf8")
  .replace(/\r\n/g, "\n");

// web/changelog.json is the artefact the PANEL actually renders; CHANGELOG.md is only its
// source. Every assertion above this line reads the source, which is how #1891 came to be
// closed with the user-visible half still broken: the markdown was de-duplicated and the
// generated JSON was not regenerated, so the pack kept shipping 307 releases with 0.4.1,
// 0.4.0, 0.3.0 and 0.2.0 each listed twice. Assert on the rendered file too.
const JSON_RELEASES = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../web/changelog.json", import.meta.url)), "utf8"),
).releases;

function assertArtifactMatches(
  markdown,
  artifactReleases = JSON_RELEASES,
  message = "web/changelog.json is stale",
) {
  assert.deepEqual(
    artifactReleases,
    parseChangelog(markdown),
    `${message} — re-run \`node scripts/gen-changelog-json.mjs\` after editing CHANGELOG.md`,
  );
}

// Keep transform-level drift fixtures independent of the live changelog's prose and heading
// layout. The shipped artifact below is the exact output generated from this small source; the
// tests then mutate only one source property at a time and compare it to that unchanged output.
const FIXTURE_CHANGELOG = [
  "# Changelog",
  "",
  "## [9.8.7] - 2026-08-25",
  "",
  "### Fixed",
  "",
  "- released fixture entry.",
  "",
  "### Changed",
  "",
  "- second released fixture entry.",
  "",
].join("\n");
const FIXTURE_ARTIFACT = parseChangelog(FIXTURE_CHANGELOG);

/** Every `## [x.y.z] - date` heading, in file order. */
function versionHeadings(markdown = MD) {
  return [...markdown.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:\s*-\s*(\S+))?/gm)].map((m) => ({
    version: m[1],
    date: m[2] ?? null,
    line: markdown.slice(0, m.index).split("\n").length,
  }));
}

function duplicateVersions(markdown) {
  const seen = new Set();
  const duplicates = [];
  for (const heading of versionHeadings(markdown)) {
    if (seen.has(heading.version)) duplicates.push(heading.version);
    else seen.add(heading.version);
  }
  return duplicates;
}

test("CHANGELOG: no version appears twice", () => {
  // The 0.14.31/32/33 regression. Both headings for a version arrived in the SAME release
  // commit, so the generator's "already has a [x.y.z] section — nothing to do" guard never
  // fired: it defends against a second INVOCATION, not against one run emitting two sections.
  const dupes = duplicateVersions(MD);
  assert.deepEqual(
    dupes,
    [],
    "duplicate version sections — one release must not write two",
  );
});

test("CHANGELOG: a newly introduced duplicate top-level section still fails", () => {
  const fixture = `${MD.trimEnd()}\n\n## [0.15.107] - 2099-01-01\n\n### Fixed\n\n- duplicate fixture\n`;
  assert.deepEqual(duplicateVersions(fixture), ["0.15.107"]);
});

test("CHANGELOG: merged legacy sections retain both note sets", () => {
  const bodyFor = (version) => {
    const heading = `## [${version}]`;
    const start = MD.indexOf(heading);
    const end = MD.indexOf("\n## ", start + heading.length);
    return MD.slice(start, end === -1 ? MD.length : end);
  };
  const markers = [
    ["0.4.1", "graph_set_node_mode", "Connect button replaces import-time auto-spawn"],
    ["0.4.0", "Application Settings page", "Auto-start the panel orchestrator on load"],
    ["0.3.0", "Provider switcher in the model selector", "Registry banner & SEO listing"],
    ["0.2.0", "Rewind & rollback (#44)", "BREAKING: MCP-driven, no API keys"],
  ];
  for (const [version, newerNote, legacyNote] of markers) {
    const body = bodyFor(version);
    assert.ok(body.includes(newerNote), `${version} lost newer note: ${newerNote}`);
    assert.ok(body.includes(legacyNote), `${version} lost legacy note: ${legacyNote}`);
  }
});

test("CHANGELOG: no version section is empty", () => {
  // #1202's defect: a data repair removed the entries and left the headings, so the panel
  // announced a release that said nothing. An empty section is worse than an absent one — it
  // asserts that a release happened and had no content.
  const empty = [];
  const parts = MD.split(/^## /m).slice(1);
  for (const part of parts) {
    const head = part.split("\n", 1)[0];
    const m = head.match(/^\[(\d+\.\d+\.\d+)\]/);
    if (!m) continue; // [Unreleased] is allowed to be empty — that is its resting state
    // Content is any prose, not only a list. A first version of this assertion demanded a
    // list item and flagged 0.11.84, whose body is the deliberate `_No user-facing changes._`
    // — a release that truthfully reports having nothing to report is correct, and a guard
    // that calls it a defect is the false positive, not the file.
    const body = part.slice(head.length).replace(/^###.*$/gm, "").trim();
    if (!body) empty.push(m[1]);
  }
  assert.deepEqual(empty, [], `version sections with no entries: ${empty.join(", ")}`);
});

test("CHANGELOG: every version heading carries a date", () => {
  const undated = versionHeadings().filter((h) => !h.date).map((h) => h.version);
  assert.deepEqual(undated, [], `undated version headings: ${undated.join(", ")}`);
});

test("CHANGELOG: versions run newest-first, with no ordering breaks", () => {
  // `releasesSince` walks this file to decide what to announce after an unattended update, so
  // an out-of-order section silently changes which releases a user is told about.
  const cmp = (a, b) => {
    const A = a.split(".").map(Number);
    const B = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
    return 0;
  };
  const vs = versionHeadings().map((h) => h.version);
  const breaks = [];
  for (let i = 1; i < vs.length; i++) {
    if (cmp(vs[i - 1], vs[i]) < 0) breaks.push(`${vs[i - 1]} precedes ${vs[i]}`);
  }
  assert.deepEqual(breaks, [], `ordering breaks:\n  ${breaks.join("\n  ")}`);
});

test("changelog.json: no version appears twice in the rendered artefact", () => {
  const seen = new Set();
  const duplicates = [];
  for (const release of JSON_RELEASES) {
    if (seen.has(release.version)) duplicates.push(release.version);
    else seen.add(release.version);
  }
  assert.deepEqual(
    duplicates,
    [],
    `web/changelog.json lists a version twice, so the panel renders it twice: ${duplicates.join(", ")}`,
  );
});

test("changelog.json: the rendered artefact matches CHANGELOG.md", () => {
  // Compare every generated field, not only versions: the panel renders dates and section
  // entries too, and a same-version edit must not survive as a stale shipped artefact.
  assertArtifactMatches(MD);
});

test("changelog.json: a same-version date drift fails the sync assertion", () => {
  const fixture = FIXTURE_CHANGELOG.replace(
    /^(## \[[^\]]+\] - )\S+$/m,
    "$12099-01-01",
  );

  assert.notEqual(fixture, FIXTURE_CHANGELOG, "date-drift fixture did not change CHANGELOG.md");
  assert.throws(
    () => assertArtifactMatches(fixture, FIXTURE_ARTIFACT),
    /web\/changelog\.json is stale/,
  );
});

test("changelog.json: same-version release content drift fails the sync assertion", () => {
  const fixture = FIXTURE_CHANGELOG.replace(
    "- released fixture entry.",
    "- changed fixture entry.",
  );

  assert.notEqual(fixture, FIXTURE_CHANGELOG, "content-drift fixture did not change CHANGELOG.md");
  assert.throws(
    () => assertArtifactMatches(fixture, FIXTURE_ARTIFACT),
    /web\/changelog\.json is stale/,
  );
});

test("changelog.json: Unreleased content remains outside released records", () => {
  const fixture = [
    "## [Unreleased]",
    "",
    "### Fixed",
    "",
    "- unreleased-only fixture content.",
    "",
    FIXTURE_CHANGELOG,
  ].join("\n");

  assert.notEqual(fixture, FIXTURE_CHANGELOG, "Unreleased fixture did not change CHANGELOG.md");
  assert.deepEqual(parseChangelog(fixture), FIXTURE_ARTIFACT);
  assertArtifactMatches(
    fixture,
    FIXTURE_ARTIFACT,
    "Unreleased content changed released records",
  );
});
