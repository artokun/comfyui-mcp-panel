/**
 * #1001 bug 1 — a saved workflow loses its identity across a reconnect.
 *
 * The reported sequence: a workflow created in-session (`panel_new_workflow` ->
 * `panel_paste_nodes` -> `panel_rename_workflow` -> `panel_save_workflow`), so it had a
 * real saved path. After a ComfyUI drop/reconnect the canvas was on the correct
 * workflow and the panel said so — yet every mutating command was refused for `no
 * trusted identity`, while reads kept working.
 *
 * MECHANISM. `establishedWorkflowReplyIdentity` publishes an identity only when the
 * uuid is ALREADY in the live-object WeakMap, because `workflowObjectUuid` is a pure
 * read that never mints (#716 — a reply must not be able to initialize an identity for
 * a canvas the panel has never seen). A reconnect can REPLACE the active ComfyWorkflow
 * object; the successor is not in that map, so the hello published no `workflow_uuid`
 * and there was nothing to fence against.
 *
 * The identity was derivable the whole time: the reporter's own recovery was
 * `panel_open_workflow` on the workflow that was ALREADY active, and an open mints
 * through `workflowStableUuid`, which seeds the map from the path.
 *
 * So the fix ADOPTS rather than mints — the persisted path->uuid alias map already
 * records what was established for that exact file. These tests run the SHIPPED
 * functions in a sandbox with the panel's globals injected, because the invariant being
 * protected (#716) and the one being added (#1001) sit in the same function and only
 * their interaction matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { savedWorkflowHandle } from "../../web/js/lib/bridge-route.js";
import { workflowAliasForPath } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "99999999-8888-4777-8666-555555555555";

/**
 * The shipped `establishedWorkflowReplyIdentity` + `rederiveSavedWorkflowIdentity`,
 * with the panel globals they read supplied as fixtures.
 */
function sandbox({ aliases = {}, objectUuids = new WeakMap(), owners = new Map(), openWorkflows = [] } = {}) {
  const src = readFileSync(PANEL_JS, "utf8");
  const minted = [];
  const parts = [
    namedFunctionSource(src, "savedWorkflowPath"),
    namedFunctionSource(src, "isCanonicalWorkflowInstanceUuid"),
    namedFunctionSource(src, "rederiveSavedWorkflowIdentity"),
    namedFunctionSource(src, "establishedWorkflowReplyIdentity"),
  ];
  for (const [i, part] of parts.entries()) assert.ok(part, `panel source part ${i} not found`);
  const make = new Function(
    "workflowObjectUuid",
    "savedWorkflowHandle",
    "workflowTabId",
    "workflowAliasForPath",
    "_workflowUuidAliases",
    "workflowUuidOwner",
    "sameWorkflowObject",
    "setWorkflowObjectUuid",
    "rememberWorkflowUuidOwner",
    "app",
    `${parts.join("; ")}; return establishedWorkflowReplyIdentity;`,
  );
  const identity = make(
    (wf) => objectUuids.get(wf),
    savedWorkflowHandle,
    () => "tmp:should-not-be-reached",
    workflowAliasForPath,
    aliases,
    (id) => owners.get(id) ?? null,
    (a, b) => a === b,
    (wf, uuid) => {
      minted.push(uuid);
      objectUuids.set(wf, uuid);
    },
    (id, owner) => owners.set(id, owner),
    { extensionManager: { workflow: { openWorkflows } } },
  );
  return { identity, minted, objectUuids, owners };
}

const savedWorkflow = (path) => ({ path, isPersisted: true, filename: path.split("/").pop() });

test("#1001 the reported case: a SAVED workflow whose object lost its uuid re-derives it", () => {
  const wf = savedWorkflow("workflows/niji_holo_impasto.json");
  const { identity, minted } = sandbox({ aliases: { "workflows/niji_holo_impasto.json": UUID_A } });
  const result = identity(wf);
  assert.equal(result?.uuid, UUID_A, "the identity already recorded for that file, not a new one");
  assert.equal(result?.routingKey, savedWorkflowHandle("workflows/niji_holo_impasto.json"));
  assert.deepEqual(minted, [UUID_A], "adopted — the value came from the alias map, nothing was invented");
});

test("#1001 an established uuid still wins; re-derivation is only for the empty case", () => {
  const wf = savedWorkflow("workflows/a.json");
  const objectUuids = new WeakMap([[wf, UUID_B]]);
  const { identity, minted } = sandbox({ aliases: { "workflows/a.json": UUID_A }, objectUuids });
  assert.equal(identity(wf)?.uuid, UUID_B, "the live object map is the authority when it has an answer");
  assert.deepEqual(minted, [], "and nothing is rewritten");
});

test("#1001 a path NOTHING was established for still publishes nothing (#716 holds)", () => {
  // This is the invariant the re-derivation must not weaken: no record, no identity.
  // The caller is told to open, which is what mints one.
  const { identity, minted } = sandbox({ aliases: { "workflows/other.json": UUID_A } });
  assert.equal(identity(savedWorkflow("workflows/never-seen.json")), null);
  assert.deepEqual(minted, []);
});

test("#1001 an UNSAVED workflow is never re-derived — there is no path to derive from", () => {
  const { identity, minted } = sandbox({ aliases: { "workflows/a.json": UUID_A } });
  assert.equal(identity({ isPersisted: false, isTemporary: true }), null);
  assert.deepEqual(minted, []);
});

test("#1001 a malformed alias is refused — only a canonical instance uuid is adopted", () => {
  for (const junk of ["", "not-a-uuid", "tmp:abc", 42, null, {}]) {
    const { identity } = sandbox({ aliases: { "workflows/a.json": junk } });
    assert.equal(identity(savedWorkflow("workflows/a.json")), null, `alias ${JSON.stringify(junk)}`);
  }
});

test("#1001 a LIVE co-open owner keeps its identity — two objects must never share one", () => {
  // A closed owner was REPLACED and this object succeeds it. An owner still in
  // openWorkflows is a genuine co-open copy, and adopting would let a command stamped
  // for one canvas pass the fence against the other.
  const liveOwner = savedWorkflow("workflows/a.json");
  const successor = savedWorkflow("workflows/a.json");
  const owners = new Map([[UUID_A, liveOwner]]);
  const stillOpen = sandbox({
    aliases: { "workflows/a.json": UUID_A },
    owners,
    openWorkflows: [liveOwner],
  });
  assert.equal(stillOpen.identity(successor), null, "the owner is still open — refuse");

  const closed = sandbox({
    aliases: { "workflows/a.json": UUID_A },
    owners: new Map([[UUID_A, liveOwner]]),
    openWorkflows: [],
  });
  assert.equal(closed.identity(successor)?.uuid, UUID_A, "the owner is gone — this object succeeds it");
});

test("#1001 re-derivation records the new owner, so the next read is consistent", () => {
  const wf = savedWorkflow("workflows/a.json");
  const { identity, owners } = sandbox({ aliases: { "workflows/a.json": UUID_A } });
  assert.equal(identity(wf)?.uuid, UUID_A);
  assert.equal(owners.get(UUID_A), wf, "the adopting object is now the owner of record");
});

test("#1001 the re-derivation is total — a hostile workflow object yields null, never a throw", () => {
  const hostile = {
    get path() {
      throw new Error("boom");
    },
  };
  const { identity } = sandbox({ aliases: { "workflows/a.json": UUID_A } });
  assert.doesNotThrow(() => identity(hostile));
  assert.equal(identity(hostile), null);
});

test("#1001 source guard: the reply re-derives, and does so only through the alias map", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /workflowObjectUuid\(wf\) \?\? rederiveSavedWorkflowIdentity\(wf\)/, "wired into the reply path");
  const fn = namedFunctionSource(src, "rederiveSavedWorkflowIdentity");
  assert.match(fn, /workflowAliasForPath\(_workflowUuidAliases, path\)/, "the recorded identity is the only source");
  assert.ok(!/crypto\.randomUUID/.test(fn), "it must never mint a fresh identity — that is #716's line");
  assert.match(fn, /ownerStillOpen/, "and it must check for a live co-open owner");
});
