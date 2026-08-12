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
 * It is not a panel bug, and it is not a graph or backend problem: in that same
 * moment `panel_get_errors` and `panel_graph_outline` both answered correctly. The
 * fault is in the frontend's own draw path, and the panel is only the caller.
 *
 * So the panel says that. It cannot repair LiteGraph's render loop, and it must not
 * pretend the failure came from somewhere it can act on — but it can name the one
 * thing that reliably clears it, and it can point out that a frozen canvas and a
 * failed screenshot are the SAME fault rather than two problems.
 */

/** A draw failure inside LiteGraph, as opposed to a panel-side precondition. */
export function isCanvasDrawFailure(err) {
  // Anything thrown out of canvas.draw() qualifies: the panel has already checked
  // its own preconditions (canvas present, scope resolvable) before reaching it, so
  // a throw from here is the renderer's. Deliberately NOT pattern-matched on the
  // message — "reading 'name'" is one shape of it, and keying on that would let the
  // next shape through as an opaque TypeError again.
  return err instanceof Error || typeof err === "string";
}

/**
 * What to say when the redraw throws.
 *
 * States what failed, what is known to be healthy, what it means for the canvas the
 * user is looking at, and the one remedy that is known to work. It claims nothing
 * about the cause beyond where the throw came from.
 */
export function describeCanvasDrawFailure(err, opts = {}) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const alsoFrozen = opts.canvasReportedFrozen === true;
  return (
    `The screenshot could not be taken: the ComfyUI canvas threw while REDRAWING itself ` +
    `(${raw || "no message"}). That throw comes from the frontend's own render path, not from ` +
    `the graph or the backend — a graph read (panel_graph_outline) and the error surface ` +
    `(panel_get_errors) are unaffected and worth using instead right now.\n\n` +
    `WHAT IT MEANS FOR THE CANVAS: a render loop that cannot complete a draw is also what a ` +
    `frozen canvas looks like from the user's side — no pan, no zoom, clicks dead. ` +
    `${alsoFrozen ? "That is what was reported here, and " : "If the user reports that too, "}` +
    `they are the same fault seen from two directions, not two problems.\n\n` +
    `WHAT CLEARS IT: a hard refresh of the ComfyUI browser tab (F5). The panel cannot repair ` +
    `the frontend's render state from here, and re-taking the screenshot will fail the same ` +
    `way until the tab is reloaded. Unsaved canvas work survives a refresh only if it was ` +
    `saved — offer that to the user before they reload.`
  );
}
