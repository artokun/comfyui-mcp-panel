// #968 — the canvas and the file it claims to be, compared directly.
//
// The reported failure: a tab marked `modified` whose live canvas held a DIFFERENT
// workflow's graph, while every check reported healthy. They all reported healthy honestly:
//
//   * `panel_open_workflow` repaints from the tab's own `activeState` and proves the result
//     against THAT state — so a tab whose state is already carrying foreign content
//     reproduces it faithfully and the proof passes;
//   * `decideOpenStaleness` compares the FILE against the tab's BASELINE, answering "has the
//     file changed since load?" — a different question;
//   * nothing compared the file against the canvas, even though that path had already read
//     the file.
//
// So this compares the two artefacts already in hand. The signal is node IDENTITY, not
// content: incremental editing usually keeps most ids, so a dirty tab whose canvas shares
// NO ids with its own file is not what editing looks like. (Not an absolute — a whole-graph
// paste before saving looks the same, which is why this discloses rather than decides.)
//
// DISCLOSURE, NOT PROOF, and the distinction is load-bearing. A user can clear a tab and
// rebuild, or paste an entire graph in, before saving — both are also disjoint (codex). So nothing here decides whether
// a command may run — it exists so a reply stops claiming "no missing work to redo" about a
// canvas it has just been shown to share nothing with. A refusal built on this would be a
// wrong-graph refusal of its own.
//
// Dependency-free (no DOM, no LiteGraph). Unit-testable with plain fixtures.

/** Node ids from a parsed workflow graph or a live root graph. Absent → null, which is
 *  "could not compare", never "no nodes". */
function nodeIdSet(nodes) {
  if (!Array.isArray(nodes)) return null;
  const ids = new Set();
  for (const node of nodes) {
    const id = node?.id;
    // Ids are numbers on the canvas and may be numbers or numeric strings in a file. Compare
    // them as strings so a faithful round-trip is never reported as divergence.
    if (typeof id === "number" && Number.isFinite(id)) ids.add(String(id));
    else if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

/**
 * @param {{ diskNodes?: unknown, canvasNodes?: unknown }} input
 * @returns {{
 *   comparable: boolean, disjoint: boolean,
 *   shared: number, canvasOnly: number, diskOnly: number,
 *   canvasCount: number, diskCount: number,
 * }}
 *
 * `comparable:false` whenever either side is unreadable OR either is empty — an empty set
 * shares nothing with everything, so calling that "disjoint" would flag every new tab and
 * every genuinely-empty file as foreign.
 */
export function canvasFileDivergence({ diskNodes, canvasNodes } = {}) {
  const disk = nodeIdSet(diskNodes);
  const canvas = nodeIdSet(canvasNodes);
  const none = {
    comparable: false,
    disjoint: false,
    shared: 0,
    canvasOnly: 0,
    diskOnly: 0,
    canvasCount: canvas ? canvas.size : 0,
    diskCount: disk ? disk.size : 0,
  };
  if (!disk || !canvas || disk.size === 0 || canvas.size === 0) return none;

  let shared = 0;
  for (const id of canvas) if (disk.has(id)) shared += 1;
  return {
    comparable: true,
    disjoint: shared === 0,
    shared,
    canvasOnly: canvas.size - shared,
    diskOnly: disk.size - shared,
    canvasCount: canvas.size,
    diskCount: disk.size,
  };
}

/**
 * The sentence a reply carries when the two share nothing.
 *
 * States what was compared and what it does NOT establish. The alternative reading — that
 * the user cleared this tab and built something new — is named rather than dismissed,
 * because it is a real thing people do and the panel cannot tell the two apart.
 */
export function canvasFileDivergenceNote(divergence, path) {
  if (!divergence || !divergence.comparable || !divergence.disjoint) return null;
  const where = typeof path === "string" && path ? ` (${path})` : "";
  return (
    `WARNING — this canvas shares NO node ids with its own file${where}: ` +
    `${divergence.canvasCount} node(s) on the canvas, ${divergence.diskCount} in the file, ` +
    `0 in common. Incremental editing usually keeps most ids, so zero overlap is what a ` +
    `canvas holding a DIFFERENT workflow looks like. It is NOT proof — clearing this tab ` +
    `and rebuilding, or pasting an entire graph in, before saving would look the same. ` +
    `Before trusting a read or making an edit here, confirm which graph you have: ` +
    `panel_load_workflow re-reads the file, and is the recovery reported to work.`
  );
}
