import { test } from "node:test";
import assert from "node:assert/strict";
import { threadMatchesCurrentWorkflow } from "../../web/js/lib/thread-workflow-match.js";

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

  assert.match(src, /import \{ threadMatchesCurrentWorkflow \} from "\.\/lib\/thread-workflow-match\.js";/);
  // Stamped at thread creation AND on the revise that follows it.
  const stamps = src.match(/workflowRouteKey: workflowTabId\(\),/g) ?? [];
  assert.ok(stamps.length >= 2, `expected the route stamp at creation and revise, saw ${stamps.length}`);
  // And actually consulted by the "Current workflow only" filter.
  assert.ok(src.includes("threadMatchesCurrentWorkflow(candidate, currentWorkflowKeys)"),
    "the picker must use the matcher — otherwise #694's under-report returns");
});
