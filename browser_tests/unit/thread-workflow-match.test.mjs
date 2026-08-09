import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  threadMatchesCurrentWorkflow,
  currentWorkflowIdentityKeys,
} from "../../web/js/lib/thread-workflow-match.js";

/**
 * #694 — "Current workflow only" showed 1 of 2 conversations created on the same
 * unsaved canvas.
 *
 * The uuid a thread is stamped with can be RE-MINTED between two records on an
 * unsaved draft (resolveUnsavedInstanceUuid fails closed rather than adopt a
 * copyable embedded uuid, #570). The live-object route id does not change across
 * that re-mint, so it is the stable half.
 *
 * The risk in this fix is the opposite of the bug: matching too loosely attaches
 * ANOTHER workflow's conversation to this one. Several tests below exist only to
 * hold that line.
 */

const keys = (...k) => new Set(k);

test("the reporter's case: two threads, different uuids, same live canvas — both match", () => {
  const current = keys("workflow:uuid-B", "tmp:live-object-1");
  const older = { workflowKey: "workflow:uuid-A", workflowRouteKey: "tmp:live-object-1" };
  const newer = { workflowKey: "workflow:uuid-B", workflowRouteKey: "tmp:live-object-1" };
  assert.equal(threadMatchesCurrentWorkflow(older, current), true, "the re-minted one must not vanish");
  assert.equal(threadMatchesCurrentWorkflow(newer, current), true);
});

test("the durable uuid alone still matches — the primary key is unchanged", () => {
  // Every thread written before this change has no route key. It must keep working
  // exactly as it does today, including after a reload when the WeakMap is gone.
  const current = keys("workflow:uuid-A", "tmp:live-object-9");
  assert.equal(threadMatchesCurrentWorkflow({ workflowKey: "workflow:uuid-A" }, current), true);
});

test("a DIFFERENT workflow does not match on either key", () => {
  const current = keys("workflow:uuid-B", "tmp:live-object-1");
  const foreign = { workflowKey: "workflow:uuid-Z", workflowRouteKey: "tmp:live-object-2" };
  assert.equal(threadMatchesCurrentWorkflow(foreign, current), false);
});

test("a foreign thread whose UUID was re-minted still does not match", () => {
  // The dangerous shape: a stale uuid plus a route id from another live object.
  // Neither half may admit it — this is the #570 cross-attribution this must not
  // reintroduce.
  const current = keys("workflow:uuid-B", "tmp:live-object-1");
  assert.equal(
    threadMatchesCurrentWorkflow({ workflowKey: "workflow:uuid-OLD", workflowRouteKey: "tmp:other" }, current),
    false,
  );
});

test("an EMPTY or missing route key never matches by accident", () => {
  // A set that happens to contain "" (a degenerate workflowTabId) must not turn
  // every unstamped thread into a match.
  const degenerate = keys("workflow:uuid-B", "");
  for (const route of ["", null, undefined]) {
    assert.equal(
      threadMatchesCurrentWorkflow({ workflowKey: "workflow:OTHER", workflowRouteKey: route }, degenerate),
      false,
      `route ${JSON.stringify(route)} must not match`,
    );
  }
});

test("an empty storage key never matches by accident either", () => {
  const degenerate = keys("", "tmp:live-1");
  assert.equal(threadMatchesCurrentWorkflow({ workflowKey: "" }, degenerate), false);
  assert.equal(threadMatchesCurrentWorkflow({ workflowKey: null }, degenerate), false);
});

test("a non-string key is not coerced into a match", () => {
  const current = keys("workflow:uuid-B", "tmp:live-1");
  assert.equal(threadMatchesCurrentWorkflow({ workflowKey: 0 }, current), false);
  assert.equal(threadMatchesCurrentWorkflow({ workflowRouteKey: {} }, current), false);
});

test("saved workflows match on the shared path handle, as they already did", () => {
  // workflowTabId() for a SAVED workflow is the path handle, which two tabs on the
  // same file legitimately share — and which the filter set already accepted before
  // this change. Not a regression, and not a new authority.
  const current = keys("workflow:uuid-S", "wf:workflows/A.json");
  assert.equal(
    threadMatchesCurrentWorkflow({ workflowKey: "workflow:older", workflowRouteKey: "wf:workflows/A.json" }, current),
    true,
  );
});

test("malformed inputs return false rather than throwing", () => {
  for (const bad of [null, undefined, 42, "x", {}]) {
    assert.equal(threadMatchesCurrentWorkflow(bad, keys("a")), false);
  }
  for (const badSet of [null, undefined, [], {}, "nope"]) {
    assert.equal(threadMatchesCurrentWorkflow({ workflowKey: "a" }, badSet), false);
  }
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: threads are STAMPED with the route key and the picker matches on it", async () => {
  // The helper being right proves nothing about it being reached. Both halves have
  // to hold: without the stamp there is nothing to match, and without the matcher
  // the stamp is never read. Both live in module-private code needing a live panel,
  // so they are pinned at source.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

  // The IMPORT BINDING, tolerant of formatting. Pinning the exact one-line form
  // broke the moment a second named export was added; but relaxing it to three
  // separate `includes` was worse (codex) — both identifiers appear elsewhere in
  // this file, and the module path could belong to an import of something else
  // entirely, so all three could pass with neither symbol bound. Parse the
  // declaration instead: line wrapping is free, an unbound symbol is not.
  const decl = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/thread-workflow-match\.js";/);
  assert.ok(decl, "the panel must import from the matcher module");
  const named = decl[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(named.includes("threadMatchesCurrentWorkflow"), "the matcher must be bound");
  assert.ok(named.includes("currentWorkflowIdentityKeys"), "the identity-set builder must be bound");
  // Stamped at thread creation AND on the revise that follows it.
  const stamps = src.match(/workflowRouteKey: workflowTabId\(\),/g) ?? [];
  assert.ok(stamps.length >= 2, `expected the route stamp at creation and revise, saw ${stamps.length}`);
  // And actually consulted by the "Current workflow only" filter.
  assert.ok(src.includes("threadMatchesCurrentWorkflow(candidate, currentWorkflowKeys)"),
    "the picker must use the matcher — otherwise #694's under-report returns");
});

test("WIRING #847: the filter's key set carries the PRIOR tmp: id", () => {
  // The helper accepting a priorRouteId proves nothing if the panel never passes
  // one. This is the whole fix: `_priorTempWorkflowIds` already retains that id for
  // the live workflow object's lifetime, and `workflowRecordMatchesSelector` already
  // honours it — the history filter was the one reader that did not.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const site = src.slice(
    src.indexOf("const currentWorkflowKeys = currentWorkflowIdentityKeys({"),
    src.indexOf("threadMatchesCurrentWorkflow(candidate, currentWorkflowKeys)"),
  );
  assert.ok(site.length > 0, "the filter must build its key set through the shared builder");
  assert.ok(site.includes("priorRouteId:"), "it must pass a prior route id");
  assert.ok(site.includes("_priorTempWorkflowIds.get(activeWf)"), "…read from the map that retains it");
  // Guarded: activeWorkflowRef() is null with no canvas, and a WeakMap.get(null)
  // throws. A history pane that crashes on an empty canvas would be a worse bug
  // than the one being fixed.
  assert.ok(site.includes("activeWf ? _priorTempWorkflowIds.get(activeWf) : null"), "the lookup must be guarded");
});

// ── #847: a first SAVE moves both identity forms at once ───────────────────

test("the prior tmp: id is part of the current workflow's identity set", () => {
  // A first save migrates the route id (tmp:<uuid> -> wf:<path>) AND re-mints the
  // storage uuid at the same boundary. A thread recorded before the save then holds
  // neither live form, and "Current workflow only" hides a conversation the user had
  // on the workflow they are looking at — same tab, same canvas, minutes earlier.
  const keys = currentWorkflowIdentityKeys({
    storageKey: "workflow:8765613d-614f-4cc6-a86b-607bdd3d2c2c",
    routeId: "wf:workflows/Untitled.json",
    priorRouteId: "tmp:15530147-0b52-4f52-9e09-732978ea6652",
  });
  // Observed in the live suite: these are the two stamps the two threads actually
  // carried, and before this change nothing they held was in the set.
  const beforeSave = {
    workflowKey: "workflow:eff67d7a-4716-4c14-82f6-1ce4d47f0a72",
    workflowRouteKey: "tmp:15530147-0b52-4f52-9e09-732978ea6652",
  };
  const afterSave = {
    workflowKey: "workflow:8765613d-614f-4cc6-a86b-607bdd3d2c2c",
    workflowRouteKey: "wf:workflows/Untitled.json",
  };
  assert.equal(threadMatchesCurrentWorkflow(beforeSave, keys), true, "the pre-save chat must not vanish");
  assert.equal(threadMatchesCurrentWorkflow(afterSave, keys), true);
});

test("without the prior id, the pre-save thread is exactly the one that disappears", () => {
  // The regression this guards. Stated as its own case so a future edit that drops
  // priorRouteId fails with the reason rather than with an opaque count.
  const keys = currentWorkflowIdentityKeys({
    storageKey: "workflow:new-uuid",
    routeId: "wf:workflows/Untitled.json",
  });
  assert.equal(
    threadMatchesCurrentWorkflow(
      { workflowKey: "workflow:old-uuid", workflowRouteKey: "tmp:abc" },
      keys,
    ),
    false,
  );
});

test("the identity set holds only real strings", () => {
  // An absent form is absent, not a hole in the set. `undefined` could never match a
  // thread's stamp anyway, but a set that silently carries holes invites a later
  // reader to treat membership as meaningful when it is not.
  const keys = currentWorkflowIdentityKeys({ storageKey: "workflow:x", routeId: null, priorRouteId: undefined });
  assert.deepEqual([...keys], ["workflow:x"]);
  assert.equal(currentWorkflowIdentityKeys({}).size, 0);
  assert.equal(currentWorkflowIdentityKeys().size, 0);
  // Empty strings are not identities.
  assert.equal(currentWorkflowIdentityKeys({ storageKey: "", routeId: "" }).size, 0);
});

test("a thread from ANOTHER workflow still does not match", () => {
  // Widening the identity set is only safe if it cannot pull in a foreign
  // conversation — the failure the uuid re-mint exists to prevent (#570).
  const keys = currentWorkflowIdentityKeys({
    storageKey: "workflow:mine",
    routeId: "wf:workflows/Mine.json",
    priorRouteId: "tmp:mine-was",
  });
  assert.equal(
    threadMatchesCurrentWorkflow(
      { workflowKey: "workflow:theirs", workflowRouteKey: "tmp:theirs" },
      keys,
    ),
    false,
  );
});
