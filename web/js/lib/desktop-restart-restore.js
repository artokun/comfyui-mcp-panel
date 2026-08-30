/**
 * #1999 — Desktop Manager reboot can STOP the Python backend without
 * anything bringing it back.
 *
 * THE REPORT. `panel_restart_comfyui` POSTed ComfyUI-Manager reboot into a
 * ComfyUI Desktop instance, observed the server go down, then waited out the
 * readiness budget with `server_ready:false`. The follow-up lifecycle tool
 * refused because it could not prove a Desktop app still supervised the port.
 * Newly installed custom nodes stayed unloaded and the user was blocked.
 *
 * A Manager reboot is identity-free in mechanism (POST, that server exits).
 * On Desktop the supervisor that is supposed to spawn the next backend is
 * the Electron app — and it does not always. A URL is not a relaunch path.
 *
 * WHAT THIS MODULE DECIDES. Before that POST:
 *
 *   * a Desktop shell with a proven restore function (`restartCore` kills
 *     and starts the backend; `restartApp` / `relaunchApp` relaunch the
 *     app) → use that function, never Manager;
 *   * a Desktop shell without that function → refuse, while the server is
 *     still up;
 *   * not a Desktop shell → Manager reboot, unchanged.
 *
 * The restore function is the recoverable supervisor/launch route. Calling
 * it is the bounded recovery. Guessing that Desktop will notice an
 * `exit(0)` is what left the reporter's server dead.
 */

/** Desktop APIs that stop AND start. Order is preference, not fallback after a stop. */
const DESKTOP_RESTORE_FNS = ["restartCore", "restartApp", "relaunchApp"];

/**
 * @param {unknown} bridge
 * @returns {{ name: string, restore: () => unknown } | null}
 */
export function resolveDesktopRestore(bridge) {
  if (!bridge || typeof bridge !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (bridge);
  for (const name of DESKTOP_RESTORE_FNS) {
    const fn = obj[name];
    if (typeof fn === "function") {
      return { name, restore: () => fn.call(obj) };
    }
  }
  return null;
}

/**
 * @param {{
 *   desktopShell?: boolean,
 *   restore?: { name?: unknown, restore?: unknown } | null,
 * }} [input]
 * @returns {{
 *   kind: "manager_reboot" | "desktop_restore" | "refuse",
 *   via: string | null,
 *   note: string,
 * }}
 */
export function decideDesktopRestartRestore({ desktopShell = false, restore = null } = {}) {
  if (desktopShell !== true) {
    return { kind: "manager_reboot", via: null, note: "" };
  }
  const name = typeof restore?.name === "string" ? restore.name : "";
  const restoreFn = restore?.restore;
  if (name && typeof restoreFn === "function") {
    return {
      kind: "desktop_restore",
      via: name,
      note:
        `Restarting via ComfyUI Desktop ${name} so the Desktop app restores the backend after stop.`,
    };
  }
  return {
    kind: "refuse",
    via: null,
    note:
      "Refusing to restart: this is a ComfyUI Desktop instance, and no Desktop relaunch " +
      "path (restartCore / restartApp / relaunchApp) is available. A Manager reboot would " +
      "STOP the backend and nothing in this tab can bring it back. Restart it from the " +
      "ComfyUI Desktop app.",
  };
}
