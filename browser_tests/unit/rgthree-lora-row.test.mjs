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
import { setWidgetCommandBudgetDeps } from "./_panel-constants.mjs";

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

test("#757 the mismatch refusal CONFIRMS the rewind instead of assuming it", () => {
  // ROUND-5 P2. `restoreRowCounter` reports whether it ran an assignment, not whether the
  // assignment took. A counter that accepts `++` but silently ignores writes back — a
  // getter-only property, a clamping pack, a proxy — made it return true while the number
  // stayed spent, and the refusal then printed the remedy that only works if it came back:
  // "Set lora_2 instead", when lora_2 is already gone too.
  const n = loader({ nextRow: 1 });
  let frozen = 0;
  Object.defineProperty(n, "loraWidgetsCounter", {
    get: () => frozen,
    set: (v) => {
      if (v > frozen) frozen = v; // accepts the mint, ignores the rewind
    },
    configurable: true,
  });
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_9", {}),
    /could not be rewound, so "lora_1" is now used up/,
    "an unrewound counter must not be advertised as rewound",
  );
});

test("#757 remove() reports a rollback it completed as clean", () => {
  // The other side of the rule below — the honest "nothing is left over" must stay reachable,
  // or every refused write would start carrying a scary sentence it has not earned.
  const n = loader({ nextRow: 1 });
  const undone = createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.equal(undone.removed, true);
  assert.equal(undone.incomplete, null, "row gone and counter back — there is nothing to disclose");
});

test("#757 remove() DISCLOSES a row name it could not give back", () => {
  // A pack that exposes addNewLoraWidget but hides its counter. The row goes back out, but
  // the NAME stays spent — and a caller told only that its value was invalid will retry the
  // same lora_1, mint a later row and be refused a second time on the name instead.
  const n = loader({ nextRow: 1, trackCounter: false });
  const undone = createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.equal(undone.removed, true, "the row itself did go");
  assert.match(undone.incomplete, /row counter could not be read, so that name is used up/);
  assert.match(undone.incomplete, /asking for "lora_1" again will create a differently-named row/);
});

test("#757 remove() discloses a FROZEN counter too, not just an unreadable one", () => {
  // Readable but unwritable — the assignment is swallowed, so the rewind silently did not
  // happen. Asking the NODE afterwards is what tells the two apart from a real rewind.
  const n = loader({ nextRow: 1 });
  const made = createRgthreeLoraRow(n, "lora_1", {});
  let frozen = n.loraWidgetsCounter;
  Object.defineProperty(n, "loraWidgetsCounter", { get: () => frozen, set: () => {}, configurable: true });
  const undone = made.remove();
  assert.equal(undone.removed, true);
  assert.match(undone.incomplete, /could not be rewound, so that name is used up/);
});

test("#757 remove() discloses a name spent because SOMEBODY ELSE advanced the counter", () => {
  // The round-2 rule stands — winding back past another row's increment would re-issue names
  // that are taken — but declining to rewind still leaves this call's name spent, and the
  // caller has to hear that rather than be told the rollback was clean.
  const n = loader({ nextRow: 1 });
  const made = createRgthreeLoraRow(n, "lora_1", {});
  n.addNewLoraWidget(); // an unrelated addition while our write was in flight
  const undone = made.remove();
  assert.equal(n.loraWidgetsCounter, 2, "still not rewound past the row that is not ours");
  assert.match(undone.incomplete, /could not be rewound, so that name is used up/);
});

test("#757 remove() reports a row it could not take back out", () => {
  const n = loader({ nextRow: 1 });
  const made = createRgthreeLoraRow(n, "lora_1", {});
  n.removeWidget = () => {}; // a node that refuses to give the row up
  const undone = made.remove();
  assert.equal(undone.removed, false);
  assert.match(undone.incomplete, /could not be removed again and is still on the node/);
});

// ---------------------------------------------------------------------------
// THE SETTLING PERIOD — a new row is not an existing row until it has been drawn
// ---------------------------------------------------------------------------
//
// The widget below is modelled on the SHIPPED one, because the defect lives entirely in the
// gap between construction and the first draw:
//
//   constructor:    this.showModelAndClip = null;
//   draw:           this.showModelAndClip =
//                     node.properties["Show Strengths"] === "Separate Model & Clip";
//   serializeValue: const v = {...this.value};
//                   if (!this.showModelAndClip) delete v.strengthTwo;
//                   else { this.value.strengthTwo = this.value.strengthTwo ?? 1; … }
//
// `null` is falsy, so an UNDRAWN row serializes down the first branch and quietly drops
// strengthTwo. A human never meets this — clicking "➕ Add Lora" repaints before they touch
// anything. An agent creating and writing in one synchronous command does.

/** The pack's row widget, with the two behaviours that matter reproduced verbatim. */
function powerLoraRowWidget(name) {
  return {
    name,
    showModelAndClip: null, // set only by draw()
    value: { on: true, lora: null, strength: 1, strengthTwo: null },
    serializeValue() {
      const v = { ...this.value };
      if (!this.showModelAndClip) {
        delete v.strengthTwo;
      } else {
        this.value.strengthTwo = this.value.strengthTwo ?? 1; // MUTATES the live value
        v.strengthTwo = this.value.strengthTwo;
      }
      return v;
    },
  };
}

function powerLoraNode({ separate = false, drawnRows = [] } = {}) {
  const node = {
    id: 153,
    type: POWER_LORA_LOADER_TYPE,
    properties: { "Show Strengths": separate ? "Separate Model & Clip" : "Single Strength" },
    widgets: [{ name: "divider" }, { name: "PowerLoraLoaderHeaderWidget" }, { name: "divider" }, { name: "➕ Add Lora" }],
    loraWidgetsCounter: 0,
    size: [200, 60],
    computeSize: () => [200, 60 + 20 * node.widgets.filter((w) => /^lora_\d+$/.test(w?.name ?? "")).length],
    removeWidget(w) {
      const i = node.widgets.indexOf(w);
      if (i >= 0) node.widgets.splice(i, 1);
    },
    addNewLoraWidget() {
      node.widgets.push(powerLoraRowWidget(`lora_${++node.loraWidgetsCounter}`));
    },
  };
  for (const name of drawnRows) {
    node.addNewLoraWidget();
    // An existing row has been drawn at least once, so its mode is already synchronised.
    node.widgets.at(-1).showModelAndClip = separate;
  }
  return node;
}

const LORA_REGISTRY = { [POWER_LORA_LOADER_TYPE]: {} };
const loraOracle = { getFreshObjectInfo: async () => ({ [POWER_LORA_LOADER_TYPE]: {} }) };

/**
 * Drive the REAL runSetWidget over the fixture, with a capture that SERIALIZES.
 *
 * ChangeTracker captures by serializing the graph, which is what runs each widget's
 * `serializeValue` — so a probe that does not serialize cannot see this class of defect at all.
 */
async function loraWriteThrough(node, { create }) {
  let depth = 0;
  const serializeAll = () => {
    for (const w of node.widgets) {
      try {
        w.serializeValue?.(node, 0);
      } catch {
        /* the capture swallows a widget that cannot serialize */
      }
    }
  };
  const opts = {
    registry: LORA_REGISTRY,
    ...loraOracle,
    beforeChange: () => {
      depth += 1;
    },
    afterChange: () => {
      depth -= 1;
      if (depth === 0) serializeAll();
    },
    ...(create
      ? {
          prepareWriteTarget: () => {
            const made = createRgthreeLoraRow(node, "lora_1", {});
            return { undo: () => made.remove().incomplete };
          },
        }
      : {}),
  };
  try {
    return { ok: true, result: await runSetWidget(node, "lora_1", SLOT_JSON, opts) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

test("#757 a Separate Model & Clip CREATION reports what an existing-row write reports", async () => {
  // ROUND-7 P1, and the invariant the whole feature is judged on. In Separate mode the pack's
  // serializeValue rewrites `strengthTwo: null` to 1 during the capture — before the write is
  // verified — so an EXISTING-row write is refused for a value that did not stick. A newly
  // created row, still undrawn, took the other branch and silently dropped strengthTwo, so the
  // write verified clean and the value changed at the NEXT queue or save instead.
  const created = await loraWriteThrough(powerLoraNode({ separate: true }), { create: true });
  const existing = await loraWriteThrough(powerLoraNode({ separate: true, drawnRows: ["lora_1"] }), { create: false });
  assert.equal(
    created.ok,
    existing.ok,
    `creation reported ok=${created.ok} where an existing row reported ok=${existing.ok}`,
  );
  assert.equal(created.ok, false, "the pack overrides strengthTwo in this mode, so both must refuse");
  assert.match(created.message, /did not retain the requested value/);
  assert.match(existing.message, /did not retain the requested value/);
});

test("#757 a Single Strength creation still SUCCEEDS — the originally reported case", async () => {
  // The other side of the settle: getting the mode wrong in this direction would refuse the
  // very case #757 exists to fix, because the pack drops strengthTwo from the serialized form
  // here by design and touches nothing.
  const node = powerLoraNode({ separate: false });
  const created = await loraWriteThrough(node, { create: true });
  assert.equal(created.ok, true, created.message);
  const row = node.widgets.find((w) => w.name === "lora_1");
  assert.equal(row.value.lora, "x.safetensors", "and the requested value is on the row");
  assert.equal(row.value.strengthTwo, null, "untouched, because this mode does not use it");
});

test("#757 the created row is settled to the SAME mode an existing row has", async () => {
  for (const separate of [true, false]) {
    const node = powerLoraNode({ separate });
    createRgthreeLoraRow(node, "lora_1", {});
    const row = node.widgets.find((w) => w.name === "lora_1");
    assert.equal(row.showModelAndClip, separate, `mode ${separate} must be synchronised at creation`);
  }
});

test("#757 a pack build with no such mode is left exactly as it was", () => {
  // `showModelAndClip` ABSENT (not merely null) is an older/other build with nothing to settle.
  // Inventing the field would hand its serializeValue a branch it never had.
  const node = powerLoraNode({ separate: true });
  node.addNewLoraWidget = () => {
    const w = powerLoraRowWidget(`lora_${++node.loraWidgetsCounter}`);
    delete w.showModelAndClip;
    node.widgets.push(w);
  };
  createRgthreeLoraRow(node, "lora_1", {});
  const row = node.widgets.find((w) => w.name === "lora_1");
  assert.ok(!("showModelAndClip" in row), "no field was invented on a build that does not have one");
});

test("#757 an unreadable node leaves the row as the pack made it, without throwing", () => {
  const node = powerLoraNode({ separate: true });
  Object.defineProperty(node, "properties", {
    get() {
      throw new Error("properties is hostile");
    },
    configurable: true,
  });
  assert.doesNotThrow(() => createRgthreeLoraRow(node, "lora_1", {}));
  assert.equal(node.widgets.find((w) => w.name === "lora_1").showModelAndClip, null, "left untouched");
});

test("#757 a throwing setDirty does not strand the row (round-7 P2)", () => {
  // The repaint hint is cosmetic, exactly as the resize is. What must NOT happen is the
  // creation failing after the row, the row NAME and the height are already committed, with
  // the caller holding no handle to undo any of it.
  const node = powerLoraNode({ separate: false });
  const made = createRgthreeLoraRow(node, "lora_1", {
    setDirty: () => {
      throw new Error("setDirtyCanvas blew up");
    },
  });
  assert.equal(made.created, "lora_1", "a cosmetic failure is not a gate");
  assert.ok(node.widgets.some((w) => w.name === "lora_1"));
});

test("#757 anything else that throws in the tail rolls the creation back (round-7 P2)", () => {
  // `remove` is only handed back at the END of the helper, and runSetWidget evaluates the whole
  // preparation BEFORE entering the try that would clean up — so a throw in the tail had no
  // undo available anywhere and stranded the row, its name and the grown height.
  const node = powerLoraNode({ separate: true });
  const sizeBefore = [...node.size];
  node.addNewLoraWidget = () => {
    const w = powerLoraRowWidget(`lora_${++node.loraWidgetsCounter}`);
    Object.defineProperty(w, "showModelAndClip", {
      get: () => null,
      set: () => {
        throw new Error("this widget refuses the mode");
      },
      configurable: true,
    });
    node.widgets.push(w);
  };
  assert.throws(() => createRgthreeLoraRow(node, "lora_1", {}), /refuses the mode/);
  assert.ok(!node.widgets.some((w) => w.name === "lora_1"), "the row was taken back out");
  assert.equal(node.loraWidgetsCounter, 0, "and the name it spent was returned");
  assert.deepEqual([...node.size], sizeBefore, "and the height it grew was put back");
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
  assert.match(body, /prepared\.undo\?\.\(\)/, "…and the undo is in the same stretch");
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

/**
 * ChangeTracker's counting rule, which is the whole reason the outer envelope matters:
 *
 *   `beforeChange(){ this.changeCount++ }`
 *   `afterChange(){ --this.changeCount || this.captureCanvasState() }`
 *
 * A close that reaches ZERO captures. So nested envelopes yield ONE capture, at the outermost
 * close — and whatever the graph looks like at that moment is what the undo history gets.
 */
function historyProbe(node) {
  const probe = {
    depth: 0,
    captures: [],
    beforeChange: () => {
      probe.depth += 1;
    },
    afterChange: () => {
      probe.depth -= 1;
      if (probe.depth < 0) throw new Error("afterChange() without a matching beforeChange()");
      if (probe.depth === 0) probe.captures.push(node.widgets.map((w) => w.name));
    },
  };
  return probe;
}

test("#757 boundary: a value the CAPTURE rewrites is caught, exactly as on an existing row", async () => {
  // ROUND-5 P1, and the rule the creating path now rests on: creation must report whatever an
  // ordinary write reports for the same value.
  //
  // applyWidgetWrite verifies AFTER its own afterChange fires, deliberately, because that is
  // when ComfyUI serializes the graph for the undo capture — and serialization runs each
  // node's own `serializeValue`. An rgthree loader in Separate Model & Clip mode rewrites
  // `strengthTwo: null` to 1 right there. Wrapping applyWidgetWrite in an OUTER envelope
  // stops its close from reaching zero, so the capture (and that rewrite) happens after the
  // last verification and the drift is never seen — the creating path reported plain success
  // where an existing-row write reported a normalization.
  //
  // The probe mutates at DEPTH ZERO only, which is exactly where a capture happens.
  const node = { id: 7, type: "KSampler", widgets: [] };
  const target = { name: "made", type: "text", value: "" };
  const probe = historyProbe(node);
  const capturing = {
    beforeChange: probe.beforeChange,
    afterChange: () => {
      probe.afterChange();
      // The serialize step the capture performs, rewriting the value behind our back.
      if (probe.depth === 0) target.value = "rewritten-by-serializeValue";
    },
  };
  await assert.rejects(
    () =>
      runSetWidget(node, "made", "hello", {
        registry: BOUNDARY_REGISTRY,
        ...boundaryOracle,
        ...capturing,
        prepareWriteTarget: () => {
          node.widgets.push(target);
          return { undo: () => { node.widgets = node.widgets.filter((w) => w !== target); } };
        },
      }),
    /did not retain the requested value/,
    "a rewrite during the capture must be caught on the creating path too, not silently accepted",
  );
});

test("#757 boundary: a POST-ASSIGNMENT refusal captures no history with the row still in it", async () => {
  // ROUND-4 P2. applyWidgetWrite closes its own envelope BEFORE the #240 read-back verifies,
  // and rolls a bad value back in an envelope of its own — so a value the widget's setter
  // normalizes away is refused only after up to two captures have already been taken. Without
  // an outer envelope those captures hold the created row and the rejected value, and the
  // cleanup then removes the row with nothing open and nothing captured: the tracker's newest
  // snapshot is a graph that no longer exists, and the next Ctrl+Z restores the very command
  // that was refused. A refusal has to be a no-op in the undo history too.
  const node = { id: 7, type: "KSampler", widgets: [] };
  // A widget that ACCEPTS the assignment and keeps its old value — the read-back rejects it
  // after the write envelope has already closed.
  const swallowing = { name: "made", type: "text", get value() { return ""; }, set value(_v) {} };
  const probe = historyProbe(node);
  let undone = 0;
  await assert.rejects(
    () =>
      runSetWidget(node, "made", "hello", {
        registry: BOUNDARY_REGISTRY,
        ...boundaryOracle,
        beforeChange: probe.beforeChange,
        afterChange: probe.afterChange,
        prepareWriteTarget: () => {
          node.widgets.push(swallowing);
          return {
            undo: () => {
              undone += 1;
              node.widgets = node.widgets.filter((w) => w !== swallowing);
              return null;
            },
          };
        },
      }),
    /did not retain the requested value/,
  );
  assert.equal(undone, 1, "the refusal rolled the preparation back");
  assert.equal(probe.depth, 0, "every envelope opened is closed — an unclosed one wedges the tracker");
  // The NEWEST snapshot is what a Ctrl+Z steps back from, and it must describe the graph that
  // actually exists. Earlier the cleanup ran with nothing open, so the newest snapshot still
  // held the refused row.
  assert.deepEqual(
    probe.captures.at(-1),
    [],
    "the newest capture is the graph AFTER the cleanup, not a row-present snapshot of a refused command",
  );
  // NOT asserted: that this is the ONLY capture. applyWidgetWrite captures its write and then
  // captures its rollback in a second envelope, so an ORDINARY refused write already leaves
  // intermediate snapshots too. Demanding fewer here is what produced the round-5 P1: the only
  // way to suppress them is to hold one envelope across the verification, which moves the
  // capture — and every pack serializeValue it runs — past the last check.
  assert.ok(probe.captures.length >= 1, "the write path keeps the captures it has always taken");
});

test("#757 boundary: a throwing history OPEN still gets the row back out", async () => {
  // ROUND-5 P2. The cleanup's envelope is opened by the graph's own hook, and a pack or
  // extension can make that throw. If it escapes, the cleanup never runs: the row AND the row
  // name it spent are left behind while the caller is handed an error — mutate-then-refuse,
  // caused by the bookkeeping rather than by the write.
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
        beforeChange: () => {
          throw new Error("onBeforeChange blew up");
        },
        afterChange: () => {},
      }),
    /panel_set_widget refused "made"/,
    "the caller still hears why the WRITE was refused",
  );
  assert.equal(seen.undone, 1, "the cleanup ran anyway");
  assert.deepEqual(node.widgets, [], "and the node is as it was found");
});

test("#757 boundary: a throwing history CLOSE does not replace the refusal", async () => {
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
        beforeChange: () => {},
        afterChange: () => {
          throw new Error("onAfterChange blew up");
        },
      }),
    /panel_set_widget refused "made"/,
    "a failed history hook must never become the reason the caller is given",
  );
  assert.equal(seen.undone, 1);
  assert.deepEqual(node.widgets, []);
});

test("#757 boundary: a SUCCESSFUL creating write is still one capture, with the row in it", async () => {
  // The same envelope on the success path: one undo step, and it covers create + assign.
  const { node, seen, prepareWriteTarget } = boundaryFixture();
  const probe = historyProbe(node);
  await runSetWidget(node, "made", "hello", {
    registry: BOUNDARY_REGISTRY,
    ...boundaryOracle,
    beforeChange: probe.beforeChange,
    afterChange: probe.afterChange,
    prepareWriteTarget,
  });
  assert.equal(seen.prepared, 1);
  assert.equal(probe.depth, 0);
  assert.equal(probe.captures.length, 1, "one undo step for the whole command");
  assert.deepEqual(probe.captures[0], ["made"], "and it covers the creation and the assign together");
});

test("#757 boundary: an INCOMPLETE rollback is disclosed on the refusal the caller sees", async () => {
  // ROUND-4 P2, the other half. The undo may report that it could not put everything back —
  // a consumed row name that the pack's hidden counter will not give up. That has to reach
  // the caller ATTACHED TO THE REFUSAL, because the refusal is all it gets.
  const { node, prepareWriteTarget: mint } = boundaryFixture({
    name: "made",
    type: "combo",
    options: { values: ["a"] },
    value: "a",
  });
  const prepareWriteTarget = () => {
    const prepared = mint();
    if (!prepared) return null;
    return {
      undo: () => {
        prepared.undo();
        return "The name it used up could not be given back.";
      },
    };
  };
  await assert.rejects(
    () => runSetWidget(node, "made", "nope", { registry: BOUNDARY_REGISTRY, ...boundaryOracle, prepareWriteTarget }),
    (err) => {
      assert.match(err.message, /is not a valid option/, "the reason the write was refused");
      assert.match(err.message, /could not be given back/, "…and what the rollback could not undo");
      return true;
    },
  );
});

test("#757 boundary: the disclosure does not cost a combo miss its retry", async () => {
  // The annotation is applied IN PLACE precisely so the error keeps its type and its `combo`
  // flag. Rethrowing a wrapped error here would turn every recoverable stale-combo miss into
  // a hard refusal — a far bigger regression than the disclosure is worth.
  const { node, widget, prepareWriteTarget: mint } = boundaryFixture({
    name: "made",
    type: "combo",
    options: { values: ["a"] },
    value: "a",
  });
  const prepareWriteTarget = () => {
    const prepared = mint();
    if (!prepared) return null;
    return {
      undo: () => {
        prepared.undo();
        return "a note that must not break the recovery";
      },
    };
  };
  const res = await runSetWidget(node, "made", "b", {
    registry: BOUNDARY_REGISTRY,
    ...boundaryOracle,
    prepareWriteTarget,
    refreshCombos: async () => {
      widget.options.values.push("b");
    },
  });
  assert.equal(res.set.value, "b", "the stale-combo recovery still ran and the write landed");
  assert.equal(res.refreshed, true);
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
  const m = PANEL_SRC.match(/ {2}async graph_set_widget\(\{ node_id, widget, value, workflow_uuid, builder_state \}\) \{[\s\S]*?\n {2}\},/);
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
  "classifyIdeogram4PromptBuilderWrite",
  "ideogram4PromptBuilderRefusal",
  "classifyMiniMaxH3PromptBuilderWrite",
  "applyMiniMaxH3PromptBuilderWrite",
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
  "comfyBackendIsDown",
  "objectInfoHistory",
  "sourceForSubgraphInput",
  "refreshComboOptionsFromDefs",
  "refreshComfyNodeDefs",
  "clearStaleRedFlag",
  "snapshotAuthorizationNote",
  // #1413 — the handler's first line is now a command budget. The REAL pieces, collected in
  // _panel-constants.mjs so no harness keeps its own copy of the numbers.
  "makeCommandBudget",
  "SET_WIDGET_COMMAND_BUDGET_MS",
  "SET_WIDGET_POST_REFRESH_RESERVE_MS",
  "monotonicNow",
  // #1418 — the budget now reaches the seed wait, the oracle read and the upload probe,
  // and the recovery distinguishes "still running" from "never ran" on a second token.
  "withTimeout",
  "OBJECT_INFO_SEED_WAIT_MS",
  "OBJECT_INFO_DEADLINE_MS",
  "REFRESH_JOIN_ABANDONED",
  "COMBO_REFRESH_NEVER_RAN",
  // The coalescer's live slot. This harness's refreshCombos path is never exercised (the
  // runSetWidget double never calls it), so a fixed null is the truth here.
  "nodeDefRefreshInFlight",
  // #1498 — the handler retires the turn's manual-change claim for the widget it just
  // wrote. Panel module state, so the harness supplies a no-op double.
  "dropManualChangeClaim",
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
    // A grown target puts the write AND its cleanup inside ONE OUTER envelope, so the tracker
    // captures once — at the end, over the graph as it really finished. Opened only when
    // something was actually prepared, exactly as the real one does.
    if (prepared) opts.beforeChange?.();
    try {
      // The real one brackets its write and fires afterChange BEFORE the #240 read-back
      // verification that can still reject — so a refusal arrives with its own pair closed.
      opts.beforeChange?.();
      opts.afterChange?.();
      if (fail) {
        // The real one ANNOTATES the refusal in place with whatever the undo could not put
        // back, so the caller is not told only why its value was rejected while a resource
        // the preparation consumed stays consumed.
        const note = prepared?.undo?.();
        if (typeof note === "string" && note && typeof fail?.message === "string") {
          fail.message = `${fail.message} ${note}`;
        }
        throw fail;
      }
      return result;
    } finally {
      if (prepared) opts.afterChange?.();
    }
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
    // #1569 guard, added to the extracted method after this harness was written. The rgthree
    // stand-in is never an Ideogram4PromptBuilderKJ, so it classifies nothing — same as the
    // other pack classifiers above.
    classifyIdeogram4PromptBuilderWrite: () => null,
    classifyMiniMaxH3PromptBuilderWrite: () => null,
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
    comfyBackendIsDown: () => false,
    // #1413 — the handler now takes a command budget on its first line. The real pieces,
    // with the shipped numbers, from the shared harness constants.
    ...setWidgetCommandBudgetDeps(),
    nodeDefRefreshInFlight: null,
    dropManualChangeClaim: () => {},
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

test("#757 executor: a refused write over a HIDDEN counter says the row name is spent", async () => {
  // ROUND-4 P2, end to end through the shipped wiring: the pack exposes addNewLoraWidget but
  // keeps its counter private, so the row goes back out and the NAME does not. The caller
  // gets one message and it has to carry both facts — otherwise the obvious next move,
  // retrying the corrected value under the same lora_1, mints a later row and is refused a
  // second time for a reason the first refusal never mentioned.
  const node = loader({ nextRow: 1, trackCounter: false });
  const { run } = executor(node, {
    runSetWidget: stubRunSetWidget({ fail: new Error('"strength" must be a number') }),
  });
  await assert.rejects(
    () => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }),
    (err) => {
      assert.match(err.message, /"strength" must be a number/, "why the write was refused");
      assert.match(err.message, /row counter could not be read, so that name is used up/, "…and what it cost");
      return true;
    },
  );
  assert.ok(!node.widgets.some((w) => w.name === "lora_1"), "the row itself did go back out");
});

test("#757 executor: a refused write that rolled back CLEANLY says nothing extra", async () => {
  // The counterpart: a readable counter that came back leaves nothing to confess, and the
  // refusal must not start carrying a warning it has not earned.
  const node = loader({ nextRow: 1 });
  const { run } = executor(node, {
    runSetWidget: stubRunSetWidget({ fail: new Error('"strength" must be a number') }),
  });
  await assert.rejects(
    () => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }),
    (err) => {
      assert.equal(err.message, '"strength" must be a number', "the refusal is exactly what the write said");
      return true;
    },
  );
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
