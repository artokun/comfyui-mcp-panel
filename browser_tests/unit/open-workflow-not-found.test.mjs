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
  knownSelectorSample,
  openWorkflowNotFoundMessage,
} from "../../web/js/lib/open-workflow-not-found.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const msg = (o) => openWorkflowNotFoundMessage({ path: "video_minimax_low_vram.json", ...o });

test("#1448 a re-read that HAPPENED is stated as such", () => {
  const t = msg({ refresh: "ok" });
  assert.match(t, /list WAS re-read/);
  assert.match(t, /still does not contain it/);
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
  for (const refresh of ["ok", "unavailable", "not-needed", "failed: x"]) {
    const t = msg({ refresh });
    assert.doesNotMatch(t, /For a file outside the workflows folder/, refresh);
    assert.match(t, /If the file IS in the workflows/, refresh);
    assert.match(t, /if it is anywhere\s+else, load it with panel_load_workflow/, refresh);
  }
});

test("#1448 it shows the selector SHAPES, which are not guessable from outside", () => {
  // Measured on the live rig: `filename` carries no extension while `key` does, and
  // `path` is folder-qualified. A caller cannot infer that, so the sample shows it.
  const t = msg({ refresh: "ok", known: ["workflows/Anima Wojak Batch.json"] });
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
  const t = msg({ refresh: "ok", known: [] });
  // Case-insensitive: a control mutation capitalising the leading word killed the
  // strict form. The property is that the refusal names the selector it was given.
  assert.match(t, /no workflow matching "video_minimax_low_vram\.json"/i);
  assert.doesNotMatch(t, /addressed as e\.g\./);
});

test("#1448 WIRING: the caller records the outcome instead of assuming one", () => {
  // The behavioural tests cannot see the call site, and the defect WAS the call site:
  // a perfect message still lies if the caller passes a refresh state it never checked.
  const panel = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(panel, /import \{\s*knownSelectorSample,\s*openWorkflowNotFoundMessage,\s*\} from "\.\/lib\/open-workflow-not-found\.js";/);
  // Every branch the refresh can take must be reachable from the call site.
  assert.match(panel, /refresh = "unavailable"/, "a frontend without syncWorkflows");
  assert.match(panel, /refresh = "ok"/, "a successful re-read");
  assert.match(panel, /refresh = `failed: \$\{err\?\.message \?\? err\}`/, "a thrown re-read");
  // The sample must be taken AFTER the refresh (codex review). A successful re-read
  // removes stale entries — measured 109 -> 107 on a live rig — so a snapshot taken
  // before it can offer a workflow that no longer exists as an example.
  assert.match(panel, /const known = knownSelectorSample\(\[\.\.\.\(s\?\.openWorkflows \?\? \[\]\), \.\.\.\(s\?\.workflows \?\? \[\]\)\]\);/);
  assert.match(panel, /openWorkflowNotFoundMessage\(\{ path, refresh, known \}\)/);
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
