/**
 * #1108 — WHEN THE CANVAS ITSELF CANNOT DRAW.
 *
 * `graph_screenshot` fits the view and then calls `canvas.draw(true, true)` — a
 * SYNCHRONOUS redraw inside LiteGraph. If that throws, the panel surfaced the raw
 * exception:
 *
 *     Error: Cannot read properties of undefined (reading 'name')
 *
 * which says nothing about what happened or what to do. The reporter hit it while
 * trying to screenshot a canvas that had frozen — pan, zoom and clicks all dead
 * during an LTX render — so the one tool that could have shown them what they were
 * looking at is the one that failed, with a message that reads like a panel bug.
 *
 * It is not a panel bug — the panel is the caller, and the throw came out of the
 * frontend's draw path. It is NOT safe to go further and call it "not a graph
 * problem", which the first version of this did: a node or widget the renderer
 * cannot draw throws exactly here while `panel_graph_outline` reads that same node
 * perfectly well, which is what the reporter observed. Where it threw is known;
 * what caused it is not.
 *
 * So the panel says what it saw. It cannot repair LiteGraph's render loop, and it
 * must not pretend to know more than where the throw came from — see the function
 * below for what was claimed and then retracted.
 */

/**
 * What to say when the redraw throws.
 *
 * It says what it saw and no more (codex review). It does NOT exclude the graph as
 * the cause — a node or widget the renderer cannot draw throws here while a graph
 * READ of that same node succeeds, so "not the graph" would have sent someone away
 * from the likeliest lead. It does not assert that the freeze and the failed draw
 * are one fault; shared timing is not a shared cause. And it offers the refresh as
 * the thing that cleared it for the one report of this, not as a remedy the panel
 * can promise.
 */
export function describeCanvasDrawFailure(err, opts = {}) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const alsoFrozen = opts.canvasReportedFrozen === true;
  const freeze = alsoFrozen
    ? `That was reported here, so it is worth treating as one fault rather than two — though ` +
      `shared timing is not proof of a shared cause.`
    : `If the user reports that too, they may be one fault seen from two directions rather than ` +
      `two problems.`;
  return (
    `The screenshot could not be taken: the ComfyUI canvas threw while REDRAWING itself ` +
    `(${raw || "no message"}). The throw is from the frontend's render path, which does NOT rule ` +
    `out the graph as its cause: a node or widget the renderer cannot draw throws here while ` +
    `panel_graph_outline still reads that same graph perfectly well. Use panel_graph_outline and ` +
    `panel_get_errors now — if either names a node, that node is the first thing to look at.\n\n` +
    `WHAT IT MAY MEAN FOR THE CANVAS: a render loop that cannot complete a draw is also what a ` +
    `frozen canvas looks like from the user's side — no pan, no zoom, clicks dead. ${freeze}\n\n` +
    `WHAT TO TRY: a hard refresh of the ComfyUI browser tab (F5) is what cleared it for the one ` +
    `report of this, and the panel cannot repair the frontend's render state from here, so ` +
    `re-taking the screenshot is unlikely to succeed before then. If a refresh does NOT clear it, ` +
    `then it is not (only) stale render state: look at the graph, and at any extension ` +
    `that draws on the canvas, because whatever it is survives a reload. Either way a refresh discards unsaved canvas work, so offer the user a save ` +
    `FIRST.`
  );
}
