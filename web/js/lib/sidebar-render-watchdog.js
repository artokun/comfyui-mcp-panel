/**
 * panel#779 — if the Agent tab is open and nothing of ours is painted, SAY SO.
 *
 * The outage this grew from: a new user's tab registered, was selectable, and
 * stayed a black rectangle — `.cmcp-root` absent, nothing in the console
 * attributed to us. The cause (our own guard deleting the root on an
 * unidentifiable tab marker, #784) is fixed, and #785 added a visible shell for
 * a render() that THROWS. But a render() that is never CALLED — which is what
 * an actual sidebar-tab contract change in a future frontend would produce —
 * still fails in perfect silence. The reporter's natural response to that
 * silence was an hour of reinstalling things that were never the problem.
 *
 * This watchdog turns that silence into one console line that names the panel
 * version, the frontend version, and what to do. It deliberately arrives
 * SECONDS after the failure, not instants: its job is a support answer, not a
 * race.
 *
 * TWO CHECKS, BOTH EVIDENCE-ONLY (the #784 lesson applies to diagnostics too:
 * "I cannot tell" must never be reported as "it is broken"):
 *
 * 1. STARVATION — our tab is PROVABLY the selected one (the rail button carries
 *    our id, read the same dual-generation way the guard reads it) and yet no
 *    `.cmcp-root` and no `.cmcp-failure-shell` exists, continuously for
 *    RENDER_STARVATION_MS, re-verified at expiry. When the selected tab is
 *    another tab, or unidentifiable ("unknown"), the check DISARMS rather than
 *    counts — an unreadable marker is not evidence of our failure. The first
 *    successful paint while our tab is active retires the check for the page's
 *    lifetime: its charter is first-paint failure, the #779 class; content that
 *    later disappears is a different bug with a different symptom.
 *
 * 2. APPEARANCE — the sidebar rail exists but our tab button never showed up in
 *    it within TAB_APPEAR_DEADLINE_MS of the rail being seen. This is what a
 *    frontend that accepts registerSidebarTab() and silently drops the legacy
 *    spec shape would look like: no tab to click, so check 1 can never trigger,
 *    and the panel simply vanishes from the product. If the rail itself cannot
 *    be found, that is "I cannot tell", and the check gives up silently.
 *
 * WHY THE BOUNDS ARE WHAT THEY ARE. Render is invoked synchronously when the
 * tab mounts, so 3s of selected-and-empty is not "a slow machine", it is a
 * no-show — and a machine so loaded that timers stall does not fire early,
 * because the deadline itself is a timer. The rail populates in the same
 * render pass that creates it, so 10s from first sighting is generous.
 */

import { readActiveSidebarTab, findSidebarTabButton } from "./active-sidebar-tab.js";
import { VERIFIED_FRONTENDS } from "./comfyui-dom-deps.js";

/** Continuous selected-but-empty time before the starvation line is spoken. */
export const RENDER_STARVATION_MS = 3000;
/** Rail seen → our button still absent for this long = the appearance line. */
export const TAB_APPEAR_DEADLINE_MS = 10000;
/** Poll cadence for the appearance check (also re-samples starvation). */
export const WATCHDOG_POLL_MS = 500;
/** Stop polling entirely this long after install — a page with no rail by then
 *  is not going to grow one, and an observerless page costs nothing forever. */
export const WATCHDOG_GIVE_UP_MS = 60000;

const ISSUES_URL = "https://github.com/artokun/comfyui-mcp-panel/issues";

/** "1.47.12 and 1.50.3", however many entries the registry carries. */
function verifiedFrontendList() {
  const list = VERIFIED_FRONTENDS.slice();
  if (list.length === 0) return "a released frontend";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The remedy sentence both reports end with — one wording, one place. */
function remedyText() {
  const pin = VERIFIED_FRONTENDS[VERIFIED_FRONTENDS.length - 1] || "1.50.3";
  return (
    `This is NOT a connection problem, and reinstalling the pack or ComfyUI cannot change it. ` +
    `Please report it at ${ISSUES_URL} and include both version numbers from this message. ` +
    `Until it is fixed, relaunching ComfyUI with ` +
    `--front-end-version comfyanonymous/ComfyUI@${pin} restores the panel ` +
    `(frontends ${verifiedFrontendList()} are verified to render this panel version).`
  );
}

/**
 * The console line for "selected, and nothing painted".
 *
 * Wording rules, learned the hard way in this issue: report what was OBSERVED,
 * never a guessed cause; name both versions, because the frontend version is
 * the field a reporter is least likely to think to include; and close off the
 * two remedies that cannot work before anyone spends an hour on them.
 *
 * @param {{ panelVersion?: string, frontendVersion?: string, waitedMs?: number }} [info]
 */
export function renderStarvationReport(info = {}) {
  const p = info.panelVersion || "unknown";
  const f = info.frontendVersion || "unknown";
  const s = Math.round((info.waitedMs ?? RENDER_STARVATION_MS) / 1000);
  return (
    `[comfyui-mcp-panel] the Agent tab has been selected for ~${s}s but no panel content exists ` +
    `(no .cmcp-root in the document). The tab registered and was selected, yet the panel was ` +
    `either never asked to render or its content was removed as soon as it was attached. ` +
    `That is a compatibility fault between panel ${p} and ComfyUI frontend ${f}. ` +
    remedyText()
  );
}

/**
 * The console line for "registered, and the tab button never appeared".
 *
 * @param {{ panelVersion?: string, frontendVersion?: string, waitedMs?: number }} [info]
 */
export function tabNeverAppearedReport(info = {}) {
  const p = info.panelVersion || "unknown";
  const f = info.frontendVersion || "unknown";
  const s = Math.round((info.waitedMs ?? TAB_APPEAR_DEADLINE_MS) / 1000);
  return (
    `[comfyui-mcp-panel] registerSidebarTab() accepted the Agent tab, but its button never ` +
    `appeared in the sidebar rail (waited ~${s}s after the rail was seen). This frontend most ` +
    `likely changed how a custom sidebar tab is declared, in a way panel ${p} does not speak ` +
    `yet — ComfyUI frontend here is ${f}. ` +
    remedyText()
  );
}

/**
 * The starvation state machine, pure so it can be tested at second-boundaries
 * without a DOM or a clock.
 *
 * Feed it observations; it answers with the state they produce:
 *   "idle"      not our tab / painted / nothing to watch — any timer can drop
 *   "armed"     our tab is active and empty; `waited` ms so far
 *   "fired"     the window elapsed with the condition continuously true —
 *               onStarve(waitedMs) was invoked exactly once, ever
 *   "satisfied" our tab painted while active; the watchdog retires for good
 *
 * @param {{ tabId: string, windowMs?: number, onStarve?: (waitedMs: number) => void }} opts
 */
export function createRenderWatchdog({ tabId, windowMs = RENDER_STARVATION_MS, onStarve } = {}) {
  let armedAt = null;
  let done = false; // fired OR satisfied — either way, permanently over
  let firedEver = false;

  return {
    fired: () => firedEver,
    done: () => done,
    /**
     * @param {{state:string, id?:string}|null|undefined} active as returned by
     *   readActiveSidebarTab — "none" / "unknown" / {state:"id", id}.
     * @param {boolean} painted is any of our content connected right now?
     * @param {number} at a monotonic-enough clock (Date.now()).
     * @returns {{ state: "idle"|"armed"|"fired"|"satisfied", waited?: number }}
     */
    sample(active, painted, at) {
      if (done) return { state: firedEver ? "fired" : "satisfied" };
      const ours = !!active && active.state === "id" && active.id === tabId;
      if (ours && painted) {
        // First proven paint: the contract works here. Retire — later blanks
        // are different bugs and get different (visible) symptoms.
        done = true;
        armedAt = null;
        return { state: "satisfied" };
      }
      if (!ours) {
        // Another tab, no tab, or a marker we cannot read. None of these is
        // evidence about US — disarm rather than count (#784's rule).
        armedAt = null;
        return { state: "idle" };
      }
      // Ours, and empty.
      if (armedAt == null) armedAt = at;
      const waited = at - armedAt;
      if (waited >= windowMs) {
        done = true;
        firedEver = true;
        try {
          onStarve?.(waited);
        } catch {
          /* a reporter that throws must not take the page down */
        }
        return { state: "fired", waited };
      }
      return { state: "armed", waited };
    },
  };
}

/**
 * Wire the watchdog to a live document.
 *
 * Injection points exist for the tests; every default is the real thing. The
 * return value exposes `sample()` (so a hosting page or test can nudge it) and
 * `stop()` (detach everything).
 *
 * @param {object} opts
 * @param {string} opts.tabId
 * @param {() => boolean} opts.isPainted is our content connected right now?
 * @param {string} [opts.panelVersion]
 * @param {() => (string|undefined)} [opts.getFrontendVersion] read at fire time.
 * @param {Document} [opts.doc]
 * @param {(line: string) => void} [opts.report] default console.error.
 * @param {(cb: () => void) => { observe: Function, disconnect: Function }|null} [opts.makeObserver]
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimer]
 * @param {(h: unknown) => void} [opts.clearTimer]
 * @param {() => number} [opts.now]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.appearDeadlineMs]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.giveUpMs]
 */
export function installSidebarRenderWatchdog({
  tabId,
  isPainted,
  panelVersion,
  getFrontendVersion = () => undefined,
  doc = typeof document !== "undefined" ? document : null,
  report = (line) => console.error(line),
  makeObserver = (cb) =>
    typeof MutationObserver === "function" ? new MutationObserver(cb) : null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  now = () => Date.now(),
  windowMs = RENDER_STARVATION_MS,
  appearDeadlineMs = TAB_APPEAR_DEADLINE_MS,
  pollMs = WATCHDOG_POLL_MS,
  giveUpMs = WATCHDOG_GIVE_UP_MS,
} = {}) {
  if (!doc || typeof isPainted !== "function" || !tabId) return null;

  const versions = (waitedMs) => ({
    panelVersion,
    frontendVersion: (() => {
      try {
        return getFrontendVersion();
      } catch {
        return undefined;
      }
    })(),
    waitedMs,
  });

  let stopped = false;
  let observer = null;
  let expiryTimer = null;
  let pollTimer = null;
  const startedAt = now();
  let railSeenAt = null;
  let buttonEverSeen = false;
  let appearanceSpoken = false;

  const machine = createRenderWatchdog({
    tabId,
    windowMs,
    onStarve: (waitedMs) => report(renderStarvationReport(versions(waitedMs))),
  });

  const stop = () => {
    stopped = true;
    if (observer) {
      try {
        observer.disconnect();
      } catch { /* an observer that cannot disconnect is already gone */ }
      observer = null;
    }
    if (expiryTimer != null) {
      clearTimer(expiryTimer);
      expiryTimer = null;
    }
    if (pollTimer != null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
  };

  const sample = () => {
    if (stopped) {
      // Report the resting state honestly: how it ended, or that it merely
      // gave up ("stopped") without ever having evidence either way.
      return { state: machine.done() ? (machine.fired() ? "fired" : "satisfied") : "stopped" };
    }
    const active = readActiveSidebarTab(doc.querySelector(".side-bar-button-selected"));
    const res = machine.sample(active, !!isPainted(), now());
    if (res.state === "armed") {
      if (expiryTimer == null) {
        // Re-verify AT the deadline rather than firing blind: everything may
        // have changed since arming, and only a fresh look is evidence.
        const delay = Math.max(windowMs - (res.waited ?? 0), 0) + 80;
        expiryTimer = setTimer(() => {
          expiryTimer = null;
          sample();
        }, delay);
      }
    } else {
      if (expiryTimer != null) {
        clearTimer(expiryTimer);
        expiryTimer = null;
      }
      if (res.state === "fired" || res.state === "satisfied") stop();
    }
    return res;
  };

  const pollAppearance = () => {
    if (stopped) return;
    pollTimer = null;
    const t = now();
    const rail = doc.querySelector(".side-tool-bar-container");
    if (rail) {
      if (railSeenAt == null) {
        railSeenAt = t;
        // The rail exists — from here on, selection changes are observable.
        // Same subscription the sidebar guard uses: tab selection toggles a
        // class on the rail's buttons in every frontend generation we know.
        observer = makeObserver(() => sample());
        if (observer) {
          try {
            observer.observe(rail, { subtree: true, attributes: true, attributeFilter: ["class"] });
          } catch {
            observer = null; // fall back to the poll below
          }
        }
      }
      if (!buttonEverSeen && findSidebarTabButton(doc, tabId)) buttonEverSeen = true;
      if (!buttonEverSeen && !appearanceSpoken && t - railSeenAt >= appearDeadlineMs) {
        appearanceSpoken = true;
        report(tabNeverAppearedReport(versions(t - railSeenAt)));
        // No button means no way to select the tab: the starvation check can
        // never trigger, so there is nothing left to watch.
        stop();
        return;
      }
    }
    // The poll doubles as a low-rate starvation re-sample, so a frontend whose
    // rail stops emitting class mutations does not blind check 1 entirely.
    if (railSeenAt != null) sample();
    if (stopped) return;
    const buttonPhaseOver = buttonEverSeen || appearanceSpoken;
    const observerCarriesOn = observer != null && buttonPhaseOver;
    if (t - startedAt >= giveUpMs || observerCarriesOn) return; // observer (or silence) from here
    pollTimer = setTimer(pollAppearance, pollMs);
  };

  sample();
  pollAppearance();
  return { sample, stop };
}
