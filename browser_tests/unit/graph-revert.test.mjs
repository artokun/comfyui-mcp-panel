// Unit tests for per-turn revert snapshot selection (web/js/lib/graph-revert.js).
//
// Regression coverage for #327: /revert restored graphSnapshots[last]
// unconditionally, so after a turn cleared/replaced the graph — and the next
// message snapshotted that already-changed graph — the newest snapshot equaled
// the current canvas and reverting to it recovered nothing (silent no-op).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tr } from "../../web/js/lib/i18n.js";

import {
  pickRevertSnapshot,
  describeRevertOutcome,
  revertDidRestore,
  REVERT_STATUS,
} from "../../web/js/lib/graph-revert.js";

const snap = (data) => ({ mid: null, ts: 0, data });
// Distinct serialized-graph shapes standing in for rootGraph.serialize() output.
const GRAPH_A = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
const GRAPH_B = { nodes: [{ id: 2, type: "SaveImage" }], links: [] };
const EMPTY = { nodes: [], links: [] };

test("skips an identical latest snapshot, reverts to the prior different one (#327)", () => {
  // A (non-empty) → turn cleared it → next message snapshotted EMPTY.
  const ring = [snap(GRAPH_A), snap(EMPTY)];
  // Current canvas is EMPTY, equal to the newest snapshot.
  const chosen = pickRevertSnapshot(ring, EMPTY);
  assert.equal(chosen.data, GRAPH_A, "reverts to the earlier non-empty graph, not the no-op latest");
});

test("returns null when EVERY snapshot equals the current graph (nothing to revert)", () => {
  const ring = [snap(GRAPH_A), snap(GRAPH_A)];
  assert.equal(pickRevertSnapshot(ring, GRAPH_A), null);
});

test("returns the newest snapshot when it already differs from current", () => {
  const ring = [snap(GRAPH_A), snap(GRAPH_B)];
  // Current is something else again → newest (B) is a genuine prior state.
  assert.equal(pickRevertSnapshot(ring, EMPTY).data, GRAPH_B);
});

test("walks back past MULTIPLE identical snapshots to the first real difference", () => {
  const ring = [snap(GRAPH_A), snap(EMPTY), snap(EMPTY)];
  assert.equal(pickRevertSnapshot(ring, EMPTY).data, GRAPH_A);
});

test("empty / missing ring yields null", () => {
  assert.equal(pickRevertSnapshot([], GRAPH_A), null);
  assert.equal(pickRevertSnapshot(null, GRAPH_A), null);
  assert.equal(pickRevertSnapshot(undefined, GRAPH_A), null);
});

test("accepts a pre-stringified snapshot.data and compares canonically", () => {
  // Key order matches because both come from the same serializer; equality holds.
  const ring = [snap(JSON.stringify(GRAPH_A)), snap(JSON.stringify(EMPTY))];
  // Current EMPTY (object) canonicalizes to the same string as the newest snap →
  // skip it, land on the stringified GRAPH_A.
  assert.equal(pickRevertSnapshot(ring, EMPTY), ring[0]);
  // And a differing current still selects the newest.
  assert.equal(pickRevertSnapshot(ring, GRAPH_B).data, JSON.stringify(EMPTY));
});

test("tolerates holes in the ring without throwing", () => {
  const ring = [snap(GRAPH_A), null, snap(EMPTY)];
  assert.equal(pickRevertSnapshot(ring, EMPTY).data, GRAPH_A);
});

test("treats key-reordered but structurally-equal graphs as identical (no false revert)", () => {
  // Same graph, different object key insertion order — must canonicalize equal so
  // the newest snapshot is recognized as a no-op and skipped, not restored.
  const newest = { nodes: [{ id: 1, type: "KSampler" }], links: [], version: 0.4 };
  const currentReordered = { version: 0.4, links: [], nodes: [{ type: "KSampler", id: 1 }] };
  const ring = [snap(GRAPH_A), snap(newest)];
  // Current equals `newest` up to key order → skip it, land on the real prior graph.
  assert.equal(pickRevertSnapshot(ring, currentReordered).data, GRAPH_A);
  // And when the ONLY snapshot equals current (reordered), nothing to revert.
  assert.equal(pickRevertSnapshot([snap(newest)], currentReordered), null);
});

// ---------------------------------------------------------------------------
// Revert OUTCOMES (#604 follow-up) — a refusal must never render as "nothing"
// ---------------------------------------------------------------------------
//
// The restore path answered with `snapshot | null`, and all three consumers
// (/revert, double-Esc rewind, the per-message rollback modal) rendered `null`
// as "no snapshot". That collapsed a REFUSAL into the one answer that ends the
// user's attempt — and the refusal fires at the worst possible moment: a backend
// restart leaves the canvas on a graph the panel cannot identify, getGraphCtx
// refuses [canvas-root-divergence] before loadGraphData, and the user is told
// there was never a snapshot, with the save/export/reload remedy dropped.
//
// FAIL-before / PASS-after: with the old `null` collapse there is no outcome to
// describe, and describeRevertOutcome / revertDidRestore do not exist.

const DIVERGENCE =
  "[canvas-root-divergence] The canvas you are looking at (31 node(s)) and the panel's bound " +
  "root graph (0 node(s)) are two DIFFERENT graphs, so this command was NOT applied — save or " +
  "export the canvas you want to keep, then reload the ComfyUI page.";

const WORDING = {
  action: "revert",
  restoredText: "Reverted the canvas to before your last message.",
  noneText: "Nothing to revert — no graph snapshot captured in this session yet.",
};

test("#604: a REFUSED restore never renders as 'nothing to revert', and keeps the remedy", () => {
  const line = describeRevertOutcome({ status: "refused", reason: DIVERGENCE }, WORDING);

  assert.doesNotMatch(
    line,
    /Nothing to revert/,
    "the exact defect: a snapshot EXISTS and was refused — claiming none ends the recovery attempt",
  );
  assert.match(line, /Could not revert/, "say what did not happen");
  // Precisely "no graph edits were applied", NOT "nothing was changed": getGraphCtx
  // may legitimately have reconciled the VIEW first (the proven-content-free
  // stranded-canvas repaint) before the binding assert refused. Retrying is safe
  // because no workflow data was touched — but a blanket "nothing changed" would
  // overstate a call whose view effect is real.
  assert.match(line, /no graph edits were applied/, "the safe-to-retry fact, stated exactly");
  assert.doesNotMatch(line, /nothing was changed/, "do not overclaim a side-effect-free path");
  // Nor may it assert a snapshot EXISTS: the no-active-workflow branches refuse
  // without ever consulting the ring, so "the snapshot is still here" would
  // fabricate one for exactly the caller least able to check.
  assert.doesNotMatch(line, /snapshot is still here/, "a refusal must not claim a snapshot exists");
  assert.match(line, /canvas-root-divergence/, "carry the reason code the panel refused with");
  assert.match(line, /reload the ComfyUI page/, "and the remedy it was carrying — that is the point");
});

test("#604: a refusal raised before any snapshot was selected must not claim one exists", () => {
  // revertGraphToLastSnapshot / revertGraphSnapshotByMid refuse on an unreadable
  // active workflow WITHOUT consulting the ring — which may well be empty.
  const line = describeRevertOutcome(
    {
      status: "refused",
      reason: "The panel cannot read the active workflow right now, so it cannot tell which snapshots belong to this canvas. Retry in a moment.",
    },
    WORDING,
  );
  assert.doesNotMatch(line, /snapshot is still here/);
  assert.match(line, /nothing was loaded/, "what IS true of every refusal");
  assert.match(line, /cannot read the active workflow/, "with the specifics carried by the reason");
});

test("#604: a FAILED restore is DISCLOSED, not reported as nothing-happened", () => {
  // loadGraphData was already called, so the canvas may be partly changed. Saying
  // "nothing to revert" here would invite a retry on top of a half-applied load.
  const line = describeRevertOutcome({ status: "failed", reason: "boom" }, WORDING);
  assert.doesNotMatch(line, /Nothing to revert/);
  assert.match(line, /RAN but the panel could not confirm/, "the action happened — disclose, never refuse after the fact");
  assert.match(line, /canvas may have changed/);
  assert.match(line, /boom/);
});

test("a genuine NONE still says nothing-to-revert, and a restore still reports success", () => {
  assert.equal(describeRevertOutcome({ status: "none" }, WORDING), WORDING.noneText);
  assert.equal(describeRevertOutcome({ status: "restored", snapshot: {} }, WORDING), WORDING.restoredText);
});

test("an UNRECOGNIZED outcome is indeterminate — it must not become a definite 'no snapshot'", () => {
  // Only a broken producer can get here, and the honest answer is "I don't know",
  // not the caller's "none" wording: rendering an unknown as "no graph snapshot
  // captured" is the same could-not-determine-becomes-a-verdict defect this whole
  // vocabulary exists to remove, one level up.
  for (const outcome of [null, undefined, {}, { status: "who-knows" }, "restored"]) {
    const line = describeRevertOutcome(outcome, WORDING);
    assert.notEqual(line, WORDING.noneText, `${JSON.stringify(outcome)} must not render as "none"`);
    assert.notEqual(line, WORDING.restoredText, `${JSON.stringify(outcome)} must not render as success`);
    assert.match(line, /Could not tell whether the revert happened/);
    assert.match(line, /check the canvas/);
  }
});

test("a refusal with no reason still refuses — it never degrades into 'nothing to revert'", () => {
  const line = describeRevertOutcome({ status: "refused" }, WORDING);
  assert.doesNotMatch(line, /Nothing to revert/);
  assert.match(line, /No reason was reported/, "an unexplained refusal is still a refusal, stated as one");
});

test("revertDidRestore: only a RESTORED outcome counts as success", () => {
  // Every outcome object is truthy, so a caller's bare `if (outcome)` would read a
  // refusal as a successful revert — which is how the rewind path would otherwise
  // have claimed "canvas reverted" over a refused one.
  assert.equal(revertDidRestore({ status: "restored", snapshot: {} }), true);
  for (const status of ["none", "refused", "failed", undefined]) {
    assert.equal(revertDidRestore({ status }), false, `${status} is not a restore`);
  }
  assert.equal(revertDidRestore(null), false);
});

test("REVERT_STATUS names exactly the four distinguishable answers", () => {
  assert.deepEqual(Object.values(REVERT_STATUS).sort(), ["failed", "none", "refused", "restored"]);
});

// The suppression was in the SHARED path, so the fix has to be there too — not at
// /revert. These bind all three entry points to it: none may re-derive its own
// verdict from a truthiness test, which is how the refusal was being lost.
test("#604 wiring: /revert, double-Esc rewind and per-message rollback all render via the shared path", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  // Every producer answers with an OUTCOME. A bare `return null` on these paths is
  // what collapsed "refused" into "no snapshot".
  for (const producer of ["restoreSnapshot", "revertGraphToLastSnapshot", "revertGraphSnapshotByMid"]) {
    const start = src.indexOf(`function ${producer}(`);
    assert.notEqual(start, -1, `${producer} must exist`);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.doesNotMatch(
      body,
      /return null;/,
      `${producer} must return a status outcome, never a bare null the caller reads as "no snapshot"`,
    );
    assert.match(body, /status: "none"/, `${producer} must say "none" explicitly when it means none`);
  }

  // Each consumer renders through describeRevertOutcome, so a refusal cannot be
  // dropped by one of them wording its own message.
  const consumers = [
    ['cmd: "/revert"', "restoredText"],
    ["function rewindLastTurn()", "restoredText"],
    ["const wantCode = ", "restoredText"],
  ];
  for (const [needle, expected] of consumers) {
    const at = src.indexOf(needle);
    assert.notEqual(at, -1, `${needle} must exist`);
    const region = src.slice(at, at + 2400);
    assert.match(
      region,
      /describeRevertOutcome\(/,
      `${needle} must render the outcome through the shared describer`,
    );
    assert.ok(region.includes(expected));
  }

  // The rewind path in particular must not treat the (always-truthy) outcome
  // object as success.
  const rewindAt = src.indexOf("function rewindLastTurn()");
  const rewind = src.slice(rewindAt, src.indexOf("\n  }\n", rewindAt));
  assert.match(
    rewind,
    /revertDidRestore\(outcome\)/,
    "an outcome object is always truthy — success must be tested explicitly",
  );
});

// ---------------------------------------------------------------------------
// The rollback modal, driven for real
// ---------------------------------------------------------------------------
//
// The canvas rollback is an async load, so this modal outlives a tick: the
// primary action can be clicked twice, and the user can Cancel while the restore
// is in flight. Both were reachable ways to rewind the conversation and RESEND
// the user's message when they had not asked for it. Source-scanning the handler
// cannot show that, so the real function is extracted and driven over a minimal
// DOM.
//
// SCOPE, stated honestly: this exercises the handler's LOGIC, not the browser. The
// fake `fire()` calls registered listeners directly, so it models neither real
// event dispatch/bubbling, nor hit-testing, nor the browser's own suppression of
// clicks on a disabled button. A wiring mistake that stops the overlay receiving
// mousedown at all would not be caught here — only in a live browser.

const PANEL_SRC = () =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");

/** Just enough DOM for openRollbackModal: element creation, class/text/value,
 *  append, listeners, remove, focus. Listeners are recorded so a test can click. */
function fakeDom() {
  const make = (tag) => {
    const el = {
      tag,
      children: [],
      listeners: new Map(),
      className: "",
      textContent: "",
      value: "",
      checked: false,
      disabled: false,
      removed: false,
      append(...kids) {
        this.children.push(...kids);
      },
      appendChild(kid) {
        this.children.push(kid);
        return kid;
      },
      addEventListener(ev, fn) {
        if (!this.listeners.has(ev)) this.listeners.set(ev, []);
        this.listeners.get(ev).push(fn);
      },
      remove() {
        this.removed = true;
      },
      focus() {},
      fire(ev, arg) {
        return Promise.all((this.listeners.get(ev) ?? []).map((fn) => fn(arg)));
      },
    };
    return el;
  };
  return {
    createElement: make,
    createTextNode: (text) => {
      const node = make("#text");
      node.textContent = text;
      return node;
    },
  };
}

/** Find the descendant whose textContent matches, breadth-first. */
function findByText(el, text) {
  const queue = [el];
  while (queue.length) {
    const node = queue.shift();
    if (node?.textContent === text) return node;
    queue.push(...(node?.children ?? []));
  }
  return null;
}

/** The REAL openRollbackModal over a fake DOM, with every collaborator recorded. */
function buildRollbackModal({ revert }) {
  const src = PANEL_SRC();
  const start = src.indexOf("  function openRollbackModal({ mid, text, anchor }) {");
  assert.notEqual(start, -1, "openRollbackModal must exist");
  const end = src.indexOf("  function drawQrToCanvas(", start);
  assert.ok(end > start, "could not bound openRollbackModal");
  const source = src.slice(start, end);

  const calls = { systems: [], frames: [], composer: [], submits: 0 };
  const root = fakeDom().createElement("div");
  const openRollbackModal = new Function(
    "document",
    "root",
    "client",
    "appendSystem",
    "setComposerValue",
    "form",
    "revertGraphSnapshotByMid",
    "describeRevertOutcome",
    "revertDidRestore",
    "setTimeout",
    // The panel's own translator, passed in like every other collaborator. Deliberately the
    // REAL `tr` rather than a stub: with no catalog loaded it returns the English fallback,
    // so the button-text assertions below still read as English and still exercise the
    // production lookup path instead of a test-only shim that could diverge from it.
    "tr",
    `${source}\nreturn openRollbackModal;`,
  )(
    fakeDom(),
    root,
    { sendFrame: (f) => calls.frames.push(f) },
    (msg) => calls.systems.push(msg),
    (v) => calls.composer.push(v),
    {
      requestSubmit() {
        calls.submits += 1;
      },
    },
    revert,
    describeRevertOutcome,
    revertDidRestore,
    () => {},
    tr,
  );

  openRollbackModal({ mid: "m1", text: "do the thing", anchor: "a1" });
  const overlay = root.children[0];
  const go = findByText(overlay, "Roll back & resend");
  const cancel = findByText(overlay, "Cancel");
  assert.ok(go && cancel, "the modal must render both buttons");
  return { calls, overlay, go, cancel };
}

test("#604: cancelling DURING an in-flight rollback must not rewind or resend", () => {
  // The reachable repro: choose Code+conversation (the default), click "Roll back &
  // resend", then Cancel while the restore is still awaiting. The user backed out —
  // resending their message afterwards is acting on their behalf.
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, go, cancel } = buildRollbackModal({ revert: () => pending });

  const done = go.fire("click");
  cancel.fire("click"); // user backs out while the load is in flight
  release({ status: "restored", snapshot: {} });

  return done.then(() => {
    assert.deepEqual(calls.frames, [], "a cancelled rollback must NOT rewind the conversation");
    assert.equal(calls.submits, 0, "and must NOT resend the user's message");
    assert.ok(
      calls.systems.some((m) => /Cancelled/.test(m)),
      "say that it stopped, rather than silently doing nothing",
    );
    assert.deepEqual(calls.composer, ["do the thing"], "the edit stays with the user");
  });
});

test("#604: BACKDROP dismissal during an in-flight rollback stops the rewind and resend too", () => {
  // Cancel and the backdrop are two separate wirings; covering only the button
  // would leave a deleted/mis-wired backdrop handler green while it silently
  // resends on the user's behalf.
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, overlay, go } = buildRollbackModal({ revert: () => pending });

  const done = go.fire("click");
  overlay.fire("mousedown", { target: overlay }); // click outside the modal body
  release({ status: "restored", snapshot: {} });

  return done.then(() => {
    assert.deepEqual(calls.frames, [], "a backdrop dismissal must NOT rewind the conversation");
    assert.equal(calls.submits, 0, "and must NOT resend the user's message");
    assert.ok(calls.systems.some((m) => /Cancelled/.test(m)));
  });
});

test("#604: a click INSIDE the modal body is not a dismissal", () => {
  // The backdrop handler fires for every mousedown on the overlay; only a hit on
  // the overlay ITSELF is a dismissal. Treating an inner click as one would abort
  // rollbacks the user never cancelled.
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, overlay, go } = buildRollbackModal({ revert: () => pending });
  // Assert the wiring EXISTS as well as its behaviour: without this the test would
  // also pass with the whole backdrop handler deleted (no handler ⇒ no dismissal
  // ⇒ the same expected rewind/resend).
  assert.equal(
    (overlay.listeners.get("mousedown") ?? []).length,
    1,
    "the overlay must have exactly one backdrop handler",
  );

  const done = go.fire("click");
  overlay.fire("mousedown", { target: { not: "the overlay" } });
  release({ status: "restored", snapshot: {} });

  return done.then(() => {
    assert.deepEqual(calls.frames, [{ type: "rewind", anchor: "a1" }], "this rollback was never cancelled");
    assert.equal(calls.submits, 1);
  });
});

test("#604: an uncancelled rollback still rewinds and resends (the modal is not simply disabled)", () => {
  const { calls, go } = buildRollbackModal({
    revert: async () => ({ status: "restored", snapshot: {} }),
  });
  return go.fire("click").then(() => {
    assert.deepEqual(calls.frames, [{ type: "rewind", anchor: "a1" }]);
    assert.equal(calls.submits, 1);
    assert.deepEqual(calls.composer, ["do the thing"]);
  });
});

test("#604: 'no snapshot for this message' also stops the resend — it is not proof the canvas is right", () => {
  // The 25-entry ring evicts, so rolling back an OLD message reports "canvas left
  // as-is" while the canvas actually carries every later turn's edits. Treating
  // that as permission to resend is the same unknown-as-verdict mistake one level
  // up, and it was the pre-existing behaviour.
  const { calls, go } = buildRollbackModal({ revert: async () => ({ status: "none" }) });
  return go.fire("click").then(() => {
    assert.deepEqual(calls.frames, [], "no rollback happened, so do not rewind the conversation");
    assert.equal(calls.submits, 0, "and do not resend against a canvas nobody verified");
    assert.ok(calls.systems.some((m) => /No graph snapshot for this message/.test(m)), "say what happened");
    assert.ok(calls.systems.some((m) => /Not resending/.test(m)), "and that it stopped short of resending");
    assert.deepEqual(calls.composer, ["do the thing"], "the edit stays with the user");
  });
});

test("#604: a REFUSED rollback stops the resend and hands the edit back", () => {
  const { calls, go } = buildRollbackModal({
    revert: async () => ({ status: "refused", reason: "[canvas-root-divergence] two different graphs" }),
  });
  return go.fire("click").then(() => {
    assert.deepEqual(calls.frames, [], "do not rewind the conversation over a canvas that was not rolled back");
    assert.equal(calls.submits, 0, "and do not resend against it — that is the destructive retry");
    assert.ok(calls.systems.some((m) => /canvas-root-divergence/.test(m)), "surface the refusal's reason");
    assert.ok(calls.systems.some((m) => /Not resending/.test(m)));
    assert.deepEqual(calls.composer, ["do the thing"]);
  });
});

test("#604: double-clicking the primary action starts ONE rollback and sends ONE message", () => {
  let restores = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, go } = buildRollbackModal({
    revert: () => {
      restores += 1;
      return pending;
    },
  });

  const first = go.fire("click");
  const second = go.fire("click"); // impatient double click
  release({ status: "restored", snapshot: {} });

  return Promise.all([first, second]).then(() => {
    assert.equal(restores, 1, "two restores would race and settle out of order");
    assert.equal(calls.frames.length, 1, "and both continuations would rewind the conversation");
    assert.equal(calls.submits, 1, "and resend the message twice");
    assert.equal(go.disabled, true, "the button is visibly disabled while it runs");
  });
});

test("#604 wiring: the rollback modal does NOT resend when the canvas was not rolled back", () => {
  // The user asked to roll the canvas back AND resend against it. Resending after a
  // refused or half-applied rollback aims the next turn at a graph they did not
  // choose — the destructive retry this cluster is about. Awaiting the load fixes
  // "still in flight"; it does not fix "did not happen".
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const at = src.indexOf('go.addEventListener("click", async () => {');
  assert.notEqual(at, -1, "the primary action handler must exist and be async");
  const handler = src.slice(at, src.indexOf("btnRow.append(cancel, go);", at));

  const gateAt = handler.indexOf("if (!revertDidRestore(outcome))");
  const rewindAt = handler.indexOf('type: "rewind"');
  const resendAt = handler.indexOf("form.requestSubmit()");
  assert.ok(gateAt !== -1, "the handler must decide whether the rollback actually happened");
  assert.ok(gateAt < rewindAt && gateAt < resendAt, "and decide BEFORE rewinding and resending");
  assert.match(
    handler.slice(gateAt),
    /if \(!revertDidRestore\(outcome\)\) \{[\s\S]*?return;/,
    "a rollback that is not PROVEN to have happened must stop the resend",
  );
  // "none" must NOT be an exemption: it means only that this message has no
  // snapshot (the ring evicts at 25), so the canvas may carry every later turn's
  // edits — an unknown state read as permission to resend.
  assert.doesNotMatch(
    handler.slice(gateAt, gateAt + 300),
    /status === "none"/,
    '"no snapshot for this message" is not proof the canvas is what the user asked for',
  );

  // The cancellation gate must sit BEFORE the rewind and the resend. (Its
  // behaviour is covered for real by the driven-modal tests above; what only a
  // source check can add is the ORDER, since a gate placed after the resend would
  // still satisfy a behavioural test that never cancels.)
  const cancelAt = handler.indexOf("if (cancelled)");
  assert.ok(cancelAt !== -1, "a cancellation during the await must be gated");
  assert.ok(cancelAt < rewindAt && cancelAt < resendAt, "and gated BEFORE rewinding and resending");
  assert.match(handler.slice(cancelAt, cancelAt + 400), /return;/, "and it must stop the handler");
});

/** The REAL rewindLastTurn over stubbed collaborators, so the reply it produces can
 *  be read rather than inferred from the source. */
function buildRewindLastTurn({ outcome, recalled }) {
  const src = PANEL_SRC();
  const start = src.indexOf("  async function rewindLastTurn() {");
  assert.notEqual(start, -1, "rewindLastTurn must exist");
  const end = src.indexOf("  function openRollbackModal(", start);
  assert.ok(end > start, "could not bound rewindLastTurn");

  const systems = [];
  // The REAL `tr`, not a stub. No catalog is loaded here, so every lookup returns its
  // English fallback — which is exactly what the assertions below read, and what every
  // locale renders when its catalog is missing the key. A stub returning the key would
  // have made these tests pass over a blanked message.
  const rewindLastTurn = new Function(
    "recallPrev",
    "input",
    "revertGraphToLastSnapshot",
    "revertDidRestore",
    "describeRevertOutcome",
    "appendSystem",
    "tr",
    `${src.slice(start, end)}\nreturn rewindLastTurn;`,
  )(
    () => recalled,
    { focus() {} },
    async () => outcome,
    revertDidRestore,
    describeRevertOutcome,
    (msg) => systems.push(msg),
    tr,
  );
  return { rewindLastTurn, systems };
}

test("#604: a rewind over an EVICTED ring must say the canvas was not restored", async () => {
  // The ring holds 25 and evicts, so an old turn's snapshot is simply gone. The
  // composer half still succeeds, and "Rewound your last turn; your message is back
  // in the composer to edit & resend" reads as a completed rewind — after which the
  // user resends against a graph that still holds the very edits they meant to undo.
  // Same unknown-canvas-as-permission-to-resend chain as the rollback modal.
  const { rewindLastTurn, systems } = buildRewindLastTurn({ outcome: { status: "none" }, recalled: true });
  await rewindLastTurn();

  const reply = systems.join("\n");
  assert.match(reply, /back in the composer/, "the composer half genuinely happened — still say so");
  assert.doesNotMatch(reply, /canvas reverted/, "but never claim the canvas half did");
  assert.match(reply, /canvas was NOT reverted/, "state the canvas half explicitly");
  assert.match(reply, /still holds that turn's edits/, "and what that means for a resend");
});

test("#604: a rewind with nothing at all to rewind still says so", async () => {
  const { rewindLastTurn, systems } = buildRewindLastTurn({ outcome: { status: "none" }, recalled: false });
  await rewindLastTurn();
  assert.match(systems.join("\n"), /Nothing to rewind yet/);
});

test("#604: a rewind over a REFUSED revert carries the refusal, not a rewound claim", async () => {
  const { rewindLastTurn, systems } = buildRewindLastTurn({
    outcome: { status: "refused", reason: "[canvas-root-divergence] two different graphs" },
    recalled: true,
  });
  await rewindLastTurn();
  const reply = systems.join("\n");
  assert.doesNotMatch(reply, /canvas reverted/);
  assert.match(reply, /canvas-root-divergence/, "the reason and its remedy must survive to the user");
});

test("#604: a successful rewind still reports the canvas revert once, with no correction", async () => {
  const { rewindLastTurn, systems } = buildRewindLastTurn({
    outcome: { status: "restored", snapshot: {} },
    recalled: true,
  });
  await rewindLastTurn();
  const reply = systems.join("\n");
  assert.match(reply, /canvas reverted/);
  assert.doesNotMatch(reply, /NOT reverted/, "a working rewind must not be followed by a warning");
  assert.equal(systems.length, 1, "and says it once");
});

test("#604: describeRevertOutcome will not let a caller SUPPRESS the none variant", async () => {
  // The mechanism-level half of the same defect: an entry point that passes empty
  // text words the variant away by omission, and a variant that renders as nothing
  // is indistinguishable from one that never fired.
  //
  // INVISIBLES count as empty. Notices render through textContent, so a zero-width
  // space is a perfectly good suppression that survives trim() — "technically
  // supplied text" that puts nothing on screen.
  // Escapes, never literal invisibles: a test that carries them is unreviewable
  // and an editor or copy/paste can silently change what it asserts.
  //
  // Each of these defeated an EARLIER version of the check, which is why the
  // filter is now an allowlist of meaning-bearing characters rather than a list
  // of invisible ones.
  const invisible = [
    "\u200b", // zero-width space - survives trim()
    "\ufeff", // byte-order mark
    "\u00ad", // soft hyphen
    "\u2060", // word joiner
    "\u200e\u200f", // bidi marks
    "\u202d\u202c", // bidi override + pop
    "\u2066", // LEFT-TO-RIGHT ISOLATE - outside the hand-listed ranges
    "\u2067",
    "\u2068",
    "\u2069", // POP DIRECTIONAL ISOLATE
    "\u2800", // BRAILLE PATTERN BLANK - a SYMBOL that draws nothing, so it
                // is neither whitespace nor Cf/Cc/Default_Ignorable
    "\u3164", // HANGUL FILLER - category Lo, a LETTER that draws nothing, so
                // a bare letter/digit allowlist admits it too
    "\u115f\u1160", // Hangul choseong/jungseong fillers, same shape
    "\uffa0", // halfwidth Hangul filler
    "\ufe0f", // variation selector
    "\u2028", // line separator
    "\u0000", // NUL - a control character renders as nothing too
    "-> ...", // punctuation only: not a statement of the verdict either
    " \u200b \ufeff \u2066 \u2800 ", // mixed with ordinary whitespace
  ];
  for (const noneText of ["", "   ", "\t\n", undefined, null, 42, {}, ...invisible]) {
    const line = describeRevertOutcome({ status: "none" }, { restoredText: "ok", noneText });
    assert.ok(line && line.trim(), `none must still be stated for noneText=${JSON.stringify(noneText)}`);
    assert.match(line, /canvas was NOT restored/);
  }
  // …while a caller whose wording merely CONTAINS an invisible is left alone.
  const worded = "No\u200bthing to revert.";
  assert.equal(describeRevertOutcome({ status: "none" }, { noneText: worded }), worded);
  // A caller's real wording is still honoured.
  assert.equal(
    describeRevertOutcome({ status: "none" }, { noneText: "Nothing to revert." }),
    "Nothing to revert.",
  );
  // RESTORED may be blank: a caller whose own summary states the restore has nothing
  // to add, and an unstated success misleads no one.
  assert.equal(describeRevertOutcome({ status: "restored" }, { restoredText: "", noneText: "n" }), "");
});

test("#604 wiring: async slash commands cannot leave a floating promise", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // /revert's run() is async now. Both entry points (the slash menu and typing the
  // command) must go through the normalizing runner rather than calling run()
  // bare, or a rejection surfaces as an unhandled promise from a sync UI handler.
  // The runner may pass the typed line as a second arg (`/record-skill name`); the
  // invariant is that run() is always wrapped in Promise.resolve(...).catch.
  assert.match(src, /function runSlashCommand\(entry(?:, raw)?\) \{[\s\S]*?Promise\.resolve\(entry\.run\([^)]*\)\)\.catch\(/);
  // POSITIVE assertions: forbidding the bare form alone would also pass if a call
  // site were deleted, or replaced with some other unguarded invocation.
  assert.match(src, /\n\s*runSlashCommand\(item\.ref(?:, item\.ref\.cmd)?\);/, "the slash menu must route through the runner");
  assert.match(src, /\n\s*runSlashCommand\(c(?:, text)?\);/, "so must the typed-command path");
  assert.doesNotMatch(src, /\n\s*item\.ref\.run\(\);/, "and neither may call run() bare");
  assert.doesNotMatch(src, /\n\s*c\.run\(\);/);
  assert.match(src, /rewindLastTurn\(\)\.catch\(/, "the double-Esc rewind is fire-and-forget with a catch");
});
