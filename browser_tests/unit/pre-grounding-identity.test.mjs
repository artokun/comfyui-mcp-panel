// #847 — the identity a tab held before GROUNDING saved it, kept so the conversation
// recorded a moment earlier still belongs to the workflow it was held on.
//
// Grounding (#330) auto-saves an unsaved workflow before a turn. ComfyUI REPLACES the
// ComfyWorkflow object at that save, and the successor finds nothing to inherit from:
// the object WeakMaps are keyed on the object that is gone, the embedded-uuid carriers
// `workflowOwnedExtra` reads are all absent on this frontend, and the path alias is
// written from the NEW id. So it mints a fresh identity, and the first chat about the
// workflow drops out of "Current workflow only".
//
// Instrumented on a live ComfyUI before writing any of this — the two threads carried
// `workflow:ff7890d8…`/`tmp:bbf55b89…` and `workflow:80140efd…`/`wf:workflows/Untitled…`,
// with `activeState.extra` holding the original uuid right after the save and null by the
// time the filter ran. Nothing live survives to be read later, which is why the record has
// to be written AT the save.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rememberPreGroundingIdentity,
  preGroundingIdentityForms,
  pruneGroundingIdentities,
  normalizedWorkflowPath,
} from "../../web/js/lib/workflow-chat-identity.js";

const TMP = "tmp:8b7791e6-e618-4266-93fa-b3a1434d6902";
const KEY = "workflow:ad8c385e-1111-2222-3333-444455556666";
const PATH = "workflows/Untitled 2026-08-09 19-40-25.json";

test("#847: a grounded path remembers the forms the tab held before the save", () => {
  const map = {};
  assert.equal(rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: TMP }), true);
  const forms = preGroundingIdentityForms(map, PATH);
  assert.ok(forms.includes(KEY), "the pre-save storage key is what the orphaned thread carries");
  assert.ok(forms.includes(TMP), "the pre-save route id is the other form a thread may hold");
});

test("#847: lookup is path-normalised, not literal", () => {
  // Windows hands back backslashes and case varies; a filter that misses on either shows
  // the bug this fixes while looking like it works.
  const map = {};
  rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: TMP });
  assert.deepEqual(
    preGroundingIdentityForms(map, "workflows\\Untitled 2026-08-09 19-40-25.json"),
    [KEY, TMP],
  );
  assert.deepEqual(preGroundingIdentityForms(map, PATH.toUpperCase()), [KEY, TMP]);
});

test("#847: only a genuine pre-save boundary is recorded", () => {
  // Saving an ALREADY-saved workflow breaks no lineage. Recording one would invent a
  // relationship rather than remember it, and the whole safety argument here is that
  // nothing is inferred.
  const map = {};
  assert.equal(
    rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: "wf:workflows/Other.json" }),
    false,
    "a wf: route means this tab was already saved — no boundary",
  );
  assert.equal(rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: null }), false);
  assert.equal(rememberPreGroundingIdentity(map, { path: "", storageKey: KEY, routeId: TMP }), false);
  assert.equal(rememberPreGroundingIdentity(map, { path: PATH, storageKey: null, routeId: null }), false);
  assert.deepEqual(map, {}, "nothing unprovable is written");
});

test("#847: an unknown path contributes no identity forms", () => {
  // The filter unions these into the current workflow's key set. Returning anything for a
  // path never grounded would let one workflow's chats appear under another — the
  // cross-attribution this area exists to prevent.
  // Entries are STORED under the normalised path, so a hand-built map has to use it too —
  // the writer normalises and the reader normalises, and that symmetry is the point.
  const stored = normalizedWorkflowPath(PATH);
  assert.deepEqual(preGroundingIdentityForms({}, PATH), []);
  assert.deepEqual(preGroundingIdentityForms(null, PATH), []);
  assert.deepEqual(preGroundingIdentityForms({ [stored]: "not-an-array" }, PATH), []);
  assert.deepEqual(preGroundingIdentityForms({ [stored]: [KEY, null, 7, ""] }, PATH), [KEY]);
  assert.deepEqual(preGroundingIdentityForms({}, null), []);
  // A raw, unnormalised key must NOT resolve — that would mean the two halves disagree.
  assert.deepEqual(preGroundingIdentityForms({ "WORKFLOWS/Foo.json": [KEY] }, "WORKFLOWS/Foo.json"), []);
});

test("#847: the latest grounding into a path replaces an older lineage", () => {
  // A path is created fresh by the grounding that names it. If a name is ever reused, the
  // record must describe the workflow living there NOW — otherwise a deleted workflow's
  // chats surface under its successor.
  const map = {};
  rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: TMP });
  rememberPreGroundingIdentity(map, { path: PATH, storageKey: "workflow:newer", routeId: "tmp:newer" });
  assert.deepEqual(preGroundingIdentityForms(map, PATH), ["workflow:newer", "tmp:newer"]);
});

test("#847: a bare tmp: prefix is not an identity", () => {
  // `startsWith("tmp:")` accepted `tmp:` itself (codex) — a prefix with nothing behind it,
  // which names no workflow and could only ever match by accident.
  const map = {};
  assert.equal(rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: "tmp:" }), false);
  assert.deepEqual(map, {});
});

test("#847: a lineage whose workflow is gone is dropped, not left to catch a namesake", () => {
  // The dangerous direction. Delete a workflow, let a new one take the name, and a kept
  // entry would show the dead workflow's chats under its successor — a false INCLUSION in
  // the one filter whose entire promise is not to do that.
  const map = {};
  rememberPreGroundingIdentity(map, { path: "workflows/Gone.json", storageKey: KEY, routeId: TMP });
  rememberPreGroundingIdentity(map, { path: "workflows/Live.json", storageKey: KEY, routeId: TMP });
  assert.equal(pruneGroundingIdentities(map, { knownPaths: ["workflows/Live.json"] }), true);
  assert.deepEqual(preGroundingIdentityForms(map, "workflows/Gone.json"), []);
  assert.deepEqual(preGroundingIdentityForms(map, "workflows/Live.json"), [KEY, TMP]);
});

test("#847: an unreadable workflow list prunes nothing", () => {
  // Absence of evidence is not evidence every workflow was deleted. Clearing here would
  // silently reintroduce the bug whenever the store is momentarily unavailable.
  const map = {};
  rememberPreGroundingIdentity(map, { path: PATH, storageKey: KEY, routeId: TMP });
  assert.equal(pruneGroundingIdentities(map, { knownPaths: null }), false);
  assert.deepEqual(preGroundingIdentityForms(map, PATH), [KEY, TMP]);
});

test("#847: the map stays bounded, oldest first", () => {
  const map = {};
  const paths = Array.from({ length: 6 }, (_, i) => `workflows/w${i}.json`);
  for (const p of paths) rememberPreGroundingIdentity(map, { path: p, storageKey: KEY, routeId: TMP });
  pruneGroundingIdentities(map, { knownPaths: paths, max: 4 });
  assert.equal(Object.keys(map).length, 4);
  assert.deepEqual(preGroundingIdentityForms(map, paths[0]), [], "the oldest went first");
  assert.deepEqual(preGroundingIdentityForms(map, paths[5]), [KEY, TMP], "the newest stayed");
});
