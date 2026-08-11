/**
 * #968 — WHAT last moved the active workflow.
 *
 * The issue is three reports of the fence saying "bound to the requested workflow" while
 * graph commands keep hitting the previous one. They have not converged because, after the
 * fact, a STALE binding and a FRESH one are the same observation: "the active workflow is
 * X", with nothing recording how it came to be X.
 *
 * Ruled out before building this, so it is not another guess: `panel_open_workflow` forces
 * the repaint and verifies it, both its skip paths fail closed, and the report where
 * `panel_run` queued the wrong workflow was on a build that had both protections.
 *
 * DIAGNOSTIC ONLY — nothing here decides whether a command may run. These tests pin that
 * property as hard as they pin the behaviour, because widening trust on an unknown entry
 * route is how a refusal becomes the silent wrong-graph edit the issue reports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MOVE_CAUSES,
  createActiveWorkflowProvenance,
} from "../../web/js/lib/active-workflow-provenance.js";

test("#968 a move the panel did NOT make is the one worth naming", () => {
  const p = createActiveWorkflowProvenance();
  p.record({ cause: MOVE_CAUSES.OPEN_EXECUTOR, from: "wf:a.json", to: "wf:b.json", at: 1, detail: "open_seq 2" });
  p.record({ cause: MOVE_CAUSES.EXTERNAL, from: "wf:b.json", to: "wf:c.json", at: 2 });

  const note = p.describeLast();
  assert.match(note, /the panel did not make that move/);
  assert.match(note, /from wf:b\.json to wf:c\.json/);
  // It must name the routes that can do it — both reporters' triggers are in this list.
  assert.match(note, /reconnect restore/);
  assert.match(note, /reopened at a new path/);
  // And say what it means for a binding taken earlier.
  assert.match(note, /stale/);
});

test("#968 a move the panel DID make names which command made it", () => {
  const p = createActiveWorkflowProvenance();
  p.record({ cause: MOVE_CAUSES.OPEN_EXECUTOR, from: "wf:a.json", to: "wf:b.json", at: 1, detail: "open_seq 2" });
  assert.match(p.describeLast(), /by panel_open_workflow \(open_seq 2\)/);

  p.record({ cause: MOVE_CAUSES.NEW_EXECUTOR, to: "tmp:1234", at: 2 });
  const note = p.describeLast();
  assert.match(note, /by panel_new_workflow/);
  // No `from` recorded → it must not invent one.
  assert.match(note, /moved to tmp:1234/);
  assert.ok(!/from null|from undefined/.test(note));
});

test("#968 NOTHING recorded reads as 'not known', never as 'the panel moved it'", () => {
  // The failure this avoids: an empty log rendering as a confident sentence. A caller that
  // has no provenance must be able to say so.
  const p = createActiveWorkflowProvenance();
  assert.equal(p.describeLast(), null);
  assert.equal(p.last(), null);
  assert.deepEqual(p.history(), []);
});

test("#968 an unrecognized cause is recorded as EXTERNAL, not dropped and not trusted", () => {
  // Dropping it would hide a move; trusting it would let a future call site invent an
  // authority it does not have. The hunted case is precisely "a move nobody attributed".
  const p = createActiveWorkflowProvenance();
  for (const cause of ["something_new", "", null, undefined, 42, {}]) {
    p.record({ cause, to: "wf:x.json", at: 1 });
    assert.equal(p.last().cause, MOVE_CAUSES.EXTERNAL, String(cause));
  }
});

test("#968 a move with no destination records NOTHING", () => {
  // A half-entry is worse than no entry: `describeLast` would then report a move whose
  // target is unknown, which reads as information and is not.
  const p = createActiveWorkflowProvenance();
  for (const bad of [null, undefined, {}, { cause: MOVE_CAUSES.EXTERNAL }, { to: "" }, { to: 5 }, "x"]) {
    assert.equal(p.record(bad), null, JSON.stringify(bad) ?? "undefined");
  }
  assert.equal(p.last(), null);
});

test("#968 the log is bounded — a long session must not grow it forever", () => {
  const p = createActiveWorkflowProvenance({ cap: 3 });
  for (let i = 0; i < 10; i += 1) p.record({ cause: MOVE_CAUSES.EXTERNAL, to: `wf:${i}.json`, at: i });
  const h = p.history();
  assert.equal(h.length, 3);
  // Oldest-first eviction: the RECENT moves are the ones a stale binding is explained by.
  assert.deepEqual(h.map((e) => e.to), ["wf:7.json", "wf:8.json", "wf:9.json"]);
  assert.equal(p.last().to, "wf:9.json");
});

test("#968 history() hands out a COPY — a diagnostic a caller can edit can lie", () => {
  const p = createActiveWorkflowProvenance();
  p.record({ cause: MOVE_CAUSES.EXTERNAL, to: "wf:a.json", at: 1 });
  const h = p.history();
  h[0].to = "wf:tampered.json";
  h[0].cause = MOVE_CAUSES.OPEN_EXECUTOR;
  assert.equal(p.last().to, "wf:a.json");
  assert.equal(p.last().cause, MOVE_CAUSES.EXTERNAL);
});

test("#968 free-text detail is bounded and never structured", () => {
  const p = createActiveWorkflowProvenance();
  p.record({ cause: MOVE_CAUSES.OPEN_EXECUTOR, to: "wf:a.json", at: 1, detail: "x".repeat(500) });
  assert.equal(p.last().detail.length, 200);
  // Non-strings are dropped rather than coerced — "[object Object]" in a diagnostic is
  // noise that reads like data.
  p.record({ cause: MOVE_CAUSES.OPEN_EXECUTOR, to: "wf:b.json", at: 2, detail: { a: 1 } });
  assert.equal(p.last().detail, null);
});

test("#968 SOURCE: this module decides nothing about whether a command may run", () => {
  // The property that makes this safe to ship while the entry route is unknown. If a future
  // edit makes a refusal or a fence consult it, that is a trust change and must be argued on
  // its own terms — not inherited from a diagnostic.
  const src = readFileSync(new URL("../../web/js/lib/active-workflow-provenance.js", import.meta.url), "utf8");
  assert.match(src, /DIAGNOSTIC ONLY/);

  // Tested as a SHAPE, not by banning words — an earlier version of this assertion failed on
  // the word "refusal" inside a comment describing where the string is displayed, which
  // would have pushed the prose to be less clear to satisfy a test.
  const exported = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ["MOVE_CAUSES", "createActiveWorkflowProvenance"], "surface is a recorder and its causes");

  // A verdict returns a boolean. This module returns records and strings, so a bare
  // `return true` / `return false` appearing here is the shape of a decision creeping in.
  const body = src.slice(src.indexOf("export function createActiveWorkflowProvenance"));
  assert.ok(!/\breturn (?:true|false)\b/.test(body), "no boolean verdict is returned");
});
