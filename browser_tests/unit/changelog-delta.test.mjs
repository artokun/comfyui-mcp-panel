// #758 — what the panel announces after the install moved under the user.
//
// The panel updates from the Comfy Registry and the orchestrator runs
// `npx comfyui-mcp@latest`, so the version changes without the user asking. Their first
// signal is behaviour they did not expect, which reads as a bug rather than a release.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  releasesSince,
  summarizeReleases,
  updateAnnouncement,
} from "../../web/js/lib/changelog-delta.js";
import { parseChangelog } from "../../scripts/gen-changelog-json.mjs";

const rel = (version, sections) => ({ version, date: "2026-08-09", sections });
const HISTORY = [
  rel("0.11.82", { Added: ["reports the observed active workflow"] }),
  rel("0.11.81", { Fixed: ["a Save-As stops stranding the agent"] }),
  rel("0.11.80", { Fixed: ["the first chat stops vanishing"] }),
  rel("0.11.79", { Fixed: ["e2e cleanup proves ownership"] }),
];

test("#758: versions compare numerically, not as strings", () => {
  // "0.11.9" > "0.11.10" under string compare, which would hide a release.
  assert.ok(compareVersions("0.11.10", "0.11.9") > 0);
  assert.ok(compareVersions("0.11.82", "0.11.82") === 0);
  assert.ok(compareVersions("0.12.0", "0.11.99") > 0);
  assert.ok(compareVersions("v1.2.3", "1.2.3") === 0, "a v prefix is not a different version");
  assert.ok(compareVersions("0.11", "0.11.1") < 0, "a missing segment is zero, not unusable");
});

test("#758: the delta is everything between the seen version and this one", () => {
  const picked = releasesSince(HISTORY, { lastSeen: "0.11.80", current: "0.11.82" });
  assert.deepEqual(picked.map((r) => r.version), ["0.11.82", "0.11.81"]);
});

test("#758: releases newer than the running panel are never announced", () => {
  // web/changelog.json is generated from the repo, so a checkout can carry entries for
  // versions the running panel does not contain. Announcing those as "what changed in your
  // install" would simply be false.
  const picked = releasesSince(HISTORY, { lastSeen: "0.11.79", current: "0.11.80" });
  assert.deepEqual(picked.map((r) => r.version), ["0.11.80"]);
});

test("#758: a first run announces nothing", () => {
  // No recorded last-seen means a fresh install or a user who predates this feature.
  // Opening with a wall of history nobody asked for is the opposite of the point.
  assert.equal(updateAnnouncement({ lastSeen: undefined, current: "0.11.82" }), "none");
  assert.equal(updateAnnouncement({ lastSeen: "", current: "0.11.82" }), "none");
});

test("#758: a downgrade or no change announces nothing", () => {
  assert.equal(updateAnnouncement({ lastSeen: "0.11.82", current: "0.11.82" }), "none");
  assert.equal(updateAnnouncement({ lastSeen: "0.11.82", current: "0.11.80" }), "none",
    "rolling back is deliberate; the notes of versions just left are noise");
});

test("#758: a minor bump or a pile of releases is major, one patch is quiet", () => {
  // The issue's actual case: a tool surface consolidates or a default flips, and the user
  // needs to know it was intentional.
  assert.equal(updateAnnouncement({ lastSeen: "0.11.82", current: "0.12.0" }), "major");
  assert.equal(updateAnnouncement({ lastSeen: "0.11.70", current: "0.11.82", releaseCount: 12 }), "major");
  assert.equal(updateAnnouncement({ lastSeen: "0.11.81", current: "0.11.82", releaseCount: 1 }), "patch");
});

test("#758: entries keep their section, because Fixed and Changed answer different questions", () => {
  const entries = summarizeReleases(releasesSince(HISTORY, { lastSeen: "0.11.80", current: "0.11.82" }));
  assert.deepEqual(entries.map((e) => e.section), ["Added", "Fixed"]);
  assert.equal(entries[0].version, "0.11.82");
  assert.match(entries[1].text, /Save-As/);
});

test("#758: junk in, nothing out — never a crash on the panel's mount path", () => {
  assert.deepEqual(releasesSince(null, { current: "1.0.0" }), []);
  assert.deepEqual(releasesSince([null, {}, { version: 7 }], { current: "1.0.0" }), []);
  assert.deepEqual(summarizeReleases(null), []);
  assert.deepEqual(summarizeReleases([{ version: "1.0.0", sections: { Fixed: [null, "", 3, "ok"] } }]),
    [{ version: "1.0.0", section: "Fixed", text: "ok" }]);
  assert.equal(updateAnnouncement(), "none");
});

test("#758: the generator parses this repo's own changelog shape", () => {
  // Tested against the real parser, not a copy of its rules — a generated file that drifts
  // from the changelog is worse than no file, because it is the one the user reads.
  const parsed = parseChangelog(
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [0.11.82] - 2026-08-09",
      "",
      "> Covers changes since 0.11.81.",
      "",
      "### Added",
      "",
      "- **A thing happened** (#887). It wrapped",
      "  onto a second line with `code` and a [link](http://x).",
      "- Another entry",
      "",
      "## [0.11.81] - 2026-08-09",
      "",
      "### Fixed",
      "- Older entry",
    ].join("\n"),
  );
  assert.deepEqual(parsed.map((r) => r.version), ["0.11.82", "0.11.81"], "Unreleased is not a release");
  assert.equal(parsed[0].sections.Added.length, 2);
  assert.equal(
    parsed[0].sections.Added[0],
    "A thing happened (#887). It wrapped onto a second line with code and a link.",
    "wrapped lines join; bold/code/link markup is stripped for a textContent renderer",
  );
  assert.ok(!JSON.stringify(parsed).includes("Covers changes since"), "the blockquote note is not an entry");
});

test("#758: a downgrade must not overwrite a newer recorded version", () => {
  // The record is what makes "announce once" true. If a downgrade moved it backwards, a
  // later re-upgrade would replay releases the user has already read (codex). The panel
  // only ever moves it forward, so this pins the comparison that decision rests on.
  assert.ok(compareVersions("0.11.80", "0.11.82") < 0, "a downgrade is not a move forward");
  assert.ok(compareVersions("0.11.83", "0.11.82") > 0, "an upgrade is");
  assert.equal(updateAnnouncement({ lastSeen: "0.11.82", current: "0.11.80" }), "none");
});

test("#758: the announcement level changes how much is shown", () => {
  // The level used to be computed and thrown away — both levels rendered the same list,
  // so the report's "prominent for a major change, quiet for a patch" was words only
  // (codex). A patch shows 3 entries, a major 10; this pins that they differ.
  const many = Array.from({ length: 20 }, (_, i) => ({
    version: `0.11.${60 + i}`,
    sections: { Fixed: [`entry ${i}`] },
  }));
  const picked = releasesSince(many, { lastSeen: "0.11.60", current: "0.11.79", max: 20 });
  assert.equal(summarizeReleases(picked, { maxEntries: 3 }).length, 3, "patch: quiet");
  assert.equal(summarizeReleases(picked, { maxEntries: 10 }).length, 10, "major: fuller");
});
