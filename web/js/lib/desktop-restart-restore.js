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
 * The first proven restore across EVERY candidate bridge, preferring by function
 * (`restartCore` before a whole-app relaunch) rather than by which global happened
 * to be defined first.
 *
 * #2134 — the caller picked its bridge with `a ?? b ?? c` and probed only that one.
 * `??` stops at the first non-nullish global, so a bridge that exists but carries no
 * restore function masked a later one that did, and the guard reported "no Desktop
 * relaunch path is available" without having looked at the rest.
 *
 * @param {unknown[]} bridges
 * @returns {{ name: string, restore: () => unknown } | null}
 */
export function resolveDesktopRestoreFrom(bridges) {
  const list = Array.isArray(bridges) ? bridges : [bridges];
  for (const name of DESKTOP_RESTORE_FNS) {
    for (const bridge of list) {
      const resolved = resolveDesktopRestore(bridge);
      if (resolved && resolved.name === name) return resolved;
    }
  }
  return null;
}

/**
 * Whether a ComfyUI Desktop app supervises THIS backend — the only question that
 * makes a Manager stop unrecoverable.
 *
 * #2134 — this guard reused `isEmbeddedDesktopShell`, which is
 * `Boolean(bridge) || /Electron\//.test(userAgent)`. That helper answers a question
 * about the BROWSER ("is this an Electron webview, which ships no speech service?")
 * and its UA arm is right for that. This is a question about the SERVER, and a UA
 * token cannot answer it: any Electron-embedded browser pointed at an ordinary
 * ComfyUI carries `Electron/` while nothing supervises the backend. There the guard
 * refused a Manager reboot that would have worked, and told the user "this is a
 * ComfyUI Desktop instance" — which was not true, and left them with no way to load
 * the nodes they had just installed.
 *
 * The injected bridge is the only positive evidence, and it is what ComfyUI's own
 * frontend uses (`src/utils/envUtil.ts` is `window.electronAPI`, and the shipped
 * 1.49.6 bundle never sniffs the UA for `Electron/` anywhere). A page with no bridge
 * is indistinguishable from an ordinary browser tab, which is the case Manager
 * reboot has always handled correctly.
 *
 * This cannot regress #1999: every page that previously had a bridge still takes the
 * restore-or-refuse path unchanged. Only the bridge-less UA-only case changes.
 *
 * @param {unknown[]} bridges
 * @returns {boolean}
 */
export function isDesktopSupervisedShell(bridges) {
  const list = Array.isArray(bridges) ? bridges : [bridges];
  return list.some((bridge) => Boolean(bridge));
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
