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
  for (const sig of [
    "graph_view_selected()",
    "graph_view_nodes_in_viewport()",
    "graph_get_subgraph({",
  ]) {
    const body = handlerBody(src, sig);
    assert.ok(body, `${sig} must exist`);
    assert.match(body, /truncation_hint:/, `${sig} must emit a remedy, not only a boolean`);
    assert.match(body, /fixedCapNote\(/, `${sig} must use the shared fixed-cap wording`);
  }
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
    /outlineValueClipNote\(outlineClipped, outlineTitlesClipped\)/,
    "and both are reported on the outline itself",
  );
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
