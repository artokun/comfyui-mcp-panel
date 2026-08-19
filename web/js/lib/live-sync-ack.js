// #1299 — live-sync acknowledgement. `notified` means the ACTIVE canvas holds
// the saved workflow, never that a notification was delivered.
//
// An external writer (H3 apply, an out-of-band JSON save) can update the file
// and count websocket clients as notified while the open tab still shows the
// previous widgets. Delivery and application are different facts. This module
// is the only place that may set `notified: true`, and it does so only when
// the live canvas's widget values match the saved graph.
//
// A dirty tab is refused rather than reloaded: clobbering unsaved canvas work
// is data loss. The reply names `panel_load_workflow` as the explicit reload.

import { normalizedWorkflowPath } from "./workflow-chat-identity.js";

/** Public recovery named in the reply. Not an internal bridge command. */
export const LIVE_SYNC_RELOAD_ACTION = "panel_load_workflow";

export const LIVE_SYNC_STATUS = Object.freeze({
  APPLIED: "applied",
  REFUSED: "refused",
  STALE: "stale",
  UNVERIFIED: "unverified",
  NO_ACTIVE: "no_active",
});

function fail(status, extra = {}) {
  return { notified: false, applied: false, status, ...extra };
}

/**
 * @param {{
 *   hasActiveTab?: boolean,
 *   pathMatches?: boolean,
 *   isModified?: boolean,
 *   canvasMatchesSaved?: boolean,
 *   diskReadable?: boolean,
 *   expectedShaMatches?: boolean | null,
 *   reloadAttempted?: boolean,
 *   reloadCompleted?: boolean,
 * }} [input]
 * @returns {{
 *   notified: boolean,
 *   applied: boolean,
 *   status: string,
 *   reason?: string,
 * }}
 *
 * INVARIANT: `notified === true` iff `status === "applied"` iff the canvas
 * currently matches the saved workflow. No other branch may set notified.
 */
export function decideLiveSyncAck({
  hasActiveTab = false,
  pathMatches = true,
  isModified = false,
  canvasMatchesSaved = false,
  diskReadable = true,
  expectedShaMatches = null,
  reloadAttempted = false,
  reloadCompleted = false,
} = {}) {
  if (!hasActiveTab || pathMatches === false) {
    return fail(LIVE_SYNC_STATUS.NO_ACTIVE, { reason: "no_active_tab" });
  }
  if (expectedShaMatches === false) {
    return fail(LIVE_SYNC_STATUS.UNVERIFIED, { reason: "sha_mismatch" });
  }
  if (canvasMatchesSaved === true) {
    return { notified: true, applied: true, status: LIVE_SYNC_STATUS.APPLIED };
  }
  if (isModified) {
    return fail(LIVE_SYNC_STATUS.REFUSED, { reason: "dirty" });
  }
  if (!diskReadable) {
    return fail(LIVE_SYNC_STATUS.UNVERIFIED, { reason: "disk_unreadable" });
  }
  if (reloadAttempted && !reloadCompleted) {
    return fail(LIVE_SYNC_STATUS.STALE, { reason: "reload_failed" });
  }
  if (reloadAttempted && reloadCompleted) {
    return fail(LIVE_SYNC_STATUS.STALE, { reason: "canvas_unchanged" });
  }
  return fail(LIVE_SYNC_STATUS.STALE, { reason: "not_applied" });
}

/** True when `requested` names the active tab, or when no path was given. */
export function liveSyncPathsMatch(requested, activePath) {
  if (requested == null || requested === "") return true;
  const a = normalizedWorkflowPath(requested);
  const b = normalizedWorkflowPath(activePath);
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (p) => p.replace(/^(workflows\/)+/, "").replace(/^\.\//, "");
  return strip(a) === strip(b);
}

function nodeWidgets(node) {
  if (!node || typeof node !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(node, "widgets_values") && node.widgets_values !== undefined) {
    return node.widgets_values;
  }
  if (Array.isArray(node.widgets)) return node.widgets.map((w) => w?.value);
  return undefined;
}

function walkNodes(nodes, prefix, out) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const id = node.id == null ? "" : String(node.id);
    const key = prefix + id;
    const widgets = nodeWidgets(node);
    if (widgets !== undefined) out.push([key, JSON.stringify(widgets)]);
    if (node.subgraph && typeof node.subgraph === "object") {
      walkNodes(node.subgraph.nodes, `${key}/`, out);
    }
  }
}

/**
 * Stable fingerprint of widget values across the root graph, in-node subgraphs,
 * and `definitions.subgraphs`. Presentation (pos/size/color) is ignored — clip
 * switches and prompts are the signal #1299 actually observed as stale.
 *
 * `comparable:false` when either side has no nodes: empty-vs-empty must not
 * count as a match (that would bless a blank canvas as "applied").
 */
export function widgetFingerprint(graph) {
  const out = [];
  if (!graph || typeof graph !== "object") {
    return { comparable: false, key: "" };
  }
  walkNodes(graph.nodes, "", out);
  const defs = graph.definitions?.subgraphs;
  if (Array.isArray(defs)) {
    for (const sg of defs) {
      if (!sg || typeof sg !== "object") continue;
      const sid = sg.id == null ? "" : String(sg.id);
      walkNodes(sg.nodes, `def:${sid}/`, out);
    }
  }
  if (out.length === 0) return { comparable: false, key: "" };
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { comparable: true, key: JSON.stringify(out) };
}

/** True only when both graphs are readable AND their widget fingerprints match. */
export function canvasMatchesSavedWorkflow(liveGraph, savedGraph) {
  const live = widgetFingerprint(liveGraph);
  const saved = widgetFingerprint(savedGraph);
  if (!live.comparable || !saved.comparable) return false;
  return live.key === saved.key;
}

function parseGraph(text) {
  if (text && typeof text === "object") return text;
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function noteFor(decision) {
  switch (decision.status) {
    case LIVE_SYNC_STATUS.APPLIED:
      return "The active canvas holds the saved workflow.";
    case LIVE_SYNC_STATUS.REFUSED:
      return (
        `The saved file changed but the live tab was intentionally not replaced — ` +
        `it has unsaved canvas edits, and overwriting them would be data loss. ` +
        `The active canvas still shows the previous values. To take the on-disk ` +
        `version (discarding in-canvas work), call ${LIVE_SYNC_RELOAD_ACTION} with ` +
        `this workflow's path. To keep the canvas, save first (panel_save_workflow).`
      );
    case LIVE_SYNC_STATUS.NO_ACTIVE:
      return (
        `No open tab matches this workflow, so the canvas was not updated. ` +
        `Open it with ${LIVE_SYNC_RELOAD_ACTION} if you want the saved file on the canvas.`
      );
    case LIVE_SYNC_STATUS.UNVERIFIED:
      return decision.reason === "sha_mismatch"
        ? "The on-disk file does not match the expected digest, so nothing was applied to the canvas."
        : "The on-disk file could not be read, so the canvas was not updated.";
    default:
      return (
        `The saved file is not what the active canvas shows. ` +
        `Call ${LIVE_SYNC_RELOAD_ACTION} with this workflow's path to load the on-disk version.`
      );
  }
}

/**
 * Agent-facing reply. `notified` is copied from decideLiveSyncAck and never
 * invented here. `reload` is only present when the canvas did NOT apply, so a
 * caller cannot treat a successful apply as a prompt to clobber the tab.
 */
export function composeLiveSyncReply(decision, extra = {}) {
  const ack = decideLiveSyncAck(decision);
  const reply = {
    ...extra,
    notified: ack.notified,
    applied: ack.applied,
    status: ack.status,
    ...(ack.reason ? { reason: ack.reason } : {}),
    note: noteFor(ack),
  };
  // `notified` is decideLiveSyncAck's, even if `extra` tried to set it.
  reply.notified = ack.notified;
  reply.applied = ack.applied;
  if (!ack.notified) reply.reload = LIVE_SYNC_RELOAD_ACTION;
  else delete reply.reload;
  return reply;
}

/**
 * Orchestrate one live-sync attempt. All I/O is injected so unit tests drive
 * this function — the same one the panel executor calls.
 *
 * `io.loadGraph(savedGraph, workflow)` is only invoked when the tab is clean
 * AND the canvas does not already match. A dirty tab never reaches it.
 */
export async function runWorkflowLiveSync(args = {}, io = {}) {
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  const expectedSha =
    typeof args.expected_sha256 === "string" && args.expected_sha256.trim()
      ? args.expected_sha256.trim()
      : typeof args.sha256 === "string" && args.sha256.trim()
        ? args.sha256.trim()
        : "";

  const active = io.getActiveWorkflow?.() ?? null;
  const activePath = typeof active?.path === "string" ? active.path : "";
  if (!active) {
    const reply = composeLiveSyncReply({ hasActiveTab: false });
    io.sendAck?.(reply);
    return reply;
  }
  if (!liveSyncPathsMatch(requestedPath, activePath)) {
    const reply = composeLiveSyncReply({ hasActiveTab: true, pathMatches: false });
    io.sendAck?.(reply);
    return reply;
  }

  const wasDirty = !!active.isModified;
  const diskText = await io.readDisk?.(activePath);
  // Re-check AFTER the await. A user edit during the disk read is still unsaved
  // work, and reloading over it is the data-loss case this exists to refuse.
  // A tab switch during the await means serializeCanvas() is now a DIFFERENT
  // workflow — refuse rather than apply the file to the wrong canvas.
  const activeNow = io.getActiveWorkflow?.() ?? active;
  if (activeNow !== active) {
    const reply = composeLiveSyncReply({ hasActiveTab: true, pathMatches: false });
    io.sendAck?.(reply);
    return reply;
  }
  const isModified = wasDirty || !!active.isModified;
  const diskReadable = typeof diskText === "string";
  const savedGraph = parseGraph(diskText);
  const liveGraph = io.serializeCanvas?.() ?? null;
  const matchesBefore = canvasMatchesSavedWorkflow(liveGraph, savedGraph);

  let expectedShaMatches = null;
  if (expectedSha) {
    if (!diskReadable) expectedShaMatches = false;
    else {
      const hex = await io.sha256?.(diskText);
      expectedShaMatches =
        typeof hex === "string" && hex.toLowerCase() === expectedSha.toLowerCase();
    }
  }

  const base = {
    hasActiveTab: true,
    pathMatches: true,
    isModified,
    canvasMatchesSaved: matchesBefore,
    diskReadable,
    expectedShaMatches,
  };

  if (expectedShaMatches === false || matchesBefore || isModified || !diskReadable || !savedGraph) {
    const reply = composeLiveSyncReply({
      ...base,
      canvasMatchesSaved: expectedShaMatches === false ? false : matchesBefore,
      diskReadable: diskReadable && !!savedGraph,
    });
    io.sendAck?.(reply);
    return reply;
  }

  let reloadCompleted = false;
  try {
    await io.loadGraph?.(savedGraph, active);
    reloadCompleted = true;
    await io.rebaseline?.(active, diskText);
  } catch {
    reloadCompleted = false;
  }

  const matchesAfter = canvasMatchesSavedWorkflow(io.serializeCanvas?.() ?? null, savedGraph);
  const reply = composeLiveSyncReply({
    hasActiveTab: true,
    pathMatches: true,
    isModified: false,
    canvasMatchesSaved: matchesAfter,
    diskReadable: true,
    expectedShaMatches,
    reloadAttempted: true,
    reloadCompleted,
  });
  io.sendAck?.(reply);
  return reply;
}
