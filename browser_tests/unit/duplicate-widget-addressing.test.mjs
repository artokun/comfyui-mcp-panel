/**
 * #2143 — a widget name shared by several rows must be ADDRESSABLE, and the reply must say
 * which row was written.
 *
 * The reported node is an rgthree Fast Groups Bypasser matching two groups. It draws one
 * toggle row per matched group and names every one `RGTHREE_TOGGLE_AND_NAV`.
 * `panel_query_graph` has reported each row with a stable index and its own label since
 * #1402; `panel_set_widget` resolved by name alone and always took the first, so the second
 * group's toggle had no address at all. On a Bypasser that row's action changes the MODE of
 * every node in its group, so "which occurrence" is a graph mutation, not a label.
 *
 * The behavioural tests below drive the production-shaped row (toggle()/doModeChange(), no
 * widget.callback — the same shape #2146's suite models) through the real `applyWidgetWrite`,
 * and assert on the MODES that moved: an address for occurrence 1 must mute the SECOND
 * group's nodes and leave the first group's alone. Deleting the occurrence plumbing makes
 * those two assertions fail in opposite directions, which is the point — a test that only
 * checked "the write succeeded" would pass with the fix removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";
import { readLiveWidgetValue, runSetWidget } from "../../web/js/lib/set-widget.js";
import { widgetWriteTimeoutReadback } from "../../web/js/lib/delivery-ack.js";
import { missingWidgetMessage } from "../../web/js/lib/missing-widget.js";
import { duplicateWidgetRows } from "../../web/js/lib/widget-rows.js";
import {
  parseOccurrenceSelector,
  resolveWidgetAddress,
  widgetOccurrenceOf,
  widgetAtOccurrence,
  duplicateAddressHint,
  WidgetAddressError,
} from "../../web/js/lib/widget-occurrence.js";

const BYPASSER = "Fast Groups Bypasser (rgthree)";

/** The address, flattened for assertion. `occurrence.widget` is the row OBJECT, so it is
 *  checked separately where it matters rather than deep-compared everywhere. */
function addr(node, requested) {
  const a = resolveWidgetAddress(node, requested);
  if (!a) return null;
  return {
    name: a.name,
    index: a.occurrence?.index ?? null,
    label: a.occurrence?.label ?? null,
  };
}
const ROW = "RGTHREE_TOGGLE_AND_NAV";

function defineMode(node, initial) {
  let current = initial;
  Object.defineProperty(node, "mode", {
    configurable: true,
    enumerable: true,
    get() {
      return current;
    },
    set(value) {
      current = value;
    },
  });
}

/**
 * A Fast Groups Bypasser matching TWO groups, so the node carries two rows both named
 * `RGTHREE_TOGGLE_AND_NAV`. Each row's action moves only ITS OWN group's node modes, which
 * is what makes "which occurrence was written" observable rather than cosmetic.
 */
function twoGroupBypasser({
  labels = ["Enable VRAM optimizations 1", "Enable VRAM optimizations 2"],
  // A widget BEFORE the toggle rows. With it, the position of a row and its ordinal among
  // same-named rows differ by one — which is the only shape that can tell the two apart,
  // and the shape `duplicate_widgets` reports indexes 1 and 2 for.
  lead = false,
} = {}) {
  const members = [
    [
      { id: 11, type: "LoadAudio" },
      { id: 12, type: "LoadAudio" },
    ],
    [
      { id: 21, type: "LoadAudio" },
      { id: 22, type: "LoadAudio" },
    ],
  ];
  for (const group of members) for (const node of group) defineMode(node, 0);

  const nodes = new Map();
  for (const group of members) for (const node of group) nodes.set(node.id, node);
  const graph = {
    links: {},
    getNodeById(id) {
      return nodes.get(id) ?? null;
    },
  };
  for (const node of nodes.values()) node.graph = graph;

  const bypasser = {
    id: 59,
    type: BYPASSER,
    graph,
    modeOn: 0,
    modeOff: 4,
    properties: {},
    widgets: [],
  };
  if (lead) bypasser.widgets.push({ name: "matchColors", type: "string", value: "" });

  const rows = members.map((groupNodes, i) => {
    const group = {
      graph,
      _children: new Set(groupNodes),
      recomputeInsideNodes() {},
    };
    const row = {
      name: ROW,
      label: labels[i],
      value: { toggled: true },
      group,
      node: bypasser,
      doModeChange() {
        group.recomputeInsideNodes();
        const hasAnyActiveNodes = [...group._children].some((node) => node.mode === 0);
        const newValue = !hasAnyActiveNodes;
        for (const groupNode of group._children) {
          groupNode.mode = newValue ? this.node.modeOn : this.node.modeOff;
        }
        group.rgthree_hasAnyActiveNode = newValue;
        this.value.toggled = newValue;
      },
      toggle(value) {
        value = value == null ? !this.value.toggled : value;
        if (value !== this.value.toggled) {
          this.value.toggled = value;
          this.doModeChange();
        }
      },
    };
    bypasser.widgets.push(row);
    return row;
  });

  return { bypasser, rows, members, modes: () => members.map((g) => g.map((n) => n.mode)) };
}

// ---------------------------------------------------------------------------
// The address resolver
// ---------------------------------------------------------------------------

test("#2143: a bracket selector parses only as a trailing non-negative integer", () => {
  assert.deepEqual(parseOccurrenceSelector("NAME[1]"), { base: "NAME", index: 1 });
  assert.deepEqual(parseOccurrenceSelector("NAME[0]"), { base: "NAME", index: 0 });
  assert.equal(parseOccurrenceSelector("NAME"), null);
  assert.equal(parseOccurrenceSelector("NAME[]"), null);
  assert.equal(parseOccurrenceSelector("NAME[-1]"), null);
  assert.equal(parseOccurrenceSelector("NAME[1] "), null);
  assert.equal(parseOccurrenceSelector("NAME[1]x"), null);
  assert.equal(parseOccurrenceSelector("[1]"), null);
  assert.equal(parseOccurrenceSelector(null), null);
});

test("#2143: an EXACT widget name always wins, brackets and all", () => {
  const node = { id: 1, type: "T", widgets: [{ name: "foo[1]" }, { name: "foo" }, { name: "foo" }] };
  // The literal name resolves to itself with no occurrence pinned — the bracket is never
  // interpreted when a widget actually carries that spelling.
  assert.deepEqual(addr(node, "foo[1]"), { name: "foo[1]", index: null, label: null });
});

test("#2143: a duplicated name addresses a specific occurrence, and composes with sub-fields", () => {
  const node = { id: 59, type: BYPASSER, widgets: [{ name: ROW }, { name: ROW }] };
  assert.deepEqual(addr(node, `${ROW}[1]`), { name: ROW, index: 1, label: null });
  assert.deepEqual(addr(node, `${ROW}[0]`), { name: ROW, index: 0, label: null });
  assert.deepEqual(addr(node, `${ROW}[1].toggled`), {
    name: `${ROW}.toggled`,
    index: 1,
    label: null,
  });
  // The row OBJECT is pinned too — the only thing that can tell two identically-labelled
  // (or unlabelled) rows apart after a reorder.
  assert.equal(resolveWidgetAddress(node, `${ROW}[1]`).occurrence.widget, node.widgets[1]);

  // A bracket address pins the LABEL of the row it landed on, exactly as the label route
  // does. Without it a `[1]` address carries only a position, and a rebuild that reorders
  // the rows across the handler's own await would write whichever group moved into slot 1.
  const labelled = {
    id: 59,
    type: BYPASSER,
    widgets: [
      { name: ROW, label: "Enable VRAM optimizations 1" },
      { name: ROW, label: "Enable VRAM optimizations 2" },
    ],
  };
  assert.deepEqual(addr(labelled, `${ROW}[1]`), {
    name: ROW,
    index: 1,
    label: "Enable VRAM optimizations 2",
  });
});

test("#2143: a duplicated widget whose NAME contains dots is addressable", () => {
  // Widget names really do contain dots here — #560 exists because of that, and #2140's
  // DynamicCombo children are `format.codec.encoding.crf`. Parsing the bracket only after
  // splitting at the first dot made a duplicated dotted name unreachable: "foo.bar[1]"
  // looked for a widget called "foo", found none, and refused — while duplicate_widgets
  // happily reported two `foo.bar` rows.
  const node = {
    id: 7,
    type: "T",
    widgets: [
      { name: "foo.bar", label: "first", value: "a" },
      { name: "foo.bar", label: "second", value: "b" },
    ],
  };
  assert.deepEqual(duplicateWidgetRows(node)["foo.bar"].map((r) => r.index), [0, 1]);
  assert.deepEqual(addr(node, "foo.bar[1]"), { name: "foo.bar", index: 1, label: "second" });

  // …and a real widget named `foo` still wins the DOTTED split, because the selector only
  // ever fires when no widget carries the requested string. Here `foo.on[0]` is not a
  // widget name and `foo.on` is not either, so it is a sub-field write on `foo`.
  const composite = { id: 8, type: "T", widgets: [{ name: "foo", value: { on: true } }] };
  assert.deepEqual(addr(composite, "foo.on"), { name: "foo.on", index: null, label: null });
});

test("#2143: the selector index is the SAME number duplicate_widgets publishes", () => {
  // The two halves of the surface must agree, and they only agree by construction when the
  // selector counts positions in `node.widgets` — NOT occurrences of the name. A compact
  // per-name ordinal happens to match on the reporter's node (its toggle rows start at
  // widget 0) and silently disagrees on any node with a leading widget: duplicate_widgets
  // would advertise indexes 1 and 2 while "ROW[2]" was refused and row 2 reported as 1.
  const node = {
    id: 59,
    type: BYPASSER,
    widgets: [
      { name: "matchColors", value: "" },
      { name: ROW, label: "Enable VRAM optimizations 1", value: { toggled: true } },
      { name: ROW, label: "Enable VRAM optimizations 2", value: { toggled: true } },
    ],
  };
  const published = duplicateWidgetRows(node)[ROW].map((row) => row.index);
  assert.deepEqual(published, [1, 2], "duplicate_widgets indexes positions in node.widgets");

  for (const index of published) {
    assert.equal(
      resolveWidgetAddress(node, `${ROW}[${index}]`).occurrence.index,
      index,
      `duplicate_widgets index ${index} must be a valid address`,
    );
  }
  // And the address that a per-name ordinal would have produced is refused, rather than
  // quietly landing on the last row.
  assert.throws(() => resolveWidgetAddress(node, `${ROW}[0]`), WidgetAddressError);

  // The reply round-trips: the index it reports is an address you can send straight back.
  assert.deepEqual(widgetOccurrenceOf(node, node.widgets[2]), {
    index: 2,
    of: 2,
    label: "Enable VRAM optimizations 2",
  });
});

test("#2143: an out-of-range occurrence is refused, naming the addresses that exist", () => {
  const node = {
    id: 59,
    type: BYPASSER,
    widgets: [
      { name: ROW, label: "Enable VRAM optimizations 1" },
      { name: ROW, label: "Enable VRAM optimizations 2" },
    ],
  };
  assert.throws(
    () => resolveWidgetAddress(node, `${ROW}[2]`),
    (err) =>
      err instanceof WidgetAddressError &&
      /carries no widget named "RGTHREE_TOGGLE_AND_NAV" at index 2/.test(err.message) &&
      err.message.includes(`"${ROW}[0]" (Enable VRAM optimizations 1)`) &&
      err.message.includes(`"${ROW}[1]" (Enable VRAM optimizations 2)`),
  );
});

test("#2143: a display label carried by exactly one row is an address, and pins that label", () => {
  const node = {
    id: 59,
    type: BYPASSER,
    widgets: [
      { name: ROW, label: "Enable VRAM optimizations 1" },
      { name: ROW, label: "Enable VRAM optimizations 2" },
    ],
  };
  assert.deepEqual(addr(node, "Enable VRAM optimizations 2"), {
    name: ROW,
    index: 1,
    label: "Enable VRAM optimizations 2",
  });
});

test("#2143: an AMBIGUOUS label is refused, never resolved to the first match", () => {
  const node = {
    id: 59,
    type: BYPASSER,
    widgets: [
      { name: ROW, label: "same" },
      { name: ROW, label: "same" },
    ],
  };
  assert.throws(
    () => resolveWidgetAddress(node, "same"),
    (err) => err instanceof WidgetAddressError && /does not say which one you meant/.test(err.message),
  );
});

test("#2143: a name that already resolves is returned untouched, with no occurrence pinned", () => {
  const node = {
    id: 1,
    type: "KSampler",
    widgets: [{ name: "seed", label: "Sampler seed" }, { name: "steps" }],
  };
  const plain = (name) => ({ name, index: null, label: null });
  // The two shapes every ordinary write takes: a plain name, and a #560 dotted sub-field.
  assert.deepEqual(addr(node, "seed"), plain("seed"));
  assert.deepEqual(addr(node, "seed.on"), plain("seed.on"));
  // A label on a UNIQUELY-named widget resolves to the ordinary name path: no ordinal is
  // pinned, so nothing about that write changes.
  assert.deepEqual(addr(node, "Sampler seed"), plain("seed"));
  // Nothing matches at all — the caller's own missing-widget refusal stays in charge.
  assert.equal(resolveWidgetAddress(node, "nope"), null);
  assert.equal(resolveWidgetAddress(node, "nope[0]"), null);
});

test("#2143: a case-variant name is left to the #524 fallback, not claimed by the label route", () => {
  const node = { id: 1, type: "T", widgets: [{ name: "Seed" }, { name: "other", label: "seed" }] };
  // "seed" is BOTH a case-variant of a real name and the label of another widget. The name
  // side must win — deciding it here would move a resolution #524 owns.
  assert.equal(resolveWidgetAddress(node, "seed"), null);
});

test("#2143: the occurrence report is by identity and only for genuinely duplicated names", () => {
  const { bypasser, rows } = twoGroupBypasser();
  assert.deepEqual(widgetOccurrenceOf(bypasser, rows[0]), {
    index: 0,
    of: 2,
    label: "Enable VRAM optimizations 1",
  });
  assert.deepEqual(widgetOccurrenceOf(bypasser, rows[1]), {
    index: 1,
    of: 2,
    label: "Enable VRAM optimizations 2",
  });
  const plain = { id: 1, type: "KSampler", widgets: [{ name: "seed" }] };
  assert.equal(widgetOccurrenceOf(plain, plain.widgets[0]), null);
});

// ---------------------------------------------------------------------------
// The write itself — which group's node modes actually moved
// ---------------------------------------------------------------------------

test("#2143: an occurrence-1 address bypasses the SECOND group and leaves the first alone", () => {
  const fixture = twoGroupBypasser();
  assert.deepEqual(fixture.modes(), [[0, 0], [0, 0]]);

  const result = applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, { occurrence: { index: 1 } });

  assert.deepEqual(
    fixture.modes(),
    [[0, 0], [4, 4]],
    "only the second group's nodes may change mode",
  );
  assert.deepEqual(fixture.rows[0].value, { toggled: true }, "the first row is untouched");
  assert.deepEqual(fixture.rows[1].value, { toggled: false });
  assert.deepEqual(result.widget_occurrence, {
    index: 1,
    of: 2,
    label: "Enable VRAM optimizations 2",
  });
  assert.equal(result.widget, ROW, "the reply still names the ADDRESSABLE widget name");
});

test("#2143: a BARE duplicated name still writes the first row — unchanged behaviour", () => {
  const fixture = twoGroupBypasser();

  const result = applyWidgetWrite(fixture.bypasser, ROW, { toggled: false });

  assert.deepEqual(fixture.modes(), [[4, 4], [0, 0]], "the first group is the one that moves");
  assert.deepEqual(fixture.rows[1].value, { toggled: true });
  // …but the reply now DISCLOSES that the name did not identify the row on its own, which is
  // the half of #524's silent-wrong-widget defect that survived on exact-name duplicates.
  assert.deepEqual(result.widget_occurrence, {
    index: 0,
    of: 2,
    label: "Enable VRAM optimizations 1",
  });
});

test("#2143: an occurrence-0 address is explicit about the row every bare name took", () => {
  const fixture = twoGroupBypasser();
  applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, { occurrence: { index: 0 } });
  assert.deepEqual(fixture.modes(), [[4, 4], [0, 0]]);
});

test("#2143: the WRITE indexes positions, not occurrences, when a widget precedes the rows", () => {
  // Without a leading widget the two readings coincide and a per-name-ordinal write passes
  // every behavioural test in this file. With one they diverge: `ROW[1]` is the FIRST toggle
  // row, so an ordinal reading would silently bypass the SECOND group instead.
  const fixture = twoGroupBypasser({ lead: true });
  assert.deepEqual(
    duplicateWidgetRows(fixture.bypasser)[ROW].map((r) => r.index),
    [1, 2],
    "the read publishes positions 1 and 2 on this node",
  );

  applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, { occurrence: { index: 1 } });
  assert.deepEqual(fixture.modes(), [[4, 4], [0, 0]], "index 1 is the FIRST group's row");

  const other = twoGroupBypasser({ lead: true });
  applyWidgetWrite(other.bypasser, ROW, { toggled: false }, { occurrence: { index: 2 } });
  assert.deepEqual(other.modes(), [[0, 0], [4, 4]], "index 2 is the SECOND group's row");

  // …and index 0 is the leading widget, not a toggle row, so it is refused rather than
  // resolved to whichever row an ordinal would have picked.
  const third = twoGroupBypasser({ lead: true });
  assert.throws(
    () => applyWidgetWrite(third.bypasser, ROW, { toggled: false }, { occurrence: { index: 0 } }),
    WidgetWriteError,
  );
  assert.deepEqual(third.modes(), [[0, 0], [0, 0]], "nothing moved");
});

test("#2143: a sub-field address reaches the addressed occurrence too", () => {
  const fixture = twoGroupBypasser();

  applyWidgetWrite(fixture.bypasser, `${ROW}.toggled`, false, { occurrence: { index: 1 } });

  assert.deepEqual(fixture.modes(), [[0, 0], [4, 4]]);
});

test("#2143: the REPORTED index is a live address, not the position the row had before", () => {
  // `widget_occurrence.index` is the number a caller sends straight back as "NAME[i]" — the
  // round trip with duplicate_widgets is the whole point of it. The write fires the widget's
  // own callback, and a Fast Groups row action changes the groups its rows come FROM, so the
  // node can reorder them. Reporting the pre-write position then names a row this write
  // never touched, and re-using it writes that row: the silent-wrong-row this issue is
  // about, reintroduced by the field added to prevent it.
  const node = { id: 59, type: "T", widgets: [] };
  const a = { name: "row", type: "string", value: "a", label: "A" };
  const b = {
    name: "row",
    type: "string",
    value: "b",
    label: "B",
    callback() {
      node.widgets = [node.widgets[1], node.widgets[0]];
    },
  };
  node.widgets = [a, b];

  const res = applyWidgetWrite(node, "row", "new", {
    occurrence: { index: 1, label: "B", widget: b },
  });

  assert.equal(b.value, "new", "row B is the one that was written");
  assert.equal(node.widgets.indexOf(b), 0, "and the callback moved it to index 0");
  assert.deepEqual(res.widget_occurrence, { index: 0, of: 2, label: "B" });
  // The round trip: feeding the reported index straight back reaches the SAME row.
  assert.equal(
    resolveWidgetAddress(node, `row[${res.widget_occurrence.index}]`).occurrence.widget,
    b,
  );
});

test("#2143: the reported index survives the node's onWidgetChanged hook too", () => {
  // TWO hooks can move a row after the value lands: the widget's own callback (the test
  // above) and then the node's `onWidgetChanged` (#1519). The address has to be read after
  // BOTH — a fix that only cleared the first leaves the identical defect one hook later,
  // which is exactly how this one was found.
  const node = { id: 59, type: "T", widgets: [] };
  const a = { name: "row", type: "string", value: "a", label: "A" };
  const b = { name: "row", type: "string", value: "b", label: "B" };
  node.widgets = [a, b];
  node.onWidgetChanged = () => {
    node.widgets = [b, a];
  };

  const res = applyWidgetWrite(node, "row", "new", {
    occurrence: { index: 1, label: "B", widget: b },
  });

  assert.equal(b.value, "new");
  assert.equal(node.widgets.indexOf(b), 0, "the hook moved the written row to index 0");
  assert.deepEqual(res.widget_occurrence, { index: 0, of: 2, label: "B" });
  assert.equal(resolveWidgetAddress(node, `row[${res.widget_occurrence.index}]`).occurrence.widget, b);
});

test("#2143: a hook that RENAMES the written row cannot make the reply self-contradictory", () => {
  // The reply carries a `widget` NAME and an occurrence, and they must describe the same
  // thing. `onWidgetChanged` can rename the widget after the write while the reported name
  // stays the pre-hook one (#1519) — counting rows under the NEW name would publish
  // `{index, of}` about a name the reply never mentions, so replaying `row[index]` would
  // address something else entirely.
  const renamedIntoADuplicate = { id: 59, type: "T", widgets: [] };
  const other = { name: "other", type: "string", value: "a" };
  const written = { name: "row", type: "string", value: "b" };
  renamedIntoADuplicate.widgets = [other, written];
  renamedIntoADuplicate.onWidgetChanged = () => {
    written.name = "other";
  };

  const res = applyWidgetWrite(renamedIntoADuplicate, "row", "new", { occurrence: null });

  assert.equal(res.widget, "row", "the reported name is the pre-hook one, per #1519");
  assert.equal(
    "widget_occurrence" in res,
    false,
    "and no occurrence is published under a name the row no longer carries",
  );

  // When the name WAS duplicated before the write, the pre-write capture still says which
  // row was written — flagged, so the number is not reused.
  const node = { id: 59, type: "T", widgets: [] };
  const a = { name: "row", type: "string", value: "a", label: "A" };
  const b = { name: "row", type: "string", value: "b", label: "B" };
  node.widgets = [a, b];
  node.onWidgetChanged = () => {
    b.name = "renamed";
  };

  const res2 = applyWidgetWrite(node, "row", "new", {
    occurrence: { index: 1, label: "B", widget: b },
  });
  assert.deepEqual(res2.widget_occurrence, { index: 1, of: 2, label: "B", stale: true });
});

test("#2143: a rebuild down to ONE row of that name is still refused, not substituted", () => {
  // The addressed row is gone and an unlabelled survivor sits at that index. It is tempting
  // to write it — a bare `row` write would reach it — but the caller deliberately did not
  // send a bare name: they addressed one of several rows, and on a Fast Groups node the
  // survivor is a DIFFERENT group's toggle. Substituting it is the same silent-wrong-row
  // this issue is about, so the refusal covers this case too.
  const node = {
    id: 7,
    type: "T",
    widgets: [{ name: "x" }, { name: "x" }, { name: "row", type: "string", value: "c" }],
  };

  assert.throws(
    () =>
      applyWidgetWrite(node, "row", "written", {
        occurrence: { index: 2, label: null, widget: { name: "row" } },
      }),
    WidgetWriteError,
  );
  assert.equal(node.widgets[2].value, "c", "the survivor was not written");

  // A survivor the pinned label still names IS resolvable — the refusal is about being
  // unable to establish the row, not about rebuilds as such.
  const labelled = {
    id: 7,
    type: "T",
    widgets: [{ name: "x" }, { name: "x" }, { name: "row", type: "string", value: "c", label: "L" }],
  };
  const res = applyWidgetWrite(labelled, "row", "written", {
    occurrence: { index: 2, label: "L", widget: { name: "row", label: "L" } },
  });
  assert.equal(res.value, "written");
});

test("#2143: a row the callback REMOVED is reported stale rather than as a usable address", () => {
  const node = { id: 59, type: "T", widgets: [] };
  const a = { name: "row", type: "string", value: "a", label: "A" };
  const b = {
    name: "row",
    type: "string",
    value: "b",
    label: "B",
    callback() {
      node.widgets = [node.widgets[0]];
    },
  };
  node.widgets = [a, b];

  const res = applyWidgetWrite(node, "row", "new", {
    occurrence: { index: 1, label: "B", widget: b },
  });

  // The row has no current address, so the pre-write capture is reported — flagged, so the
  // caller learns which row was written without being handed a number to reuse.
  assert.deepEqual(res.widget_occurrence, { index: 1, of: 2, label: "B", stale: true });
});

test("#2143: an ordinary node with unique widget names replies with no occurrence field", () => {
  const node = { id: 3, type: "KSampler", widgets: [{ name: "steps", type: "number", value: 20 }] };
  const result = applyWidgetWrite(node, "steps", 30);
  assert.equal(result.value, 30);
  assert.equal("widget_occurrence" in result, false);
});

test("#2143: an ordinal with no row behind it at write time refuses instead of writing row 0", () => {
  const fixture = twoGroupBypasser();
  // The rows rebuilt between the address being resolved and the write — exactly what a Fast
  // Groups node does when the groups it matches change.
  fixture.bypasser.widgets = [fixture.rows[0]];

  assert.throws(
    () => applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, { occurrence: { index: 1 } }),
    (err) =>
      err instanceof WidgetWriteError &&
      /index 1 no longer names the row this call addressed/.test(err.message) &&
      /Nothing was written/.test(err.message),
  );
  assert.deepEqual(fixture.modes(), [[0, 0], [0, 0]], "no mode moved");
  assert.deepEqual(fixture.rows[0].value, { toggled: true });
});

test("#2143: a row that MOVED between resolution and the write is refused, not written over", () => {
  const fixture = twoGroupBypasser();
  // The address was resolved against [group one, group two]; by write time a rebuild has
  // swapped them. Index 1 is still a perfectly valid RGTHREE_TOGGLE_AND_NAV — it is just a
  // different group, which the position alone cannot tell. The pinned label can.
  fixture.bypasser.widgets = [fixture.rows[1], fixture.rows[0]];

  assert.throws(
    () =>
      applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, {
        occurrence: { index: 1, label: "Enable VRAM optimizations 2" },
      }),
    (err) =>
      err instanceof WidgetWriteError &&
      /the row at that index is a different one/.test(err.message) &&
      /Enable VRAM optimizations 1, not "Enable VRAM optimizations 2"/.test(err.message) &&
      /Nothing was written/.test(err.message),
  );
  assert.deepEqual(fixture.modes(), [[0, 0], [0, 0]], "neither group moved");
});

test("#2143: a reorder is caught by IDENTITY even when the labels cannot tell the rows apart", () => {
  // The case a label pin alone cannot cover, and the reason the row OBJECT is pinned too:
  // two rows whose labels are identical (or absent). The label check would compare "same"
  // to "same", pass, and toggle the wrong group.
  for (const labels of [["same", "same"], [undefined, undefined]]) {
    const fixture = twoGroupBypasser({ labels });
    const addressed = fixture.rows[1];
    fixture.bypasser.widgets = [fixture.rows[1], fixture.rows[0]];

    assert.throws(
      () =>
        applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, {
          occurrence: { index: 1, label: labels[1] ?? null, widget: addressed },
        }),
      (err) => err instanceof WidgetWriteError && /the rows were REORDERED and it is now at index 0/.test(err.message),
      `labels ${JSON.stringify(labels)}`,
    );
    assert.deepEqual(fixture.modes(), [[0, 0], [0, 0]], "neither group moved");
  }
});

test("#2143: identity ACCEPTS the unmoved row, so an ordinary pinned write still lands", () => {
  const fixture = twoGroupBypasser({ labels: ["same", "same"] });
  applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, {
    occurrence: { index: 1, label: "same", widget: fixture.rows[1] },
  });
  assert.deepEqual(fixture.modes(), [[0, 0], [4, 4]]);
});

test("#2143: a rebuild that GREW the row set is refused when the label cannot single one out", () => {
  // A Fast Groups node that gains a group mid-command: the row set is not the set that was
  // addressed, so an index into it can mean a different group. What settles it is whether
  // the pinned LABEL still names exactly one row — here it does not, because the extra row
  // shares it (or there are no labels at all).
  //
  // A plain node, not the Bypasser fixture: a Fast Groups row with no live `group` refuses
  // in the #2146 mode journal before this check is ever consulted, which would make the
  // test pass for a reason that has nothing to do with the address.
  for (const label of ["two", undefined]) {
    const node = {
      id: 7,
      type: "T",
      widgets: [
        { name: "row", type: "string", value: "a", label: label && "one" },
        { name: "row", type: "string", value: "b", label },
        { name: "row", type: "string", value: "c", label },
      ],
    };
    const ghost = { name: "row", label };

    assert.throws(
      () =>
        applyWidgetWrite(node, "row", "written", {
          occurrence: { index: 1, label: label ?? null, widget: ghost },
        }),
      WidgetWriteError,
      `label ${JSON.stringify(label)}`,
    );
    assert.deepEqual(
      node.widgets.map((w) => w.value),
      ["a", "b", "c"],
      "nothing was written",
    );
  }
});

test("#2143: a grown row set still RESOLVES when the label singles the row out", () => {
  // The other half, and the reason the number of rows is not a check of its own. A rebuild
  // added a row, but the pinned label still names exactly one — so the row at that index IS
  // the row that was addressed, whatever the count did. Refusing here would be a refusal
  // over an address that is not actually ambiguous.
  const node = {
    id: 7,
    type: "T",
    widgets: [
      { name: "row", type: "string", value: "a", label: "A" },
      { name: "row", type: "string", value: "b", label: "B" },
      { name: "row", type: "string", value: "c", label: "C" },
    ],
  };

  const res = applyWidgetWrite(node, "row", "written", {
    occurrence: { index: 1, label: "B", widget: { name: "row", label: "B" } },
  });

  assert.equal(res.value, "written");
  assert.deepEqual(node.widgets.map((w) => w.value), ["a", "written", "c"]);
});

test("#2143: a REBUILD that replaces the row objects falls back to the label, not a refusal", () => {
  // Identity is inconclusive here — the addressed object is gone entirely, which is what an
  // rgthree Fast Groups rebuild does. Refusing on that would block the ordinary case; the
  // label is what says the rebuild put the same row back in the same place.
  const fixture = twoGroupBypasser();
  const ghost = { name: ROW, label: "Enable VRAM optimizations 2" };

  applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, {
    occurrence: { index: 1, label: "Enable VRAM optimizations 2", widget: ghost },
  });
  assert.deepEqual(fixture.modes(), [[0, 0], [4, 4]], "the rebuilt row was written");
});

test("#2143: a pinned label that still matches writes normally", () => {
  const fixture = twoGroupBypasser();
  applyWidgetWrite(fixture.bypasser, ROW, { toggled: false }, {
    occurrence: { index: 1, label: "Enable VRAM optimizations 2" },
  });
  assert.deepEqual(fixture.modes(), [[0, 0], [4, 4]]);
});

test("#2143: an occurrence address on a PROMOTED subgraph widget is refused, not silently dropped", () => {
  const inner = { id: 7, type: "KSampler", widgets: [{ name: "steps", type: "number", value: 20 }] };
  const subgraphNode = {
    id: 4,
    type: "SubgraphNode",
    // isPromotedContainer only accepts a LIVE inner graph (#1941/#2006).
    subgraph: { id: "sg", _nodes: [inner] },
    widgets: [{ name: "steps", type: "number", value: 20 }],
    inputs: [{ name: "steps", widget: { name: "steps" } }],
  };
  const resolveSource = () => ({ node: inner, widget: inner.widgets[0] });

  assert.throws(
    () =>
      applyWidgetWrite(subgraphNode, "steps", 30, {
        resolveSource,
        occurrence: { index: 1 },
        promotedResolution: {
          promoted: true,
          target: {
            node: inner,
            widget: inner.widgets[0],
            input: subgraphNode.inputs[0],
            parentWidget: subgraphNode.widgets[0],
            parentWidgets: [subgraphNode.widgets[0]],
          },
        },
      }),
    (err) => err instanceof WidgetWriteError && /cannot select index 1/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 20, "nothing was written to the inner widget");
  assert.equal(subgraphNode.widgets[0].value, 20, "nothing was written to the rail");
});

// ---------------------------------------------------------------------------
// The refusal, and the ack readback
// ---------------------------------------------------------------------------

test("#2143: the missing-widget refusal names the duplicated rows and the syntax that reaches them", () => {
  const { bypasser } = twoGroupBypasser();
  const message = missingWidgetMessage(bypasser, "Enable VRAM optimizations 9");
  // The available-list is de-duplicated (#1956), so without this the refusal reads as though
  // the node had exactly one toggle row.
  assert.match(message, /available: RGTHREE_TOGGLE_AND_NAV\)/);
  assert.ok(message.includes(`"${ROW}[0]" (Enable VRAM optimizations 1)`), message);
  assert.ok(message.includes(`"${ROW}[1]" (Enable VRAM optimizations 2)`), message);
  assert.match(message, /Address one by occurrence/);

  const plain = { id: 1, type: "KSampler", widgets: [{ name: "seed" }] };
  assert.equal(duplicateAddressHint(plain), "", "a node with unique names adds nothing");
});

test("#2143: the timeout readback reads the row that was written, not the first same-named one", () => {
  const { bypasser, rows } = twoGroupBypasser();
  rows[0].value = { toggled: false };
  rows[1].value = { toggled: true };

  // Without the ordinal this answers about row 0 — and row 0 holding the requested value is
  // exactly how a timed-out write to row 1 was reported "applied and verified".
  assert.deepEqual(readLiveWidgetValue(bypasser, ROW).value, { toggled: false });
  assert.deepEqual(readLiveWidgetValue(bypasser, ROW, { index: 1 }).value, { toggled: true });
  assert.equal(readLiveWidgetValue(bypasser, ROW, { index: 5 }).found, false);
});

test("#2143: the readback and the write agree on the row when the name does NOT start at 0", () => {
  // The case that separates a POSITION from a per-name ordinal. `ROW[1]` is widgets[1] — the
  // FIRST toggle row. A readback that counted occurrences instead would answer about the
  // SECOND, and if that row already held the requested value it would ack an uncertain write
  // as "applied and verified" from a row nothing wrote to.
  const node = {
    id: 59,
    type: BYPASSER,
    widgets: [
      { name: "matchColors", value: "" },
      { name: ROW, label: "group one", value: { toggled: true } },
      { name: ROW, label: "group two", value: { toggled: false } },
    ],
  };
  const address = resolveWidgetAddress(node, `${ROW}[1]`);
  assert.equal(address.occurrence.index, 1);

  const live = readLiveWidgetValue(node, ROW, address.occurrence);
  assert.equal(live.widget, node.widgets[1], "the readback must read the row the write targets");
  assert.deepEqual(live.value, { toggled: true });

  const receipt = widgetWriteTimeoutReadback({
    requested: { toggled: false },
    actual: live.value,
    found: live.found,
    node_id: node.id,
    widget: ROW,
    widget_occurrence: widgetOccurrenceOf(node, live.widget),
  });
  assert.notEqual(
    receipt.ack_note,
    "applied and verified",
    "row 2 holding the requested value must not verify a write aimed at row 1",
  );
});

test("#2143: a readback whose row MOVED reports not-found rather than verifying a stranger", () => {
  const { bypasser, rows } = twoGroupBypasser();
  rows[1].value = { toggled: false };
  // A rebuild swapped the rows after the address was resolved. Position 1 still holds a
  // perfectly valid RGTHREE_TOGGLE_AND_NAV — a different group's.
  bypasser.widgets = [rows[1], rows[0]];

  const live = readLiveWidgetValue(bypasser, ROW, { index: 1, label: "Enable VRAM optimizations 2" });
  assert.equal(live.found, false, "the pinned label refuses the row that moved into that slot");

  const receipt = widgetWriteTimeoutReadback({
    requested: { toggled: false },
    actual: live.value,
    found: live.found,
    node_id: bypasser.id,
    widget: ROW,
  });
  assert.notEqual(receipt.ack_note, "applied and verified");
});

test("#2143: a DOTTED address reads as not-found, exactly as it did before — and fails safe", () => {
  // Recorded so it is a known limit rather than something rediscovered as a defect: the
  // #2025 readback has never resolved a sub-field address, and this change does not alter
  // that. `origin/main` does `find(w => w.name === widgetName)`, which cannot match
  // "row.toggled" either. Both answer not-found, which downgrades the ack to the honest
  // outcome-unknown — never a false "applied and verified".
  const node = { id: 1, widgets: [{ name: "row", value: { toggled: true } }, { name: "row", value: { toggled: false } }] };
  assert.equal(readLiveWidgetValue(node, "row.toggled").found, false, "no occurrence: not found");
  assert.equal(readLiveWidgetValue(node, "row.toggled", { index: 1 }).found, false, "with one: the same");
  // And resolving the base would not change the outcome anyway: a dotted write's requested
  // value is the SUB-FIELD, while the widget holds the composite, so the comparison cannot
  // verify in either direction.
  const asIfFound = widgetWriteTimeoutReadback({
    requested: false,
    actual: { toggled: false },
    found: true,
    node_id: 1,
    widget: "row",
  });
  assert.notEqual(asIfFound.ack_note, "applied and verified");
});

test("#2143: the timeout receipt carries the same row attribution the write's own reply would", () => {
  const { bypasser, rows } = twoGroupBypasser();
  rows[1].value = { toggled: false };
  const live = readLiveWidgetValue(bypasser, ROW, { index: 1 });

  const receipt = widgetWriteTimeoutReadback({
    requested: { toggled: false },
    actual: live.value,
    found: live.found,
    node_id: bypasser.id,
    widget: ROW,
    widget_occurrence: widgetOccurrenceOf(bypasser, live.widget),
  });

  assert.equal(receipt.applied, true);
  assert.equal(receipt.verified, true);
  // This receipt STANDS IN for the write's reply. Without the attribution it names only
  // RGTHREE_TOGGLE_AND_NAV — restoring, on the one path that reports on a write it did not
  // perform, exactly the ambiguity the address was chosen to remove.
  assert.deepEqual(receipt.set.widget_occurrence, {
    index: 1,
    of: 2,
    label: "Enable VRAM optimizations 2",
  });

  // A unique-name write is byte-identical to before: no attribution field at all.
  const plain = { id: 3, type: "KSampler", widgets: [{ name: "steps", value: 30 }] };
  const plainLive = readLiveWidgetValue(plain, "steps");
  const plainReceipt = widgetWriteTimeoutReadback({
    requested: 30,
    actual: plainLive.value,
    found: plainLive.found,
    node_id: 3,
    widget: "steps",
    widget_occurrence: widgetOccurrenceOf(plain, plainLive.widget),
  });
  assert.equal("widget_occurrence" in plainReceipt.set, false);
});

// ---------------------------------------------------------------------------
// The whole async body — where a post-write re-read can still name the wrong row
// ---------------------------------------------------------------------------

/** A node type the fresh-/object_info authorization accepts, so runSetWidget reaches its
 *  own write and post-write retention rather than refusing at the oracle. */
function nodeCtor() {
  const c = function NodeCtor() {};
  c.nodeData = { input: { required: {} } };
  return c;
}

function wiredDeps(type) {
  const ctor = nodeCtor();
  const registry = { [type]: ctor };
  return {
    registry,
    getRegistry: () => registry,
    getFreshObjectInfo: async () => ({ [type]: {} }),
    beforeChange() {},
    afterChange() {},
    setDirty() {},
  };
}

test("#2143: the post-write retention check re-reads the row that was written", async () => {
  // The failure this pins is a FALSE REFUSAL over an APPLIED write. `retainVerifiedWrite`
  // re-reads the widget after the frontend flush; reading the first same-named row instead
  // of the addressed one sees the old value, retries the write, sees it again, and refuses —
  // telling the caller nothing was applied about a mutation that landed twice.
  const node = {
    id: 59,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [
      { name: "row", type: "string", value: "old-0" },
      { name: "row", type: "string", value: "old-1" },
    ],
  };

  const res = await runSetWidget(node, "row", "new", { ...wiredDeps("DupRows"), occurrence: { index: 1 } });

  assert.equal(res.set.value, "new");
  assert.equal(node.widgets[1].value, "new", "the addressed row was written");
  assert.equal(node.widgets[0].value, "old-0", "the first row was not");
  assert.deepEqual(res.set.widget_occurrence, { index: 1, of: 2 });
});

test("#2143: retention follows the row it wrote when a callback REORDERS the node's rows", async () => {
  // The write already fired the widget's own callback — a Fast Groups row action fires one —
  // and the node can reorder its rows in the frame retention waits for. Re-reading by
  // POSITION then checks a row nothing wrote to: here row 0 keeps its old value, so
  // retention would see a mismatch, retry, and refuse an already-applied write.
  let callbacks = 0;
  const node = {
    id: 59,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [
      { name: "row", type: "string", value: "old-0" },
      {
        name: "row",
        type: "string",
        value: "old-1",
        callback() {
          callbacks += 1;
          node.widgets = [node.widgets[1], node.widgets[0]];
        },
      },
    ],
  };
  const addressed = node.widgets[1];

  const res = await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, widget: addressed },
  });

  assert.equal(res.set.value, "new");
  assert.equal(addressed.value, "new", "the addressed row holds the written value");
  assert.equal(callbacks, 1, "the write was not retried — one callback, one mutation");
  assert.equal(node.widgets[1].value, "old-0", "and the row now AT index 1 was not touched");
});

test("#2143: retention re-writes when a rebuild replaced the row and dropped the value", async () => {
  // The #1922 shape, on a DUPLICATED name: the write lands, the callback replaces the row
  // with a fresh object that did not take the value, and the row the canvas now draws
  // still holds the old one. Retention must see that and write again rather than report a
  // success whose value is nowhere on the node.
  //
  // The rows are LABELLED here, so the retry can identify which one it means; the
  // indistinguishable case is the next test. That separation is the point.
  const node = {
    id: 59,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [{ name: "row", type: "string", value: "old-0", label: "first" }, null],
  };
  const detached = {
    name: "row",
    type: "string",
    value: "old-1",
    label: "second",
    callback() {
      // The rebuild replaces the row entirely, and the replacement did NOT take the value —
      // the #1922 shape retention exists for.
      node.widgets = [node.widgets[0], { name: "row", type: "string", value: "old-1", label: "second" }];
    },
  };
  node.widgets[1] = detached;

  await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, label: "second", widget: detached },
  });

  // A check that answered from the replaced object would pass on ITS `.value` and leave the
  // row the canvas draws holding "old-1" — the silent-stale success #1922 exists to
  // prevent. Reading the live row instead sees the mismatch and re-writes.
  assert.equal(node.widgets[1].value, "new", "the row the node actually carries was written");
  assert.notEqual(node.widgets[1], detached, "and it is the replacement, not the detached object");
});

test("#2143: a rebuild into INDISTINGUISHABLE rows refuses rather than writing one blind", async () => {
  // The addressed row object is gone and the count is unchanged, so name and count say
  // nothing about which row is which. Two shapes make the LABEL say nothing either: no
  // label at all, and a label SHARED by both same-named rows. In both, writing one of them
  // is a coin flip, and a coin flip that mutes the wrong group is the defect this issue is
  // about. Refuse; the caller re-reads duplicate_widgets and addresses it again.
  for (const label of [undefined, "shared"]) {
    const node = {
      id: 59,
      type: "DupRows",
      constructor: nodeCtor(),
      graph: { links: {} },
      widgets: [{ name: "row", type: "string", value: "old-0", label }, null],
    };
    const detached = {
      name: "row",
      type: "string",
      value: "old-1",
      label,
      callback() {
        node.widgets = [node.widgets[0], { name: "row", type: "string", value: "old-1", label }];
      },
    };
    node.widgets[1] = detached;

    await assert.rejects(
      runSetWidget(node, "row", "new", {
        ...wiredDeps("DupRows"),
        occurrence: { index: 1, label: label ?? null, widget: detached },
      }),
      /no longer names the row this call addressed/,
      `label ${JSON.stringify(label)}`,
    );
    assert.equal(node.widgets[1].value, "old-1", "the replacement row was not written blind");
  }

  // A label that names exactly ONE of the rebuilt rows still resolves — the refusal is
  // about being unable to discriminate, not about rebuilds as such.
  assert.equal(
    widgetAtOccurrence(
      { widgets: [{ name: "row", label: "a" }, { name: "row", label: "b" }] },
      "row",
      1,
      { index: 1, label: "b", widget: { name: "row", label: "b" } },
    )?.label,
    "b",
  );
});

test("#2143: a name that only BECOMES duplicated during the write is still read correctly", async () => {
  // The widget name is unique when the write starts, and the callback PREPENDS a second row
  // of the same name holding the old value. A retention read by bare name would return that
  // prepended row, see a mismatch, and mutate a second time.
  //
  // It does not, because `widget_occurrence` is resolved AFTER the write: the name is
  // duplicated by then, so the reply carries the written row's live position and retention
  // reads exactly that row. This is the case that shows the late resolution is not merely
  // about reporting — it is what makes the post-write read correct.
  let callbacks = 0;
  const node = { id: 1, type: "DupRows", constructor: nodeCtor(), graph: { links: {} }, widgets: [] };
  const only = {
    name: "row",
    type: "string",
    value: "old",
    callback() {
      callbacks += 1;
      node.widgets = [{ name: "row", type: "string", value: "old" }, only];
    },
  };
  node.widgets = [only];

  const res = await runSetWidget(node, "row", "new", wiredDeps("DupRows"));

  assert.equal(res.set.value, "new");
  assert.equal(only.value, "new", "the widget that was written holds the value");
  assert.equal(callbacks, 1, "and it was written once — no retry against the prepended row");
  assert.equal(node.widgets[0].value, "old", "the prepended row is untouched");
});

test("#2143: a reorder during the FLUSH is caught — the window after the write resolved", async () => {
  // The window neither the write nor its hooks can see. `applyWidgetWrite` resolves the
  // reported address as the last thing it does, and `retainVerifiedWrite` then awaits a
  // frontend flush — the node can reorder its rows in there. Two things go wrong if the
  // written row is not carried through it:
  //
  //   * retention re-reads by position and checks a row nothing wrote to (here row 0 was
  //     seeded with the requested value, so it "verifies" against a stranger);
  //   * the reply hands back an index that now names that stranger, and replaying it writes
  //     the wrong row.
  const row0 = { name: "row", type: "string", value: "new" };
  const row1 = { name: "row", type: "string", value: "b" };
  const node = {
    id: 1,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [row0, row1],
  };

  const res = await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, widget: row1 },
    awaitFrontendWidgetFlush: async () => {
      node.widgets = [row1, row0];
    },
  });

  assert.equal(row1.value, "new", "the addressed row holds the value");
  assert.equal(node.widgets.indexOf(row1), 0, "and the flush moved it to index 0");
  assert.equal(res.set.widget_occurrence.index, 0, "the reply reports where it ended up");
  assert.equal(
    resolveWidgetAddress(node, `row[${res.set.widget_occurrence.index}]`).occurrence.widget,
    row1,
    "so the reported index round-trips back to the row that was written",
  );
});

test("#2143: a flush reorder does not make retention refuse a write that landed", async () => {
  // What only RETENTION'S identity key can answer, as distinct from the reported address.
  // The flush swaps the rows and the row now at the addressed index holds its ORIGINAL
  // value — so a positional re-read sees a mismatch it cannot fix, retries, and the retry's
  // own pin refuses the reorder. The command then reports "nothing was applied" about a
  // write that landed. Reading the row that was written instead sees the value and stops.
  const row0 = { name: "row", type: "string", value: "a" };
  const row1 = { name: "row", type: "string", value: "b" };
  const node = {
    id: 1,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [row0, row1],
  };

  const res = await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, widget: row1 },
    awaitFrontendWidgetFlush: async () => {
      node.widgets = [row1, row0];
    },
  });

  assert.equal(res.set.value, "new");
  assert.equal(row1.value, "new");
  assert.equal(row0.value, "a", "the other row was never written — there was no retry");
});

test("#2143: a rename during the flush cannot publish an address under the old name", async () => {
  // The rename case again, in the flush window this time. The reply's `widget` is the name
  // that was written; counting rows under the widget's NEW name would publish `{index, of}`
  // about a name the reply never mentions.
  //
  // The row is renamed INTO an already-duplicated name on purpose: renaming it to something
  // unique would leave the occurrence null either way, so the fixture could not tell an
  // anchored lookup from an unanchored one.
  const row0 = { name: "row", type: "string", value: "a" };
  const row1 = { name: "row", type: "string", value: "b" };
  const alreadyRenamed = { name: "renamed", type: "string", value: "z" };
  const node = {
    id: 1,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [row0, row1, alreadyRenamed],
  };

  const res = await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, widget: row1 },
    awaitFrontendWidgetFlush: async () => {
      row1.name = "renamed";
    },
  });

  assert.equal(res.set.widget, "row");
  assert.deepEqual(
    res.set.widget_occurrence,
    { index: 1, of: 2, stale: true },
    "reported as the row it was, flagged — never as a live `row[i]` the name no longer has",
  );
});

test("#2143: a row REMOVED during the flush is reported stale, not as a live address", async () => {
  // The other half of the flush window: the flush REPLACED the written row with a fresh
  // object that carries the value forward, so retention is satisfied (the value is in effect
  // at the address the caller gave) but the row that was written is gone. It therefore has no
  // current address — the caller still learns which row was written, flagged, rather than
  // being handed a number whose meaning nobody can vouch for.
  const row0 = { name: "row", type: "string", value: "a" };
  const row1 = { name: "row", type: "string", value: "b" };
  const node = {
    id: 1,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [row0, row1],
  };

  const res = await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, widget: row1 },
    awaitFrontendWidgetFlush: async () => {
      node.widgets = [row0, { name: "row", type: "string", value: row1.value }];
    },
  });

  assert.equal(node.widgets.includes(row1), false, "the written row was replaced");
  assert.deepEqual(res.set.widget_occurrence, { index: 1, of: 2, stale: true });
});

test("#2143: retention accepts an ordinary rebuild that CARRIES THE VALUE forward", async () => {
  // Why retention keys on name+position once the written object is gone, rather than
  // demanding identity as the write does. A rebuild that replaces the row objects and
  // copies their values across is the ORDINARY thing a rebuild does — and from here it is
  // indistinguishable from "my row was replaced by one that already held the value".
  // Requiring identity would refuse both, reporting failure for a command whose asked-for
  // effect is on the canvas at the address the caller gave.
  const node = {
    id: 1,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [],
  };
  node.widgets = [
    { name: "row", type: "string", value: "a" },
    {
      name: "row",
      type: "string",
      value: "b",
      callback() {
        node.widgets = node.widgets.map((w) => ({ name: "row", type: "string", value: w.value }));
      },
    },
  ];
  const addressed = node.widgets[1];

  const res = await runSetWidget(node, "row", "new", {
    ...wiredDeps("DupRows"),
    occurrence: { index: 1, widget: addressed },
  });

  assert.equal(res.set.value, "new");
  assert.equal(node.widgets[1].value, "new", "the value is in effect on the row the node draws");
  assert.notEqual(node.widgets[1], addressed, "on a REPLACEMENT object, not the one written");
});

test("#2143: retention survives a callback that RELABELS the row it just wrote", async () => {
  // The write's callback re-derives the row labels — which is what a Fast Groups row action
  // does, since it changes the very groups the labels come from. Retention runs after that
  // callback, so a label pin there would reject the row it had just written, and the retry
  // it triggers is a SECOND MUTATION — on a Fast Groups row, a second toggle of the group.
  // Name + position is the level that holds.
  let callbacks = 0;
  const node = {
    id: 59,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [
      { name: "row", type: "string", value: "old-0", label: "before 0" },
      {
        name: "row",
        type: "string",
        value: "old-1",
        label: "before 1",
        callback() {
          callbacks += 1;
          node.widgets[0].label = `pass ${callbacks} row 0`;
          node.widgets[1].label = `pass ${callbacks} row 1`;
        },
      },
    ],
  };

  const res = await runSetWidget(node, "row", "new", { ...wiredDeps("DupRows"), occurrence: { index: 1 } });

  assert.equal(res.set.value, "new");
  assert.equal(node.widgets[1].value, "new");
  assert.equal(node.widgets[1].label, "pass 1 row 1", "the callback did relabel the row");
  assert.equal(callbacks, 1, "a relabel must not trigger a second write of the same row");
});

test("#2143: an end-to-end write to a bare duplicated name is unchanged, and discloses the row", async () => {
  const node = {
    id: 59,
    type: "DupRows",
    constructor: nodeCtor(),
    graph: { links: {} },
    widgets: [
      { name: "row", type: "string", value: "old-0" },
      { name: "row", type: "string", value: "old-1" },
    ],
  };

  const res = await runSetWidget(node, "row", "new", wiredDeps("DupRows"));

  assert.equal(node.widgets[0].value, "new");
  assert.equal(node.widgets[1].value, "old-1");
  assert.deepEqual(res.set.widget_occurrence, { index: 0, of: 2 });
});

// ---------------------------------------------------------------------------
// The CALL SITE — the plumbing above is inert unless the shipped handler uses it
// ---------------------------------------------------------------------------

const panelSource = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

test("#2143: the shipped graph_set_widget resolves the address BEFORE every name-keyed guard", () => {
  const handlerStart = panelSource.indexOf("  async graph_set_widget({");
  assert.ok(handlerStart >= 0, "could not locate the shipped graph_set_widget");
  // Bounded by the NEXT executor, not by a fixed window: a fixed slice silently stops
  // covering the handler the moment it grows, and every ordering assertion below then
  // passes because the guard it is about fell outside the text it read.
  const handlerEnd = panelSource.indexOf(`\n\n  // artokun/comfyui-mcp#938`, handlerStart);
  assert.ok(handlerEnd > handlerStart, "could not locate the end of the shipped graph_set_widget");
  const body = panelSource.slice(handlerStart, handlerEnd);

  const resolveAt = body.indexOf("resolveWidgetAddress(node, widget)");
  assert.ok(resolveAt > 0, "graph_set_widget does not resolve the widget address at all");
  // Every one of these keys on the widget NAME. Resolving a display label after any of them
  // would let a label-shaped address walk past a name-keyed safety refusal.
  for (const guard of [
    "classifyMiniMaxH3DirectorWrite(node, widget)",
    "classifyLtxTimelineWrite(node, widget)",
    "classifyRgthreeFastGroupsWrite(node, widget)",
    "deferredWidgetSafetyReason(node, widget",
  ]) {
    const at = body.indexOf(guard);
    assert.ok(at > 0, `guard not found in the shipped handler: ${guard}`);
    assert.ok(at > resolveAt, `${guard} runs BEFORE the address is resolved`);
  }
  // …and the resolved ordinal AND its pinned label are handed to the write, not merely
  // computed. The label is what makes a reorder across the handler's own await detectable.
  assert.match(body, /occurrence: widgetOccurrence,/);
});

test("#2143: runSetWidget forwards the ordinal to the write and to its own ack readback", () => {
  const setWidgetSource = readFileSync(
    new URL("../../web/js/lib/set-widget.js", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // applyWidgetWrite is the only thing that can select the row…
  assert.match(setWidgetSource, /applyWidgetWrite\(node, widgetName, value, \{[\s\S]*?\n\s*occurrence,/);
  // …and the #2025 timeout readback must consult the same row — WITH the same label pin —
  // or a write that timed out on one row can be acked from another row's value.
  assert.match(setWidgetSource, /readLiveWidgetValue\(node, widget, occurrence\)/);
  // The readback and the write must share ONE definition of what the index means. Two local
  // implementations is how they came to disagree in the first place.
  assert.match(setWidgetSource, /widgetAtOccurrence\(node, widgetName, occurrence\.index, occurrence\)/);
  // …and report which row it read.
  assert.match(setWidgetSource, /widget_occurrence: live\.widget \? widgetOccurrenceOf\(node, live\.widget\) : null/);
  // …and the ack WRAPPER must hand both halves of the address on. The readback can only
  // honour a pin it was given, so dropping either here is invisible to every test that
  // calls readLiveWidgetValue directly.
  assert.match(setWidgetSource, /occurrence: opts\.occurrence \?\? null,/);
});

test("#2143: the write resolves the row through the SHARED definition, not its own copy", () => {
  const widgetWriteSource = readFileSync(
    new URL("../../web/js/lib/widget-write.js", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // The defect the gate caught between rounds was two local implementations of "the i-th
  // one" drifting apart — the write moved to positions, the readback stayed on ordinals.
  // Keeping both call sites on the one exported rule is what stops them naming different
  // widgets again.
  assert.match(widgetWriteSource, /return widgetAtOccurrence\(node, wanted, occurrence\.index, occurrence\);/);
});
