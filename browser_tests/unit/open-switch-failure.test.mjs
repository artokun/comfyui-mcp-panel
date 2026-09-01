/**
 * #2158 — `panel_open_workflow` failed with a bare `NetworkError when attempting to fetch
 * resource.` while switching between two saved workflows.
 *
 * Two things were wrong and they are tested separately, because only one of them is the
 * symptom that got reported:
 *
 *   1. The message. The raw browser string was rethrown with no route and no
 *      classification, even though the panel already owned a classifier for exactly this
 *      failure class (`manager-fetch-failure.js`, comfyui-mcp#1472).
 *   2. The receipt. The executor journaled `applied: false` — "confirmed not applied, safe
 *      to retry" in the orchestrator's vocabulary — from an ASSERTION, on a path where the
 *      store had already been mutated and where the active pointer can have moved.
 *
 * The second is the one that could hurt someone, so most of what follows is about it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WORKFLOW_CONTENT_ROUTE,
  classifyOpenSwitchFailure,
  openSwitchFailureMessage,
} from "../../web/js/lib/open-switch-failure.js";

const PANEL_JS = new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url);

/** The exact string Firefox produced in the report. */
const FIREFOX = new Error("NetworkError when attempting to fetch resource.");
/** The reporter was on Firefox; the other engines must classify identically. */
const CHROME = new Error("Failed to fetch");
const SAFARI = new Error("Load failed");
/** What `UserFile.load()` throws when the server ANSWERED and said no. */
const ANSWERED = new Error("Failed to load file 'workflows/a.json': 404 Not Found");

// --- classification -------------------------------------------------------

test("#2158 the reported Firefox string is recognised as a transport failure", () => {
  for (const err of [FIREFOX, CHROME, SAFARI]) {
    assert.equal(classifyOpenSwitchFailure({ err }).transport, true, err.message);
  }
});

test("#2158 an ANSWERED failure is NOT relabelled as transport", () => {
  // The dangerous direction. A 404/403 means the server considered the request and said
  // no; calling that "no usable response reached the browser" would send the caller after
  // their network when the file is simply not there.
  const v = classifyOpenSwitchFailure({ err: ANSWERED });
  assert.equal(v.transport, false);
  const text = openSwitchFailureMessage({ path: "workflows/a.json", err: ANSWERED, activeIsSource: true });
  assert.match(text, /404 Not Found/, "the real message survives");
  assert.doesNotMatch(text, /TRANSPORT failure/);
  // And it must NOT inherit the "safe to retry" sentence, which is only earned by
  // knowing the failed call was a read that never reached the server.
  assert.doesNotMatch(text, /safe/i);
});

test("#2158 a transport phrase MID-SENTENCE is not a transport failure", () => {
  // Inherited from #1472's anchoring, and re-pinned here because this module is a new
  // consumer of it: a workflow whose own content mentions the phrase must not flip the
  // classification of an error the server actually produced.
  const err = new Error("Workflow validation failed: NetworkError in a saved node property");
  assert.equal(classifyOpenSwitchFailure({ err }).transport, false);
});

// --- the verdict, which is the load-bearing half --------------------------

test("#2158 `false` is returned ONLY when the pointer is PROVEN to be on the source", () => {
  const v = classifyOpenSwitchFailure({
    err: FIREFOX,
    activeIsTarget: false,
    activeIsSource: true,
    tabAppeared: true,
    contentLoaded: false,
  });
  assert.equal(v.applied, false);
  // The tab residue is REPORTED but must not downgrade the verdict: downgrading would
  // replace "safe to retry" with "inspect first" on exactly the case this issue is
  // about, which is the caller's situation getting worse.
  assert.deepEqual(v.residue, ["tab_listed_without_content"]);
});

test("#2158 a pointer that MOVED TO THE TARGET can never be reported as not-applied", () => {
  // The wrong-graph hazard. `openWorkflow` assigns `activeWorkflow.value` and only THEN
  // writes `comfyApp.canvas.bg_tint`, so a throw after the pointer moved is reachable.
  // Saying "confirmed not applied" there tells the caller the canvas is still the
  // previous workflow's while it is not.
  const v = classifyOpenSwitchFailure({
    err: new Error("Cannot set properties of null (setting 'bg_tint')"),
    activeIsTarget: true,
    activeIsSource: false,
    tabAppeared: false,
    contentLoaded: true,
  });
  assert.equal(v.applied, "unknown");
  assert.ok(v.residue.includes("active_pointer_moved_to_target"));
  assert.ok(v.residue.includes("workflow_content_loaded"));
});

test("#2158 an UNOBSERVABLE pointer degrades to unknown, never to a negative", () => {
  // The whole bug in one line: an unmeasured negative is not a negative. Every one of
  // these must refuse to claim the clean negative.
  for (const obs of [
    {},
    { activeIsSource: null, activeIsTarget: null },
    { activeIsSource: false, activeIsTarget: false }, // active is some THIRD workflow
    { activeIsSource: undefined },
  ]) {
    assert.equal(classifyOpenSwitchFailure({ err: FIREFOX, ...obs }).applied, "unknown", JSON.stringify(obs));
  }
});

test("#2158 `false` from sameWorkflowObject is 'not proven', not 'proven different'", () => {
  // sameWorkflowObject never proves difference — it returns false for "cannot prove".
  // So a false on activeIsTarget must not, on its own, license the clean negative.
  assert.equal(
    classifyOpenSwitchFailure({ err: FIREFOX, activeIsTarget: false, activeIsSource: false }).applied,
    "unknown",
  );
});

// --- the message ----------------------------------------------------------

test("#2158 the transport message names the ROUTE and refuses to invent a status", () => {
  const text = openSwitchFailureMessage({
    path: "workflows/VR180 SeedVR2 Benchmark Runner.json",
    err: FIREFOX,
    activeIsTarget: false,
    activeIsSource: true,
    tabAppeared: true,
    contentLoaded: false,
    sourceLabel: "workflows/VR180 Restoration - 1s Trim Proof.json",
  });
  // The workflow the reporter asked for, and the one they were on.
  assert.match(text, /VR180 SeedVR2 Benchmark Runner\.json/);
  assert.match(text, /VR180 Restoration - 1s Trim Proof\.json/);
  // The route — the single thing the bare error was missing.
  assert.match(text, /GET \/userdata/);
  assert.equal(WORKFLOW_CONTENT_ROUTE, "/userdata/<workflow path>");
  // The raw browser text is preserved, not replaced.
  assert.match(text, /NetworkError when attempting to fetch resource/);
  // No status or body is promised, because none exists.
  assert.match(text, /no HTTP status or response body to report/);
  // The measurement is labelled as such, so it reads differently from the assertion it
  // replaced.
  assert.match(text, /MEASURED, NOT ASSUMED/);
  assert.match(text, /the switch did not happen/);
  // The actionable recovery, earned by the failed call being a read.
  assert.match(text, /re-issuing panel_open_workflow is safe/);
  // And the residue the old message denied.
  assert.match(text, /now listed among the open workflow tabs/);
});

test("#2158 when the pointer moved, the message says so INSTEAD of claiming a clean miss", () => {
  const text = openSwitchFailureMessage({
    path: "workflows/b.json",
    err: new Error("Cannot set properties of null (setting 'bg_tint')"),
    activeIsTarget: true,
    activeIsSource: false,
  });
  assert.match(text, /the active workflow IS now "workflows\/b\.json"/);
  assert.match(text, /Re-read the graph/);
  assert.doesNotMatch(text, /the switch did not happen/);
  assert.doesNotMatch(text, /safe/i, "a moved pointer must never carry the retry-is-safe sentence");
});

test("#2158 an unobservable pointer says it cannot tell, and asks for a read", () => {
  const text = openSwitchFailureMessage({ path: "workflows/b.json", err: FIREFOX });
  assert.match(text, /could NOT observe which workflow is active/);
  assert.match(text, /Read the active workflow before deciding whether to retry/);
  assert.doesNotMatch(text, /the switch did not happen/);
});

test("#2158 a tab that was ALREADY listed is not reported as new residue", () => {
  // `tabAppeared:false` is what the executor passes when its BEFORE snapshot already saw
  // the tab. Reporting it anyway would blame this failure for a tab the user opened.
  const text = openSwitchFailureMessage({
    path: "workflows/b.json",
    err: FIREFOX,
    activeIsSource: true,
    tabAppeared: false,
  });
  assert.doesNotMatch(text, /now listed among the open workflow tabs/);
});

// --- wiring: a module nothing calls is inert ------------------------------

test("#2158 WIRED: the native-switch catch MEASURES instead of asserting", () => {
  const src = readFileSync(PANEL_JS, "utf8");

  // The assertion this issue is about is GONE. It is the sentence, not the mechanism,
  // that encoded the wrong belief.
  assert.doesNotMatch(
    src,
    /The native switch itself failed — nothing was applied/,
    "the unmeasured claim must not survive",
  );

  // The catch reads the pointer and feeds the classifier.
  const at = src.indexOf("openSwitchObservations = {");
  assert.ok(at > 0, "the catch records its observations");
  // Compared LOCALLY rather than by whole-file index — several of these identifiers
  // appear elsewhere in a 2.5MB file and a global index comparison passes for the wrong
  // reason.
  const near = src.slice(at - 1500, at + 1200);
  assert.match(near, /activeNow = activeWorkflowRef\(\)/, "the pointer is actually read");
  assert.match(near, /activeIsTarget:/);
  assert.match(near, /activeIsSource:/);
  assert.match(near, /tabAppeared:/);
  assert.match(near, /openSwitchFailureMessage\(\{/, "the classified message replaces the raw one");

  // Each observation is GUARDED — an unreadable store must yield null, not false. That
  // is the property the whole fix rests on.
  assert.match(near, /activeReadable \? provenSame\(activeNow, target\) : null/);
  assert.match(near, /activeReadable \? provenSame\(activeNow, activeBefore\) : null/);
});

test("#2158 WIRED: the receipt carries the measured verdict AND the resolved identity", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const at = src.indexOf('let applied = "unknown";');
  assert.ok(at > 0, "the throw site classifies");
  const near = src.slice(at, at + 1100);
  assert.match(near, /applied = classifyOpenSwitchFailure\(\{/, "the journal takes the MEASURED verdict");
  assert.match(near, /throw failOpen\(openFailed, \{\s*\n?\s*applied,/);
  // The default is the HONEST side. If the classifier is ever unusable the verdict must
  // land on "unknown" — a fabricated `false` is read by the orchestrator as "confirmed
  // not applied, safe to retry", which is the wrong-graph edit this whole change avoids.
  assert.ok(
    src.slice(at, src.indexOf("classifyOpenSwitchFailure({", at)).includes('"unknown"'),
    "the pre-classification default is unknown, not false",
  );
  // Without a resolved path the orchestrator's correlator rejects the receipt before it
  // ever reads `applied`, which would make the measurement unreachable.
  assert.match(near, /resolved: \{[\s\S]{0,200}?path: target\.path/);
  assert.match(near, /routing_key: workflowTabId\(target\)/);
});

test("#2158 WIRED: the tab-list snapshot is taken BEFORE the switch, or it proves nothing", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const snapshot = src.indexOf("const targetWasListedOpen = targetIsListedOpen();");
  const switchAt = src.indexOf("await s.openWorkflow(target);");
  assert.ok(snapshot > 0, "the before-snapshot exists");
  assert.ok(switchAt > 0, "the native switch is still here");
  assert.ok(snapshot < switchAt, "the snapshot must precede the mutation it is a baseline for");
  // And it is a DIFFERENT question from wasOpen, which asks about loaded content.
  assert.match(src, /const wasOpen = !!target\.changeTracker;/);
});

test("#2158 WIRED: the classifier is SHARED with #1472, not a second copy of the table", () => {
  // A duplicated table drifts: a browser wording added to one would be unknown to the
  // other, and this module would silently stop recognising a real transport failure.
  const lib = readFileSync(new URL("../../web/js/lib/open-switch-failure.js", import.meta.url), "utf8");
  assert.match(lib, /import \{ isTransportFailure \} from "\.\/manager-fetch-failure\.js";/);
  assert.doesNotMatch(lib, /networkerror when attempting to fetch resource/i, "no second copy of the table");
});

test("#2158 the raw message is not double-punctuated", () => {
  // Firefox's string already ends in a full stop and Chrome's does not, so a bare
  // `${raw}.` produced "…fetch resource.." for the exact browser this was reported from.
  const ff = openSwitchFailureMessage({ path: "a.json", err: FIREFOX, activeIsSource: true });
  assert.doesNotMatch(ff, /\.\./, "no doubled full stop");
  assert.match(ff, /fetch resource\. This is a TRANSPORT failure/);
  // Chrome's has no trailing stop and must still get one.
  const cr = openSwitchFailureMessage({ path: "a.json", err: CHROME, activeIsSource: true });
  assert.match(cr, /Failed to fetch\. This is a TRANSPORT failure/);
  // Same on the non-transport branch, where the server's own text is kept.
  const ans = openSwitchFailureMessage({ path: "a.json", err: ANSWERED, activeIsSource: true });
  assert.match(ans, /404 Not Found\. MEASURED/);
  assert.doesNotMatch(ans, /\.\./);
});
