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

const MD = readFileSync(fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)), "utf8")
  .replace(/\r\n/g, "\n");

/** Every `## [x.y.z] - date` heading, in file order. */
function versionHeadings() {
  return [...MD.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:\s*-\s*(\S+))?/gm)].map((m) => ({
    version: m[1],
    date: m[2] ?? null,
    line: MD.slice(0, m.index).split("\n").length,
  }));
}

/**
 * Versions that legitimately appear twice, and are NOT the bug this file exists to catch.
 *
 * These four are version-number COLLISIONS, not duplications: each pair holds genuinely
 * DIFFERENT release notes. `0.4.1 - 2026-06-26` announces `graph_set_node_mode`; the second
 * `0.4.1 - 2026-06-17` announces the Connect button that replaced auto-spawn after the
 * Registry's scanner flagged 0.4.0. Two real releases reused one number, early in the
 * project's life.
 *
 * They are deliberately NOT merged. Merging would assert that one release shipped both sets
 * of changes, which is false — the same fabrication #1203 had to undo when a repair invented
 * content. Renumbering would rewrite published history. So they are recorded as fact here,
 * and the assertion below still fails on any NEW duplicate.
 *
 * The list is asserted to be EXHAUSTIVE against the file, so it cannot quietly rot into a
 * blanket exemption: an entry that stops colliding must be removed from it.
 */
const KNOWN_VERSION_COLLISIONS = ["0.4.1", "0.4.0", "0.3.0", "0.2.0"];

test("CHANGELOG: no version appears twice", () => {
  // The 0.14.31/32/33 regression. Both headings for a version arrived in the SAME release
  // commit, so the generator's "already has a [x.y.z] section — nothing to do" guard never
  // fired: it defends against a second INVOCATION, not against one run emitting two sections.
  const seen = new Map();
  const dupes = [];
  for (const h of versionHeadings()) {
    if (seen.has(h.version)) {
      dupes.push({
        version: h.version,
        where: `lines ${seen.get(h.version).line} and ${h.line} ` +
          `(dates ${seen.get(h.version).date} / ${h.date})`,
      });
    } else {
      seen.set(h.version, h);
    }
  }
  const unexpected = dupes.filter((d) => !KNOWN_VERSION_COLLISIONS.includes(d.version));
  assert.deepEqual(
    unexpected.map((d) => `${d.version} at ${d.where}`),
    [],
    "duplicate version sections — one release must not write two",
  );
  // The exemption list may not outlive what it exempts. Without this, a future repair that
  // fixes a collision leaves a permanent hole the next regression can hide in.
  const stillColliding = dupes.map((d) => d.version);
  const stale = KNOWN_VERSION_COLLISIONS.filter((v) => !stillColliding.includes(v));
  assert.deepEqual(stale, [], `KNOWN_VERSION_COLLISIONS lists versions that no longer collide: ${stale.join(", ")}`);
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
  // The ONE known break is where the second, older history block begins — the same block
  // that holds the collisions above. Recorded rather than repaired for the same reason:
  // reordering it would interleave two histories that were never one.
  const KNOWN_BREAK = "0.1.3 precedes 0.4.1";
  const unexpected = breaks.filter((b) => b !== KNOWN_BREAK);
  assert.deepEqual(unexpected, [], `ordering breaks:\n  ${unexpected.join("\n  ")}`);
  assert.ok(breaks.includes(KNOWN_BREAK), "the known ordering break is gone — remove KNOWN_BREAK");
  assert.equal(breaks.length, 1, `expected exactly one known break, saw ${breaks.length}`);
});
