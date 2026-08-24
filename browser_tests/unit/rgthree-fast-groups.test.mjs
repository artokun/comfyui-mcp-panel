/**
 * #983 — a write to rgthree's Fast Groups Muter toggle row is refused, because it cannot land.
 *
 * Established from the pack's own source (rgthree-comfy `src_web/comfyui/`), not from the
 * report: `BaseFastGroupsModeChanger` declares `serialize_widgets = false` (so the value never
 * reaches the workflow), the node's refresh loop overwrites `widget.toggled` from
 * `group.rgthree_hasAnyActiveNode` (so it is a readout), and only the widget's own `toggle()`
 * changes anything because it also calls `doModeChange()` (so a raw assignment does nothing).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRgthreeFastGroupsWrite,
  rgthreeFastGroupsRefusal,
  RGTHREE_TOGGLE_WIDGET,
} from "../../web/js/lib/rgthree-fast-groups.js";

const BYPASSER = "Fast Groups Bypasser (rgthree)";
const MUTER = "Fast Groups Muter (rgthree)";

test("#983: the Fast Groups Muter write is classified derived", () => {
  // The exact address from the report, including the composite sub-field.
  assert.equal(
    classifyRgthreeFastGroupsWrite({ type: MUTER }, "RGTHREE_TOGGLE_AND_NAV.toggled"),
    "derived",
  );
  // And the bare widget name, which addresses the same widget.
  assert.equal(classifyRgthreeFastGroupsWrite({ type: MUTER }, RGTHREE_TOGGLE_WIDGET), "derived");
});

test("#983: the Muter refusal survives case-insensitive widget resolution", () => {
  assert.equal(
    classifyRgthreeFastGroupsWrite({ type: MUTER }, "rgthree_toggle_and_nav.toggled"),
    "derived",
  );
  assert.equal(
    classifyRgthreeFastGroupsWrite({ type: BYPASSER }, "rgthree_toggle_and_nav.toggled"),
    null,
  );
});

test("#2146: a Fast Groups Bypasser row remains a writable action control", () => {
  // Bypasser callbacks change linked node modes. They are transactional at the widget-write
  // boundary, so this existing refusal must not broaden to them.
  assert.equal(
    classifyRgthreeFastGroupsWrite({ type: BYPASSER }, "RGTHREE_TOGGLE_AND_NAV.toggled"),
    null,
  );
  assert.equal(classifyRgthreeFastGroupsWrite({ type: BYPASSER }, RGTHREE_TOGGLE_WIDGET), null);
});

test("#983: ANOTHER widget on the same node is NOT refused", () => {
  // Keyed on type AND widget name. The type alone would refuse a legitimate write to some
  // other widget these nodes carry or later gain.
  assert.equal(classifyRgthreeFastGroupsWrite({ type: BYPASSER }, "matchTitle"), null);
  assert.equal(classifyRgthreeFastGroupsWrite({ type: BYPASSER }, "matchColors"), null);
});

test("#983: the SAME widget name on an unrelated node is NOT refused", () => {
  // The widget name alone would refuse it anywhere the name is reused.
  assert.equal(classifyRgthreeFastGroupsWrite({ type: "KSampler" }, "RGTHREE_TOGGLE_AND_NAV.toggled"), null);
  assert.equal(classifyRgthreeFastGroupsWrite({ type: "SomeOtherPackNode" }, RGTHREE_TOGGLE_WIDGET), null);
});

test("#983: a name that merely STARTS with the widget name is not it", () => {
  // Splitting on the first dot must not turn a different widget into this one.
  assert.equal(classifyRgthreeFastGroupsWrite({ type: BYPASSER }, "RGTHREE_TOGGLE_AND_NAV_EXTRA"), null);
  assert.equal(classifyRgthreeFastGroupsWrite({ type: BYPASSER }, "prefix_RGTHREE_TOGGLE_AND_NAV"), null);
});

test("#983: malformed input never throws and never classifies", () => {
  for (const node of [null, undefined, {}, { type: 42 }, "nope"]) {
    assert.equal(classifyRgthreeFastGroupsWrite(node, "RGTHREE_TOGGLE_AND_NAV.toggled"), null);
  }
  for (const w of [null, undefined, 42, {}]) {
    assert.equal(classifyRgthreeFastGroupsWrite({ type: BYPASSER }, w), null);
  }
});

test("#983: the refusal says what it is, why it cannot land, and what to do", () => {
  const msg = rgthreeFastGroupsRefusal("RGTHREE_TOGGLE_AND_NAV.toggled", 12, BYPASSER);
  assert.match(msg, /DERIVED READOUT/, "names what the widget actually is");
  assert.match(msg, /serialize_widgets = false/, "cites the fact that makes persistence impossible");
  assert.match(msg, /reverts/, "explains the reported symptom");
  assert.match(msg, /Set the TARGET NODES' modes instead/, "gives the reporter's verified remedy");
  assert.match(msg, /per MATCHED GROUP/i, "warns that the name is ambiguous across groups");
  assert.match(msg, /node 12/, "names the node");
  assert.match(msg, new RegExp(BYPASSER.replace(/[()]/g, "\\$&")), "names the node type");
});
