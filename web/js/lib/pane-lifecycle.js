// Remaining pane lifecycle after close/dismiss (#1952, #1961).
//
// Close already sheds the unified shell. The agent still could not undock /
// re-dock it, so a long session that opened the pane docked (the open_civitai
// default) had no inverse short of closing. These functions ARE that inverse.

/**
 * Dock or undock the unified side panel.
 *
 * Idempotent: a missing/closed handle is success with `open:false`. Already in
 * the requested mode is success with `changed:false`. `docked` must be a
 * boolean — a missing value is a caller error, not a no-op, so an omitted
 * argument cannot be read as "leave it".
 */
export function setSidePanelDocked(handle, docked) {
  if (typeof docked !== "boolean") {
    throw new Error("set_dock requires docked: true or false");
  }
  if (!handle || typeof handle.setDocked !== "function") {
    return { ok: true, open: false, changed: false, docked: false, tab: null };
  }
  const open = typeof handle.isOpen === "function" ? !!handle.isOpen() : true;
  if (!open) return { ok: true, open: false, changed: false, docked: false, tab: null };
  return handle.setDocked(docked);
}
