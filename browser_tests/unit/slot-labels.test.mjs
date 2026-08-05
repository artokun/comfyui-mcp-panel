/**
 * Unit tests for web/js/lib/slot-labels.js (#636) — run with `node --test`.
 *
 * Reported: a user renamed a subgraph node's promoted widgets to Filename / project? /
 * project. A screenshot confirmed the labels rendered. But panel_query_graph
 * (fields:'detail'), panel_get_subgraph and the boundary `rails` payload all kept
 * returning the underlying keys value / boolean / value_1 with no label anywhere, so
 * the agent told the user their renames had not stuck when they had.
 *
 * The correction is additive and strictly OBSERVED — which cuts both ways, and both
 * directions are pinned here:
 *   - a label the frontend DOES carry must be reported (the reported bug), and
 *   - a label must never be INVENTED. No label carried ⇒ no `label` key; a label equal
 *     to the name is not a rename and must not be emitted, or every unrenamed node
 *     would read as renamed and the field would carry no information at all.
 *
 * The programmatic NAME is never moved or replaced: it is the identity panel_set_widget
 * and panel_connect address, and the label is display-only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { displayLabel, boundaryInputLabel, widgetLabelMap } from "../../web/js/lib/slot-labels.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

test("#636: a renamed entry reports its display label", () => {
  assert.equal(displayLabel({ name: "value", label: "Filename" }), "Filename");
  assert.equal(displayLabel({ name: "value_1", label: "project" }), "project");
  // Punctuation the user actually used is preserved — only surrounding whitespace is
  // trimmed (see below), never the label's own characters.
  assert.equal(displayLabel({ name: "boolean", label: "project?" }), "project?");
});

test("#636: surrounding whitespace is trimmed, and is not by itself a rename", () => {
  // Trimming is deliberate and stated in the helper's contract. A caller cannot match
  // " Filename " against anything, and " seed " is not a rename of `seed` — reporting it
  // as one would be a rename that never happened, which is this bug inverted.
  assert.equal(displayLabel({ name: "value", label: "  Filename  " }), "Filename");
  assert.equal(displayLabel({ name: "seed", label: "  seed  " }), null);
  assert.equal(
    boundaryInputLabel({ name: "value", _subgraphSlot: { name: "value", label: " Filename " } }),
    "Filename",
  );
});

test("#636: NOTHING is invented — no label, an empty label, or a non-string is null", () => {
  assert.equal(displayLabel({ name: "value" }), null);
  assert.equal(displayLabel({ name: "value", label: "" }), null);
  assert.equal(displayLabel({ name: "value", label: "   " }), null);
  assert.equal(displayLabel({ name: "value", label: 42 }), null);
  assert.equal(displayLabel(null), null);
  assert.equal(displayLabel(undefined), null);
});

test("#636: a label IDENTICAL to the name is not a rename and is not emitted", () => {
  // Frontends commonly default `label` to the name. Emitting it would make every
  // unrenamed widget look renamed — the field would then mean nothing, which is the
  // reported failure inverted rather than fixed.
  assert.equal(displayLabel({ name: "seed", label: "seed" }), null);
  // …but a case difference IS a user-visible rename and must survive.
  assert.equal(displayLabel({ name: "seed", label: "Seed" }), "Seed");
});

test("#636: a boundary input's label is taken from the host input FIRST, then the backing slot", () => {
  // The host input is what renders on the outer node the caller is looking at, so it
  // wins when both carry one.
  assert.equal(
    boundaryInputLabel({ name: "value", label: "Filename", _subgraphSlot: { name: "value", label: "Inner" } }),
    "Filename",
  );
  // Older frontends record the rename only on the backing subgraph slot.
  assert.equal(
    boundaryInputLabel({ name: "value", _subgraphSlot: { name: "value", label: "Filename" } }),
    "Filename",
  );
  // The backing slot's label is compared against the name the entry is REPORTED under,
  // so a slot whose label merely repeats the host name is still not a rename.
  assert.equal(
    boundaryInputLabel({ name: "value", _subgraphSlot: { name: "inner_value", label: "value" } }),
    null,
  );
  assert.equal(boundaryInputLabel({ name: "value" }), null);
  assert.equal(boundaryInputLabel(null), null);
});

test("#636: widgetLabelMap keys renamed widgets by their ADDRESSABLE name, and omits the rest", () => {
  const node = {
    widgets: [
      { name: "value", label: "Filename", value: "out" },
      { name: "boolean", label: "project?", value: true },
      { name: "value_1", label: "project", value: "x" },
      { name: "seed", value: 1 }, // not renamed
      { name: "steps", label: "steps", value: 20 }, // label === name, not a rename
      { value: "no name" }, // malformed, ignored
    ],
  };
  assert.deepEqual(widgetLabelMap(node), {
    value: "Filename",
    boolean: "project?",
    value_1: "project",
  });
});

test("#636: a node with no renames yields an EMPTY map, so the payload key can be omitted entirely", () => {
  // This is what keeps an unrenamed node's read byte-identical to before the change.
  assert.deepEqual(widgetLabelMap({ widgets: [{ name: "seed", value: 1 }] }), {});
  assert.deepEqual(widgetLabelMap({}), {});
  assert.deepEqual(widgetLabelMap(null), {});
});

test("#636: the panel's structured readers actually CONSUME these helpers", () => {
  // Without this, the helpers above could be perfectly correct and entirely unwired —
  // which is the state the bug was reported in. summarizeNode backs panel_query_graph
  // (fields:'detail') and panel_get_subgraph; describeRails backs the `rails` payload.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ displayLabel, boundaryInputLabel, widgetLabelMap \} from "\.\/lib\/slot-labels\.js"/);
  assert.match(src, /widget_labels: widgetLabels/, "summarizeNode emits widget_labels");
  assert.match(src, /const label = boundaryInputLabel\(inp\);/, "summarizeNode labels inputs");
  assert.match(src, /const widgetLabels = widgetLabelMap\(node\);/);
  // describeRails' slotList must label boundary slots too — the rails payload was one
  // of the three readers that dropped renames.
  assert.match(src, /const slotList = \(slots\) =>[\s\S]{0,400}displayLabel\(s\)/);
});
