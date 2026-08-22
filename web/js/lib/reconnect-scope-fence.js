// #1636 — after a reconnect, panel_graph_outline.viewing and the graph a
// mutation/enter searches can disagree: a read during restore sees the canvas
// at root, then the frontend puts the pre-reconnect subgraph back, and the
// immediately following enter_subgraph searches that subgraph ("currently
// inside a subgraph") even though the outline just promised root.
//
// One fence, armed on reconnect. The first resolved scope this epoch pins.
// Explicit enter/exit update it. A canvas that later drifts into a subgraph
// without panel_enter_subgraph cannot change a root pin — the caller rebinds
// so the next mutation uses the same graph the outline reported.
//
// Hold-root is the only direction: a subgraph pin never yanks the canvas back
// into a subgraph (that is auto-layout's remembered identity, a different job,
// and it would fight a breadcrumb exit). Content-bearing unreachable canvases
// still arrive as resolveScope's diverged verdict — this fence does not arm
// the #604 repaint.

let armed = false;
let viewing = null; // "root" | "subgraph" | null (unpinned this epoch)

/** Arm a fresh epoch: drop the stored pin (and the caller drops auto-layout's
 *  remembered subgraph owner). Next resolveScope observation pins. */
export function noteReconnectScopeFence() {
  armed = true;
  viewing = null;
}

export function peekReconnectScopeFence() {
  return { armed, viewing };
}

/** Explicit navigation (enter/exit) is allowed to move the pin. No-ops when
 *  the fence is not armed, so a double-click enter outside a reconnect epoch
 *  does not start holding the canvas at root. */
export function pinReconnectScope(scopeName) {
  if (!armed) return peekReconnectScopeFence();
  viewing = scopeName === "subgraph" ? "subgraph" : "root";
  return peekReconnectScopeFence();
}

/** Enter that never landed: forget the pin so the next observation re-pins
 *  whatever the canvas actually shows. */
export function releaseReconnectScopePin() {
  if (!armed) return peekReconnectScopeFence();
  viewing = null;
  return peekReconnectScopeFence();
}

export function disarmReconnectScopeFence() {
  armed = false;
  viewing = null;
}

/**
 * Fold a live resolveScope result through the fence.
 *
 * @param {object|null} liveScope  resolveScope(app) result
 * @returns the scope the caller must use (possibly a hold-root rebind trigger)
 */
export function applyReconnectScopeFence(liveScope) {
  if (!armed || !liveScope) return liveScope;
  if (viewing == null) {
    viewing = liveScope.scope === "subgraph" ? "subgraph" : "root";
    return liveScope;
  }
  // Outline (or any earlier command) promised root. A restore that re-opened
  // a live subgraph must not become the mutation target.
  if (viewing === "root" && liveScope.scope === "subgraph") {
    return {
      graph: liveScope.rootGraph,
      rootGraph: liveScope.rootGraph,
      scope: "root",
      owner: null,
      stale: true,
      diverged: false,
      divergedKind: liveScope.divergedKind,
    };
  }
  return liveScope;
}
