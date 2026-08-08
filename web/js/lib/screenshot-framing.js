/**
 * panel#754(2) — a screenshot frames the WHOLE GRAPH, and never said so.
 *
 * The reporter centred on node 42, zoomed to 0.55, and took three screenshots.
 * All three came back pixel-identical fit-all framing of a 175-node graph; the
 * only frame-to-frame difference was the FPS counter. They reasonably concluded
 * "screenshot does not follow the viewport" and filed it as a defect.
 *
 * It is not a defect in the code. `graph_screenshot` computes bounds over every
 * node and group, temporarily sets its own scale/offset to fit them, captures,
 * and restores the caller's viewport afterwards. Fit-all is what it is FOR — a
 * capture that inherited a half-scrolled canvas would be worse for the common
 * case, and the restore is why `panel_canvas` state survives a capture.
 *
 * What was missing is that the reply never mentioned it. `width`, `height`,
 * `renderer` and `viewing` are all reported; the FRAMING — the one thing that
 * explains three identical images — was not. So the only way to learn it was the
 * experiment they ran.
 *
 * This adds the disclosure and nothing else. No pixel changes, no viewport
 * behaviour changes. Framing a subset (the "show me just this node" the reporter
 * actually wanted) is a capability and stays parked; when it lands, `mode` is
 * where it announces itself, which is why this is a field rather than a sentence.
 */

/**
 * Describe how a capture was framed.
 *
 * @param {object} counts
 * @param {number} counts.nodes  nodes included in the bounds
 * @param {number} counts.groups groups included in the bounds
 */
export function describeScreenshotFraming({ nodes = 0, groups = 0 } = {}) {
  const n = Number.isFinite(nodes) ? Math.max(0, Math.trunc(nodes)) : 0;
  const g = Number.isFinite(groups) ? Math.max(0, Math.trunc(groups)) : 0;
  return {
    mode: "fit-all",
    nodes: n,
    groups: g,
    note:
      `This capture FRAMED THE WHOLE GRAPH (${n} node(s), ${g} group(s)). It does NOT use the ` +
      `current viewport: it sets its own scale and offset to fit everything, captures, then ` +
      `restores the scale and offset you had. So panel_canvas center_on_node / zoom change the ` +
      `live canvas but do NOT change what a screenshot shows — repeated captures after moving ` +
      `the canvas being identical is expected, not a failure. There is currently no way to ` +
      `capture a single node; read its state with panel_query_graph instead.`,
  };
}
