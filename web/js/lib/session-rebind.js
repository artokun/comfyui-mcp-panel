// Session / reconnect / tab-rebind helpers — pure, side-effect-free logic split
// out of comfyui-mcp-panel.js so it can be unit-tested with `node --test`.
//
// These back the frontend half of the session/tab-binding cluster (panel repo
// issues #278, #334, #296, #291, #207, #332, #310). The orchestrator owns the
// authoritative tab-target + tool registration (comfyui-mcp #512); the panel
// must (a) preserve/rebind the active tab across reboot/soft-reload/free_vram,
// (b) advertise the local COMFYUI_PATH at session init, (c) not report the same
// active tab twice, and (d) degrade gracefully during the reconnect window.

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// #278 — Post-reboot autonomous resume. ComfyUI fires `reconnected` after it
// comes back (a Manager reboot, a free_vram bounce, …). We respawn + reconnect
// the orchestrator ONLY when the bridge is actually down AND the session is
// worth resuming. The prior guard resumed only on an explicit REBOOT_KEY /
// AUTOCONNECT_KEY marker, so a reboot that lost the marker stranded a still-live
// workflow conversation ("Connected: none"). A resumable active session is now
// a third, independent reason to reconnect.
export function shouldResumeAfterComfyReconnect({
  bridgeConnected = false,
  rebootPending = false,
  autoConnect = false,
  hasResumableSession = false,
} = {}) {
  // Bridge still up → the orchestrator (and agent) never died; a benign ComfyUI
  // WS blip must NOT bounce a live session.
  if (bridgeConnected) return false;
  return Boolean(rebootPending || autoConnect || hasResumableSession);
}

// #310 — free_vram can bounce the ComfyUI connection (models unloaded, the WS
// blips), which drops the orchestrator's tab mapping the way a restart does.
// Re-advertise (rehello) this tab after a successful free_vram so the very next
// graph tool still routes to the connected tab instead of "Connected: none".
export function shouldRehelloAfterCommand(cmd, reply) {
  return cmd === "free_vram" && Boolean(reply && reply.ok);
}

// #332 — During the post-restart reconnect window a Manager-backed fetch (e.g.
// panel_list_nodes) throws a bare transport error ("Failed to fetch") before any
// HTTP status exists, so the usual 404/"unreachable" handling never fires. Match
// those transient transport failures so they can be retried / reworded instead
// of surfaced raw.
export function isTransientReconnectError(err) {
  const msg = String((err && err.message) || err || "");
  return /failed to fetch|networkerror|network error|load failed|fetch failed|connection (was )?lost|err_connection|econnrefused|econnreset|socket hang up/i.test(
    msg,
  );
}

// Bounded retry for a call that may hit the reconnect window. Retries ONLY
// transient transport failures (isTransient), with capped exponential backoff.
// A non-transient error propagates immediately (unchanged behavior); a transient
// failure that never clears is reworded into an actionable "still reconnecting"
// message rather than a raw "Failed to fetch".
export async function retryDuringReconnect(
  fn,
  {
    attempts = 4,
    baseDelayMs = 250,
    maxDelayMs = 2000,
    sleep = DEFAULT_SLEEP,
    isTransient = isTransientReconnectError,
    label = "ComfyUI/Manager",
  } = {},
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const last = i === attempts - 1;
      if (!isTransient(err) || last) break;
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** i));
    }
  }
  if (isTransient(lastErr)) {
    const detail = String((lastErr && lastErr.message) || lastErr || "");
    // Preserve the original error as `cause` so its type/stack are not lost —
    // and word it as "not reachable right now (may still be reconnecting)"
    // rather than asserting a restart, since a persistent CORS/proxy/Manager
    // outage can look the same at the transport layer.
    throw new Error(
      `${label} is not reachable right now (it may still be reconnecting after a restart) — retry in a moment.` +
        (detail ? ` (${detail})` : ""),
      { cause: lastErr },
    );
  }
  throw lastErr;
}

// #207 / #334 — Stable identity for a workflow tab record. A load that replaces
// the active canvas can flip the tab id (tmp: → wf:) or re-add the same file, so
// dedupe on the rename-stable identity. Strip the tmp:/wf: scheme prefix so the
// path form ("workflows/a.json") and the key form ("wf:workflows/a.json") of the
// SAME file converge, normalize separators, and drop the .json suffix. Case is
// PRESERVED so distinct files on a case-sensitive (Linux) filesystem are never
// collapsed; the frontend reports a stable casing per file so real duplicates
// still match.
export function workflowTabKey(rec) {
  if (!rec || typeof rec !== "object") return "";
  // ONLY a path or a path-bearing key is a stable identity. A bare `filename` is
  // NOT: multiple unsaved tabs share the name "Unsaved Workflow", and a filename
  // "foo" would otherwise collide with the saved file "foo.json". Records with no
  // real path/key return "" and are kept as DISTINCT (never deduped).
  let s = String(rec.path || rec.key || "").replace(/\\/g, "/");
  const scheme = s.match(/^(tmp|wf):(.*)$/);
  if (scheme) {
    // `wf:` always denotes a real SAVED path (even a root-level "wf:foo.json"),
    // so strip it unconditionally to unify with the path form "foo.json". `tmp:`
    // is an ephemeral tab id that may be a bare token ("tmp:<uuid>") — strip it
    // ONLY when a real path follows (contains "/") so a pathless temp tab keeps
    // its own namespace and can never collide with a saved file of the same name.
    if (scheme[1] === "wf" || scheme[2].includes("/")) s = scheme[2];
  }
  // Case-sensitive .json strip (workflows are always lowercase ".json") and
  // case-PRESERVING otherwise, so case-distinct files on a case-sensitive
  // (Linux) filesystem are never collapsed.
  return s.replace(/\.json$/, "").trim();
}

// #207 — panel_load_workflow could leave panel_list_workflows reporting the SAME
// active tab several times (each load appended a record instead of updating one),
// and a later save then 409'd. Collapse records that share a stable key into one,
// preferring the active/persisted flags and the freshest fields. Unkeyed records
// (a blank/Unsaved tab with no path) are kept as-is — they are genuinely distinct.
export function dedupeWorkflowTabRecords(records) {
  if (!Array.isArray(records)) return [];
  const byKey = new Map();
  const out = [];
  for (const rec of records) {
    if (!rec) continue;
    const key = workflowTabKey(rec);
    if (!key) {
      out.push(rec);
      continue;
    }
    const prev = byKey.get(key);
    if (!prev) {
      const slot = { index: out.length };
      byKey.set(key, slot);
      out.push(rec);
      slot.ref = rec;
    } else {
      out[prev.index] = mergeTabRecord(out[prev.index], rec);
    }
  }
  return out;
}

function mergeTabRecord(prev, next) {
  return {
    ...prev,
    ...next,
    active: Boolean(prev.active || next.active),
    persisted: Boolean(prev.persisted || next.persisted),
    modified: Boolean(prev.modified || next.modified),
  };
}

// #207 / #334 — Args for app.loadGraphData when panel_load_workflow replaces the
// active canvas. Passing the active workflow as the 4th arg ASSOCIATES the load
// with the existing tab (exactly like workflow_open does), so the graph replaces
// the persisted tab IN PLACE instead of spawning a new "Unsaved Workflow" tab
// (the dup-tab-record + frozen-routing report). With no active workflow (a truly
// blank canvas) we fall back to the plain single-arg load.
export function resolveLoadGraphArgs(graphData, activeWorkflow) {
  if (activeWorkflow && typeof activeWorkflow === "object") {
    return [graphData, true, true, activeWorkflow];
  }
  return [graphData];
}

// #296 / #291 — Session-init hello frame. Centralizing it guarantees every
// session advertises the same fields, and adds `comfyui_path`: for a LOCAL
// portable ComfyUI the orchestrator otherwise has no workspace path, so it
// reports "no COMFYUI_PATH configured" and skips registering the live panel_*
// graph tools. Propagating the embedded ComfyUI's base path at init lets the
// orchestrator register those tools independent of any CLI workspace config.
export function buildHelloPayload({
  tabId,
  title,
  panelVersion,
  backend,
  blind = false,
  comfyuiUrl,
  comfyuiPath,
  resume,
} = {}) {
  const frame = {
    type: "hello",
    tab_id: tabId,
    title,
    panel_version: panelVersion,
    backend: backend || "claude",
    blind: Boolean(blind),
  };
  if (comfyuiUrl) frame.comfyui_url = comfyuiUrl;
  if (typeof comfyuiPath === "string" && comfyuiPath.trim()) {
    frame.comfyui_path = comfyuiPath.trim();
  }
  if (resume) frame.resume = resume;
  return frame;
}
