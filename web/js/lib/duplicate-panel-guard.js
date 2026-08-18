/**
 * #1269 — ONE panel bundle per page.
 *
 * The pack can be installed twice — a git clone at `custom_nodes/comfyui-mcp-panel`
 * AND a Manager/Registry install at `custom_nodes/comfyui-agent-panel` — and ComfyUI
 * loads BOTH web bundles into the same page. Each copy opens its own bridge socket
 * and hellos under the same workflow tab ids, and the bridge keeps exactly one
 * connection per tab id: whichever hello landed last owns it. A STALE copy's hello
 * (no `panel_version` before 0.11.83, no workflow-stamp fence flags before 0.11.29,
 * bare `wf:<path>` tab ids before the per-tab route) then owns the connection the
 * orchestrator routes "the active workflow" to, while the CURRENT copy's full
 * advertisement sits on a connection nothing routes to. Every graph write is
 * refused as "this tab advertised NO panel version" on an install that is current,
 * and the stated remedy — a hard refresh — cannot help, because the stale copy is
 * served from its own stale directory and re-registers on every reload.
 *
 * The orchestrator cannot fix this from its side: a version-less hello is
 * indistinguishable from a genuinely old panel, and the write fence must fail
 * closed either way. What CAN fix it is the bundle itself, at module scope, before
 * either copy's `setup()` can register or connect: arbitrate so the NEWER bundle
 * runs and the older one stands down loudly.
 *
 * These helpers are PURE / dependency-injected (no DOM, no ComfyUI globals) so the
 * arbitration is unit-testable without a browser.
 */

import { compareVersions } from "./changelog-delta.js";

/** The shared page-global both copies of the bundle arbitrate through. */
export const DUPLICATE_PANEL_GUARD_KEY = "__comfyuiMcpPanelGuard";

/** The extension name every copy of this pack registers under. */
export const PANEL_EXTENSION_NAME = "comfyui-mcp.agent-panel";

/** The install directory a bundle URL names: `/extensions/<dir>/...`. */
export function installDirFromBundleUrl(url) {
  const match = typeof url === "string" && url.match(/\/extensions\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Arbitrate between the copies of this pack loaded in one page. Returns an
 * `active()` the caller must consult BEFORE registering (and again at `setup()`:
 * a later-evaluated NEWER copy can stand this one down after it registered).
 *
 *  - no prior claim          → claim the page (`"sole"`).
 *  - prior claim, we are NEWER → stand the prior copy down and take the page
 *                               (`"took-over"`). A stale copy must never win just
 *                               because its directory sorts first.
 *  - prior claim, same/older → stand down (`"stood-down"`); the first claim keeps
 *                               the page.
 *
 * A malformed prior claim (a foreign script that collided with the key) carries
 * no comparable version and no working standDown — treat it as claimable rather
 * than letting it silence the panel.
 */
export function arbitratePanelCopy({ registry, key = DUPLICATE_PANEL_GUARD_KEY, self } = {}) {
  let stoodDown = false;
  // WHO stood this copy down, when the stand-down arrives after this copy's own
  // arbitration (a later-evaluated newer copy). Recorded so the setup()-time
  // re-check can name the copy it is yielding to instead of "unknown location".
  let supersededBy = null;
  const claim = {
    version: self?.version,
    url: self?.url,
    standDown: (successor) => {
      stoodDown = true;
      supersededBy =
        successor && typeof successor === "object"
          ? { version: successor.version, url: successor.url }
          : null;
    },
  };
  const prior = registry?.[key];
  if (!prior || typeof prior !== "object" || typeof prior.version !== "string") {
    registry[key] = claim;
    return { outcome: "sole", active: () => !stoodDown, supersededBy: () => supersededBy, prior: null };
  }
  if (compareVersions(self?.version, prior.version) > 0) {
    try {
      prior.standDown?.({ version: self?.version, url: self?.url });
    } catch {
      /* a throwing standDown must not keep the newer copy off the page */
    }
    registry[key] = claim;
    return {
      outcome: "took-over",
      active: () => !stoodDown,
      supersededBy: () => supersededBy,
      prior: { version: prior.version, url: prior.url },
    };
  }
  stoodDown = true;
  return {
    outcome: "stood-down",
    active: () => false,
    supersededBy: () => supersededBy,
    prior: { version: prior.version, url: prior.url },
  };
}

/**
 * The loud half of the arbitration: name BOTH install directories and the remedy.
 * Silent stand-down would leave a page with no panel and no explanation; a quiet
 * console.debug would never be found.
 */
export function describeDuplicatePanelCopies({ outcome, self, prior } = {}) {
  const dirOf = (copy) => installDirFromBundleUrl(copy?.url) ?? copy?.url ?? "unknown location";
  const mine = `custom_nodes/${dirOf(self)}`;
  const theirs = `custom_nodes/${dirOf(prior)}`;
  const remedy =
    `Remove one of the two panel installs (${mine} and ${theirs}) and restart ComfyUI — ` +
    `until then the two copies fight over the same browser tab, and graph writes are ` +
    `refused as if the panel were out of date (#1269).`;
  if (outcome === "took-over") {
    return (
      `[comfyui-mcp-panel] two copies of the panel pack are loaded: ${theirs} ` +
      `(panel ${prior?.version ?? "unknown"}) and ${mine} (panel ${self?.version ?? "unknown"}). ` +
      `The newer copy is taking over; the older one is standing down. ${remedy}`
    );
  }
  return (
    `[comfyui-mcp-panel] two copies of the panel pack are loaded: ${theirs} ` +
    `(panel ${prior?.version ?? "unknown"}) and ${mine} (panel ${self?.version ?? "unknown"}). ` +
    `This copy is standing down. ${remedy}`
  );
}

/**
 * Backstop for a copy too OLD to carry this guard: it never writes the shared
 * claim, so arbitration cannot see it — but it registers under the SAME extension
 * name, which the frontend's extension list does show. `extensions` is the app's
 * registered extension objects; OUR own registration is one of them, so a count
 * above 1 means another copy of this pack is loaded.
 */
export function countExtensionsNamed(extensions, name) {
  if (!Array.isArray(extensions)) return 0;
  return extensions.filter((ext) => ext && ext.name === name).length;
}

/** The message for the guardless-duplicate backstop. Stays active on purpose:
 *  standing down would hand the page to a copy too old to arbitrate; the fight
 *  is no worse than before this guard existed, and now it is NAMED. */
export function describeUnguardedDuplicatePanelCopy({ self } = {}) {
  const mine = `custom_nodes/${installDirFromBundleUrl(self?.url) ?? self?.url ?? "unknown location"}`;
  return (
    `[comfyui-mcp-panel] another copy of the panel pack is registered alongside this one ` +
    `(${mine}, panel ${self?.version ?? "unknown"}) — check custom_nodes for a second panel ` +
    `install (e.g. both comfyui-mcp-panel and comfyui-agent-panel), remove it, and restart ` +
    `ComfyUI. Two copies fight over the same browser tab, and graph writes are refused as ` +
    `if the panel were out of date (#1269).`
  );
}
