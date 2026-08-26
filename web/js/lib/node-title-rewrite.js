// #1855 — a graph command must never leave the caller holding a node title the
// node does not have.
//
// `panel_add_node` accepted `title: "Preview Mask Animation"` for a
// `PreviewAnimation` node and reported that title back; a later
// `panel_query_graph` showed `Preview Animation`. The reporter read that as the
// ADD snapshotting success too early, but the add's payload is already a LIVE
// read of `node.title` (summarizeNode), and the frontend's `LGraph.add` does not
// touch `title` at all — it sets `node.graph`, pushes the node, and calls
// `onAdded` / `onNodeAdded` (read from comfyui_frontend_package 1.49.x, the
// reporter's own version). So nothing on the add path can have rewritten it.
//
// The class that CAN is the node pack. ComfyUI-KJNodes registers
// `PreviewAnimation` with two title writers of its own (web/js/jsnodes.js):
//
//     case "PreviewAnimation":
//       nodeType.prototype.onConnectInput = function (...) { …; this.title = "Preview Animation"; … }
//       nodeType.prototype.onExecuted     = function (message) { …; this.title = "Preview Animation " + values; … }
//
// and the frontend invokes `onConnectInput` from exactly one place —
// `connectSlots` / `SubgraphInput.connect`, i.e. WIRING. So the title is
// discarded when the node is connected (and rewritten again after every run),
// not when it is created. `panel_connect` reported a plain success while the
// name the caller had just been told was this node's silently became stale, with
// nothing in the reply to say so.
//
// This module does NOT restore the old title. That is deliberate: the pack owns
// the field on purpose — the reset exists so a stale "Preview Animation 24" from
// an earlier run is cleared when the node is rewired — and from here a
// user-chosen name and a leftover run status are indistinguishable strings.
// Putting one back would silently reinstate the other, and would be undone by
// the next run regardless. Disclosure is the honest answer, and it is the one
// the reporter also accepted: "return the actual final title plus a warning
// instead of echoing the requested title as successful".

/**
 * Snapshot the titles of the nodes a command is about to touch, BEFORE it runs.
 *
 * Duplicates are dropped by node IDENTITY, so a self-connect (origin === target)
 * is captured once and cannot report itself as two rewrites. Non-objects are
 * skipped rather than throwing: this is a disclosure rider, and it must never be
 * the reason a wire that landed is reported as a failure.
 */
export function captureNodeTitles(nodes) {
  const snapshot = [];
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    if (snapshot.some((entry) => entry.node === node)) continue;
    snapshot.push({ node, title: node.title });
  }
  return snapshot;
}

/**
 * Which of the snapshotted nodes the command's own side effects renamed.
 *
 * Compared with `===` against the captured value, so a node that carries no
 * title at all (`undefined` before and after) is not reported as a rewrite.
 */
export function describeTitleRewrites(snapshot) {
  const rewrites = [];
  for (const entry of snapshot ?? []) {
    const node = entry?.node;
    if (!node || typeof node !== "object") continue;
    if (node.title === entry.title) continue;
    rewrites.push({
      node_id: node.id,
      from: entry.title ?? null,
      to: node.title ?? null,
    });
  }
  return rewrites;
}

/**
 * The prose that rides alongside `title_rewritten`.
 *
 * It has to do two things the structured field cannot: say that the rename came
 * from the NODE PACK rather than from the panel (otherwise this reads as the
 * panel corrupting the graph), and say that re-applying the title is a real
 * repair but not a durable one, because `onExecuted` rewrites it again after
 * every run.
 */
export function titleRewriteWarning(rewrites) {
  if (!rewrites?.length) return "";
  const list = rewrites
    .map((r) => `node ${r.node_id}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`)
    .join(", ");
  return (
    `This connect RENAMED ${rewrites.length === 1 ? "a node" : `${rewrites.length} nodes`} — ${list}. ` +
    `The panel did not do this: LiteGraph runs the target node's own onConnectInput hook from ` +
    `inside the connect, and some packs rewrite their title there (ComfyUI-KJNodes' ` +
    `PreviewAnimation resets it to "Preview Animation" on every connect, then to ` +
    `"Preview Animation <frames>" after every run). Any title panel_add_node or panel_edit_node ` +
    `reported for ${rewrites.length === 1 ? "that node" : "those nodes"} is now STALE. ` +
    `Re-apply the name you want with panel_edit_node AFTER wiring — and expect a node that ` +
    `owns its own title to overwrite it again once the graph runs.`
  );
}
