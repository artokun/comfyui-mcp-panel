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

test("#968 an UNCLAIMED move asserts ignorance, not that the panel is innocent", () => {
  const p = createActiveWorkflowProvenance();
  p.record({ cause: MOVE_CAUSES.OPEN_EXECUTOR, from: "wf:a.json", to: "wf:b.json", at: 1, detail: "open_seq 2" });
  p.record({ cause: MOVE_CAUSES.UNKNOWN, from: "wf:b.json", to: "wf:c.json", at: 2 });

  const note = p.describeLast();
  // NOT "the panel did not make that move". Not every executor can claim — `workflow_new` is
  // reconstructed in isolation by #606/#708 — and one of #968's three reports entered the
  // desync through exactly that command. A false EXCLUSION on a reported entry path would
  // send the next investigator away from the panel at the moment it was responsible (codex).
  assert.match(note, /NO PANEL COMMAND CLAIMED IT/);
  assert.match(note, /does not prove the panel did not do it/);
  assert.match(note, /covers a panel_new_workflow/);
  assert.ok(!/the panel did not make that move/.test(note), "the false exclusion is gone");
  // "last seen as", not "from": observations are point-in-time, so adjacency was never
  // established (codex P2).
  assert.match(note, /to wf:c\.json \(last seen as wf:b\.json\)/);
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

test("#968 an unrecognized cause is recorded as UNKNOWN, not dropped and not trusted", () => {
  // Dropping it would hide a move; trusting it would let a future call site invent an
  // authority it does not have. The hunted case is precisely "a move nobody attributed".
  const p = createActiveWorkflowProvenance();
  for (const cause of ["something_new", "", null, undefined, 42, {}]) {
    p.record({ cause, to: "wf:x.json", at: 1 });
    assert.equal(p.last().cause, MOVE_CAUSES.UNKNOWN, String(cause));
  }
});

test("#968 a move with no destination records NOTHING", () => {
  // A half-entry is worse than no entry: `describeLast` would then report a move whose
  // target is unknown, which reads as information and is not.
  const p = createActiveWorkflowProvenance();
  for (const bad of [null, undefined, {}, { cause: MOVE_CAUSES.UNKNOWN }, { to: "" }, { to: 5 }, "x"]) {
    assert.equal(p.record(bad), null, JSON.stringify(bad) ?? "undefined");
  }
  assert.equal(p.last(), null);
});

test("#968 the log is bounded — a long session must not grow it forever", () => {
  const p = createActiveWorkflowProvenance({ cap: 3 });
  for (let i = 0; i < 10; i += 1) p.record({ cause: MOVE_CAUSES.UNKNOWN, to: `wf:${i}.json`, at: i });
  const h = p.history();
  assert.equal(h.length, 3);
  // Oldest-first eviction: the RECENT moves are the ones a stale binding is explained by.
  assert.deepEqual(h.map((e) => e.to), ["wf:7.json", "wf:8.json", "wf:9.json"]);
  assert.equal(p.last().to, "wf:9.json");
});

test("#968 history() hands out a COPY — a diagnostic a caller can edit can lie", () => {
  const p = createActiveWorkflowProvenance();
  p.record({ cause: MOVE_CAUSES.UNKNOWN, to: "wf:a.json", at: 1 });
  const h = p.history();
  h[0].to = "wf:tampered.json";
  h[0].cause = MOVE_CAUSES.OPEN_EXECUTOR;
  assert.equal(p.last().to, "wf:a.json");
  assert.equal(p.last().cause, MOVE_CAUSES.UNKNOWN);
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

test("#968 WIRED: the observer runs before the refusal, and the note reaches it", () => {
  // A recorder nothing calls is inert — the first attempt at this shipped exactly that, so
  // these pin the wiring rather than the module.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

  // 1. Something drives the observer, and it does so BEFORE the mismatch is reported.
  const obs = src.indexOf("noteActiveWorkflowMove();");
  assert.ok(obs > 0, "the observer is called");
  // Compared LOCALLY, not by whole-file index: `noteWorkflowInstanceMismatch` has an earlier
  // occurrence of its own, and an index comparison against that one passes for the wrong
  // reason. Assert the two sit together on the refusal path instead.
  const near = src.slice(obs, obs + 400);
  assert.match(near, /noteWorkflowInstanceMismatch\(\);/, "observed immediately before the refusal is composed");

  // 2. NOT beside onCommandReceived: #508 pins that callback being alone in its own try, so
  //    a host callback cannot suppress a reply. Sharing that try would weaken it.
  const boundary = src.indexOf("onCommandReceived?.();");
  assert.ok(Math.abs(boundary - obs) > 200, "the observer does not share the onCommandReceived try");

  // 3. The refusal a caller actually sees is given the line.
  assert.match(src, /movedNote: activeWorkflowMoves\.describeLast\(\),/);

  // 4. The pure helper's own call site is UNCHANGED — #1019 pins its three-argument shape,
  //    and it is rebuilt with `new Function`, where a module global does not exist.
  assert.match(
    src,
    /workflowInstanceMismatchMessage\(\{ commandUuid, activeUuid, activeIsUnsaved \}\)/,
    "the fence helper still calls it with exactly three arguments",
  );
});

test("#968 WIRED: the message stays PURE and single-line", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // Single line, because namedFunctionSource extracts this function by name and a multi-line
  // parameter list makes it stop at the PARAMETER brace instead of the body's — which is how
  // an earlier attempt broke 13 tests without touching their subject.
  assert.match(
    src,
    /function workflowInstanceMismatchMessage\(\{ commandUuid, activeUuid, activeIsUnsaved = null, movedNote = null \} = \{\}\) \{/,
  );
  // And it reads only its parameters: a module global here is unreachable under `new Function`.
  // Extracted with the brace-balanced reader below rather than a hand-rolled slice — the
  // slice this replaces depended on a literal "\r\n}" and on a local's name, and broke when
  // neither had changed, which is a test failing for a reason unrelated to its subject.
  const body = namedFunctionSource(src, "workflowInstanceMismatchMessage");
  assert.ok(body, "the message function is extractable");
  assert.ok(!/activeWorkflowMoves/.test(body), "the message never reaches for the recorder");
});

/** Same extractor the other suites use — brace-balanced, so a destructured parameter list
 *  cannot make it stop at the parameter brace (the trap that broke an earlier attempt). */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  // `") {"`, not `"{"`. With a DESTRUCTURED parameter list the first `{` belongs to the
  // parameters, so balancing from there ends at the parameter object's close and returns a
  // truncated function that fails to parse. That is the third time this trap has bitten this
  // file today; the copies in bridge-route/open-outcome still use the naive form and work
  // only because their subjects take positional parameters.
  const open = src.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const buildMismatchMessage = () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const fn = namedFunctionSource(src, "workflowInstanceMismatchMessage");
  assert.ok(fn, "workflowInstanceMismatchMessage not found");
  return new Function(`${fn}; return workflowInstanceMismatchMessage;`)();
};

test("#968 the note is APPENDED to the refusal, never substituted for it", () => {
  const msg = buildMismatchMessage();
  const args = { commandUuid: "aaaa-1111", activeUuid: "bbbb-2222" };
  const plain = msg(args);
  const withNote = msg({ ...args, movedNote: "MOVED-BY-SOMETHING-ELSE" });

  // Everything the refusal already said survives — the note explains, it does not replace.
  assert.ok(withNote.startsWith(plain), "the original refusal is still the whole first part");
  assert.match(withNote, /MOVED-BY-SOMETHING-ELSE$/);
  assert.match(withNote, /\n\nMOVED-BY-SOMETHING-ELSE$/, "separated, so it reads as its own statement");
  // Both identities are still reported.
  assert.match(withNote, /aaaa-1111/);
  assert.match(withNote, /bbbb-2222/);
});

test("#968 no note, or an empty one, changes the refusal not at all", () => {
  const msg = buildMismatchMessage();
  const args = { commandUuid: "aaaa-1111", activeUuid: "bbbb-2222" };
  const plain = msg(args);
  for (const empty of [null, undefined, "", "   ", 42, {}]) {
    assert.equal(msg({ ...args, movedNote: empty }), plain, JSON.stringify(empty) ?? "undefined");
  }
});
