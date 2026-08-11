/**
 * #968 — the canvas compared against the file it claims to be.
 *
 * The report that made this diagnosable: tab B was `modified:true`, its canvas held A's
 * 44-node graph, and B on disk is a disjoint 40-node set. `panel_open_workflow(B)` asserted
 * the canvas was bound to B, "differed only cosmetically", and there was "no missing work to
 * redo". `panel_load_workflow(B)` — the one path that reads DISK — restored the right graph.
 *
 * Every check passed HONESTLY: the repaint loads from the tab's own state and the content
 * proof compares the canvas against that state, while staleness compares the FILE against the
 * tab's BASELINE. Nobody compared the file against the canvas, although that path had already
 * read the file.
 *
 * DISCLOSURE, NOT PROOF — a user can clear a tab and build something new before saving, which
 * is also disjoint. These tests pin that this never becomes a verdict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canvasFileDivergence,
  canvasFileDivergenceNote,
} from "../../web/js/lib/canvas-file-divergence.js";

const nodes = (...ids) => ids.map((id) => ({ id }));

test("#968 THE REPORTED CASE: disjoint id sets are detected", () => {
  const d = canvasFileDivergence({
    diskNodes: nodes(...Array.from({ length: 40 }, (_, i) => 100 + i)),
    canvasNodes: nodes(...Array.from({ length: 44 }, (_, i) => 1 + i)),
  });
  assert.equal(d.comparable, true);
  assert.equal(d.disjoint, true);
  assert.equal(d.shared, 0);
  assert.equal(d.canvasCount, 44);
  assert.equal(d.diskCount, 40);
});

test("#968 ORDINARY EDITING is not divergence — that is the false-positive to avoid", () => {
  // Add two, delete one, move the rest: still overwhelmingly the same ids.
  const d = canvasFileDivergence({
    diskNodes: nodes(1, 2, 3, 4, 5),
    canvasNodes: nodes(1, 2, 3, 5, 6, 7),
  });
  assert.equal(d.disjoint, false);
  assert.equal(d.shared, 4);
  assert.equal(d.canvasOnly, 2);
  assert.equal(d.diskOnly, 1);
  assert.equal(canvasFileDivergenceNote(d, "workflows/a.json"), null, "no note for an edited tab");
});

test("#968 numeric and string ids compare equal — a faithful round-trip is not divergence", () => {
  // The canvas holds numbers; a file may hold either. Comparing types rather than values
  // would report EVERY saved workflow as foreign, which is the worst possible false positive.
  const d = canvasFileDivergence({ diskNodes: nodes("1", "2", "3"), canvasNodes: nodes(1, 2, 3) });
  assert.equal(d.comparable, true);
  assert.equal(d.disjoint, false);
  assert.equal(d.shared, 3);
});

test("#968 an EMPTY side is not comparable — empty shares nothing with everything", () => {
  // Without this, a brand-new empty tab and a genuinely empty file both read as "foreign".
  for (const input of [
    { diskNodes: nodes(1, 2), canvasNodes: [] },
    { diskNodes: [], canvasNodes: nodes(1, 2) },
    { diskNodes: [], canvasNodes: [] },
  ]) {
    const d = canvasFileDivergence(input);
    assert.equal(d.comparable, false, JSON.stringify(input));
    assert.equal(d.disjoint, false);
  }
});

test("#968 an unreadable side is 'could not compare', never 'no nodes'", () => {
  for (const bad of [null, undefined, {}, "nodes", 42]) {
    assert.equal(canvasFileDivergence({ diskNodes: bad, canvasNodes: nodes(1) }).comparable, false);
    assert.equal(canvasFileDivergence({ diskNodes: nodes(1), canvasNodes: bad }).comparable, false);
  }
  assert.equal(canvasFileDivergence().comparable, false);
  assert.equal(canvasFileDivergence({}).comparable, false);
});

test("#968 nodes without usable ids are ignored rather than counted", () => {
  const d = canvasFileDivergence({
    diskNodes: [{ id: 1 }, { id: null }, {}, { id: "" }, { id: NaN }],
    canvasNodes: [{ id: 1 }, { id: undefined }],
  });
  assert.equal(d.diskCount, 1);
  assert.equal(d.canvasCount, 1);
  assert.equal(d.disjoint, false);
});

test("#968 the note says what it compared and what it does NOT establish", () => {
  const d = canvasFileDivergence({ diskNodes: nodes(9, 10), canvasNodes: nodes(1, 2, 3) });
  const note = canvasFileDivergenceNote(d, "workflows/B.json");
  assert.match(note, /shares NO node ids with its own file/);
  assert.match(note, /workflows\/B\.json/);
  assert.match(note, /3 node\(s\) on the canvas, 2 in the file, 0 in common/);
  // The alternative reading is NAMED, not dismissed — people do clear tabs and rebuild.
  assert.match(note, /It is NOT proof/);
  // Codex named a second legitimate zero-overlap flow — pasting a whole graph in before
  // saving — so the note names both rather than only the one I had thought of.
  assert.match(note, /clearing this tab and rebuilding, or pasting an entire graph in/);
  // Not an absolute claim about editing (codex): "usually keeps most ids", not "never
  // replaces every id" — the mechanism does not establish the stronger form.
  assert.match(note, /Incremental editing usually keeps most ids/);
  assert.ok(!/does not replace every id/.test(note));
  // And the recovery that the reporter confirmed works.
  assert.match(note, /panel_load_workflow re-reads the file/);
  // It must not claim to know which workflow the canvas actually holds.
  assert.ok(!/the canvas holds workflow|this is workflow/i.test(note));
});

test("#968 no note unless the comparison actually ran and found nothing shared", () => {
  assert.equal(canvasFileDivergenceNote(null, "p"), null);
  assert.equal(canvasFileDivergenceNote({ comparable: false, disjoint: true }, "p"), null);
  assert.equal(canvasFileDivergenceNote({ comparable: true, disjoint: false }, "p"), null);
});

test("#968 SOURCE: this decides nothing about whether a command may run", () => {
  // The property that makes it safe to add while the CAUSE of the contamination is unknown.
  // A refusal built on a heuristic that cannot tell "foreign graph" from "cleared and
  // rebuilt" would be a wrong-graph refusal of its own.
  const src = readFileSync(new URL("../../web/js/lib/canvas-file-divergence.js", import.meta.url), "utf8");
  assert.match(src, /DISCLOSURE, NOT PROOF/);
  const exported = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ["canvasFileDivergence", "canvasFileDivergenceNote"]);
  assert.ok(!/\brefuse|\bthrow new Error|\bblock\b/i.test(src.slice(src.indexOf("export function"))));
});

test("#968 WIRED: the open path compares the file it already read against the canvas", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // Computed where onDiskContent is in hand — the whole point is that the read already
  // happened and nobody used it for this.
  assert.match(src, /canvasDivergence = canvasFileDivergence\(\{/);
  assert.match(src, /diskNodes: diskParsed\?\.nodes,/);
  assert.match(src, /canvasNodes: app\?\.graph\?\._nodes \?\? app\?\.graph\?\.nodes,/);
  // Its OWN reply key: staleness is about the file changing, this is about the canvas not
  // being that file's graph at all, and a caller can hit one without the other.
  assert.match(src, /canvas_file_divergence: canvasFileDivergenceNote\(canvasDivergence, target\.path\)/);
  // An unparseable file must not become a divergence claim.
  const at = src.indexOf("canvasDivergence = canvasFileDivergence({");
  const around = src.slice(at - 400, at + 700);
  assert.match(around, /catch \{[\s\S]{0,300}?canvasDivergence = null;/);
});
