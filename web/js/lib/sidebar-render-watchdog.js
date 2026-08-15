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
 * ONE CHECK, EVIDENCE-ONLY (the #784 lesson applies to diagnostics too:
 * "I cannot tell" must never be reported as "it is broken"):
 *
 * STARVATION — our tab is PROVABLY the selected one (the rail button carries
 * our id, read the same dual-generation way the guard reads it) and yet no
 * `.cmcp-root` and no `.cmcp-failure-shell` exists, continuously for
 * RENDER_STARVATION_MS, re-verified at expiry. When the selected tab is
 * another tab, or unidentifiable ("unknown"), the check DISARMS rather than
 * counts — an unreadable marker is not evidence of our failure. A paint that
 * SURVIVES SATISFY_CONFIRM_MS while our tab is active retires the check for
 * the page's lifetime: its charter is first-paint failure, the #779 class;
 * content that disappears after a confirmed dwell is a different bug with a
 * different symptom. A mere glimpse of paint retires nothing — the actual
 * #779 attached the root and removed it in the same mutation flush, and a
 * live drill proved a glimpse-trusting watchdog sleeps through it.
 *
 * WHY THE BOUND IS WHAT IT IS. `render()` attaches `.cmcp-root` (or, if it
 * throws, the #785 shell) SYNCHRONOUSLY, in the same task ComfyUI calls it
 * from — there is no async gap in our paint path for a slow machine to widen.
 * So 3s of selected-and-empty is not "a slow build", it is a no-show; a
 * machine so loaded that `buildPanel()` takes seconds blocks the main thread,
 * which delays the deadline timer with it rather than firing it early; and a
 * paint that lands at any point inside the window disarms the check, because
 * the deadline RE-READS the document instead of deciding on the stale sample
 * that armed it.
 *
 * WHAT IT SUBSCRIBES TO, AND WHY IT IS NOT THE RAIL. The rail element is a
 * gate, never a handle: its existence proves "this page has a sidebar we
 * understand" (no rail, no evidence, no claim), and nothing more. The
 * subscription that drives sampling watches the DOCUMENT, because ComfyUI
 * destroys and recreates the rail on focus-, linear- and builder-mode
 * transitions — a subscription pinned to the first one goes permanently deaf
 * the first time a user toggles focus mode, which is how a fully tested
 * watchdog ends up unable to run. See `pollForRail` for the frontend citations.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK — and why (Copilot review, PR #804).
 * An earlier draft also reported "the rail exists but our tab button never
 * joined it within 10s", meaning to catch a frontend that accepts
 * registerSidebarTab() and silently drops the legacy spec. That check was
 * REMOVED: DOM absence cannot support that conclusion, because a shipped,
 * supported ComfyUI view renders a deliberately FILTERED rail —
 * `src/views/LinearView.vue` mounts `<SideToolbar :visible-tab-ids="['assets',
 * 'apps']">` (verified in the frontend repo at both v1.50.3 and v1.51.3, and
 * reached whenever the user turns on linear mode: `GraphView.vue` renders
 * `<LinearView v-if="linearMode" />`). In that view `.side-tool-bar-container`
 * is present and our button is absent while registration succeeded exactly as
 * designed — the frontend's own registry still lists us
 * (`sidebarTabStore.sidebarTabs`, which `visibleTabIds` only filters at RENDER
 * time). The check would therefore have told a user whose panel is perfectly
 * healthy that their panel is broken and to relaunch ComfyUI pinned to another
 * frontend. Filtering and a contract break are indistinguishable from the DOM,
 * so under this module's own rule the honest answer is silence.
 */

import { readActiveSidebarTab } from "./active-sidebar-tab.js";
import { VERIFIED_FRONTENDS } from "./comfyui-dom-deps.js";

/** Continuous selected-but-empty time before the starvation line is spoken. */
export const RENDER_STARVATION_MS = 3000;
/** A paint must SURVIVE this long before it retires the watchdog. The actual
 *  #779 failure attached the root and removed it within the same mutation
 *  flush — to a single sample that instant is indistinguishable from healthy.
 *  Found live: a drill that reproduced the historical remove-on-attach retired
 *  the first draft of this watchdog instead of firing it. Never trust one
 *  glimpse of paint. */
export const SATISFY_CONFIRM_MS = 1500;
/** Poll cadence while waiting for the rail (also re-samples starvation). */
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

/** The remedy sentence both reports end with — one wording, one place.
 *
 *  The pin names Comfy-Org/ComfyUI_frontend, NOT comfyanonymous/ComfyUI: the
 *  flag fetches GitHub releases from the named repo, and the frontend's 1.x
 *  release tags exist only in the frontend repo. A comfyanonymous/ComfyUI pin
 *  quietly falls back to whatever frontend package is installed — it appears
 *  to work exactly when it did nothing. Verified live against ComfyUI 0.30.2's
 *  frontend_management.py while fixing #779.
 *
 *  The pin prefers the newest verified frontend that DIFFERS from the one
 *  being reported: telling someone whose frontend is failing to pin that very
 *  version would be advice-shaped noise.
 *
 *  @param {string|undefined} runningFrontend the version being reported on. */
function remedyText(runningFrontend) {
  const known = VERIFIED_FRONTENDS.filter((v) => v !== runningFrontend);
  const pin = known[known.length - 1] || VERIFIED_FRONTENDS[VERIFIED_FRONTENDS.length - 1] || "1.50.3";
  return (
    `This is NOT a connection problem, and reinstalling the pack or ComfyUI cannot change it. ` +
    `Please report it at ${ISSUES_URL} and include both version numbers from this message. ` +
    `Until it is fixed, relaunching ComfyUI with ` +
    `--front-end-version Comfy-Org/ComfyUI_frontend@${pin} restores the panel ` +
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
    remedyText(info.frontendVersion)
  );
}

/**
 * The starvation state machine, pure so it can be tested at second-boundaries
 * without a DOM or a clock.
 *
 * Feed it observations; it answers with the state they produce:
 *   "idle"      not our tab / nothing to watch — any timer can drop
 *   "armed"     our tab is active and empty; `waited` ms so far
 *   "verifying" our tab painted, and the paint has not yet SURVIVED
 *               SATISFY_CONFIRM_MS — the actual #779 bug attached and removed
 *               the root within one mutation flush, so one glimpse of paint
 *               proves nothing; `waited` ms of confirmed dwell so far
 *   "fired"     the window elapsed with selected-and-empty continuously true —
 *               onStarve(waitedMs) was invoked exactly once, ever
 *   "satisfied" the paint survived the confirmation dwell while our tab was
 *               active; the watchdog retires for good
 *
 * @param {{ tabId: string, windowMs?: number, confirmMs?: number, onStarve?: (waitedMs: number) => void }} opts
 */
export function createRenderWatchdog({
  tabId,
  windowMs = RENDER_STARVATION_MS,
  confirmMs = SATISFY_CONFIRM_MS,
  onStarve,
} = {}) {
  let armedAt = null;
  let paintedAt = null;
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
     * @returns {{ state: "idle"|"armed"|"verifying"|"fired"|"satisfied", waited?: number }}
     */
    sample(active, painted, at) {
      if (done) return { state: firedEver ? "fired" : "satisfied" };
      const ours = !!active && active.state === "id" && active.id === tabId;
      if (!ours) {
        // Another tab, no tab, or a marker we cannot read. None of these is
        // evidence about US — disarm rather than count (#784's rule). An
        // interrupted confirmation dwell does NOT retire: stay alive and
        // re-evaluate on the next dwell.
        armedAt = null;
        paintedAt = null;
        return { state: "idle" };
      }
      if (painted) {
        // Painted — but a paint only counts once it has SURVIVED. The real
        // #779 removed the root instants after render() attached it, and a
        // watchdog that retired on the glimpse missed the entire outage.
        armedAt = null;
        if (paintedAt == null) paintedAt = at;
        const dwell = at - paintedAt;
        if (dwell >= confirmMs) {
          done = true;
          return { state: "satisfied" };
        }
        return { state: "verifying", waited: dwell };
      }
      // Ours, and empty. A prior unconfirmed paint is void.
      paintedAt = null;
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
  confirmMs = SATISFY_CONFIRM_MS,
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

  const machine = createRenderWatchdog({
    tabId,
    windowMs,
    confirmMs,
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
    // No rail seen yet means the page has not shown us a sidebar we understand,
    // and NOTHING may arm or speak on such a page — the same "no evidence, no
    // claim" rule the appearance check follows (codex gate: without this, the
    // one pre-rail sample could arm starvation and its expiry timer would fire
    // on a page the watchdog had otherwise sworn silence about).
    if (railSeenAt == null) return { state: "idle" };
    const active = readActiveSidebarTab(doc.querySelector(".side-bar-button-selected"));
    const res = machine.sample(active, !!isPainted(), now());
    if (res.state === "armed" || res.state === "verifying") {
      if (expiryTimer == null) {
        // Re-verify AT the deadline rather than deciding blind: everything may
        // have changed since this sample, and only a fresh look is evidence.
        // "armed" re-checks at the starvation deadline; "verifying" re-checks
        // when the paint would have survived long enough to count.
        const horizon = res.state === "armed" ? windowMs : confirmMs;
        const delay = Math.max(horizon - (res.waited ?? 0), 0) + 80;
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

  const pollForRail = () => {
    if (stopped) return;
    pollTimer = null;
    const t = now();
    const railExists = !!doc.querySelector(".side-tool-bar-container");
    if (railExists && railSeenAt == null) {
      railSeenAt = t;
      // A rail exists — from here on, selection changes are observable, so
      // subscribe. NOTE WHAT IS **NOT** SUBSCRIBED TO: the rail element.
      //
      // ComfyUI does not keep one rail element for the life of the page. The
      // rail is `v-if`-gated, so it is DESTROYED AND RECREATED, not hidden —
      // verified in the shipped frontend at 1.47.12, 1.48.7, 1.50.3 and 1.51.5:
      //
      //   src/components/graph/GraphCanvas.vue
      //     <SideToolbar v-if="showUI && !isBuilderMode && !linearMode" />
      //     const showUI = computed(() => !workspaceStore.focusMode && betaMenuEnabled.value)
      //
      // and linear mode mounts a SECOND, separate instance of its own
      // (src/views/LinearView.vue). So focus mode, linear mode and builder mode
      // each replace the <nav> with a brand-new element. An earlier draft bound
      // here and then stopped polling for good; after the first such toggle the
      // subscription pointed at a node that had left the document, nothing was
      // left to call sample(), and selections on the REPLACEMENT rail were
      // never sampled — the watchdog went silent in exactly the way it exists
      // to prevent, while its tests stayed green. Found in review of PR #804.
      //
      // The document is the one anchor in this page that cannot be replaced, so
      // that is what we watch. Nothing about a rail is retained, there is no
      // reference that can go stale, and no re-binding step exists to get wrong
      // — the failure is removed rather than detected. `sample()` already reads
      // the selected button at DOCUMENT scope, so it never cared which rail it
      // was looking at; only this subscription did.
      //
      // childList as well as class, because the two halves of a remount are
      // different mutations: the user toggling tabs on the new rail is a class
      // change, but a rail rebuilt WHILE our tab is active comes back with its
      // button already selected — no attribute ever transitions on it, and the
      // only observable is that the element appeared.
      //
      // Cost: the callback is `sample()` — two querySelectors and some
      // arithmetic — and MutationObserver batches records into ONE callback per
      // microtask checkpoint rather than one per record. It also disconnects
      // for good the moment the check resolves either way (stop() on
      // fired/satisfied), which for anyone who opens the panel is a second or
      // two after first paint.
      observer = makeObserver(() => sample());
      if (observer) {
        try {
          observer.observe(doc.documentElement ?? doc, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
          });
        } catch {
          observer = null; // fall back to the poll below
        }
      }
    }
    // The poll doubles as a low-rate starvation re-sample, so a frontend whose
    // rail stops emitting class mutations does not blind the check entirely.
    if (railSeenAt != null) sample();
    if (stopped) return;
    // Once the observer is watching, it drives sampling and the poll has
    // nothing left to discover — and because it watches the document rather
    // than one element, that stays true across every rail remount. Without one,
    // keep trickling until the give-up bound. A page that never grows a rail we
    // recognize simply goes quiet forever — no rail, no evidence, no claim.
    if (observer != null || t - startedAt >= giveUpMs) return;
    pollTimer = setTimer(pollForRail, pollMs);
  };

  sample();
  pollForRail();
  return { sample, stop };
}
