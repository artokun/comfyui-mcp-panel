// Unit tests for the graph read helpers (web/js/lib/graph-read.js) backing
// panel_query_graph / panel_graph_outline.
//
//   #607 — link-driven widgets must be flagged so a read never reports a stale
//          stored value as if it were the value that executes.
//   #609 — one oversized widget blob (or several nodes) must not blow the whole
//          max_chars budget and return shown:0 for a node asked for by id.
//   #342 — a link's recorded target_slot goes stale when the target's inputs are
//          compacted; the outline must resolve the LIVE backlink and render
//          NOTHING for an orphaned link.
import test from "node:test";
import assert from "node:assert/strict";

import {
  WIDGET_VALUE_CAP,
  COMPACT_VALUE_CLIP,
  linkDrivenWidgets,
  drivenWidgetsFor,
  drivenTag,
  liveLinkTargetInput,
  capWidgetValue,
  capSummaryWidgets,
  clipLine,
  fitDetailLine,
  isLineProtected,
  truncationTail,
  // #809
  clipCompactValue,
  compactClipNote,
  OUTLINE_DETAIL_LEVELS,
  OUTLINE_MAX_CHARS_DEFAULT,
  OUTLINE_MAX_CHARS_FLOOR,
  OUTLINE_MAX_CHARS_CEILING,
  clampOutlineMaxChars,
  outlineDegradeBanner,
  outlineFloorRefusal,
  outlineValueClipNote,
  clipOutlineTitle,
  OUTLINE_TITLE_CAP,
  MAX_CHARS_CEILING,
  // #1748
  NOTE_NODE_TYPES,
} from "../../web/js/lib/graph-read.js";

// ---- #607: link-driven widget detection -----------------------------------

// A node whose `steps` input is fed by a link from node 85 slot 0, but whose
// stored `steps` widget still says 30 (the classic Primitive/switch-rail case).
function ksamplerDrivenBySteps() {
  const graph = { links: { 7: { origin_id: 85, origin_slot: 0 } } };
  return {
    id: 3,
    type: "KSampler",
    graph,
    widgets: [
      { name: "steps", value: 30 },
      { name: "cfg", value: 4 },
    ],
    inputs: [
      { name: "model", type: "MODEL", link: null },
      { name: "steps", type: "INT", link: 7 }, // converted-to-input, link-driven
    ],
  };
}

test("linkDrivenWidgets names the overridden input and its source (#607)", () => {
  const map = linkDrivenWidgets(ksamplerDrivenBySteps());
  assert.deepEqual(map, { steps: { node_id: 85, output_slot: 0 } });
});

test("linkDrivenWidgets supports array-form links [id, slot, ...] (#607)", () => {
  const node = {
    graph: { links: { 9: [9, 42, 1, 3, 0, "INT"] } }, // [id, origin_id, origin_slot, ...]
    inputs: [{ name: "cfg", link: 9 }],
  };
  assert.deepEqual(linkDrivenWidgets(node), { cfg: { node_id: 42, output_slot: 1 } });
});

test("drivenWidgetsFor keeps only names that are real widgets (#607)", () => {
  const node = ksamplerDrivenBySteps();
  // `model` is a link-connected input but NOT a widget — must not appear.
  node.inputs[0].link = 11;
  node.graph.links[11] = { origin_id: 2, origin_slot: 0 };
  const only = drivenWidgetsFor(node, ["steps", "cfg"]);
  assert.deepEqual(only, { steps: { node_id: 85, output_slot: 0 } });
});

test("drivenWidgetsFor is empty when no widget input is link-connected", () => {
  const node = {
    graph: { links: {} },
    widgets: [{ name: "steps", value: 30 }],
    inputs: [{ name: "steps", type: "INT", link: null }],
  };
  assert.deepEqual(drivenWidgetsFor(node, ["steps"]), {});
});

test("linkDrivenWidgets never throws on malformed nodes", () => {
  assert.deepEqual(linkDrivenWidgets(null), {});
  assert.deepEqual(linkDrivenWidgets({}), {});
  assert.deepEqual(linkDrivenWidgets({ inputs: [{ name: "x", link: 5 }] }), {}); // no graph.links
  assert.deepEqual(linkDrivenWidgets({ graph: { links: {} }, inputs: [{ link: 5 }] }), {}); // no name
});

test("drivenTag renders a concise, honest annotation", () => {
  assert.equal(drivenTag({ node_id: 85, output_slot: 0 }), " [⚠ link-driven #85.0]");
  assert.equal(drivenTag(null), "");
});

// ---- #609: per-value widget cap -------------------------------------------

test("capWidgetValue leaves small values untouched (identity, any type)", () => {
  assert.equal(capWidgetValue(30), 30);
  assert.equal(capWidgetValue("euler"), "euler");
  assert.equal(capWidgetValue(null), null);
  const obj = { a: 1 };
  assert.equal(capWidgetValue(obj), obj, "small objects returned by reference");
});

test("capWidgetValue clips an oversized string and reports the drop (#609)", () => {
  const blob = "x".repeat(20000);
  const out = capWidgetValue(blob);
  assert.ok(out.length < blob.length, "clipped shorter than original");
  assert.ok(out.startsWith("x".repeat(1000)), "keeps the head");
  assert.match(out, /…\(\+\d+ chars cut at the 2048-char per-widget cap, which `max_chars` does not raise\)$/, "#809: reports how much was dropped AND that max_chars cannot raise this cap");
  assert.ok(JSON.stringify(out).length <= WIDGET_VALUE_CAP, "ESCAPED size within the cap");
});

test("capWidgetValue bounds by ESCAPED size for control chars / surrogates (#609)", () => {
  // NUL escapes to 6 chars each (\\u0000); a raw-length cap would blow the budget.
  const nuls = String.fromCharCode(0).repeat(5000);
  const out = capWidgetValue(nuls, 600);
  assert.ok(JSON.stringify(out).length <= 600, `escaped size within cap, got ${JSON.stringify(out).length}`);
  // #809: the marker names the CAUSE and the lever, not just "truncated".
  assert.match(out, /chars cut (over the `max_chars` budget|at the \d+-char per-widget cap)/);
});

test("capWidgetValue clips oversized serialized objects (ResolutionMaster presets)", () => {
  const bigObj = { presets: Array.from({ length: 500 }, (_, i) => ({ i, name: `preset ${i}` })) };
  const out = capWidgetValue(bigObj);
  assert.equal(typeof out, "string");
  assert.ok(JSON.stringify(out).length <= WIDGET_VALUE_CAP, "escaped size within the cap");
  // #809: the marker names the CAUSE and the lever, not just "truncated".
  assert.match(out, /chars cut (over the `max_chars` budget|at the \d+-char per-widget cap)/);
});

test("capSummaryWidgets bounds every widget value without mutating the input (#609)", () => {
  const summary = { id: 1, type: "ResolutionMaster", widgets: { auto_detect_presets_json: "y".repeat(9000), steps: 20 } };
  const capped = capSummaryWidgets(summary);
  assert.notEqual(capped, summary, "returns a clone when something changed");
  assert.equal(summary.widgets.auto_detect_presets_json.length, 9000, "original untouched");
  assert.ok(capped.widgets.auto_detect_presets_json.length <= WIDGET_VALUE_CAP + 40);
  assert.equal(capped.widgets.steps, 20, "small values preserved");
});

test("capSummaryWidgets bounds the TOTAL widgets size, keeping valid JSON (#609)", () => {
  // 40 oversized widgets: per-value capping alone still yields ~40×2KB. The total
  // cap must drop overflow with an elision marker so one node can't blow the budget.
  const widgets = {};
  for (let i = 0; i < 40; i++) widgets[`w${i}`] = "z".repeat(5000);
  const capped = capSummaryWidgets({ id: 1, widgets }, WIDGET_VALUE_CAP, 3000);
  const json = JSON.stringify(capped);
  assert.doesNotThrow(() => JSON.parse(json), "result is still valid JSON");
  assert.ok(json.length < 3000 * 2, `bounded near totalCap, got ${json.length}`);
  assert.ok("…" in capped.widgets, "carries the elision marker");
  assert.ok(Object.keys(capped.widgets).length >= 2, "at least one real widget survives");
});

test("capSummaryWidgets keeps at least one widget even if it alone exceeds the total cap", () => {
  const capped = capSummaryWidgets({ id: 1, widgets: { blob: "x".repeat(20000), extra: 1 } }, WIDGET_VALUE_CAP, 500);
  assert.ok("blob" in capped.widgets, "the single huge widget still renders (per-value capped)");
  // #809: these are BUDGET-driven cuts (totalCap < WIDGET_VALUE_CAP), so the marker must
  // name `max_chars` — the lever that genuinely lifts them.
  // #809 (codex gate): the raise must state HOW FAR. "raise `max_chars`" with no ceiling
  // leaves a caller unable to tell whether the retry is even possible.
  assert.match(capped.widgets.blob, /over the `max_chars` budget; raise `max_chars` \(up to 60000\)\)$/);
});

test("capSummaryWidgets tightens the per-value cap to a SMALL total budget (#609)", () => {
  // totalCap 600 < WIDGET_VALUE_CAP: the single retained widget must be clipped to the
  // budget, so the serialized line stays near totalCap, not ~2KB.
  const capped = capSummaryWidgets({ id: 1, widgets: { blob: "q".repeat(5000) } }, WIDGET_VALUE_CAP, 600);
  assert.ok(JSON.stringify(capped).length < 600 * 2, "line bounded near the small budget");
  // #809: these are BUDGET-driven cuts (totalCap < WIDGET_VALUE_CAP), so the marker must
  // name `max_chars` — the lever that genuinely lifts them.
  // #809 (codex gate): the raise must state HOW FAR. "raise `max_chars`" with no ceiling
  // leaves a caller unable to tell whether the retry is even possible.
  assert.match(capped.widgets.blob, /over the `max_chars` budget; raise `max_chars` \(up to 60000\)\)$/);
});

test("#1402: duplicate_widgets is bounded by the SAME budget, not exempt from it", () => {
  // duplicate_widgets carries a value per OCCURRENCE, and the node it exists for (a Fast
  // Groups Bypasser over many groups) is exactly the one that repeats a row many times.
  // Left uncapped it would push the detail past max_chars and fitDetailLine would stub
  // the WHOLE row — the field would make the read carry LESS than before it existed.
  const rows = Array.from({ length: 40 }, (_, i) => ({
    index: i,
    label: `Enable GROUP ${i}`,
    value: "z".repeat(500),
  }));
  const capped = capSummaryWidgets(
    { id: 1, widgets: { RGTHREE_TOGGLE_AND_NAV: "z".repeat(500) }, duplicate_widgets: { RGTHREE_TOGGLE_AND_NAV: rows } },
    WIDGET_VALUE_CAP,
    3000,
  );
  assert.ok(JSON.stringify(capped).length < 3000 * 2, `line bounded, got ${JSON.stringify(capped).length}`);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(capped)), "still valid JSON");
  // Dropped occurrences are ANNOUNCED with the lever that lifts them, never silently
  // lost — a silent drop here is the collapsed map's failure wearing a different key.
  assert.match(
    capped.duplicate_widgets["…"],
    /more duplicate widget occurrence\(s\) cut by the `max_chars` budget; raise `max_chars` \(up to 60000\)/,
  );
  // At least one occurrence always survives, so the field never renders empty.
  assert.ok(capped.duplicate_widgets.RGTHREE_TOGGLE_AND_NAV.length >= 1);
  // The input is not mutated (the #609 contract for `widgets` holds here too).
  assert.equal(rows.length, 40);
  assert.equal(rows[0].value.length, 500);
});

test("#1402: a duplicate report that FITS is passed through untouched", () => {
  // The common affected node — two rgthree toggle rows — is far under budget and must
  // arrive exactly as summarizeNode built it, markers and clipping nowhere in sight.
  const duplicate_widgets = {
    RGTHREE_TOGGLE_AND_NAV: [
      { index: 0, label: "Enable MODEL FL2", value: { toggled: true } },
      { index: 1, label: "Enable MODEL REF", value: { toggled: false } },
    ],
  };
  const summary = { id: 1, widgets: { RGTHREE_TOGGLE_AND_NAV: { toggled: false } }, duplicate_widgets };
  const capped = capSummaryWidgets(summary, WIDGET_VALUE_CAP, 12000);
  assert.deepEqual(capped.duplicate_widgets, duplicate_widgets);
  assert.ok(!("…" in capped.duplicate_widgets), "nothing was cut, so nothing is announced");
  // Nothing changed at all ⇒ the identical object comes back, as with an uncapped node.
  assert.equal(capped, summary);
});

test("#1402: a summary with NO duplicates is untouched — the common node is unchanged", () => {
  const summary = { id: 1, widgets: { seed: 1, steps: 20 } };
  assert.equal(capSummaryWidgets(summary, WIDGET_VALUE_CAP, 12000), summary);
  assert.ok(!("duplicate_widgets" in capSummaryWidgets(summary, WIDGET_VALUE_CAP, 12000)));
  // A widgets-only clip must not invent the key either.
  const clipped = capSummaryWidgets({ id: 1, widgets: { blob: "x".repeat(5000) } }, WIDGET_VALUE_CAP, 600);
  assert.ok(!("duplicate_widgets" in clipped));
});

test("capSummaryWidgets stays bounded on ESCAPE-HEAVY content at a small budget (#609)", () => {
  // Every char JSON-escapes to two; halving the effective cap keeps the escaped line
  // near the budget rather than doubling past it.
  const capped = capSummaryWidgets({ id: 1, widgets: { blob: '"'.repeat(5000) } }, WIDGET_VALUE_CAP, 600);
  assert.ok(JSON.stringify(capped).length < 600 * 2, `escaped line bounded, got ${JSON.stringify(capped).length}`);
});

test("fitDetailLine degrades an over-budget JSON line to a bounded valid-JSON stub (#609)", () => {
  const stub = { id: 42, type: "Hub", title: "x" };
  const huge = JSON.stringify({ id: 42, type: "Hub", widgets: {}, inputs: Array.from({ length: 5000 }, (_, i) => i) });
  const out = fitDetailLine(huge, stub, 800);
  assert.ok(out.length <= 800, `stub within budget, got ${out.length}`);
  assert.doesNotThrow(() => JSON.parse(out), "stub is valid JSON");
  assert.equal(JSON.parse(out).id, 42, "keeps the id so the row still identifies the node");
  assert.match(out, /detail_omitted/);
});

test("fitDetailLine leaves a within-budget line untouched (#609)", () => {
  const line = JSON.stringify({ id: 1, type: "KSampler", widgets: { steps: 20 } });
  assert.equal(fitDetailLine(line, { id: 1, type: "KSampler" }, 2000), line);
  assert.equal(fitDetailLine(line, { id: 1 }, Infinity), line, "no cap ⇒ unchanged");
});

test("fitDetailLine clips its OWN stub fields so the stub is ≤ max_chars (#609)", () => {
  // A pathologically long node id/type must not blow even the degraded stub.
  const huge = "y".repeat(20000);
  const out = fitDetailLine(huge, { id: "n".repeat(5000), type: "T".repeat(5000), title: "x".repeat(5000) }, 600);
  assert.ok(out.length <= 600, `stub self-bounded, got ${out.length}`);
  assert.doesNotThrow(() => JSON.parse(out), "still valid JSON");
});

test("clipLine bounds a plain compact line by length, leaving short lines intact (#609)", () => {
  assert.equal(clipLine("#1 KSampler · steps=20", 2000), "#1 KSampler · steps=20", "short line untouched");
  const huge = "#1 Wide · " + "k=v ".repeat(5000);
  const out = clipLine(huge, 2000);
  assert.ok(out.length <= 2000, `clipped to <= maxChars, got ${out.length}`);
  // #809: a bare "…" said only "something was here". The marker now says how much was
  // cut and which parameter lifts the cut, and STILL fits inside maxChars.
  assert.match(out, /…\(\+\d+ chars over `max_chars`; raise `max_chars` \(up to 60000\)\)$/);
  assert.equal(clipLine(huge, Infinity), huge, "no cap ⇒ unchanged");
});

test("capSummaryWidgets returns the same object when nothing needed capping", () => {
  const summary = { id: 1, widgets: { steps: 20, cfg: 4 } };
  assert.equal(capSummaryWidgets(summary), summary);
});

// The concrete #609 symptom: a single node with a huge widget blob must render.
test("a capped detail line for one huge-blob node fits a modest budget (#609)", () => {
  const summary = { id: 164, type: "ResolutionMaster", widgets: { auto_detect_presets_json: "x".repeat(20000) } };
  const before = JSON.stringify(summary);
  const after = JSON.stringify(capSummaryWidgets(summary));
  assert.ok(before.length > 7000, "raw detail exceeds the default single-node budget (reproduces shown:0)");
  assert.ok(after.length < 7000, "capped detail fits, so the requested node renders");
});

// ---- #609: budget protection + truncation message -------------------------

test("isLineProtected protects ONLY the first match (never shown:0), keeping the budget bound (#609)", () => {
  assert.equal(isLineProtected(0), true, "first line always renders, so matched≥1 ⇒ shown≥1");
  assert.equal(isLineProtected(1), false, "later lines stay budget-governed — output stays token-bounded");
  assert.equal(isLineProtected(9), false);
});

test("truncationTail advises raising max_chars when ids were explicit (#609)", () => {
  const withIds = truncationTail(1, 3, true, "max_chars", { limit: 40, maxChars: 600 });
  assert.match(withIds, /raise `max_chars`/);
  assert.doesNotMatch(withIds, /narrow with/, "no dead-end 'narrow with ids' advice");

  const noIds = truncationTail(5, 40, false, "max_chars", { limit: 40, maxChars: 600 });
  assert.match(noIds, /narrow with `types`\/`where`\/`ids`\/`depth`/);
});

// #809 — the defect this issue was filed for: the tail used to name ONE remedy for BOTH
// cuts. `limit` and `max_chars` have opposite fixes, so a tail that names the wrong one
// costs the caller a retry and then reads to them as proof the tool cannot do the job.
test("#809 truncationTail names the cap that ACTUALLY fired, and disowns the other", () => {
  const byChars = truncationTail(5, 690, false, "max_chars", { limit: 200, maxChars: 12000 });
  assert.match(byChars, /raise `max_chars` up to 60000/, "names the real lever and its real ceiling");
  assert.doesNotMatch(byChars, /raise `limit`/, "must NOT tell the caller to raise the useless lever");
  assert.match(byChars, /Raising `limit` will not help/);

  const byLimit = truncationTail(40, 690, false, "limit", { limit: 40, maxChars: 60000 });
  assert.match(byLimit, /raise `limit` up to 200/);
  assert.doesNotMatch(byLimit, /raise `max_chars`/);
  assert.match(byLimit, /`max_chars` is not the constraint here/);

  // Explicit ids get the same split — "request fewer ids" is wrong advice for a limit cut
  // in exactly the way "raise limit" is wrong advice for a budget cut.
  const idsByLimit = truncationTail(3, 60, true, "limit", { limit: 3, maxChars: 60000 });
  assert.match(idsByLimit, /raise `limit` up to 200/);
  assert.doesNotMatch(idsByLimit, /raise `max_chars`/);
});

// codex gate: "raise `X` up to N" is ITSELF a dead retry at N. A wasted retry is exactly
// what teaches an agent the tool cannot do the job, so at the ceiling the remedy must
// switch to something that can still work.
test("#809 truncationTail stops offering a raise the caller has already maxed out", () => {
  const maxedLimit = truncationTail(200, 690, false, "limit", { limit: 200, maxChars: 12000 });
  assert.match(maxedLimit, /`limit` is already at its ceiling of 200/);
  assert.doesNotMatch(maxedLimit, /raise `limit` up to/);
  assert.match(maxedLimit, /narrow with `types`/, "still names what IS left");

  const maxedChars = truncationTail(5, 690, false, "max_chars", { limit: 40, maxChars: 60000 });
  assert.match(maxedChars, /`max_chars` is already at its ceiling of 60000/);
  assert.doesNotMatch(maxedChars, /raise `max_chars` up to/);

  // Below the ceiling the raise is still the right first move.
  const room = truncationTail(40, 690, false, "limit", { limit: 40, maxChars: 12000 });
  assert.match(room, /raise `limit` up to 200/);
  assert.doesNotMatch(room, /already at its ceiling/);
});

// The stronger bar (codex gate): naming a real parameter is necessary and NOT
// sufficient. A raise with no ceiling leaves the caller unable to tell whether the retry
// is possible at all; a raise they have already maxed out is a guaranteed wasted round
// trip. Every marker this module emits is swept for both.
test("#809 no marker ever says 'raise X' without saying how far", () => {
  const emitted = [
    capWidgetValue("z".repeat(20000)),
    capWidgetValue("z".repeat(20000), 600),
    capSummaryWidgets({ id: 1, widgets: { blob: "q".repeat(5000) } }, WIDGET_VALUE_CAP, 600).widgets["…"],
    capSummaryWidgets({ id: 1, widgets: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`w${i}`, "z".repeat(500)])) }, WIDGET_VALUE_CAP, 3000).widgets["…"],
    clipLine("#1 Wide · " + "k=v ".repeat(5000), 2000),
    fitDetailLine("y".repeat(20000), { id: 1, type: "T" }, 800),
    truncationTail(5, 690, false, "max_chars", { limit: 40, maxChars: 12000 }),
    truncationTail(40, 690, false, "limit", { limit: 40, maxChars: 12000 }),
    outlineDegradeBanner({ level: "groups", nodeCount: 690, groupCount: 3, maxChars: 4000 }),
    outlineFloorRefusal({ nodeCount: 690, groupCount: 3, maxChars: 500, floorChars: 3000 }),
    outlineValueClipNote(3, 2),
    compactClipNote(3),
  ].filter((v) => typeof v === "string");

  assert.ok(emitted.length >= 10, "the sweep must actually cover the markers");
  for (const text of emitted) {
    for (const m of text.matchAll(/\braise\s+`([A-Za-z_][A-Za-z0-9_]*)`/gi)) {
      const name = m[1];
      const stated = new RegExp(`\`${name}\`[^.]{0,40}?\\(?up to \\d+|\`${name}\` is already at its ceiling`);
      assert.ok(
        stated.test(text),
        `remedy says "raise \`${name}\`" without a ceiling: ${JSON.stringify(text)}`,
      );
    }
  }
});

test("#809 every marker switches away from a raise the caller has already maxed out", () => {
  // Same code paths, caller at the ceiling.
  const atCeiling = [
    capSummaryWidgets({ id: 1, widgets: { blob: "q".repeat(5000) } }, WIDGET_VALUE_CAP, MAX_CHARS_CEILING).widgets.blob,
    clipLine("#1 Wide · " + "k=v ".repeat(50000), MAX_CHARS_CEILING),
    truncationTail(5, 690, false, "max_chars", { limit: 40, maxChars: MAX_CHARS_CEILING }),
    truncationTail(200, 690, false, "limit", { limit: 200, maxChars: 12000 }),
  ].filter((v) => typeof v === "string");
  for (const text of atCeiling) {
    if (!/already at its ceiling/.test(text)) continue; // marker may not fire at this size
    assert.doesNotMatch(text, /raise `max_chars` \(up to/, `dead raise alongside the ceiling note: ${text}`);
  }
  // And at least one of them must actually have taken the ceiling branch, or this test
  // is asserting nothing.
  assert.ok(atCeiling.some((t) => /already at its ceiling/.test(t)), "no ceiling branch exercised");
});

test("#809 a user-controlled title can never blow the outline budget", () => {
  const long = "T".repeat(5000);
  const out = clipOutlineTitle(long);
  assert.ok(out.text.length <= OUTLINE_TITLE_CAP + 1, `clipped title, got ${out.text.length}`);
  assert.match(out.text, /…$/);
  // It REPORTS the clip rather than leaving a bare "…" — the caller counts these and
  // raises ONE footer, instead of scattering signal-free ellipses through the outline.
  assert.equal(out.clipped, true);
  // Short titles pass through untouched — this is a bound, not a reformat.
  assert.deepEqual(clipOutlineTitle("REPLACEMENT MODE"), { text: "REPLACEMENT MODE", clipped: false });
  assert.deepEqual(clipOutlineTitle(undefined), { text: "", clipped: false });
  // Newlines in a title would break the one-line-per-group layout.
  assert.equal(clipOutlineTitle("a\n\nb").text, "a b");
});

test("#809 the outline footer covers title clips as well as value clips", () => {
  assert.equal(outlineValueClipNote(0, 0), "", "silent when nothing was clipped");
  const titlesOnly = outlineValueClipNote(0, 3);
  assert.match(titlesOnly, /3 title\(s\) clipped to 120 chars/);
  assert.doesNotMatch(titlesOnly, /widget value/);
  const both = outlineValueClipNote(2, 3);
  assert.match(both, /2 widget value\(s\) clipped to 60 chars and 3 title\(s\) clipped to 120 chars/);
  assert.match(both, /`max_chars` does not raise/);
});

test("#1748 the outline footer names NOTE nodes whose text was clipped", () => {
  // No note ids → byte-identical to the old footer: an unnoted graph pays nothing and
  // the clause never fires on title-only clips either.
  assert.equal(outlineValueClipNote(2, 0), outlineValueClipNote(2, 0, []), "no ids, no clause");
  const noted = outlineValueClipNote(3, 0, [7, 12]);
  assert.match(noted, /3 widget value\(s\) clipped to 60 chars/);
  assert.match(noted, /on-canvas note text \(node id\(s\): 7, 12\)/, "names the note nodes");
  assert.match(noted, /trigger words and usage instructions/, "says WHY a note clip matters");
  // The remedy that was already there still applies — detail reads the note up to the
  // fixed per-widget cap.
  assert.match(noted, /panel_query_graph \{ids:\[…\], fields:'detail'\}/);
  // The id list is bounded: a graph dense with notes cannot flood the footer (the
  // footer is part of the measured rung, but an unbounded list would still be noise).
  const many = outlineValueClipNote(25, 0, Array.from({ length: 30 }, (_, i) => i + 1));
  assert.match(many, /\+10 more/, "the id list is capped with an explicit remainder");
  assert.doesNotMatch(many, /\b21\b/, "ids past the cap are not listed");
});

test("#1748 NOTE_NODE_TYPES is the positive allowlist of on-canvas prose nodes", () => {
  assert.ok(NOTE_NODE_TYPES.has("Note"));
  assert.ok(NOTE_NODE_TYPES.has("MarkdownNote"));
  // A type that merely CONTAINS "note" is not prose-on-canvas by convention — the
  // footer naming a non-note would send the agent reading instructions that are not.
  assert.ok(!NOTE_NODE_TYPES.has("NoteToSelf"));
  assert.ok(!NOTE_NODE_TYPES.has("Reroute"));
});

test("#809 shown-of-matched is always stated, so 'how much is left' is never guesswork", () => {
  for (const by of ["limit", "max_chars"]) {
    for (const ids of [true, false]) {
      const t = truncationTail(7, 690, ids, by, { limit: 40, maxChars: 12000 });
      assert.match(t, /truncated at 7 of 690/, `${by}/ids=${ids} must state shown of matched`);
    }
  }
});

test("#809 the compact 60-char clip points at fields:'detail', not at a dead lever", () => {
  const short = clipCompactValue("hello");
  assert.equal(short.clipped, false);
  assert.equal(short.text, "hello");

  const long = clipCompactValue("z".repeat(400));
  assert.equal(long.clipped, true);
  assert.ok(long.text.length <= 60);

  const note = compactClipNote(3);
  assert.match(note, /3 widget value\(s\) clipped to 60 chars/);
  assert.match(note, /`fields`:"detail"/);
  // Raising max_chars does NOT lift this clip, so the note must not suggest it.
  assert.doesNotMatch(note, /raise `max_chars`/);
  assert.equal(compactClipNote(0), "", "silent when nothing was clipped");
});

// #809 — panel_graph_outline's budget. The ruling on this tool: degrade by RESOLUTION,
// never by coverage. Half a map is not a smaller map — an agent handed the first 200 of
// 690 nodes cannot tell what it is missing and will reason confidently about a graph it
// has seen a third of.
test("#809 outline ladder shrinks detail, never coverage", () => {
  assert.deepEqual(OUTLINE_DETAIL_LEVELS, ["full", "no_values", "no_widgets", "ids_only", "groups"]);

  // The same clamp window as panel_query_graph's max_chars — one budget concept, one
  // spelling, so a lever learned on one graph read is already known on the other.
  assert.equal(clampOutlineMaxChars(undefined), OUTLINE_MAX_CHARS_DEFAULT);
  assert.equal(clampOutlineMaxChars(1), OUTLINE_MAX_CHARS_FLOOR);
  assert.equal(clampOutlineMaxChars(1e9), OUTLINE_MAX_CHARS_CEILING);
  assert.equal(clampOutlineMaxChars("nonsense"), OUTLINE_MAX_CHARS_DEFAULT);
  assert.equal(clampOutlineMaxChars(4000), 4000);
});

test("#809 every degraded outline still states the TRUE shape and the lever", () => {
  for (const level of ["no_values", "no_widgets", "ids_only", "groups"]) {
    const b = outlineDegradeBanner({ level, nodeCount: 690, groupCount: 12, maxChars: 4000 });
    assert.match(b, /COVERAGE IS COMPLETE/, `${level} must not read as a partial graph`);
    assert.match(b, /all 690 node\(s\) and 12 group\(s\)/, `${level} must state the real totals`);
    assert.match(b, /raise `max_chars` up to 60000/i, `${level} must name the lever and its ceiling`);
  }
  // "full" is not a degradation, so it must be silent — a banner on an undegraded read
  // would train the caller to ignore banners.
  assert.equal(outlineDegradeBanner({ level: "full", nodeCount: 1, groupCount: 0, maxChars: 60000 }), "");
});

test("#809 the outline's fixed 60-char value clip names a tool, not a dead lever", () => {
  const note = outlineValueClipNote(7, 0);
  assert.match(note, /7 widget value\(s\) clipped to 60 chars/);
  // The clip is fixed. Suggesting max_chars here would be defect 1 in miniature.
  assert.match(note, /`max_chars` does not raise/);
  assert.match(note, /panel_query_graph/);
  // "Read FULL values" would over-promise: detail rows carry their own 2048-char
  // per-widget cap (codex gate). The note must state that downstream bound.
  assert.doesNotMatch(note, /full values/);
  assert.match(note, /caps each value at 2048 chars/);
});

test("#809 the outline floor REFUSES rather than emitting a partial graph", () => {
  const r = outlineFloorRefusal({ nodeCount: 690, groupCount: 12, maxChars: 500, floorChars: 3200 });
  assert.match(r, /CANNOT RENDER/);
  assert.match(r, /690 node\(s\)/, "a refusal still tells you how big the graph is");
  assert.match(r, /PARTIAL outline is deliberately NOT returned/);
  assert.match(r, /raise `max_chars` \(up to 60000\)/i);
});

test("#809 the refusal stops offering a raise that could never hold the outline", () => {
  // A graph whose group-level floor exceeds the CEILING cannot be outlined at any budget
  // this tool accepts, so "raise max_chars up to 60000" is a guaranteed second refusal —
  // a dead retry inside the message explaining the first one (codex gate).
  const r = outlineFloorRefusal({
    nodeCount: 20000,
    groupCount: 300,
    maxChars: 500,
    floorChars: 100_000,
  });
  assert.match(r, /Even `max_chars`'s ceiling of 60000 could not hold it/);
  assert.match(r, /raising it will NOT produce an outline/);
  assert.doesNotMatch(r, /Raise `max_chars` \(up to/);
  assert.match(r, /panel_query_graph/);

  // Below the ceiling the raise is still the right first move.
  const reachable = outlineFloorRefusal({
    nodeCount: 690,
    groupCount: 12,
    maxChars: 500,
    floorChars: 32_000,
  });
  assert.match(reachable, /Raise `max_chars` \(up to 60000\)/);
});

// End-to-end shape: mirror the graph_query budget loop with the helpers to prove a
// single-id query with a pathological blob yields shown:1, not shown:0.
test("budget loop with helpers: one requested huge-blob node renders (shown:1) (#609)", () => {
  const matched = [{ id: 164, type: "ResolutionMaster", widgets: { blob: "x".repeat(20000) } }];
  const maxChars = 7000;
  let shown = 0, truncated = false, chars = 20;
  for (const n of matched) {
    const line = JSON.stringify(capSummaryWidgets({ id: n.id, type: n.type, widgets: n.widgets }));
    const protectedLine = isLineProtected(shown);
    if (!protectedLine && chars + line.length + 1 > maxChars) { truncated = true; break; }
    chars += line.length + 1;
    shown++;
  }
  assert.equal(shown, 1, "the node the caller asked for by id renders");
  assert.equal(truncated, false);
});

// The budget stays token-bounded: a large ids list is NOT wholesale-exempted (the
// codex P1 regression). Only the first over-budget line renders; the rest truncate.
test("budget loop stays bounded for a large ids list — only the first overflows (#609)", () => {
  const matched = Array.from({ length: 10 }, (_, i) => ({ id: i, widgets: { note: "y".repeat(1500) } }));
  const maxChars = 4000;
  let shown = 0, truncated = false, chars = 20;
  for (const n of matched) {
    const line = JSON.stringify(capSummaryWidgets({ id: n.id, widgets: n.widgets }));
    if (!isLineProtected(shown) && chars + line.length + 1 > maxChars) { truncated = true; break; }
    chars += line.length + 1;
    shown++;
  }
  assert.ok(shown >= 1 && shown < 10, `bounded: rendered ${shown} of 10, not all`);
  assert.equal(truncated, true, "the rest are honestly marked truncated");
});

// #1634 — a compact row's 60-char clip is a SURVEY cap. On a PINPOINT read (explicit
// `ids`) it starved the very value the caller asked for: measured on a FOUR-node graph,
// {ids:["2"]} returned a 300-char prompt cut at 60 in a 301-char reply against a
// 12000-char budget. These pin the note's half of that fix — it must name the cap that
// ACTUALLY fired, because at the fixed cap "use fields:detail" is a dead retry.
test("#1634 the clip note names the cap actually in force", () => {
  // Survey read: unchanged — 60 chars, and `fields`:"detail" is a live remedy.
  const survey = compactClipNote(3);
  assert.match(survey, /clipped to 60 chars by `fields`:"compact"/);
  assert.match(survey, /read fuller values with `fields`:"detail"/);
  assert.equal(compactClipNote(3), compactClipNote(3, 60), "60 is the survey default");

  // Pinpoint at the FIXED cap: `fields`:"detail" applies the SAME cap, so pointing
  // there would be exactly the dead retry #809 exists to remove.
  const atCap = compactClipNote(1, WIDGET_VALUE_CAP);
  assert.match(atCap, new RegExp(`clipped to ${WIDGET_VALUE_CAP} chars`));
  assert.doesNotMatch(atCap, /read fuller values with `fields`:"detail"/);
  assert.match(atCap, /no parameter raises/);

  // #1634 (gate): there are exactly TWO honest forms, because the cap is uniform across
  // the row and is only ever the survey clip or the fixed cap. An intermediate,
  // budget-derived cap was tried and removed — it named a number that was in force for no
  // widget, and called a cut "unraisable" that raising `max_chars` demonstrably lifted.
  // The survey clip is one of them, verbatim.
  assert.equal(compactClipNote(1, 60), compactClipNote(1), "the survey cap uses the survey note");
  // Whichever form is emitted, the number it names is a cap that really applies — never a
  // budget-derived figure that was in force for no widget.
  for (const cap of [COMPACT_VALUE_CLIP, WIDGET_VALUE_CAP]) {
    const named = /clipped to (\d+) chars/.exec(compactClipNote(1, cap))?.[1];
    assert.equal(named, String(cap), `the note must name the cap in force (${cap})`);
  }
  assert.equal(compactClipNote(0, WIDGET_VALUE_CAP), "", "still silent when nothing clipped");
});

test("#1634 clipCompactValue honours a raised cap for a pinpoint read", () => {
  const prompt = "m".repeat(300);
  // Survey cap starves it...
  const survey = clipCompactValue(prompt, 60);
  assert.equal(survey.clipped, true);
  assert.ok(survey.text.length < 70);
  // ...the pinpoint cap carries it whole, with no clip to report.
  const pinpoint = clipCompactValue(prompt, WIDGET_VALUE_CAP);
  assert.equal(pinpoint.clipped, false);
  assert.equal(pinpoint.text, prompt);
});

// ---- #342: live target-slot resolution for the outline ---------------------

// The #342 shape: `easy saveVideo` after `input_mode` (COMFY_DYNAMICCOMBO_V3)
// collapsed — link 7's recorded target_slot (2, the old `input_mode.images`) is
// stale, and slot 2 is now occupied by the BOOLEAN `output_mode.save_metadata`.
// The live truth: NO input backlinks link 7 — the connection is gone.
function saveVideoAfterComboCollapse() {
  return {
    id: 12,
    type: "easy saveVideo",
    inputs: [
      { name: "input_mode", type: "COMBO", link: null },
      { name: "output_mode.save_metadata", type: "BOOLEAN", link: null },
      { name: "output_mode", type: "COMBO", link: null },
      { name: "filename_prefix", type: "STRING", link: null },
    ],
  };
}

test("liveLinkTargetInput returns null for an orphaned link (slot removed) (#342)", () => {
  // The orphaned record must render NOTHING — the old render showed it against
  // save_metadata, fabricating a connection the graph no longer has.
  assert.equal(liveLinkTargetInput(saveVideoAfterComboCollapse(), 7), null);
});

test("liveLinkTargetInput finds the live slot AFTER compaction shifted it (#342)", () => {
  // A removed ref_video_0 input compacted the tail: link 9 was recorded against
  // slot 3 but the input that still backlinks it now sits at index 2.
  const node = {
    id: 5,
    inputs: [
      { name: "image", type: "IMAGE", link: null },
      { name: "ref_video_1", type: "VIDEO", link: 9 },
      { name: "fps", type: "FLOAT", link: null },
    ],
  };
  assert.deepEqual(liveLinkTargetInput(node, 9), { index: 1, name: "ref_video_1" });
});

test("liveLinkTargetInput resolves the ordinary uncompacted case (#342)", () => {
  const node = {
    id: 3,
    inputs: [
      { name: "model", type: "MODEL", link: 4 },
      { name: "clip", type: "CLIP", link: null },
    ],
  };
  assert.deepEqual(liveLinkTargetInput(node, 4), { index: 0, name: "model" });
});

test("liveLinkTargetInput keeps the index when the live input has no name (#342)", () => {
  const node = { id: 8, inputs: [{ type: "IMAGE", link: 2 }] };
  assert.deepEqual(liveLinkTargetInput(node, 2), { index: 0, name: undefined });
});

test("liveLinkTargetInput matches a string link id against a numeric backlink (#342)", () => {
  const node = { id: 8, inputs: [{ name: "image", type: "IMAGE", link: 7 }] };
  assert.deepEqual(liveLinkTargetInput(node, "7"), { index: 0, name: "image" });
});

test("liveLinkTargetInput never matches an unlinked input — even to link id 0 (#342)", () => {
  // Number(null) is 0: without the null guard, link id 0 would "resolve" to the
  // first UNCONNECTED input and fabricate the very connectivity #342 removes.
  const node = { id: 8, inputs: [{ name: "image", type: "IMAGE", link: null }] };
  assert.equal(liveLinkTargetInput(node, 0), null);
});

test("liveLinkTargetInput never throws on malformed nodes (#342)", () => {
  assert.equal(liveLinkTargetInput(null, 1), null);
  assert.equal(liveLinkTargetInput({}, 1), null);
  // Holes in the inputs array are skipped, not crashed on.
  assert.equal(liveLinkTargetInput({ inputs: [null, undefined] }, 3), null);
  assert.deepEqual(liveLinkTargetInput({ inputs: [null, { link: 3 }] }, 3), { index: 1, name: undefined });
});
