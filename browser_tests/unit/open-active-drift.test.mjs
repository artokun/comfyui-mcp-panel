// panel#887 — `panel_open_workflow` reported:
//
//   workflow_open RAN and the canvas IS bound to VOICEvideo_LTX23_SAFE_TEST ...
//   You are NOT on the wrong workflow.
//
// and `panel_list_workflows`, called immediately afterwards, reported a DIFFERENT
// workflow active. The reporter names the sharp end of it: a Save-As on that state
// writes the wrong canvas.
//
// THE DEFECT IS NOT IN THE VERDICT. `resolveOpenRebindVerdict` is sound —
// CONTENT_UNVERIFIED requires instance AND marker AND identity, each compared
// against `true`, so an unreadable observation counts as not-proven. Nothing there
// admits a wrong canvas.
//
// It is a TENSE defect. All four proofs are captured in one synchronous window
// straight after `await app.loadGraphData(...)`, which is the correct place to take
// them — it is the only moment this attempt's single-use marker is known to be on
// the root. But three of those proofs are about the ROOT, which nothing else
// touches, while `instanceStillTarget` is about the ACTIVE POINTER, which is
// frontend state that keeps moving. Re-opening an already-open MODIFIED workflow —
// the reporter's exact case — lets ComfyUI's own tab machinery settle after the
// await returns. The disclosure then asserts that one past observation in the
// PRESENT tense ("X IS the active one"), so the sentence is true when measured and
// false when read.
//
// THE FIX re-earns the reassurance at composition time instead of inheriting it,
// and fails closed in BOTH directions: drift is only claimed when it is observed,
// and reassurance is only given when it is re-proven. An unreadable pointer gets
// neither — the rule this repo already applies to every other proof-of-sameness
// oracle: unproven degrades to unknown, never to the negative.
//
// WHY THE DECISION IS A PURE EXPORTED FUNCTION. The wording branches on it, and an
// assertion on message TEXT cannot tell this logic from its own inversion — two
// earlier fences in this repo shipped with tests that survived exactly that
// mutation. These tests drive the real functions and assert on OUTCOMES.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OPEN_ACTIVE_DRIFT,
  OPEN_REBIND_STATUS,
  openActiveDriftVerdict,
  resolveOpenRebindVerdict,
  describeOpenRebindOutcome,
} from "../../web/js/lib/graph-binding.js";

// ---------------------------------------------------------------------------
// 1. The decision itself.
// ---------------------------------------------------------------------------

test("#887 still the target on re-read ⇒ held", () => {
  assert.equal(
    openActiveDriftVerdict({ instanceProvenAtLoad: true, activeStillTargetNow: true }),
    OPEN_ACTIVE_DRIFT.HELD,
  );
});

test("#887 something else active on re-read ⇒ drifted", () => {
  assert.equal(
    openActiveDriftVerdict({ instanceProvenAtLoad: true, activeStillTargetNow: false }),
    OPEN_ACTIVE_DRIFT.DRIFTED,
  );
});

test("#887 an unreadable re-read is NOT drift and NOT reassurance", () => {
  // The whole point of the tri-state. Folding null into `false` would invent a
  // wrong-canvas warning the panel never observed; folding it into `true` restores
  // the bug. Both are wrong, so it gets its own answer.
  for (const unreadable of [null, undefined]) {
    assert.equal(
      openActiveDriftVerdict({ instanceProvenAtLoad: true, activeStillTargetNow: unreadable }),
      OPEN_ACTIVE_DRIFT.UNREADABLE,
    );
  }
});

test("#887 a non-boolean re-read is treated as unreadable, never as proof", () => {
  // Defensive for the same reason every proof here compares against `true`
  // explicitly: a truthy non-boolean must not be able to buy a present-tense claim.
  for (const junk of ["true", 1, {}, []]) {
    assert.equal(
      openActiveDriftVerdict({ instanceProvenAtLoad: true, activeStillTargetNow: junk }),
      OPEN_ACTIVE_DRIFT.UNREADABLE,
    );
  }
});

test("#887 an instance never proven at load time keeps its existing wording", () => {
  // This fix must not weaken the already-honest branch: when the instance was never
  // proven, the disclosure already says the panel could not confirm which workflow
  // is active, and that stays the answer regardless of what the re-read says.
  for (const now of [true, false, null]) {
    assert.equal(
      openActiveDriftVerdict({ instanceProvenAtLoad: false, activeStillTargetNow: now }),
      OPEN_ACTIVE_DRIFT.NOT_PROVEN,
    );
  }
});

test("#887 the decision defaults closed when called with nothing", () => {
  assert.equal(openActiveDriftVerdict(), OPEN_ACTIVE_DRIFT.NOT_PROVEN);
  assert.equal(openActiveDriftVerdict({}), OPEN_ACTIVE_DRIFT.NOT_PROVEN);
});

// ---------------------------------------------------------------------------
// 2. The message, driven end-to-end through the real verdict.
// ---------------------------------------------------------------------------

const contentUnverified = () =>
  resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });

const describe = (activeStillTargetNow, extra = {}) =>
  describeOpenRebindOutcome(contentUnverified(), {
    targetLabel: "TARGET_WF",
    activeLabel: "TARGET_WF",
    activeStillTargetNow,
    activeNowLabel: "OTHER_WF",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: null,
    ...extra,
  });

test("#887 the verdict is unchanged — this fix touches disclosure only", () => {
  // Guards the blast radius: the fence still refuses exactly what it refused.
  assert.equal(contentUnverified().status, OPEN_REBIND_STATUS.CONTENT_UNVERIFIED);
  assert.equal(contentUnverified().bindingProven, true);
});

test("#887 REGRESSION: a drifted pointer no longer says the target is active", () => {
  const text = describe(false);
  assert.doesNotMatch(text, /You are NOT on the wrong workflow/);
  assert.doesNotMatch(text, /TARGET_WF IS the active one/);
  assert.doesNotMatch(text, /You are on the right workflow/);
});

test("#887 a drifted pointer NAMES what is active and warns before a save", () => {
  const text = describe(false);
  assert.match(text, /OTHER_WF is active NOW, not TARGET_WF/);
  assert.match(text, /NOT the one a save would write/);
  assert.match(text, /panel_list_workflows/);
});

test("#887 a re-proven pointer still gets its reassurance — no false alarm", () => {
  // The other half of failing closed. If drift were assumed whenever it was not
  // disproven, every healthy open would gain a scary warning, which is the
  // false-positive this repo has fixed twice (#696, #825).
  const text = describe(true);
  assert.match(text, /You are NOT on the wrong workflow: TARGET_WF IS the active one/);
  assert.doesNotMatch(text, /is active NOW, not/);
});

test("#887 an unreadable pointer asserts NEITHER direction", () => {
  const text = describe(null);
  assert.doesNotMatch(text, /TARGET_WF IS the active one/, "does not reassure");
  assert.doesNotMatch(text, /OTHER_WF is active NOW/, "does not invent drift");
  assert.match(text, /could not be re-read/);
  assert.match(text, /panel_list_workflows/);
});

test("#887 drift is retracted on the nodes-intact branches too, not just the general one", () => {
  // CONTENT_UNVERIFIED has three wordings; the reassurance had to be removed from
  // ALL of them. An earlier cut fixed only the sentence quoted in the report, which
  // left the two friendlier branches — the ones a healthy-looking open actually
  // takes — still asserting the stale claim.
  const nodesIntact = (valuesMatched) =>
    describeOpenRebindOutcome(contentUnverified(), {
      targetLabel: "TARGET_WF",
      activeStillTargetNow: false,
      activeNowLabel: "OTHER_WF",
      contentComparable: true,
      contentSurfaces: ["nodes"],
      contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: valuesMatched },
    });
  for (const valuesMatched of [true, false]) {
    const text = nodesIntact(valuesMatched);
    assert.doesNotMatch(text, /You are on the right workflow/, `values-matched=${valuesMatched}`);
    assert.match(text, /OTHER_WF is active NOW, not TARGET_WF/, `values-matched=${valuesMatched}`);
  }
});

test("#887 the fence-refresh note survives every drift branch", () => {
  // #702's recovery instruction is appended after the reassurance slot. Rewriting
  // that slot must not drop it, or a drifted open loses the one cheap call that
  // clears the fence.
  for (const now of [true, false, null]) {
    assert.match(describe(now), /NO fence refresh/, `re-read=${String(now)}`);
  }
});

test("#887 an UNPROVEN open is untouched by this change", () => {
  const unproven = resolveOpenRebindVerdict({
    instanceStillTarget: false,
    markerMatches: true,
    identityMatches: true,
    contentMatches: true,
  });
  const text = describeOpenRebindOutcome(unproven, {
    targetLabel: "TARGET_WF",
    activeStillTargetNow: false,
    activeNowLabel: "OTHER_WF",
  });
  assert.match(text, /could not prove that the active canvas was rebound/);
  assert.match(text, /could not confirm which workflow is active/);
});

// ---------------------------------------------------------------------------
// 3. The WIRING. The helper being right is worth nothing if the call site
//    hands it the stale observation — which is the bug itself.
// ---------------------------------------------------------------------------

const panelSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

test("#887 WIRING: the call site RE-READS the pointer instead of reusing activeNow", () => {
  // The mutation this catches is `activeStillTargetNow: instanceStillTarget` — which
  // type-checks, reads plausibly, passes every behavioural test above, and restores
  // the bug exactly. Only the call site can rule it out.
  assert.match(
    panelSrc,
    /const activeAtCompose = activeWorkflowRef\(\);/,
    "a second, later read of the active pointer",
  );
  assert.match(
    panelSrc,
    /const activeStillTargetNow = activeAtCompose \? sameWorkflowObject\(activeAtCompose, target\) : null;/,
    "compared against the target, with an unreadable pointer passed through as null",
  );
  // Asserted as a boolean, not `assert.match` on the whole file: a failure there
  // dumps 1.4MB of source into the report and buries what actually broke.
  assert.ok(
    /^\s*activeStillTargetNow,\s*$/m.test(panelSrc),
    "the re-read is actually handed to the disclosure as `activeStillTargetNow`",
  );
  assert.ok(
    /^\s*activeNowLabel: activeAtCompose$/m.test(panelSrc),
    "and the label naming what IS active comes from the same re-read",
  );
});

test("#887 WIRING: the re-read happens AFTER the load-window observation", () => {
  // Ordering is the whole fix. A re-read hoisted above the original observation
  // would be the same instant and prove nothing.
  const atLoad = panelSrc.indexOf("const instanceStillTarget = sameWorkflowObject(activeNow, target);");
  const atCompose = panelSrc.indexOf("const activeAtCompose = activeWorkflowRef();");
  assert.ok(atLoad > 0 && atCompose > 0, "both reads are present");
  assert.ok(atCompose > atLoad, "the re-read comes later in the flow");
});
