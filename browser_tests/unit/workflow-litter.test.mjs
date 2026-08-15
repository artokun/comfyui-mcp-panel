// #907 — the suite saves real workflows into the developer's library and leaves
// them there: 1269 of 1286 files were test output when this was measured.
//
// The cleanup deletes files from a directory that also holds the user's real
// work, so the tests that matter here are the ones about what it must NOT touch.
// A cleanup that removes too much is a far worse defect than the leak it fixes,
// and it is unrecoverable.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isTestLitter,
  leakReport,
  plannedDeletions,
  workflowUserdataPath,
} from "../fixtures/workflow-litter.ts";

test("recognises ONLY names the suite itself chose", () => {
  assert.equal(isTestLitter("cmcp-e2e-m2x1a-a7bd9c.json"), true);
  // ComfyUI's `Untitled <date> <time>` is deliberately NOT matched by the
  // automated cleanup, even though 1272 such files were the original symptom.
  // It is the same name ComfyUI gives the developer's own unnamed saves, so a
  // developer who saves during a run would lose it (codex P0). The specs save
  // under the prefix above instead, and the ambiguous family is left to a human
  // running scripts/clean-e2e-litter.mjs --include-untitled.
  assert.equal(isTestLitter("Untitled 2026-08-09 19-37-51.json"), false);
  assert.equal(isTestLitter("Untitled 2026-08-09.json"), false);
});

test("THE P0: a developer's unnamed save during a run is never a target", () => {
  // Both conditions used to hold for this file — new since baseline, and matching
  // the pattern — so it would have been deleted. That is someone's work.
  const before = ["Artokun Flow v1.json"];
  const after = [...before, "Untitled 2026-08-09 20-15-00.json"];
  assert.deepEqual(plannedDeletions(before, after), []);
});

test("recognises the suite prefix in the shapes the specs generate", () => {
  // Every spec builds its name as `cmcp-e2e-<base36 time>-<nonce>`, and one adds
  // a purpose in the middle. Dots and dashes are allowed because a name is
  // assembled, not validated, at the call site.
  assert.equal(isTestLitter("cmcp-e2e-m2x1a-a7bd9c.json"), true);
  assert.equal(isTestLitter("cmcp-e2e-identity-m2x1-a7bd9c.json"), true);
  assert.equal(isTestLitter("cmcp-e2e-b-1.json"), true);
  assert.equal(isTestLitter("cmcp-e2e-x.y.json"), true);
  // Near misses stay out: the prefix is the whole ownership claim.
  assert.equal(isTestLitter("cmcp-e2e.json"), false);
  assert.equal(isTestLitter("my-cmcp-e2e-copy.json"), false);
});

test("does not recognise the user's own work", () => {
  for (const real of [
    "Artokun Flow v1.json",
    "krea2_identity_edit.json",
    "MiniMax_H3_00173_ (Copy).json",
    "my Untitled experiment.json", // contains the word, is not the pattern
    "Untitled.json", // no date — ComfyUI never names an autosave this
  ]) {
    assert.equal(isTestLitter(real), false, real);
  }
});

test("BOTH conditions are required — new AND recognisable", () => {
  const before = ["Artokun Flow v1.json", "cmcp-e2e-old.json"];
  const after = [
    "Artokun Flow v1.json",
    "cmcp-e2e-old.json", // recognisable BUT pre-existing → left alone
    "cmcp-e2e-abc123.json", // new AND recognisable → ours
    "New Idea.json", // new but NOT recognisable → the user saved it mid-run
  ];
  assert.deepEqual(plannedDeletions(before, after), ["cmcp-e2e-abc123.json"]);
});

test("a file the user saved DURING the run is never deleted", () => {
  // The case that makes "new" alone unsafe.
  const planned = plannedDeletions(["a.json"], ["a.json", "Tuesday sketch.json"]);
  assert.deepEqual(planned, []);
});

test("last week's Untitled is never deleted", () => {
  // The case that makes "matches the pattern" alone unsafe — ComfyUI gives the
  // user's own unnamed saves exactly this shape.
  const before = ["cmcp-e2e-lastweek.json"];
  assert.deepEqual(plannedDeletions(before, [...before]), []);
});

test("an empty or unreadable listing plans nothing", () => {
  assert.deepEqual(plannedDeletions([], []), []);
  assert.deepEqual(plannedDeletions(null, null), []);
  assert.deepEqual(plannedDeletions(["a.json"], null), []);
});

test("duplicates in a listing are planned once", () => {
  const planned = plannedDeletions([], ["cmcp-e2e-x.json", "cmcp-e2e-x.json"]);
  assert.deepEqual(planned, ["cmcp-e2e-x.json"]);
});

// ── THE LEAK REPORT ───────────────────────────────────────────────────────
// #907 is not "the suite saves files" — it is that 1269 accumulated with nobody
// noticing. A cleanup with no check behind it reproduces that silence one layer
// down, so the teardown has to be able to say it failed.

test("a clean run reports nothing", () => {
  const r = leakReport(["a.json"], ["a.json"], ["cmcp-e2e-zz.json"]);
  assert.deepEqual(r, { undeleted: [], unrecognised: [] });
});

test("a delete that did not take is UNDELETED — the cleanup is broken", () => {
  const r = leakReport(["a.json"], ["a.json", "cmcp-e2e-zz.json"], [
    "cmcp-e2e-zz.json",
  ]);
  assert.deepEqual(r.undeleted, ["cmcp-e2e-zz.json"]);
  assert.deepEqual(r.unrecognised, []);
});

test("a new name we never tried is UNRECOGNISED — a spec may have changed", () => {
  // The direction that catches the next version of this bug: a spec starts
  // saving under a name no pattern matches, and the leak resumes silently.
  const r = leakReport([], ["e2e-brand-new-shape.json"], []);
  assert.deepEqual(r.unrecognised, ["e2e-brand-new-shape.json"]);
  assert.deepEqual(r.undeleted, []);
});

test("the two kinds are reported separately — they mean different things", () => {
  const r = leakReport([], ["cmcp-e2e-zz.json", "something-else.json"], [
    "cmcp-e2e-zz.json",
  ]);
  assert.deepEqual(r.undeleted, ["cmcp-e2e-zz.json"]);
  assert.deepEqual(r.unrecognised, ["something-else.json"]);
});

test("userdata paths are namespaced to workflows", () => {
  assert.equal(workflowUserdataPath("cmcp-e2e-zz.json"), "workflows/cmcp-e2e-zz.json");
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: playwright runs the cleanup, and it FAILS OPEN without a baseline", async () => {
  const { readFile } = await import("node:fs/promises");
  const cfg = await readFile(new URL("../../playwright.config.ts", import.meta.url), "utf8");
  // Per-spec cleanup cannot cover a failing test; only these see the whole run.
  assert.match(cfg, /globalSetup: '\.\/browser_tests\/global-setup\.ts'/);
  assert.match(cfg, /globalTeardown: '\.\/browser_tests\/global-teardown\.ts'/);

  const impl = await readFile(new URL("../global-workflow-litter.ts", import.meta.url), "utf8");
  const clean = impl.slice(impl.indexOf("export async function cleanWorkflowLitter"));
  // THE SAFETY PROPERTY, pinned at source: no baseline ⇒ no deletions. Treating
  // an unreadable listing as "the directory was empty" would make every file in
  // it look new — and this code deletes files.
  assert.ok(
    /const before = readBaseline\(\)\s*\n\s*if \(!before\) return/.test(clean),
    "a missing baseline must delete nothing",
  );
  assert.ok(clean.includes("throw new Error("), "a broken cleanup must fail the run, not warn");
});
