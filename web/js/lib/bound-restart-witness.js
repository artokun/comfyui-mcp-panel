/**
 * #1913 — which ComfyUI `panel_restart_comfyui` may restart.
 *
 * The panel can be bound to a live canvas at :8189 while the orchestrator's
 * boot target is :8188. Manager reboot is identity-free in *mechanism* (POST
 * to a base, that server stops itself) and emphatically not in *safety*: a
 * URL is not an instance. Rebooting the boot target would take down a server
 * this tab has not been working on; refusing because the two differ would
 * leave the bound instance unrestartable (newly installed nodes stay unloaded).
 *
 * The panel case has something the headless case does not: a live connection
 * to the very server in question (the bridge the command arrived on, and/or
 * the ComfyUI backend socket this page is holding). That connection is a
 * #871-grade witness — a successor at the same URL cannot inherit it. If it
 * is still open at dispatch, Manager reboot of the bound origin hits THIS
 * instance.
 *
 * A closed connection is inconclusive, not proof of replacement (tunnels
 * hiccup; our own reboot closes it by design). Without a live witness we do
 * not dispatch: the reboot may reach a successor, not the instance we just
 * assessed.
 */

/**
 * Scheme+host+port, or "" when the value is not a usable http(s) origin.
 * Trailing slashes and paths are dropped — a reboot target is a host, not a
 * mount. Empty / non-string / unparseable is omitted, never guessed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBoundOrigin(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.host) return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameBoundOrigin(a, b) {
  const left = normalizeBoundOrigin(a);
  const right = normalizeBoundOrigin(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * @param {{
 *   boundOrigin?: unknown,
 *   bootTarget?: unknown,
 *   requestedTarget?: unknown,
 *   bridgeConnected?: boolean,
 *   witnessAlive?: boolean,
 * }} [input]
 * @returns {{
 *   kind: "reboot_bound" | "refuse_wrong_instance" | "refuse_no_witness" | "refuse_unidentified",
 *   target: string | null,
 *   note: string,
 * }}
 */
export function decideBoundRestart({
  boundOrigin,
  bootTarget = "",
  requestedTarget = "",
  bridgeConnected = false,
  witnessAlive = false,
} = {}) {
  const bound = normalizeBoundOrigin(boundOrigin);
  const boot = normalizeBoundOrigin(bootTarget);
  const requested = normalizeBoundOrigin(requestedTarget);
  const liveWitness = bridgeConnected === true || witnessAlive === true;

  // An explicit request to restart a host that is not the live canvas is the
  // wrong-instance hazard: it may find nothing, or it may SUCCEED and take
  // down a ComfyUI this tab has not been working on.
  if (requested && bound && !sameBoundOrigin(requested, bound)) {
    return {
      kind: "refuse_wrong_instance",
      target: null,
      note:
        `Refusing to restart ${requested}: the live canvas is bound to ${bound}, ` +
        "a DIFFERENT server. Restarting the requested target would take down a " +
        "ComfyUI you have not been working on.",
    };
  }

  // Bound ≠ boot is the reported case. The live connection is what makes
  // routing to the bound origin tractable: without it we cannot prove the
  // thing that reboots is the instance we just assessed.
  if (bound && boot && !sameBoundOrigin(bound, boot)) {
    if (!liveWitness) {
      return {
        kind: "refuse_no_witness",
        target: null,
        note:
          `Refusing to restart: the live canvas is bound to ${bound} while the ` +
          `boot target is ${boot}, and no live connection witnesses that ${bound} ` +
          "is still this instance. A URL is not an instance — a successor on that " +
          "port would receive the reboot.",
      };
    }
    return {
      kind: "reboot_bound",
      target: bound,
      note:
        `Restarting the ComfyUI bound to the live canvas (${bound}), not the ` +
        `boot target (${boot}).`,
    };
  }

  if (!bound && !liveWitness) {
    return {
      kind: "refuse_unidentified",
      target: null,
      note: "Refusing to restart: the ComfyUI bound to the live canvas could not be identified.",
    };
  }

  return {
    kind: "reboot_bound",
    target: bound || null,
    note: bound ? `Restarting the ComfyUI bound to the live canvas (${bound}).` : "",
  };
}
