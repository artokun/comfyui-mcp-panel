/**
 * #757 — `panel_set_widget` could not CREATE an rgthree Power Lora Loader row.
 *
 * The rows exist only after the user clicks "➕ Add Lora", a DOM-only control an agent
 * cannot activate, so every write to `lora_1` on a fresh node was refused for a widget no
 * tool could bring into existence.
 *
 * The load-bearing constraint is what this must NOT become. The panel deliberately refuses
 * to auto-press a pressable control, because a generic "press this node's button" rule
 * would mutate the graph on an ordinary TYPO — the overwhelmingly common reason a widget
 * name misses. Most of these tests exist to pin that the route cannot be reached by
 * anything but the real case.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isRgthreeLoraRowCreation,
  createRgthreeLoraRow,
  POWER_LORA_LOADER_TYPE,
} from "../../web/js/lib/rgthree-lora-row.js";
import { runSetWidget } from "../../web/js/lib/set-widget.js";

const SLOT = { on: true, lora: "x.safetensors", strength: 0.5, strengthTwo: null };

/**
 * A Power Lora Loader as it looks fresh from panel_add_node: no rows yet.
 *
 * Modelled on the pack's SHIPPED source (`rgthree-comfy/web/comfyui/power_lora_loader.js`),
 * which increments `this.loraWidgetsCounter` and only then derives the row name from it: the
 * increment happens first and is never undone by removing the row. `nextRow` says which row
 * the next mint produces; the counter itself therefore starts one BELOW it.
 *
 * `trackCounter: false` stands in for a pack build that keeps no counter we can read.
 */
function loader({ nextRow = 1, addNew = true, widgets = null, trackCounter = true } = {}) {
  const node = {
    id: 153,
    type: POWER_LORA_LOADER_TYPE,
    widgets: widgets ?? [
      { name: "divider" },
      { name: "PowerLoraLoaderHeaderWidget" },
      { name: "divider" },
      { name: "➕ Add Lora" },
    ],
    removeWidget(w) {
      const i = node.widgets.indexOf(w);
      if (i >= 0) node.widgets.splice(i, 1);
    },
    // The pack sizes its node from the row count, and `addNewLoraWidget` does NOT resize —
    // rgthree's own button recomputes the height right after calling it. Modelled so the
    // resize step (and its rollback) can be asserted rather than assumed.
    size: [200, 60],
    computeSize() {
      return [200, 60 + 20 * node.widgets.filter((w) => /^lora_\d+$/.test(w?.name ?? "")).length];
    },
  };
  let shadow = nextRow - 1; // used when the node exposes no readable counter
  if (trackCounter) node.loraWidgetsCounter = nextRow - 1;
  if (addNew) {
    // rgthree's real behaviour: a MONOTONIC counter, so names are not positional.
    node.addNewLoraWidget = () => {
      let n;
      if (trackCounter) n = ++node.loraWidgetsCounter;
      else n = ++shadow;
      node.widgets.push({ name: `lora_${n}`, value: { on: true, lora: null, strength: 1, strengthTwo: null } });
    };
  }
  return node;
}

// ---------------------------------------------------------------------------
// The classifier — three independent facts, all required
// ---------------------------------------------------------------------------

test("#757 the reported case classifies: right type, lora_N name, slot-shaped value", () => {
  assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", SLOT), true);
});

test("#757 a TYPO does not reach the creation route", () => {
  // The whole reason the panel refuses to auto-press a button. `strenght` or `lora1` or
  // `seed` must all get the ordinary refusal (and its pressable hint), never a new row.
  for (const name of ["lora1", "loras_1", "lora_", "seed", "strenght", "LORA_1", ""]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), name, SLOT), false, `name ${JSON.stringify(name)}`);
  }
});

test("#757 another node type never reaches it, even with a lora_N name and a slot value", () => {
  const other = { ...loader(), type: "LoraLoader" };
  assert.equal(isRgthreeLoraRowCreation(other, "lora_1", SLOT), false);
  const noType = { ...loader(), type: undefined, comfyClass: undefined };
  assert.equal(isRgthreeLoraRowCreation(noType, "lora_1", SLOT), false);
});

test("#757 a value that is not a lora slot never reaches it", () => {
  // A slot is minted to receive a row. Growing the node for a value the writer would then
  // refuse leaves a stray row behind and reports a failure — worse than refusing up front.
  for (const value of [null, undefined, 5, "x.safetensors", [], { on: true }, { on: true, lora: "a", strength: 1, extra: 1 }]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", value), false, `value ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// The shape the TOOL sends — a JSON string, not an object
// ---------------------------------------------------------------------------
//
// This is the defect that made the whole route dead code, and the reason it survived the
// first round of tests: `panel_set_widget` carries scalar values and `coerceWidgetValue`
// parses the composite at widget-write.js:508-512, well AFTER this classifier runs. Every
// test above hands in an OBJECT — the shape the tests chose, not the shape production uses.
// So each of these drives the STRING form deliberately.

test("#757 the value as the TOOL actually sends it — a JSON string — classifies", () => {
  assert.equal(
    isRgthreeLoraRowCreation(loader(), "lora_1", JSON.stringify(SLOT)),
    true,
    "this is the production shape; with it rejected the feature never fired at all",
  );
});

test("#757 every slot spelling the writer accepts also classifies as a string", () => {
  for (const slot of [
    { on: true, lora: "x.safetensors", strength: 0.5, strengthTwo: null },
    { on: false, lora: "nested/dir/y.safetensors", strength: 1, strengthTwo: 0.8 },
    { on: true, lora: "z.safetensors", strength: 0 },
  ]) {
    const asString = JSON.stringify(slot);
    assert.equal(
      isRgthreeLoraRowCreation(loader(), "lora_1", asString),
      isRgthreeLoraRowCreation(loader(), "lora_1", slot),
      `the string and object forms must agree for ${asString}`,
    );
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", asString), true, asString);
  }
});

test("#757 parsing does not WIDEN what counts as a slot", () => {
  // The string form is normalized, not trusted. Anything whose PARSE is not a slot is still
  // not a creation request — otherwise "any JSON string" would become a fourth way in, and
  // the typo guard is only as strong as its narrowest fact.
  for (const value of [
    "not json at all",
    "",
    "null",
    "5",
    '"x.safetensors"',
    "[]",
    '{"on":true}',
    '{"on":true,"lora":"a","strength":1,"extra":1}',
    '{"on":true,"lora":"a","strength":1,"strengthTwo":null,',
  ]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", value), false, `value ${JSON.stringify(value)}`);
  }
});

test("#757 a STRING value does not bypass the other two facts either", () => {
  const asString = JSON.stringify(SLOT);
  assert.equal(isRgthreeLoraRowCreation({ ...loader(), type: "LoraLoader" }, "lora_1", asString), false, "wrong type");
  assert.equal(isRgthreeLoraRowCreation(loader(), "strenght", asString), false, "typo name");
  const existing = loader();
  existing.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  assert.equal(isRgthreeLoraRowCreation(existing, "lora_1", asString), false, "row already present");
});

test("#757 an EXISTING row is left to the ordinary write path", () => {
  const n = loader();
  n.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  assert.equal(isRgthreeLoraRowCreation(n, "lora_1", SLOT), false, "minting over it would duplicate the row");
});

test("#757 the classifier is total — a hostile node answers false, never throws", () => {
  const hostile = {
    get type() {
      throw new TypeError("disposed");
    },
  };
  assert.doesNotThrow(() => isRgthreeLoraRowCreation(hostile, "lora_1", SLOT));
  assert.equal(isRgthreeLoraRowCreation(hostile, "lora_1", SLOT), false);
});

// ---------------------------------------------------------------------------
// Creation, and the post-verify that makes a pack-private call safe
// ---------------------------------------------------------------------------

test("#757 the reported case: the row is created and named", () => {
  const n = loader();
  const events = [];
  const r = createRgthreeLoraRow(n, "lora_1", {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirty: () => events.push("dirty"),
  });
  assert.equal(r.created, "lora_1");
  assert.equal(typeof r.remove, "function", "the caller must be able to take the row back out again");
  assert.ok(n.widgets.some((w) => w.name === "lora_1"), "the row now exists for the write that follows");
  assert.deepEqual(events, ["before", "after", "dirty"], "the mutation is bracketed for undo");
});

test("#757 a pack without addNewLoraWidget refuses LOUDLY, and changes nothing", () => {
  // Feature detection, as ltx-director.js does for its own pack-private entry point. A
  // renamed or dropped method must produce an actionable refusal, never a silent no-op.
  const n = loader({ addNew: false });
  const before = n.widgets.length;
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /does not expose addNewLoraWidget/);
  assert.equal(n.widgets.length, before);
});

test("#757 a call that adds NOTHING is caught — the effect is verified, not the call", () => {
  // The probe that motivated this file found pack callbacks that accept a call and create
  // nothing. Only comparing the widget list catches that.
  const n = loader();
  n.addNewLoraWidget = () => {};
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /ran but added no widget/);
});

test("#757 a pack method that THROWS is attributed to the pack", () => {
  const n = loader();
  n.addNewLoraWidget = () => {
    throw new Error("rgthree exploded");
  };
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /rgthree pack's own addNewLoraWidget\(\) threw \(rgthree exploded\)/);
});

test("#757 afterChange still runs when the pack method throws", () => {
  const n = loader();
  n.addNewLoraWidget = () => {
    throw new Error("boom");
  };
  const events = [];
  assert.throws(() =>
    createRgthreeLoraRow(n, "lora_1", {
      beforeChange: () => events.push("before"),
      afterChange: () => events.push("after"),
    }),
  );
  assert.deepEqual(events, ["before", "after"], "an unclosed beforeChange would corrupt the undo stack");
});

test("#757 a MONOTONIC counter: the wrong row is taken back out and the real name is named", () => {
  // rgthree's loraWidgetsCounter only ever increases, so after a row is removed the next
  // created row is NOT the removed name. A refusal that left the stray row behind could not
  // be safely retried.
  const n = loader({ nextRow: 7 });
  const before = n.widgets.length;
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_1", {}),
    /this node's next row is "lora_7", not "lora_1"[\s\S]*has been removed again/,
  );
  assert.equal(n.widgets.length, before, "nothing is left behind");
  assert.ok(!n.widgets.some((w) => w.name === "lora_7"), "including the row it minted");
});

test("#757 the refusal's remedy actually WORKS — the row counter is rewound too", () => {
  // The defect this pins: `addNewLoraWidget` increments the counter BEFORE it names the row,
  // and removing the row does not undo the increment. Rolling back only the widget left a
  // refusal that said `nothing was changed. Set "lora_7" instead` having already moved the
  // next name to lora_8 — so obeying it refused again, one name further along, forever.
  // Measured before it was fixed; this is the assertion that would have caught it.
  const n = loader({ nextRow: 7 });
  let named = null;
  try {
    createRgthreeLoraRow(n, "lora_1", {});
    assert.fail("expected a refusal");
  } catch (err) {
    named = err.message.match(/next row is "(lora_\d+)"/)?.[1];
    assert.match(err.message, /counter was rewound/);
  }
  assert.equal(named, "lora_7");
  assert.equal(n.loraWidgetsCounter, 6, "the increment the refusal undid");
  // Doing exactly what the refusal said must succeed. A remedy that cannot be obeyed is
  // worse than no remedy: it reads as actionable and costs a row name on every attempt.
  assert.equal(createRgthreeLoraRow(n, named, {}).created, "lora_7");
});

test("#757 a call that adds nothing does not silently burn a row name either", () => {
  const n = loader({ nextRow: 4 });
  n.addNewLoraWidget = () => {
    n.loraWidgetsCounter++; // incremented, then whatever appends the row failed
  };
  assert.throws(() => createRgthreeLoraRow(n, "lora_4", {}), /ran but added no widget/);
  assert.equal(n.loraWidgetsCounter, 3, "'nothing was changed' includes the counter");
});

test("#757 a pack with no readable counter is told the truth, not an unusable remedy", () => {
  // Nothing can be rewound here, so `lora_9` really is used up. Promising "set lora_9
  // instead" would be advice that cannot work — name the state instead.
  const n = loader({ nextRow: 9, trackCounter: false });
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_2", {}),
    /next row is "lora_9"[\s\S]*could not be rewound[\s\S]*"lora_9" is now used up/,
  );
  assert.ok(!("loraWidgetsCounter" in n), "no counter was invented on the node");
});

test("#757 the counter is NOT rewound while the stray row is still on the node", () => {
  // Rewinding past a name a surviving row still holds would point the next mint at a
  // duplicate — a worse outcome than the burnt name.
  const n = loader({ nextRow: 5 });
  n.removeWidget = () => {}; // a node that protects its rows
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /could not be rewound/);
  assert.equal(n.loraWidgetsCounter, 5, "left alone, because lora_5 is still there");
  assert.ok(n.widgets.some((w) => w.name === "lora_5"));
});

test("#757 the stray row is removed even on a node with no removeWidget method", () => {
  const n = loader({ nextRow: 9 });
  delete n.removeWidget;
  const before = n.widgets.length;
  assert.throws(() => createRgthreeLoraRow(n, "lora_2", {}), /next row is "lora_9"/);
  assert.equal(n.widgets.length, before, "the splice fallback still cleans up");
});

test("#757 consecutive creates work: lora_1 then lora_2", () => {
  const n = loader();
  assert.equal(createRgthreeLoraRow(n, "lora_1", {}).created, "lora_1");
  assert.equal(createRgthreeLoraRow(n, "lora_2", {}).created, "lora_2");
  assert.deepEqual(
    n.widgets.map((w) => w.name).filter((x) => x.startsWith("lora_")),
    ["lora_1", "lora_2"],
  );
});

// ---------------------------------------------------------------------------
// `remove` — the undo the caller needs when the write it made room for refuses
// ---------------------------------------------------------------------------

test("#757 remove() takes the created row back out", () => {
  const n = loader();
  const before = n.widgets.map((w) => w.name);
  createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.deepEqual(n.widgets.map((w) => w.name), before, "the node is back to what it was");
});

test("#757 remove() rewinds the row counter as well as the row", () => {
  // The same trap the mismatch refusal hit: addNewLoraWidget increments BEFORE it names, so
  // dropping only the widget leaves the number spent and the next mint lands further along.
  // A rolled-back write must not cost the node a row name.
  const n = loader({ nextRow: 1 });
  assert.equal(n.loraWidgetsCounter, 0);
  createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.equal(n.loraWidgetsCounter, 0, "the increment the rollback undid");
  // And the proof that it matters: the next create must be able to mint lora_1 again.
  assert.equal(createRgthreeLoraRow(n, "lora_1", {}).created, "lora_1");
});

test("#757 remove() will not rewind past a row that is still there", () => {
  // Rewinding while the name is still held would point the next mint at a duplicate.
  const n = loader({ nextRow: 3 });
  const made = createRgthreeLoraRow(n, "lora_3", {});
  n.removeWidget = () => {}; // a node that refuses to give the row up
  made.remove();
  assert.equal(n.loraWidgetsCounter, 3, "left alone, because lora_3 survived");
  assert.ok(n.widgets.some((w) => w.name === "lora_3"));
});

test("#757 remove() targets the row BY IDENTITY, not by name", () => {
  // rgthree's configure() re-mints rows from serialized order, so `lora_1` after an undo is
  // not necessarily the widget this call grew. Removing by name would take out a stranger.
  const n = loader();
  const made = createRgthreeLoraRow(n, "lora_1", {});
  const mine = n.widgets.find((w) => w.name === "lora_1");
  n.widgets = n.widgets.filter((w) => w !== mine);
  const impostor = { name: "lora_1", value: { on: true, lora: "someone-elses.safetensors", strength: 1 } };
  n.widgets.push(impostor);
  made.remove();
  assert.ok(n.widgets.includes(impostor), "the row that answers to the name now is not ours to remove");
});

test("#757 the node GROWS to fit the row, as the pack's own button does", () => {
  // `addNewLoraWidget` only mints, appends and reorders. rgthree's ➕ Add Lora callback
  // recomputes the height itself right afterwards; marking the canvas dirty just repaints, so
  // without this the new row is clipped or drawn over the button until some later edit.
  const n = loader();
  const heightBefore = n.size[1];
  createRgthreeLoraRow(n, "lora_1", {});
  assert.ok(n.size[1] > heightBefore, `the node grew (${heightBefore} -> ${n.size[1]})`);
  assert.equal(n.size[1], n.computeSize()[1], "to exactly what the pack would compute");
});

test("#757 the node's size is put back when the creation is rolled back", () => {
  const n = loader();
  const sizeBefore = [...n.size];
  createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.deepEqual([...n.size], sizeBefore, "a rolled-back creation leaves no stretched node behind");
});

test("#757 a node that cannot measure itself is still created on", () => {
  const n = loader();
  delete n.computeSize;
  assert.equal(createRgthreeLoraRow(n, "lora_1", {}).created, "lora_1", "the resize is best-effort, not a gate");
});

test("#757 remove() will not rewind past a counter somebody else advanced", () => {
  // Create lora_1, let another edit add lora_2, then roll back. Rewinding to `counterBefore`
  // would re-issue lora_1 AND lora_2 — the second a DUPLICATE of a row still on the node.
  const n = loader({ nextRow: 1 });
  const made = createRgthreeLoraRow(n, "lora_1", {});
  n.addNewLoraWidget(); // an unrelated addition while our write was in flight
  assert.equal(n.loraWidgetsCounter, 2);
  made.remove();
  assert.equal(n.loraWidgetsCounter, 2, "the counter now covers a row that is not ours to un-name");
  n.addNewLoraWidget();
  const names = n.widgets.map((w) => w.name).filter((x) => /^lora_/.test(x));
  assert.equal(new Set(names).size, names.length, `no duplicate row names: ${names.join(", ")}`);
});

test("#757 a pack method that throws PART-WAY is cleaned up, not just reported", () => {
  // The shipped method is `loraWidgetsCounter++` FIRST, then construct, append and move. A
  // throw in any later step can burn the number and leave the row. Saying "nothing was added"
  // without looking would be asserting something never checked.
  const n = loader({ nextRow: 1 });
  n.addNewLoraWidget = () => {
    n.loraWidgetsCounter += 1;
    n.widgets.push({ name: `lora_${n.loraWidgetsCounter}`, value: { on: true, lora: null, strength: 1 } });
    throw new Error("moveArrayItem blew up");
  };
  const namesBefore = n.widgets.map((w) => w.name);
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /addNewLoraWidget\(\) threw \(moveArrayItem blew up\)/);
  assert.deepEqual(n.widgets.map((w) => w.name), namesBefore, "the half-added row was taken back out");
  assert.equal(n.loraWidgetsCounter, 0, "and the number it had already spent was returned");
});

test("#757 an UNKNOWN counter is reported as an incomplete rollback, not a clean one", () => {
  // A pack that exposes no readable counter still has one, and the shipped method increments
  // it BEFORE it constructs — so a throw has probably already spent a row name. Saying
  // "nothing was changed" there tells the caller a retry is safe when it is not, which is
  // exactly the unfollowable advice the mismatch refusal already had to stop giving.
  const n = loader({ nextRow: 1, trackCounter: false });
  n.addNewLoraWidget = () => {
    throw new Error("boom"); // a private counter may already have moved
  };
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_1", {}),
    /row counter could not be read, so it may have consumed a row name before it threw/,
  );
});

test("#757 an UNKNOWN counter also makes 'added no widget' an incomplete rollback", () => {
  const n = loader({ nextRow: 1, trackCounter: false });
  n.addNewLoraWidget = () => {}; // accepted the call, added nothing, counter unknowable
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_1", {}),
    /ran but added no widget[\s\S]*could not be read, so the call may still have consumed a row name/,
  );
});

test("#757 a KNOWN counter that came back really does report a clean rollback", () => {
  // The other side of the same rule — the honest "nothing was changed" must still be reachable.
  const n = loader({ nextRow: 1 });
  n.addNewLoraWidget = () => {
    n.loraWidgetsCounter += 1; // spent, but we can see it and put it back
  };
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /ran but added no widget\. Nothing was changed\./);
  assert.equal(n.loraWidgetsCounter, 0);
});

test("#757 a pack throw whose damage could NOT be undone says so", () => {
  const n = loader({ nextRow: 1 });
  n.addNewLoraWidget = () => {
    n.loraWidgetsCounter += 1;
    n.widgets.push({ name: `lora_${n.loraWidgetsCounter}`, value: { on: true, lora: null, strength: 1 } });
    throw new Error("boom");
  };
  n.removeWidget = () => {}; // and the node will not give the row up
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_1", {}),
    /had already changed the node before it threw, and that could not be fully undone \(lora_1 is still on the node\)/,
  );
});

test("#757 remove() never throws, whatever the node does", () => {
  const n = loader();
  const made = createRgthreeLoraRow(n, "lora_1", {});
  n.removeWidget = () => {
    throw new Error("disposed");
  };
  assert.doesNotThrow(() => made.remove(), "an undo on an error path must not replace the refusal");
});

// ---------------------------------------------------------------------------
// The panel wiring
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

const SET_WIDGET_LIB_SRC = readFileSync(new URL("../../web/js/lib/set-widget.js", import.meta.url), "utf8");

test("#757 NO AWAIT separates the creation from the write", () => {
  // The rule the whole feature now rests on. `write()` is runSetWidget's synchronous
  // boundary: fence, then prepareWriteTarget, then applyWidgetWrite, then the undo on
  // failure — with nothing awaited in between. An `await` anywhere in that stretch reopens
  // every window this design closes: a transient row visible to an undo capture, to a
  // concurrent command frame, and to the user's own hands.
  const start = SET_WIDGET_LIB_SRC.indexOf("const write = (extra = {}) => {");
  assert.notEqual(start, -1, "could not locate the write boundary");
  const end = SET_WIDGET_LIB_SRC.indexOf("\n  };", start);
  const body = SET_WIDGET_LIB_SRC.slice(start, end);
  assert.match(body, /prepareWriteTarget\(\)/, "the creation hook is invoked here");
  assert.match(body, /applyWidgetWrite\(/, "…and the write immediately follows it");
  assert.match(body, /prepared\?\.undo\?\.\(\)/, "…and the undo is in the same stretch");
  // Comments in this block DISCUSS the await that used to be here, so judge the code only.
  const code = body.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bawait\b/.test(code), `no await may appear between them:\n${code}`);
});

test("#757 the creation runs AFTER the workflow fence", () => {
  // A row must never be grown on a canvas the caller did not address (#570/#718). The fence
  // is runSetWidget's own, re-checked at the write boundary, so the creation is now behind
  // the SAME check the write is.
  const start = SET_WIDGET_LIB_SRC.indexOf("const write = (extra = {}) => {");
  const body = SET_WIDGET_LIB_SRC.slice(start, SET_WIDGET_LIB_SRC.indexOf("\n  };", start));
  const fence = body.indexOf("assertTargetStillCurrentNow()");
  const mint = body.indexOf("prepareWriteTarget()");
  // Both anchors must EXIST before their order means anything: `indexOf` returns -1 for a
  // line that was deleted, and -1 < anything reads exactly like a pass. A fence that is gone
  // is a worse failure than a fence in the wrong place.
  assert.notEqual(fence, -1, "the write boundary still re-checks the workflow fence");
  assert.notEqual(mint, -1, "the write boundary still invokes the creation hook");
  assert.ok(fence < mint, "the fence runs before the mutation");
});

// ---------------------------------------------------------------------------
// The write boundary itself — the REAL runSetWidget, driven
// ---------------------------------------------------------------------------
//
// The executor tests above stub runSetWidget, so they verify the panel's HALF of the
// contract against a model of the other half. That model could agree with a set-widget.js
// that no longer honours it. These drive the shipped runSetWidget directly, the way
// set-widget-refresh.test.mjs does, so the hook's actual ordering, its rollback and its
// behaviour across the retry await are verified rather than assumed.

const BOUNDARY_REGISTRY = { KSampler: {} };
const boundaryOracle = { getFreshObjectInfo: async () => ({ KSampler: {} }) };

/**
 * A node whose write target DOES NOT EXIST until the hook mints it — the shape #757 needs.
 * `prepareWriteTarget` is the only thing that can bring "made" into existence, so any write
 * that lands proves the hook ran first, and any surviving widget proves it was not undone.
 */
function boundaryFixture(widget = { name: "made", type: "text", value: "" }) {
  const node = { id: 7, type: "KSampler", widgets: [] };
  const seen = { prepared: 0, undone: 0 };
  const prepareWriteTarget = () => {
    // Idempotent exactly as the panel's hook is: the classifier there requires the row to be
    // ABSENT, and a retry re-enters this after the first attempt undid its work.
    if (node.widgets.includes(widget)) return null;
    seen.prepared += 1;
    node.widgets.push(widget);
    return {
      undo: () => {
        seen.undone += 1;
        node.widgets = node.widgets.filter((w) => w !== widget);
      },
    };
  };
  return { node, widget, seen, prepareWriteTarget };
}

test("#757 boundary: the hook mints the target and the write lands on it", async () => {
  const { node, seen, prepareWriteTarget } = boundaryFixture();
  const res = await runSetWidget(node, "made", "hello", {
    registry: BOUNDARY_REGISTRY,
    ...boundaryOracle,
    prepareWriteTarget,
  });
  assert.equal(seen.prepared, 1);
  assert.equal(seen.undone, 0, "a write that succeeded is never rolled back");
  assert.equal(res.set.value, "hello");
  assert.equal(node.widgets[0].value, "hello", "the write landed on the widget the hook created");
});

test("#757 boundary: the fence refuses BEFORE the hook can mint anything", async () => {
  // The user switched workflow tabs while /object_info was in flight. The refusal must
  // arrive over a node this command never touched. End-to-end, and therefore satisfied by
  // whichever fence fires first — the isolating version is the next test.
  const { node, seen, prepareWriteTarget } = boundaryFixture();
  await assert.rejects(
    () =>
      runSetWidget(node, "made", "hello", {
        registry: BOUNDARY_REGISTRY,
        ...boundaryOracle,
        prepareWriteTarget,
        assertTargetStillCurrent: () => {
          throw new Error("the workflow changed while this write was in flight");
        },
      }),
    /the workflow changed/,
  );
  assert.equal(seen.prepared, 0, "nothing was minted on the stale canvas");
  assert.deepEqual(node.widgets, [], "and the node is exactly as it was found");
});

test("#757 boundary: the write boundary re-checks the fence on its OWN account", async () => {
  // WHY THE TEST ABOVE IS NOT ENOUGH. A direct node ALWAYS reconciles
  // (preflightSetWidgetTarget returns `{reconcile: true}` for any node without a `subgraph`),
  // and reconcile runs a fence check of its own well before the write boundary. A fence that
  // throws on sight is therefore caught by that earlier check, and deleting the boundary's
  // own re-check would leave the previous test green while reopening the exact #718 window
  // the re-check exists for.
  //
  // So the user is still on the right canvas when reconcile asks, and has switched tabs by
  // the time the write boundary asks. Only a fence AT the boundary refuses this.
  const { node, seen, prepareWriteTarget } = boundaryFixture();
  let fenceCalls = 0;
  await assert.rejects(
    () =>
      runSetWidget(node, "made", "hello", {
        registry: BOUNDARY_REGISTRY,
        ...boundaryOracle,
        prepareWriteTarget,
        assertTargetStillCurrent: () => {
          fenceCalls += 1;
          if (fenceCalls > 1) throw new Error("the workflow changed while this write was in flight");
        },
      }),
    /the workflow changed/,
  );
  assert.equal(fenceCalls, 2, "the write boundary asked again, on its own account");
  assert.equal(seen.prepared, 0, "and nothing was minted on the canvas the user had left");
  assert.deepEqual(node.widgets, [], "…so the refusal arrives over an untouched node");
});

test("#757 boundary: a REFUSED write undoes what the hook prepared", async () => {
  // A combo value the list does not contain, with no refresh wired: applyWidgetWrite refuses,
  // and the refusal must be reported over the node the command started from.
  const { node, seen, prepareWriteTarget } = boundaryFixture({
    name: "made",
    type: "combo",
    options: { values: ["a"] },
    value: "a",
  });
  await assert.rejects(
    () =>
      runSetWidget(node, "made", "nope", {
        registry: BOUNDARY_REGISTRY,
        ...boundaryOracle,
        prepareWriteTarget,
      }),
    /panel_set_widget refused "made"/,
  );
  assert.equal(seen.prepared, 1);
  assert.equal(seen.undone, 1, "the refusal took the prepared target back out");
  assert.deepEqual(node.widgets, [], "and left the node as it found it");
});

test("#757 boundary: an undo that THROWS never replaces the refusal that caused it", async () => {
  const node = { id: 7, type: "KSampler", widgets: [] };
  await assert.rejects(
    () =>
      runSetWidget(node, "made", "nope", {
        registry: BOUNDARY_REGISTRY,
        ...boundaryOracle,
        prepareWriteTarget: () => {
          node.widgets.push({ name: "made", type: "combo", options: { values: ["a"] }, value: "a" });
          return {
            undo: () => {
              throw new Error("the undo itself blew up");
            },
          };
        },
      }),
    /panel_set_widget refused "made"/,
    "the caller hears why the WRITE was refused, not why the cleanup failed",
  );
});

test("#757 boundary: nothing the hook made survives ACROSS the retry await", async () => {
  // THE RULE, stated where it can actually be broken. The stale-combo recovery awaits
  // `refreshCombos` between two write attempts. If the first attempt's creation were not
  // undone before that await, a transient widget would sit in the live graph across a network
  // request — the exact window that produced every P1 this feature has had. So the first
  // attempt must roll back, the node must be EMPTY while the refresh is in flight, and the
  // retry must mint it again from scratch.
  const { node, widget, seen, prepareWriteTarget } = boundaryFixture({
    name: "made",
    type: "combo",
    options: { values: ["a"] },
    value: "a",
  });
  let widgetsDuringRefresh = null;
  const res = await runSetWidget(node, "made", "b", {
    registry: BOUNDARY_REGISTRY,
    ...boundaryOracle,
    prepareWriteTarget,
    // The authoritative list now carries "b". Written through the captured widget rather than
    // by looking it up on the node, BECAUSE the node no longer has it — the first attempt's
    // rollback is exactly what this test is asserting.
    refreshCombos: async () => {
      widgetsDuringRefresh = node.widgets.map((w) => w.name);
      await Promise.resolve();
      widget.options.values.push("b");
    },
  });
  assert.deepEqual(widgetsDuringRefresh, [], "no half-made target may sit in the graph across the await");
  assert.equal(seen.undone, 1, "the first attempt rolled its creation back");
  assert.equal(seen.prepared, 2, "and the retry minted it again inside its own synchronous stretch");
  assert.equal(res.set.value, "b");
  assert.equal(res.refreshed, true);
});

test("#757 the panel mints the row ONLY inside the write-boundary hook", () => {
  // The regression that produced three separate P1s. A creation reached from the executor's
  // OWN statements runs before `await runSetWidget(...)` and therefore before
  // `await getFreshObjectInfo()` — a live graph mutation left sitting across a network
  // request. Textual order cannot express that (the options object is written above the call
  // it is passed to), so the rule is stated structurally instead: the single creation site
  // lives inside `prepareWriteTarget`, which only runSetWidget's synchronous write boundary
  // ever calls. Anything outside that hook is the old shape coming back.
  const sw = PANEL_SRC.slice(PANEL_SRC.indexOf("async graph_set_widget("));
  const body = sw.slice(0, sw.indexOf("async graph_remove_widget("));
  assert.equal(body.split("createRgthreeLoraRow(").length - 1, 1, "exactly one creation site in the command");
  const hookStart = body.indexOf("      prepareWriteTarget: () => {");
  assert.notEqual(hookStart, -1, "could not locate the write-boundary hook");
  const hookEnd = body.indexOf("\n      },", hookStart);
  assert.ok(hookEnd > hookStart, "could not locate the end of the hook");
  const hook = body.slice(hookStart, hookEnd);
  assert.match(hook, /createRgthreeLoraRow\(node, widget, \{/, "the creation is inside the hook");
  const outsideTheHook = body.slice(0, hookStart) + body.slice(hookEnd);
  assert.ok(
    !outsideTheHook.includes("createRgthreeLoraRow("),
    "createRgthreeLoraRow may only be reached from prepareWriteTarget, never from the command's own flow",
  );
});

test("#757 the created row is disclosed on its own field, not in `warning`", () => {
  assert.match(PANEL_SRC, /created_widget: createdLoraRow/);
  const sw = PANEL_SRC.slice(PANEL_SRC.indexOf("async graph_set_widget("));
  const body = sw.slice(0, sw.indexOf("async graph_remove_widget("));
  assert.ok(!/warning:[^\n]*createdLoraRow/.test(body), "it must not displace a warning about the write");
});

// ---------------------------------------------------------------------------
// The executor itself — the SHIPPED method, extracted and run
// ---------------------------------------------------------------------------
//
// Source-text assertions cannot answer the two questions review actually asked: does a
// REFUSED write leave the row behind, and is create+assign ONE undo step? Both are about
// what happens at runtime across a rejected await. So the real `graph_set_widget` is pulled
// out of the panel and run against doubles, the way graph-edit-node.test.mjs does — the
// implementation is verified, never a copy of it.

const SET_WIDGET_SRC = (() => {
  const m = PANEL_SRC.match(/ {2}async graph_set_widget\(\{ node_id, widget, value, workflow_uuid \}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(m, "could not locate graph_set_widget in the panel source");
  return m[0];
})();

/** Every free name the extracted method can reach. Injected, so nothing resolves to a global. */
const EXECUTOR_DEPS = [
  "getGraphCtx",
  "resolveNode",
  "classifyLtxTimelineWrite",
  "derivedTimelineRefusal",
  "applyLtxTimelineWrite",
  "classifyPromptRelayTimelineWrite",
  "promptRelayDerivedRefusal",
  "applyPromptRelayTimelineWrite",
  "classifyRgthreeFastGroupsWrite",
  "rgthreeFastGroupsRefusal",
  "awaitObjectInfoHistorySeed",
  "isRgthreeLoraRowCreation",
  "createRgthreeLoraRow",
  "assertActiveWorkflowCommandTarget",
  "WORKFLOW_UUID_FIELD",
  "runSetWidget",
  "objectInfoCache",
  "CACHE_OUTCOME",
  "fetchWholeObjectInfo",
  "api",
  "backendReconnectEpoch",
  "objectInfoSnapshot",
  "recordObjectInfoTypes",
  "objectInfoOracleFailureNote",
  "comfyBackendSocketDown",
  "objectInfoHistory",
  "sourceForSubgraphInput",
  "refreshComboOptionsFromDefs",
  "refreshComfyNodeDefs",
  "clearStaleRedFlag",
  "snapshotAuthorizationNote",
];

/**
 * A graph that delivers undo bookkeeping the way LiteGraph and ChangeTracker really do.
 *
 * Both halves are modelled from the shipped frontend bundle, because the interesting failure
 * lives in the seam between them:
 *
 *   LGraph:        `beforeChange(){ …; this.canvasAction(c => c.onBeforeChange?.(this)) }`
 *                  `canvasAction(cb){ const l = this.list_of_graphcanvas; if (l) for (const c of l) cb(c) }`
 *   ChangeTracker: `beforeChange(){ this.changeCount++ }`
 *                  `afterChange(){ --this.changeCount || this.captureCanvasState() }`
 *
 * So the hooks reach the tracker only through ATTACHED canvases. Detach the graph — which is
 * exactly what switching workflow tabs or leaving a subgraph does — and a close reaches
 * nobody, leaving the tracker at 1 forever: `--this.changeCount` never returns 0 again and NO
 * later edit in that workflow is ever captured. `detachCanvas()` reproduces it.
 *
 * Nested pairs collapse into one captured state, and an unmatched close would drive the count
 * negative — which is truthy, so the capture never fires at all. That is why `onAfterChange`
 * throws rather than going below zero.
 */
function trackedGraph(node) {
  const tracker = {
    changeCount: 0,
    /** One entry per undo step the tracker would record: the widget names at that moment. */
    captures: [],
    onBeforeChange() {
      tracker.changeCount += 1;
    },
    onAfterChange() {
      tracker.changeCount -= 1;
      if (tracker.changeCount < 0) {
        throw new Error("afterChange() without a matching beforeChange() — the undo entry would be lost");
      }
      if (tracker.changeCount === 0) tracker.captures.push(g.node.widgets.map((w) => w.name));
    },
  };
  const canvas = {
    onBeforeChange: () => tracker.onBeforeChange(),
    onAfterChange: () => tracker.onAfterChange(),
  };
  const g = {
    node,
    tracker,
    list_of_graphcanvas: [canvas],
    log: [],
    beforeChange() {
      g.log.push("before");
      for (const c of g.list_of_graphcanvas) c.onBeforeChange?.(g);
    },
    afterChange() {
      g.log.push("after");
      for (const c of g.list_of_graphcanvas) c.onAfterChange?.(g);
    },
    setDirtyCanvas() {
      g.log.push("dirty");
    },
    /** The user switched workflow tabs, or left the subgraph. */
    detachCanvas() {
      g.list_of_graphcanvas = [];
    },
  };
  return g;
}

/**
 * Stands in for runSetWidget, modelling the shape that matters: an AWAITED authorization
 * phase, then a synchronous write boundary where `prepareWriteTarget` mints a missing target,
 * the write runs inside its own beforeChange/afterChange pair, and a refusal undoes the
 * preparation before it propagates.
 */
function stubRunSetWidget({ fail = null, result = { ok: true } } = {}) {
  const fn = async (n, widgetName, v, opts) => {
    fn.calls.push({ node: n, widget: widgetName, value: v });
    await Promise.resolve(); // the /object_info fetch
    // A preparation that REFUSES propagates from here without the write ever being attempted,
    // exactly as it does in the real one (the hook is called before applyWidgetWrite's try).
    const prepared = opts.prepareWriteTarget?.() ?? null;
    fn.writes += 1;
    // The real one brackets its write and fires afterChange BEFORE the #240 read-back
    // verification that can still reject — so a refusal arrives with its own pair closed.
    opts.beforeChange?.();
    opts.afterChange?.();
    if (fail) {
      prepared?.undo?.();
      throw fail;
    }
    return result;
  };
  fn.calls = [];
  /** Write ATTEMPTS — the calls that got past `prepareWriteTarget`, not merely into the body. */
  fn.writes = 0;
  return fn;
}

function executor(node, overrides = {}) {
  const graph = overrides.graph ?? trackedGraph(node);
  const deps = {
    getGraphCtx: () => ({ app: { canvas: null }, graph, LG: { registered_node_types: {} }, rootGraph: graph }),
    resolveNode: () => node,
    classifyLtxTimelineWrite: () => null,
    classifyPromptRelayTimelineWrite: () => null,
    classifyRgthreeFastGroupsWrite: () => null,
    awaitObjectInfoHistorySeed: async () => {},
    // The REAL classifier and creator: a double here would let the executor pass against a
    // route that never fires, which is precisely the defect under test.
    isRgthreeLoraRowCreation,
    createRgthreeLoraRow,
    assertActiveWorkflowCommandTarget: () => {},
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    runSetWidget: overrides.runSetWidget ?? stubRunSetWidget(),
    clearStaleRedFlag: () => {},
    objectInfoHistory: { wasTypeEverDefined: () => true },
    ...overrides,
  };
  const factory = new Function(
    ...EXECUTOR_DEPS,
    `const GRAPH_TOOL_EXECUTORS = { ${SET_WIDGET_SRC} }; return GRAPH_TOOL_EXECUTORS.graph_set_widget;`,
  );
  const run = factory(...EXECUTOR_DEPS.map((name) => deps[name]));
  return { run, graph, runSetWidget: deps.runSetWidget };
}

/** The production value shape: a JSON string, not an object. */
const SLOT_JSON = JSON.stringify(SLOT);

test("#757 executor: create + assign is ONE undo step", async () => {
  // The creation is deliberately NOT bracketed. ChangeTracker captures whole-graph snapshots,
  // not deltas, so the pair runSetWidget opens for the write closes with the row already
  // present — and that single entry covers the creation and the assign together.
  const node = loader();
  const { run, graph } = executor(node);
  const reply = await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(reply.created_widget, "lora_1", "the structural change is disclosed");
  assert.ok(node.widgets.some((w) => w.name === "lora_1"));
  assert.equal(graph.tracker.changeCount, 0, "the transaction is balanced");
  assert.equal(
    graph.tracker.captures.length,
    1,
    "two captures would be two Ctrl+Z, the first of which leaves a default row behind",
  );
  assert.ok(graph.tracker.captures[0].includes("lora_1"), "and the one undo step covers the created row");
});

test("#757 executor: the row does not exist while the write is still awaiting", async () => {
  // THE RULE THE WHOLE DESIGN RESTS ON. Creating the row before runSetWidget left a live
  // graph mutation sitting across a network request, and all three of this feature's P1s
  // came out of that one window: an undo transaction that could never be closed if the user
  // switched tabs, a concurrent frame whose write got rolled back under it, and a user's own
  // hand-edit exposed to an unrelated rollback. A row visible HERE is that window reopening.
  const node = loader();
  let rowDuringAwait = null;
  const runSetWidget = async (n, w, v, opts) => {
    rowDuringAwait = node.widgets.some((x) => x.name === "lora_1");
    await Promise.resolve(); // the /object_info fetch
    const prepared = opts.prepareWriteTarget?.() ?? null;
    opts.beforeChange?.();
    opts.afterChange?.();
    assert.ok(prepared, "the creation happens at the write boundary, not before the call");
    return { ok: true };
  };
  const { run } = executor(node, { runSetWidget });
  const reply = await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(rowDuringAwait, false, "no transient row may sit in the graph across the await");
  assert.equal(reply.created_widget, "lora_1", "and it is created by the time the write runs");
});

test("#757 executor: a workflow switch during the await cannot wedge the undo history", async () => {
  // LiteGraph delivers beforeChange / afterChange through ATTACHED canvases, so a
  // transaction opened before the /object_info await and closed after it reaches no canvas
  // at all once the user switches tabs — and the tracker then sits at 1 forever, so NO
  // further edit in that workflow is ever captured for undo, for the rest of the session.
  // Nothing in this command may open a transaction it awaits across.
  const node = loader();
  const graph = trackedGraph(node);
  const runSetWidget = async (n, w, v, opts) => {
    graph.detachCanvas(); // the user switched tabs while /object_info was in flight
    const prepared = opts.prepareWriteTarget?.() ?? null;
    opts.beforeChange?.();
    opts.afterChange?.();
    prepared?.undo?.();
    throw new Error("the workflow changed while this write was in flight");
  };
  const { run } = executor(node, { graph, runSetWidget });
  await assert.rejects(() => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.equal(
    graph.tracker.changeCount,
    0,
    "a tracker left above zero stops capturing undo snapshots for the whole session",
  );
});

test("#757 executor: a fence that refuses at the write boundary creates nothing", async () => {
  // The creation sits behind runSetWidget's own workflow fence. If the user switched tabs
  // during the fetch, the refusal must arrive over an untouched node.
  const node = loader();
  const before = node.widgets.map((w) => w.name);
  const runSetWidget = async (n, w, v, opts) => {
    await Promise.resolve();
    throw new Error("the workflow changed"); // the fence fires before prepareWriteTarget
  };
  const { run } = executor(node, { runSetWidget });
  await assert.rejects(() => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.deepEqual(node.widgets.map((w) => w.name), before, "nothing was grown on the stale canvas");
});

test("#757 executor: a REFUSED write takes the row back out", async () => {
  // runSetWidget can still refuse after the row exists — a removed pack, invalid slot fields,
  // a workflow switched mid-await, the #240 read-back rollback. Reporting that over a graph
  // this command had already grown is mutate-then-refuse, and every retry adds another row.
  const node = loader();
  const before = node.widgets.map((w) => w.name);
  const refusal = new Error("value is not a valid option");
  const { run, graph } = executor(node, { runSetWidget: stubRunSetWidget({ fail: refusal }) });
  await assert.rejects(
    () => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }),
    /value is not a valid option/,
    "the refusal reaches the caller unchanged",
  );
  assert.deepEqual(node.widgets.map((w) => w.name), before, "and the node is back to what it was");
});

test("#757 executor: a refused write rewinds the row counter too", async () => {
  // The counter is the half of the mutation that is easy to miss: addNewLoraWidget increments
  // BEFORE it names the row, so removing the widget alone still spends the name and the next
  // attempt lands on lora_2 — the retry loop the mismatch refusal already had to fix.
  const node = loader({ nextRow: 1 });
  assert.equal(node.loraWidgetsCounter, 0);
  const { run } = executor(node, { runSetWidget: stubRunSetWidget({ fail: new Error("nope") }) });
  await assert.rejects(() => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.equal(node.loraWidgetsCounter, 0, "the refused attempt cost the node nothing");
  // The retry the caller will actually make must now succeed under the SAME name.
  const second = executor(node);
  const reply = await second.run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(reply.created_widget, "lora_1", "retrying the same request works, rather than drifting to lora_2");
});

test("#757 executor: a refused write is balanced and leaves the graph as it found it", async () => {
  const node = loader();
  const before = node.widgets.map((w) => w.name);
  const { run, graph } = executor(node, { runSetWidget: stubRunSetWidget({ fail: new Error("nope") }) });
  await assert.rejects(() => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.equal(graph.tracker.changeCount, 0, "every transaction opened is closed, even on the error path");
  assert.deepEqual(node.widgets.map((w) => w.name), before, "and the row is gone again");
});

test("#757 executor: an ordinary write opens no transaction of its own", async () => {
  // Everything that is not a creation must be untouched by this route — including the undo
  // bookkeeping, which runSetWidget owns on that path.
  const node = loader();
  node.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  const { run, graph } = executor(node);
  const reply = await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(reply.created_widget, undefined, "nothing was created, so nothing is disclosed");
  assert.deepEqual(graph.log, ["before", "after"], "exactly one pair, and it is runSetWidget's");
  assert.equal(graph.tracker.captures.length, 1);
});

test("#757 executor: creation that REFUSES opens no transaction, and never reaches the write", async () => {
  const node = loader({ addNew: false }); // a pack build with no addNewLoraWidget
  const { run, graph, runSetWidget } = executor(node);
  await assert.rejects(
    () => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }),
    /does not expose addNewLoraWidget/,
  );
  assert.equal(graph.tracker.changeCount, 0, "an unclosed transaction would swallow the next command's undo entry");
  assert.deepEqual(graph.log, [], "a refusal that changed nothing has no bookkeeping to do");
  // runSetWidget IS entered now — the creation lives at its write boundary, so a refusal to
  // create can only be raised from inside it. What must not happen is the WRITE: the refusal
  // has to arrive before applyWidgetWrite, over a node nothing touched.
  assert.equal(runSetWidget.calls.length, 1, "the refusal is raised from inside the call, at the write boundary");
  assert.equal(runSetWidget.writes, 0, "the write is never attempted for a row that does not exist");
});

test("#757 executor: two overlapping requests for the same missing row both come out right", async () => {
  // Command frames run concurrently, and this used to be a P1: A minted the row and parked
  // in its write, B saw a row that now existed and wrote it, and A's rollback then deleted
  // the row B had been told it wrote. With both the creation and the write behind the same
  // synchronous boundary, the interleaving that made that possible cannot occur — each
  // request's create-and-write is uninterruptible, so exactly one of them creates.
  const node = loader();
  const graph = trackedGraph(node);
  const request = () =>
    executor(node, { graph }).run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  const [a, b] = await Promise.all([request(), request()]);
  const created = [a, b].filter((r) => r.created_widget === "lora_1");
  assert.equal(created.length, 1, "exactly one of the two created the row; the other wrote the existing one");
  assert.equal(
    node.widgets.filter((w) => w.name === "lora_1").length,
    1,
    "and the node carries exactly one lora_1, not a duplicate",
  );
});

test("#757 executor: a failing request cannot roll back a row the OTHER request wrote", async () => {
  // The same interleaving, with the loser failing. Because the winner's create-and-write is
  // synchronous and complete before the loser's boundary runs, the loser never created
  // anything and so has nothing to undo — the surviving row belongs to the request that was
  // told it succeeded.
  const node = loader();
  const graph = trackedGraph(node);
  const ok = await executor(node, { graph }).run({
    node_id: 153,
    widget: "lora_1",
    value: SLOT_JSON,
    workflow_uuid: "u",
  });
  assert.equal(ok.created_widget, "lora_1");
  const loser = executor(node, { graph, runSetWidget: stubRunSetWidget({ fail: new Error("too late") }) });
  await assert.rejects(() => loser.run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.ok(node.widgets.some((w) => w.name === "lora_1"), "the successful request's row is still there");
});

test("#757 executor: the write is handed the row that was just created", async () => {
  const node = loader();
  const { run, runSetWidget } = executor(node);
  await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(runSetWidget.calls.length, 1);
  assert.equal(runSetWidget.calls[0].widget, "lora_1");
  assert.equal(runSetWidget.calls[0].value, SLOT_JSON, "the value is passed through untouched, string and all");
});
