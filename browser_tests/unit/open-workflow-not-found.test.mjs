// #1448 — "it isn't among the saved/open workflows even after a refresh."
//
// Said for a file the reporter had confirmed on disk INSIDE the workflows folder,
// twice. Two defects in one sentence: it asserted a refresh it had not checked, and
// its remedy ("for a file outside the workflows folder") named a cause that was not
// the case and sent them away from the file.
//
// The refresh only runs when the frontend exposes `syncWorkflows`, and a throw from
// it was swallowed by a console.warn no agent session reads — so both ways it can
// fail to happen were invisible while the message claimed it had.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyWorkflowRefresh,
  knownSelectorSample,
  openWorkflowNotFoundMessage,
} from "../../web/js/lib/open-workflow-not-found.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const msg = (o) => openWorkflowNotFoundMessage({ path: "video_minimax_low_vram.json", ...o });

test("#1448 r2 a CHANGED list is reported as a change, NOT as a successful read", () => {
  // The claim this round had to retreat from. "The list changed" is an
  // observation; "the server read succeeded" is a causal claim the panel cannot
  // make — another writer can move the store while the sync silently fails.
  const t = msg({ refresh: "changed" });
  assert.match(t, /the list DID change/);
  assert.match(t, /still does not contain a match/);
  assert.doesNotMatch(t, /WAS re-read from the server/, "no causal claim about the read");
  assert.match(t, /cannot see whether the server read itself succeeded/i);
});

test("#1448 r2 the re-read verdict is DECIDED from the store, both directions", () => {
  // Mutation found this gap: the message tests and the source-text wiring test
  // could both pass while the comparison itself was inverted or halved. The
  // decision lives in lib/ precisely so it can be driven here.
  const openA = [{ path: "a" }];
  const savedA = [{ path: "b" }];
  const fp = (counts, open, saved) => ({ counts, open, saved });

  // Nothing moved: same counts, same array identities → cannot confirm.
  assert.equal(
    classifyWorkflowRefresh(fp("1/1", openA, savedA), fp("1/1", openA, savedA)),
    "unchanged",
  );
  // A count changed (the 109 → 107 case) → proof it ran.
  assert.equal(
    classifyWorkflowRefresh(fp("1/109", openA, savedA), fp("1/107", openA, savedA)),
    "changed",
  );
  // Counts identical but the arrays were REPLACED → still a change. Dropping
  // this half is a mutation that survived a count-only comparison.
  assert.equal(
    classifyWorkflowRefresh(fp("1/1", openA, savedA), fp("1/1", [{ path: "a" }], [{ path: "b" }])),
    "changed",
  );
  // ...but identity is IGNORED when the caller says it carries no information.
  // A reactive getter handing back a fresh array per access would otherwise
  // report "changed" on every refresh — the original bug in new wording.
  assert.equal(
    classifyWorkflowRefresh(
      fp("1/1", openA, savedA),
      fp("1/1", [{ path: "a" }], [{ path: "b" }]),
      { openIdentityMeaningful: false, savedIdentityMeaningful: false },
    ),
    "unchanged",
  );
  // A real count move is still honoured with identity disabled.
  assert.equal(
    classifyWorkflowRefresh(fp("1/109", openA, savedA), fp("1/107", openA, savedA), {
      openIdentityMeaningful: false,
      savedIdentityMeaningful: false,
    }),
    "changed",
  );
  // PER-LIST calibration: one fresh getter must not blind us to the other list.
  // A single all-or-nothing flag threw away the stable list's signal (round 3).
  assert.equal(
    classifyWorkflowRefresh(
      fp("1/1", openA, savedA),
      fp("1/1", [{ path: "a" }], [{ path: "b" }]),
      { openIdentityMeaningful: false, savedIdentityMeaningful: true },
    ),
    "changed",
    "saved-list identity still counts when only the open list is fresh",
  );
  assert.equal(
    classifyWorkflowRefresh(
      fp("1/1", openA, savedA),
      fp("1/1", [{ path: "a" }], savedA),
      { openIdentityMeaningful: false, savedIdentityMeaningful: true },
    ),
    "unchanged",
    "and the fresh list alone still proves nothing",
  );

  // A missing sample claims nothing rather than defaulting to confident.
  assert.equal(classifyWorkflowRefresh(null, fp("1/1", openA, savedA)), "unchanged");
  assert.equal(classifyWorkflowRefresh(fp("1/1", openA, savedA), null), "unchanged");
});

test("#1448 r2 an UNCONFIRMED re-read never claims the list was refreshed", () => {
  // The state that did not exist before, and the one that is now almost always
  // right: syncWorkflows resolves whether or not the read succeeded, so unless
  // the store visibly changed we cannot say it happened.
  const t = msg({ refresh: "unchanged" });
  assert.doesNotMatch(t, /WAS re-read/, "it must not assert what it could not observe");
  assert.match(t, /cannot confirm/i);
  // …and it must not let the caller conclude the file is missing.
  assert.match(t, /cannot treat the absence as proof|not.*proof the file is missing/i);
  // The reason the panel is blind here is worth saying once, in place.
  assert.match(t, /swallows its own\s+errors/i);
});

test("#1448 r2 NO refresh state claims the server read succeeded", () => {
  // The invariant across the whole surface, not one branch of it. Every earlier
  // version of this fix leaked a causal claim into at least one state.
  for (const refresh of ["changed", "unchanged", "unavailable", "not-needed"]) {
    const t = msg({ refresh });
    assert.doesNotMatch(t, /WAS re-read from the server/, refresh);
  }
});

test("#1448 a frontend with no sync method does NOT claim a refresh", () => {
  // The reported sentence, on a build where the refresh cannot even be attempted.
  const t = msg({ refresh: "unavailable" });
  assert.match(t, /was NOT re-read/);
  assert.match(t, /no workflow-sync method/);
  // And the action that WOULD make the file visible.
  assert.match(t, /Reload the ComfyUI browser/);
  assert.doesNotMatch(t, /WAS re-read/);
});

test("#1448 a FAILED re-read says so, and that it is not evidence of absence", () => {
  // Swallowing this was the worst of the three: the caller was told the list had been
  // re-read when the attempt had thrown, so an absent file looked confirmed.
  const t = msg({ refresh: "failed: NetworkError when attempting to fetch resource" });
  assert.match(t, /re-read of the workflow list FAILED/);
  assert.match(t, /NetworkError when attempting to fetch resource/);
  assert.match(t, /not evidence the file is absent/);
});

test("#1448 it no longer asserts the file is outside the workflows folder", () => {
  // The remedy that misled the reporter. panel_load_workflow is still offered — it IS
  // the right tool for a path elsewhere — but as a branch, not as a diagnosis.
  for (const refresh of ["changed", "unchanged", "unavailable", "not-needed", "failed: x"]) {
    const t = msg({ refresh });
    assert.doesNotMatch(t, /For a file outside the workflows folder/, refresh);
    assert.match(t, /If the file IS in the workflows/, refresh);
    assert.match(t, /if it is anywhere\s+else, load it with panel_load_workflow/, refresh);
  }
});

test("#1448 it shows the selector SHAPES, which are not guessable from outside", () => {
  // Measured on the live rig: `filename` carries no extension while `key` does, and
  // `path` is folder-qualified. A caller cannot infer that, so the sample shows it.
  const t = msg({ refresh: "changed", known: ["workflows/Anima Wojak Batch.json"] });
  assert.match(t, /workflows\/Anima Wojak Batch\.json/);
  assert.match(t, /bare name with or without "\.json"/);
});

test("#1448 the sample is only PERSISTED records, and is bounded", () => {
  // An unsaved tab is addressable only by its per-instance routing id, so showing its
  // path as an example would be advice that does not work. And a 100-entry store in a
  // refusal is noise — the shape disambiguates, not the inventory.
  const records = [
    { path: "workflows/a.json", isPersisted: true },
    { path: "workflows/Unsaved Workflow.json", isPersisted: false, isTemporary: true },
    { path: "workflows/b.json", isPersisted: true },
    { path: "workflows/c.json", isPersisted: true },
    { path: "workflows/d.json", isPersisted: true },
  ];
  const sample = knownSelectorSample(records);
  assert.deepEqual(sample, ["workflows/a.json", "workflows/b.json", "workflows/c.json"]);
  assert.equal(knownSelectorSample([]).length, 0);
  assert.equal(knownSelectorSample(undefined).length, 0);
});

test("#1448 with no known records it still gives a usable message", () => {
  const t = msg({ refresh: "changed", known: [] });
  // Case-insensitive: a control mutation capitalising the leading word killed the
  // strict form. The property is that the refusal names the selector it was given.
  assert.match(t, /no workflow matching "video_minimax_low_vram\.json"/i);
  assert.doesNotMatch(t, /addressed as e\.g\./);
});

test("#1448 WIRING: the caller records the outcome instead of assuming one", () => {
  // The behavioural tests cannot see the call site, and the defect WAS the call site:
  // a perfect message still lies if the caller passes a refresh state it never checked.
  const panel = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  // Members required, not an exact list: pinning the whole specifier meant that
  // ADDING an import broke this test for no reason, which is churn rather than
  // coverage. What matters is that each name comes from this module.
  const spec = panel.match(
    /import \{([\s\S]*?)\} from "\.\/lib\/open-workflow-not-found\.js";/,
  );
  assert.ok(spec, "the panel must import from lib/open-workflow-not-found.js");
  for (const name of [
    "knownSelectorSample",
    "openWorkflowNotFoundMessage",
    "classifyWorkflowRefresh",
  ]) {
    assert.ok(spec[1].includes(name), `the panel must import ${name} from that module`);
  }
  // Every branch the refresh can take must be reachable from the call site.
  assert.match(panel, /refresh = "unavailable"/, "a frontend without syncWorkflows");
  assert.match(panel, /refresh = `failed: \$\{err\?\.message \?\? err\}`/, "a thrown re-read");
  // #1448 r2 — "ok" must be EARNED, not assigned. This used to pin the literal
  // `refresh = "ok"`, which was satisfied by the unconditional assignment that
  // was the defect: syncWorkflows resolves even when the re-read failed, so
  // every refusal claimed the list had been re-read. Pin the discrimination
  // instead — both outcomes present, and the store observed to decide between
  // them.
  assert.doesNotMatch(
    panel,
    /await s\.syncWorkflows\(\);\s*\n\s*refresh = "ok";/,
    "an unconditional 'ok' after the call is exactly the bug",
  );
  assert.match(panel, /const before = fingerprintStore\(\);/, "the store is sampled BEFORE");
  assert.match(panel, /const after = fingerprintStore\(\);/, "...and AFTER the re-read");
  assert.match(
    panel,
    /refresh = classifyWorkflowRefresh\(before, after, \{\s*openIdentityMeaningful,\s*savedIdentityMeaningful,\s*\}\);/,
    "the verdict comes from the shared decision, not an inline guess",
  );
  // The fresh-getter probe: two samples with NOTHING between them. Without it,
  // a store that materialises a new array per access reports "changed" every
  // time and the original bug returns in new wording (review, round 2).
  assert.match(panel, /const control = fingerprintStore\(\);/, "identity is calibrated first");
  // PER LIST — a single flag would disable identity for both the moment either
  // getter is fresh, discarding a real signal from the stable one (round 3).
  assert.match(panel, /const openIdentityMeaningful = control\.open === before\.open;/);
  assert.match(panel, /const savedIdentityMeaningful = control\.saved === before\.saved;/);
  // The sample must be taken AFTER the refresh (codex review). A successful re-read
  // removes stale entries — measured 109 -> 107 on a live rig — so a snapshot taken
  // before it can offer a workflow that no longer exists as an example.
  assert.match(panel, /const known = knownSelectorSample\(\[\.\.\.\(s\?\.openWorkflows \?\? \[\]\), \.\.\.\(s\?\.workflows \?\? \[\]\)\]\);/);
  // `disk` is required, not optional (#1448 — the half the reporter filed). Omitting
  // it compiles and reads fine, and silently restores the defect: the refusal goes
  // back to asserting absence from an in-memory scan that was MEASURED to lag disk in
  // both directions.
  assert.match(panel, /openWorkflowNotFoundMessage\(\{ path, refresh, known, disk \}\)/);
  const failSite = panel.slice(panel.indexOf("const known = knownSelectorSample"));
  assert.ok(
    failSite.indexOf("openWorkflowNotFoundMessage") < 400,
    "the sample is computed immediately before the refusal it feeds",
  );
  // And the old sentence is no longer EMITTED. Scoped to non-comment lines: the fix
  // quotes the old wording in a comment to explain itself, and a bare doesNotMatch
  // over the whole file forbade describing the very defect being fixed.
    const NEWLINE = new RegExp(String.raw`\r?\n`);
    const code = panel
      .split(NEWLINE)
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  assert.doesNotMatch(code, /even after a refresh/);
  assert.doesNotMatch(code, /For a file outside the workflows folder/);
});
