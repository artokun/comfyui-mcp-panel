// #809 — panel_graph_outline must never trade COVERAGE for budget.
//
// The outline exists so an agent can UNDERSTAND a whole graph. A budget that stopped
// partway would defeat that outright: half a map is not a smaller map. An agent handed
// the first 200 of a 690-node graph cannot tell what it is missing, and will reason
// confidently about a graph it has seen a third of — the fabrication failure mode in a
// different hat. So the executor is allowed to shed RESOLUTION and never nodes.
//
// These are STRUCTURAL assertions over the handler source, because the invariant is
// about what the code is permitted to do, not about one sampled output. A future edit
// that "fixes" an over-budget outline by slicing the node list fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { liveLinkTargetInput } from "../../web/js/lib/graph-read.js";
import { readStoredLink } from "../../web/js/lib/connect-verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** The executor method body, from its signature to the next executor method. */
function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const after = start + sig.length;
  const m = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  const end = m ? after + m.index : src.length;
  return src.slice(start, end);
}

const outline = () => {
  const body = handlerBody(readFileSync(PANEL_JS, "utf8"), "graph_outline({");
  assert.ok(body, "graph_outline({ … }) handler must exist");
  return body;
};

test("#809 graph_outline takes the SAME max_chars budget as panel_query_graph", () => {
  const body = outline();
  assert.match(body, /graph_outline\(\{ max_chars \} = \{\}\)/, "accepts max_chars, still callable with no args");
  assert.match(body, /clampOutlineMaxChars\(max_chars\)/, "clamps through the shared 500–60000 window");
  // A differently-named budget for the same concept would force agents to learn the
  // lever twice, which is how they end up not reaching for it at all.
  assert.doesNotMatch(body, /max_nodes|node_limit|outline_chars/, "no second spelling of the same budget");
});

test("#809 graph_outline never truncates the NODE LIST to fit", () => {
  const body = outline();
  // The only slicing allowed in this handler is none: every rung renders every node.
  assert.doesNotMatch(
    body,
    /\b(sorted|nodes)\s*\.\s*slice\s*\(/,
    "the node list must never be sliced — degrade detail, not coverage",
  );
  assert.doesNotMatch(body, /MAX_STATE_NODES/, "the outline is not a MAX_STATE_NODES view");
  // Every rung iterates the FULL topologically-sorted set.
  assert.match(body, /for \(const n of sorted\)/, "node rows are rendered from the full sorted set");
});

test("#809 no user-controlled title reaches the outline unbounded", () => {
  const body = outline();
  // Group titles ride in the GROUPS index at every node rung, in the group summary at the
  // floor, and the subgraph title rides in the header the REFUSAL also emits. A single
  // long title would breach max_chars at every rung, since the ladder sheds detail but
  // cannot shorten one title (codex gate).
  assert.doesNotMatch(body, /\$\{g\.title \?\? ""\}/, "raw group title in the outline");
  assert.doesNotMatch(body, /\$\{va\.title \?\? ""\}/, "raw subgraph title in the header");
  assert.doesNotMatch(body, /` "\$\{n\.title\}"`/, "raw NODE title in a node row");
  // Every title site goes through the counting wrapper: the GROUPS index, the group
  // summary floor, the header (which the REFUSAL path re-emits), and the node rows.
  // Four direct calls (GROUPS index, group-summary floor, header, node row) plus the
  // `grps.map(title_)` reference asserted below.
  const clips = body.match(/title_\(/g) ?? [];
  assert.ok(clips.length >= 4, `every title site must clip, found ${clips.length}`);
  assert.match(body, /const title_ = \(t\) => \{/, "the wrapper counts, so one footer can report");

  // The per-node `group:` tag is the sneaky one: groupOf deliberately holds RAW titles so
  // MEMBERSHIP never depends on a display clip, which means the clip has to happen at the
  // interpolation site — and one long group title otherwise rides on EVERY member node's
  // row (codex gate).
  assert.doesNotMatch(body, /group:\$\{grps\.join\("\/"\)\}/, "raw group title on every member row");
  assert.match(body, /group:\$\{grps\.map\(title_\)\.join\("\/"\)\}/);
});

test("#809 the query path fits its tail and footer INSIDE max_chars", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "graph_query({");
  assert.ok(body, "graph_query handler must exist");
  // Fitting AFTERWARDS, not reserving up front: a reserve would manufacture a truncation
  // on a result that fitted, which is the false-truncation defect in the other direction.
  assert.match(body, /while \(text\.length > maxChars && lines\.length > 1\)/);
  assert.match(body, /lines\.pop\(\);/);
  assert.doesNotMatch(body, /FOOTER_RESERVE/, "no up-front reserve");

  // The AGGREGATE branch returns earlier and is not covered by that loop — it filled the
  // budget with rows and then appended its tail, the same defect on a different path.
  assert.match(body, /while \(aggText\.length > maxChars && kept\.length > 0\)/);
  assert.match(body, /kept\.pop\(\);/);

  // The clip footer counts only rows actually RETURNED: a running total would include
  // rows the budget rejected and rows the post-fit loop popped, so the note would claim
  // clips the reader cannot see.
  assert.match(body, /lineClips\.push\(rowClips\);/);
  assert.match(body, /lineClips\.pop\(\);/);
  assert.match(body, /compactClipNote\(lineClips\.reduce\(/);
});

test("#1681 only an explicit detail query can raise the per-widget cap", () => {
  const body = handlerBody(readFileSync(PANEL_JS, "utf8"), "graph_query({");
  assert.match(body, /widget_max_chars/, "the opt-in cap is an argument to graph_query");
  assert.match(body, /fields === "detail" && Array\.isArray\(ids\) && ids\.length === 1/);
  assert.match(body, /clampDetailWidgetCap\(widget_max_chars\)/);
  assert.match(body, /capSummaryWidgets\(summarizeNode\(n\), detailWidgetCap, maxChars\)/);
  // artokun/comfyui-mcp#2436 — the stub now also carries `is_subgraph`, which is
  // LOAD-BEARING: the orchestrator refuses an ordinary write on any node it cannot
  // classify, so dropping it made every wide node unwritable. Pinned by the fields
  // that MATTER rather than by the whole literal, which froze incidental field order
  // and broke on a change that was correct.
  assert.match(body, /fitDetailLine\(line, \{[^}]*\}, maxChars\)/);
  assert.match(body, /fitDetailLine\(line, \{[^}]*is_subgraph: summary\.is_subgraph[^}]*\}/);
});

// The `groups`/`rails` riders sit OUTSIDE the max_chars accounting (#807 owns that fix).
// Until it lands they must at least be BOUNDED and MARKED, or the reply exceeds the very
// budget the tool advertises no matter what the caller sets — and a silently short groups
// list reads as "this graph has N groups" (codex gate).
test("#809 the groups rider is bounded and says so", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "graph_query({");
  assert.match(body, /GROUPS_RIDER_CAP/, "the rider itself is capped");
  assert.match(body, /groups_truncation_hint:/, "and the cut is stated in-band");
  // A SIBLING field, not an extra array element: injecting a {truncated,hint} object into
  // groups[] would make the array heterogeneous for any client expecting id/title.
  assert.doesNotMatch(body, /\.\.\.allGroups\.slice\(0, GROUPS_RIDER_CAP\),\s*\{/);
  assert.match(body, /#807/, "pointing at the issue that owns the accounting fix");

  const summarize = handlerBody(src, "function summarizeGroup(graph, g) {");
  assert.ok(summarize, "summarizeGroup must exist");
  // A user-controlled title and an unbounded member list are the two ways one group can
  // be arbitrarily large.
  assert.match(summarize, /clipOutlineTitle\(g\.title\)/);
  assert.match(summarize, /GROUP_NODE_IDS_CAP/);
  assert.match(summarize, /node_ids_truncated:/);
  // node_count stays the TRUE total, so a clipped node_ids can never read as the whole
  // membership.
  assert.match(summarize, /node_count: memberIds\.length/);
});

test("#809 graph_outline walks the detail ladder and reports which rung it used", () => {
  const body = outline();
  assert.match(body, /OUTLINE_DETAIL_LEVELS/, "uses the shared ladder");
  assert.match(body, /detail_level:/, "reports the rung it landed on");
  assert.match(body, /degraded_reason:/, "says WHY detail was reduced");
  assert.match(body, /outlineDegradeBanner\(/, "puts the notice ON the outline text, not only in a field");
});

test("#809 graph_outline REFUSES rather than emitting a partial graph at the floor", () => {
  const body = outline();
  assert.match(body, /outlineFloorRefusal\(/, "the floor is a refusal, not a partial dump");
  assert.match(body, /detail_level: refused \? "refused"/, "a refusal is reported as such");

  // The refusal was assembled AFTER the ladder's fit test, so the stale banner and header
  // could push it back over the very bound it was explaining (codex gate). It now sheds
  // the optional parts in order — both are also returned as structured fields, so nothing
  // is lost — and never truncates the refusal sentence itself.
  assert.match(body, /const candidates = \[/);
  assert.match(body, /candidates\.find\(\(c\) => c\.length <= maxChars\) \?\? refusal/);
});

test("#809 the refusal itself fits the smallest budget the tool accepts", async () => {
  const m = await import("../../web/js/lib/graph-read.js");
  // If the message that says "I refused to hand you a partial graph" did not fit, the
  // tool would have to either truncate it (self-defeating) or breach its own bound.
  const refusal = m.outlineFloorRefusal({
    nodeCount: 690,
    groupCount: 12,
    maxChars: m.OUTLINE_MAX_CHARS_FLOOR,
    floorChars: 32000,
  });
  assert.ok(
    refusal.length <= m.OUTLINE_MAX_CHARS_FLOOR,
    `refusal is ${refusal.length} chars, over the ${m.OUTLINE_MAX_CHARS_FLOOR} floor`,
  );
});

test("#809 the MAX_STATE_NODES views state their cap instead of a bare boolean", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // Each capped view must carry prose the model actually reads, not just `truncated:true`.
  // Views whose cap is FIXED and has no lever: they must say so, using the shared
  // wording that is honest about there being nothing to raise.
  for (const sig of ["graph_view_selected()", "graph_get_subgraph({"]) {
    const body = handlerBody(src, sig);
    assert.ok(body, `${sig} must exist`);
    assert.match(body, /truncation_hint:/, `${sig} must emit a remedy, not only a boolean`);
    assert.match(body, /fixedCapNote\(/, `${sig} must use the shared fixed-cap wording`);
  }

  // #845 — the viewport view now HAS a lever (`max_chars`), because a 100-node cap
  // bounded the wrong unit and still emitted 135k characters. It must therefore NOT
  // use the fixed-cap wording, which would tell a caller no parameter raises it when
  // one does — the same defect (naming a lever that does not match reality) pointed
  // the other way. It still owes a remedy, and that remedy must carry a ceiling.
  const viewport = handlerBody(src, "graph_view_nodes_in_viewport({ max_chars } = {})");
  assert.ok(viewport, "graph_view_nodes_in_viewport must exist");
  assert.ok(!/fixedCapNote\(/.test(viewport),
    "a view WITH a lever must not claim the fixed-cap 'no parameter raises it' wording");
  assert.ok(/viewportTruncation\(/.test(viewport),
    "it must emit the lever-aware truncation instead");
  // And the shared wording must be honest about there being no lever — inventing one
  // would be the same defect as naming the wrong one.
  assert.match(src, /FIXED cap of \$\{MAX_STATE_NODES\} and no parameter raises it/);
});

test("#809 graph_find_nodes says the scan STOPPED, not that it found everything", () => {
  const body = handlerBody(readFileSync(PANEL_JS, "utf8"), "graph_find_nodes({");
  assert.ok(body, "graph_find_nodes handler must exist");
  assert.match(body, /truncation_hint:/, "a bare `truncated` boolean is not a signal a model reads");
  assert.match(body, /not evidence a node is absent/, "a capped scan must not read as 'no such node'");
  // Backticks are escaped in the source template literal.
  assert.match(body, /Raise \\`limit\\` up to \$\{LIMIT_CEILING\}/, "names the real lever and its real ceiling");
  assert.match(body, /Math\.min\(Math\.max\(Number\(limit \?\? 40\), 1\), LIMIT_CEILING\)/, "the clamp and the quoted ceiling are the SAME constant");
});

// A false truncation claim is its own defect: told "there may be more" when there is not,
// an agent burns a retry and learns the tool is unreliable. `truncated` must be PROVEN by
// an actually-found (cap+1)-th match, never inferred from reaching the cap.
test("#809 graph_find_nodes proves truncation with a (cap+1)-th match, never infers it", () => {
  const body = handlerBody(readFileSync(PANEL_JS, "utf8"), "graph_find_nodes({");
  assert.match(body, /let overCap = false;/, "truncation is a proven fact, not a count comparison");
  assert.match(body, /if \(matches\.length > cap\) \{[\s\S]*?matches\.pop\(\);[\s\S]*?overCap = true;/,
    "takes one past the cap, then drops it");
  assert.match(body, /truncated: overCap,/, "reports the proven fact");
  assert.doesNotMatch(body, /truncated: matches\.length >= cap/,
    "matches.length >= cap is true for an EXACT-cap result that dropped nothing");
});

test("#809 the outline's own fixed clips are not left silent", () => {
  const body = outline();
  assert.match(body, /outlineClipped\+\+/, "the fixed per-value clip is counted");
  assert.match(body, /outlineTitlesClipped\+\+/, "so is the fixed per-title clip");
  assert.match(
    body,
    /outlineValueClipNote\(outlineClipped, outlineTitlesClipped, outlineClippedNoteIds\)/,
    "and both are reported on the outline itself",
  );
});

// A bare count of clipped values cannot tell the reader that one of them was on-canvas
// INSTRUCTIONS (a Note/MarkdownNote holding trigger words) rather than a re-queryable
// seed — the row's own 60-char clip reads as the whole note. The footer must NAME the
// note nodes whose text was clipped, and the id list must reset per rung like the
// counts do, or a lower rung would claim note clips it does not contain.
test("#1748 clipped NOTE text is named by node id, not folded into the count", () => {
  const body = outline();
  assert.match(body, /let outlineClippedNoteIds = \[\];/, "the note-id list exists");
  assert.match(
    body,
    /NOTE_NODE_TYPES\.has\(node\?\.type\) && !outlineClippedNoteIds\.includes\(node\.id\)\s*\)\s*\n?\s*outlineClippedNoteIds\.push\(node\.id\)/,
    "a clipped value on a Note/MarkdownNote records the node id, deduped",
  );
  const assembleStart = body.indexOf("const assemble = (level) => {");
  assert.notEqual(assembleStart, -1, "assemble() must exist");
  const assembleBody = body.slice(assembleStart, body.indexOf("// Walk DOWN the ladder"));
  assert.match(assembleBody, /outlineClippedNoteIds = \[\];/, "the id list resets per rung, inside assemble");
});

// The footer is PART of the rung. Appending it after the fit test could tip a rung over
// budget and trigger the floor refusal while lower rungs were never tried — and the
// refusal would then call that oversized full-detail size the "smallest whole-graph
// form" (codex gate).
test("#809 each rung is measured WITH its footer, and the counters reset inside", () => {
  const body = outline();
  const assembleStart = body.indexOf("const assemble = (level) => {");
  assert.notEqual(assembleStart, -1, "assemble() must exist");
  const assembleBody = body.slice(assembleStart, body.indexOf("// Walk DOWN the ladder"));
  assert.match(assembleBody, /outlineClipped = 0;/, "counters reset per rung, inside assemble");
  assert.match(assembleBody, /outlineTitlesClipped = 0;/);
  assert.match(assembleBody, /outlineValueClipNote\(/, "the footer is inside the measured string");
  // The ladder loop must contain no post-hoc append of the note.
  const ladder = body.slice(body.indexOf("// Walk DOWN the ladder"));
  assert.doesNotMatch(ladder, /outline \+= outlineValueClipNote/, "no post-fit append");
});

// ---- #342: the OUTGOING render must resolve the link's LIVE target slot -----
//
// A link record's `target_slot` is captured at connect time and goes STALE when the
// target node's inputs are compacted afterwards (a COMFY_DYNAMICCOMBO_V3 rebuilding
// its slots, a removed dynamic `ref_video_N` input shifting the tail). The outline
// then reported the link against whatever slot now OCCUPIES that index —
// `VAEDecode → easy saveVideo.output_mode.save_metadata`, a BOOLEAN — while
// panel_query_graph, which reads the live `inputs[].link` backlink, correctly showed
// the connection was gone.
//
// These tests EXECUTE the render block lifted verbatim out of the handler, because a
// helper-level test cannot see this call site: with the entire wiring hunk reverted,
// all eight liveLinkTargetInput unit tests (and the other 5030) still pass. Reading
// the source would not have caught that; running it does.

/** The outgoing-link render block, taken VERBATIM from the graph_outline handler and
 *  run against a synthetic graph. Free variables of the block are injected. */
function renderOutgoing({ node, links, nodes }) {
  const body = outline();
  const start = body.indexOf("const outs = [];");
  const end = body.indexOf("if (outs.length)", start);
  assert.notEqual(start, -1, "the outgoing-link render block must be locatable");
  assert.ok(end > start, "the outgoing-link render block must terminate at its emit");
  assert.equal(body.lastIndexOf("const outs = [];"), start, "one outgoing render block only");
  const block = body.slice(start, end);
  // eslint-disable-next-line no-new-func -- running the real source IS the assertion
  const run = new Function(
    "n",
    "links",
    "byId",
    "liveLinkTargetInput",
    "readStoredLink",
    "graph",
    block + " return outs;",
  );
  return run(
    node,
    links,
    new Map(nodes.map((x) => [x.id, x])),
    liveLinkTargetInput,
    readStoredLink,
    { links },
  );
}

/** The graph_query adjacency block, taken VERBATIM from the handler and run against a
 * synthetic graph. Keeping this at the production-source boundary covers traversal,
 * rather than only the outline's formatting branch. */
function queryAdjacency({ nodes, links }) {
  const body = handlerBody(readFileSync(PANEL_JS, "utf8"), "graph_query({");
  assert.ok(body, "graph_query({ … }) handler must exist");
  const start = body.indexOf("const up = new Map();");
  const end = body.indexOf("const closure =", start);
  assert.notEqual(start, -1, "the graph-query adjacency block must be locatable");
  assert.ok(end > start, "the graph-query adjacency block must terminate at the closure");
  const block = body.slice(start, end);
  // eslint-disable-next-line no-new-func -- running the real source IS the assertion
  const run = new Function("nodes", "graph", "links", "readStoredLink", `${block}\nreturn { up, down };`);
  return run(nodes, { links }, links, readStoredLink);
}

test("#342 an ORPHANED outgoing link renders NOTHING, not the slot that took its index", () => {
  // The repro: `easy saveVideo` after `input_mode` (COMFY_DYNAMICCOMBO_V3) collapsed.
  // Link 7's recorded target_slot 1 was `input_mode.images`; slot 1 now holds the
  // BOOLEAN `output_mode.save_metadata`, and NO input backlinks link 7 any more.
  const target = {
    id: 12,
    type: "easy saveVideo",
    inputs: [
      { name: "input_mode", type: "COMBO", link: null },
      { name: "output_mode.save_metadata", type: "BOOLEAN", link: null },
      { name: "output_mode", type: "COMBO", link: null },
      { name: "filename_prefix", type: "STRING", link: null },
    ],
  };
  const origin = { id: 4, type: "VAEDecode", outputs: [{ name: "IMAGE", links: [7] }] };
  const outs = renderOutgoing({
    node: origin,
    nodes: [origin, target],
    links: { 7: { id: 7, origin_id: 4, origin_slot: 0, target_id: 12, target_slot: 1 } },
  });
  assert.deepEqual(outs, [], "a link no input backlinks must not appear in the outline");
  // Named explicitly: this exact string is what #342 was filed about.
  assert.ok(
    !outs.includes("12.output_mode.save_metadata"),
    "the outline must never attribute a dropped link to the slot that took its index",
  );
});

test("#342 a link whose live slot SHIFTED renders the slot it actually feeds", () => {
  // A removed dynamic `ref_video_0` compacted the tail: link 9 was recorded against
  // slot 2, but the input that still backlinks it now sits at index 1. Slot 2 now
  // holds `fps` — which is what the stale render reported.
  const target = {
    id: 5,
    type: "Bernini r2v",
    inputs: [
      { name: "image", type: "IMAGE", link: null },
      { name: "ref_video_1", type: "VIDEO", link: 9 },
      { name: "fps", type: "FLOAT", link: null },
    ],
  };
  const origin = { id: 2, type: "LoadVideo", outputs: [{ name: "VIDEO", links: [9] }] };
  const outs = renderOutgoing({
    node: origin,
    nodes: [origin, target],
    links: { 9: { id: 9, origin_id: 2, origin_slot: 0, target_id: 5, target_slot: 2 } },
  });
  assert.deepEqual(outs, ["5.ref_video_1"]);
  assert.ok(!outs.includes("5.fps"), "the stale index must not name the input it now points at");
});

test("#342 an ordinary, uncompacted link still renders exactly as before", () => {
  const target = {
    id: 3,
    type: "KSampler",
    inputs: [
      { name: "model", type: "MODEL", link: 4 },
      { name: "positive", type: "CONDITIONING", link: null },
    ],
  };
  const origin = { id: 1, type: "CheckpointLoaderSimple", outputs: [{ name: "MODEL", links: [4] }] };
  const outs = renderOutgoing({
    node: origin,
    nodes: [origin, target],
    links: { 4: { id: 4, origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0 } },
  });
  assert.deepEqual(outs, ["3.model"]);
});

test("#1590 a stale source output backlink cannot fabricate downstream consumers", () => {
  // The live target backlink and link record say 4 → 8. Node 17's output cache still
  // carries that link id, which used to make the outline say 17 → 8 while detail and
  // downstream_of followed the stored origin and said 4 → 8.
  const target = {
    id: 8,
    type: "KSampler",
    inputs: [{ name: "model", type: "MODEL", link: 40 }],
  };
  const staleSource = { id: 17, type: "NC04 LoRA", outputs: [{ name: "MODEL", links: [40] }] };
  const realSource = { id: 4, type: "CheckpointLoaderSimple", outputs: [{ name: "MODEL", links: [40] }] };
  const links = { 40: { id: 40, origin_id: 4, origin_slot: 0, target_id: 8, target_slot: 0 } };

  assert.deepEqual(
    renderOutgoing({ node: staleSource, nodes: [staleSource, realSource, target], links }),
    [],
    "the outline must not attribute another source's stored link to node 17",
  );
  assert.deepEqual(
    renderOutgoing({ node: realSource, nodes: [staleSource, realSource, target], links }),
    ["8.model"],
    "the stored origin must remain visible from its actual source",
  );
});

test("#1590 downstream traversal follows the stored origin, including a Map-backed link store", () => {
  const target = { id: 8, inputs: [{ name: "model", link: 40 }] };
  const staleSource = { id: 17, outputs: [{ links: [40] }] };
  const realSource = { id: 4, outputs: [{ links: [40] }] };
  const stored = { id: 40, origin_id: 4, origin_slot: 0, target_id: 8, target_slot: 0 };
  const { down } = queryAdjacency({
    nodes: [staleSource, realSource, target],
    links: new Map([[40, stored]]),
  });

  assert.deepEqual([...down.get("17") ?? []], [], "stale output metadata must not create a consumer");
  assert.deepEqual([...down.get("4") ?? []], ["8"], "the stored origin must retain its consumer");
});

test("#342 with no live inputs to verify against, the recorded slot renders as a bare index", () => {
  // Fail-open is bounded to the case where there is nothing to check: the target is
  // not in this graph's node set (a dead record naming an id the outline does not
  // even list, so the reader can SEE it is dangling), or it carries no inputs array.
  const origin = { id: 6, type: "VAEDecode", outputs: [{ name: "IMAGE", links: [11, 12] }] };
  const inputless = { id: 8, type: "Note" };
  const outs = renderOutgoing({
    node: origin,
    nodes: [origin, inputless],
    links: {
      11: { id: 11, origin_id: 6, origin_slot: 0, target_id: 99, target_slot: 2 },
      12: { id: 12, origin_id: 6, origin_slot: 0, target_id: 8, target_slot: 0 },
    },
  });
  assert.deepEqual(outs, ["99.2", "8.0"]);
});
