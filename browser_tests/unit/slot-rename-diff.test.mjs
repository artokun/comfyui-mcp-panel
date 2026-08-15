import { test } from "node:test";
import assert from "node:assert/strict";
import { slotRenameLines } from "../../web/js/lib/slot-rename-diff.js";

/**
 * #636 — the MANUAL CANVAS CHANGES block reported a widget VALUE change in the
 * same edit session but said nothing about the user's slot renames, which
 * "reinforced the wrong conclusion" that the renames hadn't stuck. They had; a
 * screenshot was the only thing that settled it.
 *
 * The silence was worse than no diff at all: the value line proved the diff was
 * running, so its omission read as evidence of absence.
 */

const NODE = '173 SubgraphNode "Save Video"';

test("a promoted-widget rename is reported", () => {
  const prev = { inputs: [{ name: "value", type: "STRING" }] };
  const curr = { inputs: [{ name: "value", type: "STRING", label: "Filename" }] };
  const [line, ...rest] = slotRenameLines(prev, curr, NODE);
  assert.equal(rest.length, 0);
  assert.match(line, /input "value" renamed \(default\) → "Filename"/);
});

test("the line keeps naming the ADDRESSABLE name, not the new label", () => {
  // Load-bearing: a rename changes what the user sees, not what panel_set_widget
  // and panel_connect must address. An agent that switched to "Filename" would
  // start failing, so the line says so explicitly.
  const prev = { inputs: [{ name: "value" }] };
  const curr = { inputs: [{ name: "value", label: "Filename" }] };
  assert.match(slotRenameLines(prev, curr, NODE)[0], /still addressed as "value"/);
});

test("renaming BACK to the default is reported too", () => {
  const prev = { inputs: [{ name: "value", label: "Filename" }] };
  const curr = { inputs: [{ name: "value" }] };
  assert.match(slotRenameLines(prev, curr, NODE)[0], /renamed "Filename" → \(default\)/);
});

test("outputs are covered, not just inputs", () => {
  const prev = { outputs: [{ name: "IMAGE" }] };
  const curr = { outputs: [{ name: "IMAGE", label: "Preview" }] };
  assert.match(slotRenameLines(prev, curr, NODE)[0], /output "IMAGE" renamed/);
});

test("the reporter's three renames all appear", () => {
  const prev = { inputs: [{ name: "value" }, { name: "boolean" }, { name: "value_1" }] };
  const curr = {
    inputs: [
      { name: "value", label: "Filename" },
      { name: "boolean", label: "project?" },
      { name: "value_1", label: "project" },
    ],
  };
  const lines = slotRenameLines(prev, curr, NODE);
  assert.equal(lines.length, 3);
  for (const l of ["Filename", "project?", "project"]) {
    assert.ok(lines.some((line) => line.includes(`→ "${l}"`)), `${l} must be reported`);
  }
});

test("an UNCHANGED graph produces no lines — the diff must not become noise", () => {
  const same = { inputs: [{ name: "value", label: "Filename" }], outputs: [{ name: "IMAGE" }] };
  assert.deepEqual(slotRenameLines(same, structuredClone(same), NODE), []);
});

test("a label equal to the name is NOT a rename", () => {
  // ComfyUI writes the label redundantly on some paths. Treating that as a change
  // would emit a line for an edit the user never made.
  const prev = { inputs: [{ name: "value" }] };
  const curr = { inputs: [{ name: "value", label: "value" }] };
  assert.deepEqual(slotRenameLines(prev, curr, NODE), []);
});

test("slots are matched by NAME, so an inserted slot does not fake renames", () => {
  // Index-matching would shift every slot after the insertion and report each as
  // renamed. Only the genuinely renamed one may be reported.
  const prev = { inputs: [{ name: "a" }, { name: "b" }, { name: "c" }] };
  const curr = { inputs: [{ name: "new" }, { name: "a" }, { name: "b", label: "Bee" }, { name: "c" }] };
  const lines = slotRenameLines(prev, curr, NODE);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /input "b" renamed/);
});

test("a slot that appeared or vanished is NOT reported as a rename", () => {
  // Those are add/remove, already covered by the node and wiring lines.
  const prev = { inputs: [{ name: "gone", label: "Old" }] };
  const curr = { inputs: [{ name: "fresh", label: "New" }] };
  assert.deepEqual(slotRenameLines(prev, curr, NODE), []);
});

test("missing/garbage snapshots yield no lines rather than throwing", () => {
  for (const bad of [undefined, null, {}, { inputs: null }, { inputs: "nope" }, 42]) {
    assert.deepEqual(slotRenameLines(bad, bad, NODE), []);
    assert.deepEqual(slotRenameLines(bad, { inputs: [{ name: "x", label: "y" }] }, NODE), []);
  }
});

test("unnamed slots are skipped — a rename cannot be attributed without an identity", () => {
  const prev = { inputs: [{ type: "STRING" }] };
  const curr = { inputs: [{ type: "STRING", label: "Something" }] };
  assert.deepEqual(slotRenameLines(prev, curr, NODE), []);
});

// ── WIRING ────────────────────────────────────────────────────────────────
// Everything above proves the helper is right. None of it proves it is CALLED:
// deleting the one line in diffGraphsForAgent restores #636's silence with the
// whole suite still green. diffGraphsForAgent is a module-private function in
// the monolith (not exported, and the manual-changes path needs a live graph),
// so the callable seam does not exist — pin the wiring at source.

test("WIRING: diffGraphsForAgent emits the rename lines", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

  assert.match(src, /import \{ slotRenameLines \} from "\.\/lib\/slot-rename-diff\.js";/,
    "the helper must be imported");

  // Anchor INSIDE diffGraphsForAgent, so an occurrence elsewhere cannot satisfy this.
  const fn = src.slice(src.indexOf("function diffGraphsForAgent"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert.ok(body.includes("lines.push(...slotRenameLines(p, c, label(c)));"),
    "diffGraphsForAgent must push the rename lines — without this #636's silence returns");
});
