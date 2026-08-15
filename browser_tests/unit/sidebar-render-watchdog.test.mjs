// panel#779 — the silence detector: a selected Agent tab with nothing painted
// must produce ONE console line naming both versions and what to do.
//
// The outage this grew from failed in perfect silence: tab registered,
// selectable, black rectangle, `.cmcp-root` absent, nothing attributed to us.
// #784 fixed that cause and #785 gave a THROWING render a visible shell — but a
// render that is never CALLED (what a real sidebar-tab contract change would
// produce) still says nothing. The reporter answered that silence with an hour
// of reinstalls that could never have helped.
//
// The bar for these tests is the false-positive bar: the watchdog will be read
// as "something is broken", so every path where it must stay quiet — slow first
// build, keep-alive detach on tab switch, a user wandering off mid-window, an
// unreadable tab marker — is asserted as hard as the firing path.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RENDER_STARVATION_MS,
  SATISFY_CONFIRM_MS,
  WATCHDOG_POLL_MS,
  WATCHDOG_GIVE_UP_MS,
  renderStarvationReport,
  createRenderWatchdog,
  installSidebarRenderWatchdog,
} from "../../web/js/lib/sidebar-render-watchdog.js";
import { VERIFIED_FRONTENDS } from "../../web/js/lib/comfyui-dom-deps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const OURS = "comfyui-mcp.agent";

// ---------------------------------------------------------------------------
// The reports: observed facts, both versions, closed-off dead ends, a remedy.
// ---------------------------------------------------------------------------

test("#779 the starvation line carries everything a support answer needs", () => {
  const line = renderStarvationReport({
    panelVersion: "0.11.44",
    frontendVersion: "1.50.3",
    waitedMs: 3000,
  });
  assert.match(line, /^\[comfyui-mcp-panel\]/, "attributed to us — the outage line was not");
  assert.match(line, /0\.11\.44/, "panel version");
  assert.match(line, /1\.50\.3/, "frontend version — the field this whole issue turned on");
  assert.match(line, /~3s/, "how long it watched before speaking");
  assert.match(line, /\.cmcp-root/, "the observable a reporter can re-check");
  assert.match(line, /never asked to render|removed as soon as/, "names BOTH shapes it cannot distinguish");
  assert.match(line, /NOT a connection problem/i, "dead end #1, closed");
  assert.match(line, /reinstalling.*cannot change it/i, "dead end #2 — the one that cost an hour");
  assert.match(line, /github\.com\/artokun\/comfyui-mcp-panel\/issues/, "where to send it");
  // Comfy-Org/ComfyUI_frontend, NOT comfyanonymous/ComfyUI: the flag fetches
  // releases from the named repo, and the frontend's 1.x tags only exist in the
  // frontend repo — the other spelling silently falls back to the installed
  // default and appears to work exactly when it did nothing (verified live
  // against ComfyUI 0.30.2 while fixing this issue).
  assert.match(line, /--front-end-version Comfy-Org\/ComfyUI_frontend@/, "the workaround, in paste-able form");
});

test("#779 unknown versions say 'unknown' — never a guess", () => {
  const line = renderStarvationReport({});
  assert.match(line, /panel unknown/);
  assert.match(line, /frontend unknown/);
});

test("#779 the workaround pin is a VERIFIED frontend, not a hardcoded relic", () => {
  // The pin must track the registry that records what was actually checked
  // against shipped bundles — otherwise this string ages into bad advice.
  const newest = VERIFIED_FRONTENDS[VERIFIED_FRONTENDS.length - 1];
  const line = renderStarvationReport({});
  assert.ok(
    line.includes(`--front-end-version Comfy-Org/ComfyUI_frontend@${newest}`),
    `the recommended pin should be ${newest} (the newest verified frontend)`,
  );
  for (const v of VERIFIED_FRONTENDS) {
    assert.ok(line.includes(v), `every verified frontend is named as known-good (missing ${v})`);
  }
});

test("#779 the pin never recommends the frontend that is failing right now", () => {
  // Live-drill finding: with the failing frontend equal to the newest verified
  // one, a newest-only pin told the user to pin the version they were already
  // on. Advice-shaped noise — prefer the newest verified frontend that DIFFERS.
  const newest = VERIFIED_FRONTENDS[VERIFIED_FRONTENDS.length - 1];
  const previous = VERIFIED_FRONTENDS[VERIFIED_FRONTENDS.length - 2];
  const line = renderStarvationReport({ frontendVersion: newest });
  assert.ok(
    line.includes(`--front-end-version Comfy-Org/ComfyUI_frontend@${previous}`),
    `running ${newest}, the pin should back off to ${previous}`,
  );
  assert.ok(!line.includes(`ComfyUI_frontend@${newest} `), "never the failing version itself");
});

// ---------------------------------------------------------------------------
// The state machine. Times in ms; WINDOW below for readability.
// ---------------------------------------------------------------------------

const WINDOW = RENDER_STARVATION_MS;
const CONFIRM = SATISFY_CONFIRM_MS;
const ours = { state: "id", id: OURS };
const other = { state: "id", id: "workflows" };
const unknown = { state: "unknown" };
const none = { state: "none" };

function machine(onStarve = () => {}) {
  return createRenderWatchdog({ tabId: OURS, onStarve });
}

test("#779 the healthy path retires the watchdog — after the paint SURVIVES", () => {
  const m = machine(() => assert.fail("must not fire"));
  // One glimpse of paint is only "verifying" — the real #779 removed the root
  // instants after render() attached it.
  assert.equal(m.sample(ours, true, 0).state, "verifying");
  assert.equal(m.sample(ours, true, CONFIRM - 1).state, "verifying");
  assert.equal(m.sample(ours, true, CONFIRM).state, "satisfied");
  // Retired means RETIRED: even a later selected-and-empty eternity says nothing.
  assert.equal(m.sample(ours, false, WINDOW * 100).state, "satisfied");
  assert.equal(m.fired(), false);
});

test("#779 paint-then-instant-removal STILL fires — the shape of the actual outage", () => {
  // Live-drill regression: a saboteur that reproduced the pre-#784 guard
  // (remove .cmcp-root the moment render attaches it) put the first draft of
  // this watchdog to sleep, because its rail observer glimpsed the root in the
  // instant between attach and removal and retired on that single sample. The
  // glimpse must not count: only a paint that survives the confirmation dwell
  // retires the watchdog.
  let fired = 0;
  const m = machine(() => (fired += 1));
  m.sample(ours, false, 0); // armed on selection
  assert.equal(m.sample(ours, true, 10).state, "verifying"); // the glimpse
  assert.equal(m.sample(ours, false, 20).state, "armed"); // …and it is gone
  assert.equal(m.sample(ours, false, 20 + WINDOW).state, "fired");
  assert.equal(fired, 1);
});

test("#779 selected-and-empty shorter than the window never fires (slow first build)", () => {
  const m = machine(() => assert.fail("must not fire"));
  assert.equal(m.sample(ours, false, 0).state, "armed");
  assert.equal(m.sample(ours, false, WINDOW - 1).state, "armed");
  // The build lands just inside the deadline — a loaded machine, not a fault.
  assert.equal(m.sample(ours, true, WINDOW - 1).state, "verifying");
  assert.equal(m.sample(ours, true, WINDOW - 1 + CONFIRM).state, "satisfied");
});

test("#779 an interrupted confirmation dwell does not retire — it re-evaluates later", () => {
  const m = machine(() => assert.fail("must not fire"));
  assert.equal(m.sample(ours, true, 0).state, "verifying");
  // The user wanders off before the dwell completes. The paint was probably
  // real, but PROBABLY is not the retirement bar — stay alive, stay quiet.
  assert.equal(m.sample(other, false, 100).state, "idle");
  // Next dwell starts the confirmation over and completes it.
  assert.equal(m.sample(ours, true, 5000).state, "verifying");
  assert.equal(m.sample(ours, true, 5000 + CONFIRM).state, "satisfied");
});

test("#779 a full continuous window fires exactly once, with the waited time", () => {
  let fired = 0;
  let waitedMs = null;
  const m = machine((w) => {
    fired += 1;
    waitedMs = w;
  });
  m.sample(ours, false, 0);
  m.sample(ours, false, 1000); // observer noise mid-window must not reset the clock
  assert.equal(m.sample(ours, false, WINDOW).state, "fired");
  assert.equal(fired, 1);
  assert.equal(waitedMs, WINDOW);
  // Nothing ever fires twice — one line per page load is the contract.
  assert.equal(m.sample(ours, false, WINDOW * 10).state, "fired");
  assert.equal(fired, 1);
  assert.equal(m.fired(), true);
});

test("#779 switching away disarms; the clock restarts from zero on return", () => {
  let fired = 0;
  const m = machine(() => (fired += 1));
  m.sample(ours, false, 0);
  // Keep-alive: user peeks at another tab mid-window. destroy() detached our
  // root, but the active tab is theirs — that is not evidence about us.
  assert.equal(m.sample(other, false, WINDOW - 500).state, "idle");
  // Back to us: a FRESH window, not the remainder of the old one.
  m.sample(ours, false, WINDOW);
  assert.equal(m.sample(ours, false, WINDOW * 2 - 1).state, "armed");
  assert.equal(fired, 0);
  assert.equal(m.sample(ours, false, WINDOW * 2).state, "fired");
  assert.equal(fired, 1);
});

test("#779 an unreadable or absent selection NEVER arms — the #784 rule for diagnostics", () => {
  const m = machine(() => assert.fail("must not fire"));
  // "unknown" is "I cannot tell which tab is active", not "ours is starving".
  // This is deliberate blindness: if the marker moves again, the guard keeps
  // the panel alive (#784) and this watchdog stays quiet rather than crying
  // wolf on every tab the user opens.
  assert.equal(m.sample(unknown, false, 0).state, "idle");
  assert.equal(m.sample(unknown, false, WINDOW * 2).state, "idle");
  assert.equal(m.sample(none, false, WINDOW * 4).state, "idle");
  assert.equal(m.sample(other, false, WINDOW * 6).state, "idle");
  assert.equal(m.sample(null, false, WINDOW * 8).state, "idle");
});

test("#779 stray paint under ANOTHER active tab neither satisfies nor arms", () => {
  const m = machine(() => assert.fail("must not fire"));
  // Our content lingering while another tab is active is the guard's problem,
  // not proof the contract works — satisfaction requires painted WHILE ours.
  assert.equal(m.sample(other, true, 0).state, "idle");
  assert.equal(m.sample(ours, false, 1).state, "armed");
});

test("#779 a reporter that throws is swallowed and still counts as fired", () => {
  const m = createRenderWatchdog({
    tabId: OURS,
    onStarve: () => {
      throw new Error("console is broken too");
    },
  });
  m.sample(ours, false, 0);
  assert.equal(m.sample(ours, false, WINDOW).state, "fired");
  assert.equal(m.fired(), true);
});

// ---------------------------------------------------------------------------
// The installer, against a fake document and a hand-cranked clock.
// ---------------------------------------------------------------------------

/** A selected rail button double, in the 1.50 (data-testid) shape. */
function modernButton(id) {
  return {
    classList: ["side-bar-button", "side-bar-button-selected"],
    getAttribute: (k) => (k === "data-testid" ? `${id}-tab-button` : null),
  };
}

/** The same in the <=1.49 (class) shape. */
function legacyButton(id) {
  return {
    classList: ["side-bar-button", "side-bar-button-selected", `${id}-tab-button`],
    getAttribute: () => null,
  };
}

/**
 * The whole harness: fake doc, fake timers, captured reports, an observer stub
 * whose callback we can pull. `state` is mutated by the tests to move the world.
 */
function harness({
  windowMs = 300,
  confirmMs = 200,
  pollMs = 50,
  giveUpMs = 6000,
} = {}) {
  const state = {
    rail: null, // truthy once the rail exists
    button: false, // our tab button present in the rail?
    selected: null, // the selected rail button element, or null
    painted: false,
  };
  const reports = [];
  let clock = 0;
  let seq = 0;
  let timers = []; // { id, at, fn }
  const observers = [];

  const doc = {
    querySelector(sel) {
      if (sel === ".side-bar-button-selected") return state.selected;
      if (sel === ".side-tool-bar-container") return state.rail;
      if (sel.startsWith("[data-testid=")) {
        return state.button ? { tag: "modern-button" } : null;
      }
      if (sel.startsWith("button[class~=")) return null; // fake rail is 1.50-shaped
      return null;
    },
  };

  const handle = installSidebarRenderWatchdog({
    tabId: OURS,
    doc,
    isPainted: () => state.painted,
    panelVersion: "0.11.44-test",
    getFrontendVersion: () => "9.9.9",
    report: (line) => reports.push(line),
    makeObserver: (cb) => {
      // A real MutationObserver is REGISTERED ON A NODE. It hears mutations in
      // that node's tree and nowhere else, and it keeps hearing nothing at all
      // once that node is detached from the document. The first version of this
      // stub ignored `observe()`'s target and `mutate()` fired every observer
      // unconditionally — which made a rail-bound subscription and a
      // document-bound one indistinguishable, and hid the remount defect below.
      const o = {
        cb,
        target: null,
        opts: {},
        observe(node, opts) {
          this.target = node;
          this.opts = opts || {};
        },
        disconnect() {
          this.target = null;
          this.opts = {};
        },
      };
      observers.push(o);
      return o;
    },
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    now: () => clock,
    windowMs,
    confirmMs,
    pollMs,
    giveUpMs,
  });

  /** Advance the clock, running due timers in order (they may schedule more). */
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t.id !== due.id);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = until;
  }

  /**
   * A DOM mutation happens. Two things decide whether an observer hears it, and
   * the stub models both because the defect below hides if either is faked:
   *
   *  - WHERE it is registered. A real MutationObserver only hears mutations in
   *    the tree of the node it was given. A node the frontend has unmounted is
   *    detached and mutates no more, so a subscription left on a replaced rail
   *    hears nothing ever again.
   *  - WHAT it subscribed to. `{attributes:true}` does not deliver childList
   *    records, so an element that is BORN with the class already set produces
   *    no attribute record at all — only the insertion is observable.
   *
   * @param {"attributes"|"childList"} kind
   */
  function mutate(kind = "attributes") {
    for (const o of observers) {
      const reachable = o.target === doc || (state.rail != null && o.target === state.rail);
      if (reachable && o.opts[kind]) o.cb();
    }
  }

  /**
   * ComfyUI unmounts the rail and mounts a fresh one. Verified in the shipped
   * frontend at 1.47.12 / 1.48.7 / 1.50.3 / 1.51.5: the rail is `v-if`-gated,
   * `<SideToolbar v-if="showUI && !isBuilderMode && !linearMode" />` in
   * src/components/graph/GraphCanvas.vue, where `showUI` is
   * `!workspaceStore.focusMode && betaMenuEnabled`. Linear mode is a SECOND,
   * separate instance (src/views/LinearView.vue). So focus mode, linear mode
   * and builder mode each replace the element with a brand-new <nav>.
   *
   * The old element leaving and the new one arriving are childList mutations,
   * not attribute ones.
   */
  function remountRail(tag = "rail") {
    state.rail = { tag, n: (remountRail.n = (remountRail.n || 0) + 1) };
    mutate("childList");
    return state.rail;
  }

  return {
    state,
    reports,
    advance,
    mutate,
    remountRail,
    handle,
    observers,
    timersLeft: () => timers.length,
    /** Observers still registered on a node that has left the document. */
    staleObservers: () =>
      observers.filter(
        (o) => o.target != null && o.target !== doc && o.target !== state.rail,
      ),
    liveObservers: () => observers.filter((o) => o.target != null),
  };
}

test("#779 installer: the healthy first open reports nothing and stands down", () => {
  const h = harness();
  h.state.rail = {};
  h.advance(60); // poll finds the rail, attaches the observer
  h.state.button = true;
  h.advance(60); // poll sees the button — appearance satisfied
  h.state.selected = modernButton(OURS);
  h.state.painted = true; // render() attached the root, as it should
  h.mutate(); // the selection class change
  assert.equal(h.reports.length, 0);
  assert.equal(h.handle.sample().state, "verifying", "one glimpse is not proof");
  h.advance(400); // the paint survives the confirmation dwell
  assert.equal(h.handle.sample().state, "satisfied");
  h.advance(20000);
  assert.equal(h.reports.length, 0, "a satisfied watchdog never speaks");
  assert.equal(h.timersLeft(), 0, "…and holds no timers");
});

test("#779 installer: the live drill — root attached then instantly ripped out — fires", () => {
  // This exact sequence put the first draft to sleep on a real 1.47.12 page:
  // render attaches the root, the watchdog's observer glimpses it painted, and
  // a saboteur (standing in for the pre-#784 guard) removes it within the same
  // flush. The glimpse must leave the watchdog in "verifying", and the removal
  // must re-arm it — ending in the one report.
  const h = harness();
  h.state.rail = {};
  h.state.button = true;
  h.advance(60);
  h.state.selected = modernButton(OURS);
  h.state.painted = true; // the attach…
  h.mutate();
  h.state.painted = false; // …and the same-flush removal
  h.mutate();
  h.advance(500); // past windowMs 300 + slack
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0], /no panel content exists/);
  h.advance(20000);
  assert.equal(h.reports.length, 1, "still exactly one line");
});

test("#779 installer: selected-but-never-painted produces EXACTLY the one line", () => {
  const h = harness();
  h.state.rail = {};
  h.state.button = true;
  h.advance(60);
  // The user opens the Agent tab; render never attaches anything. This is the
  // reporter's screen on 1.50.3 before #784, and any future contract move.
  h.state.selected = modernButton(OURS);
  h.mutate();
  assert.equal(h.reports.length, 0, "nothing said inside the window");
  h.advance(500); // windowMs 300 + slack
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0], /no panel content exists/);
  assert.match(h.reports[0], /0\.11\.44-test/);
  assert.match(h.reports[0], /9\.9\.9/, "frontend version read at fire time");
  h.mutate();
  h.advance(20000);
  assert.equal(h.reports.length, 1, "one line per page load, ever");
});

test("#779 installer: the pre-1.50 class shape drives the same detection", () => {
  const h = harness();
  h.state.rail = {};
  h.state.button = true;
  h.advance(60);
  h.state.selected = legacyButton(OURS);
  h.mutate();
  h.advance(500);
  assert.equal(h.reports.length, 1, "a 1.47-shaped rail is watched identically");
});

test("#779 installer: switching away inside the window keeps it quiet", () => {
  const h = harness();
  h.state.rail = {};
  h.state.button = true;
  h.advance(60);
  h.state.selected = modernButton(OURS);
  h.mutate(); // armed
  h.advance(150); // half the window
  h.state.selected = modernButton("workflows"); // user wanders off; root detached
  h.mutate();
  h.advance(20000);
  assert.equal(h.reports.length, 0, "an abandoned window is not a failure");
});

test("#779 installer: paint landing inside the window keeps it quiet", () => {
  const h = harness();
  h.state.rail = {};
  h.state.button = true;
  h.advance(60);
  h.state.selected = modernButton(OURS);
  h.mutate(); // armed — render hasn't run yet, exactly the mid-construction gap
  h.advance(100);
  h.state.painted = true; // …and now it has
  h.advance(20000);
  assert.equal(h.reports.length, 0, "the expiry re-check found a healthy panel");
});

test("#779 installer: the #785 failure shell counts as painted — one voice at a time", () => {
  // If render() threw, the shell is already saying something better than we
  // can. isPainted() covers it at the integration site; here we prove the
  // installer trusts whatever isPainted says.
  const h = harness();
  h.state.rail = {};
  h.state.button = true;
  h.advance(60);
  h.state.selected = modernButton(OURS);
  h.state.painted = true; // the shell IS paint
  h.mutate();
  h.advance(20000);
  assert.equal(h.reports.length, 0);
});

test("#779 installer: a rail our button is FILTERED out of is never reported (LinearView)", () => {
  // The regression this replaces an earlier check for (Copilot review, PR #804).
  // A rail that exists without our button in it is NOT evidence of a broken
  // contract: ComfyUI ships a supported view that renders a deliberately
  // filtered rail — src/views/LinearView.vue mounts
  //   <SideToolbar :visible-tab-ids="['assets', 'apps']" …>
  // (present at frontend v1.50.3 AND v1.51.3; reached whenever the user turns
  // on linear mode, since GraphView.vue renders <LinearView v-if="linearMode"/>).
  // There, registration succeeded — the frontend's own sidebarTabStore still
  // lists us, `visibleTabIds` filters only at RENDER time — so reporting "your
  // panel is broken, relaunch pinned to another frontend" would be a false
  // statement aimed at a user whose panel is perfectly healthy.
  //
  // Filtering and a genuine contract break are indistinguishable from the DOM,
  // so the honest answer is silence — the same no-evidence-no-claim rule the
  // starvation check follows for an unreadable marker (#784).
  const h = harness();
  h.state.rail = {}; // the rail exists…
  h.state.button = false; // …and our button is simply not one of the visible ids
  h.advance(WATCHDOG_GIVE_UP_MS + 20000);
  assert.equal(h.reports.length, 0, "a filtered rail must never be called a fault");
  assert.equal(h.timersLeft(), 0, "…and it stands down rather than watching forever");
});

test("#779 installer: a filtered rail stays silent even while our tab is selectable later", () => {
  // The same shape, but the user leaves linear mode: the button turns up late
  // and everything paints. Nothing was ever wrong, and nothing is ever said.
  const h = harness();
  h.state.rail = {};
  h.advance(600); // rail seen, our button absent throughout
  h.state.button = true; // back to the full rail
  h.state.selected = modernButton(OURS);
  h.state.painted = true;
  h.mutate();
  h.advance(20000);
  assert.equal(h.reports.length, 0, "late appearance is not a contract break");
});

test("#779 installer: no rail at all is 'I cannot tell' — permanent silence", () => {
  const h = harness();
  h.advance(WATCHDOG_GIVE_UP_MS + 20000);
  assert.equal(h.reports.length, 0);
  assert.equal(h.timersLeft(), 0, "gave up without a word — no rail, no evidence");
});

test("#779 installer: a selected-and-empty tab on a rail-LESS page still says nothing", () => {
  // Codex-gate case: a page with a readable selected-button marker but no
  // recognizable rail container. Starvation evidence exists in isolation, but
  // "no rail seen" means this is not a sidebar we understand — the whole
  // watchdog holds to no-evidence-no-claim, not just the appearance half.
  const h = harness();
  h.state.selected = modernButton(OURS); // marked selected, never painted…
  h.advance(WATCHDOG_GIVE_UP_MS + 20000); // …forever, on a page with no rail
  assert.equal(h.reports.length, 0, "no rail was ever seen, so nothing may speak");
  assert.equal(h.timersLeft(), 0);
});

test("#779 installer: a button that appeared and later VANISHED stays silent", () => {
  // A tab that disappears is a different, visibly different symptom (gone, not
  // never-there) and the watchdog has no evidence about its cause — a filtered
  // rail produces exactly this transition when the user enters linear mode.
  const h = harness();
  h.state.rail = {};
  h.advance(120); // rail seen, poll running
  h.state.button = true;
  h.advance(120);
  h.state.button = false; // …and now it is gone
  h.advance(20000);
  assert.equal(h.reports.length, 0);
});

// ---------------------------------------------------------------------------
// The rail REMOUNT. A watchdog that can only hear the first rail is a watchdog
// that cannot run — the failure shape this project pays for most often.
// ---------------------------------------------------------------------------

test("#779 P1: a rail REMOUNT must not deafen the watchdog", () => {
  // Found in pre-merge review of PR #804, reproduced here before fixing.
  //
  // The first draft subscribed to the rail ELEMENT and then stopped polling for
  // good ("once the observer is watching the rail, the poll has nothing left to
  // discover"). ComfyUI does not keep one rail element for the life of the
  // page: entering or leaving focus mode / linear mode unmounts the sidebar and
  // mounts a fresh one. From that instant the subscription pointed at a node
  // that had left the document, and nothing was left to call sample() — so a
  // selection on the REPLACEMENT rail was never sampled, and the exact silence
  // this module exists to break came back.
  //
  // Nothing here is about the panel: the panel is broken in precisely the #779
  // way throughout. Only the detector changes.
  const h = harness();
  h.state.rail = { tag: "first" };
  h.state.button = true;
  h.advance(60); // the poll finds the rail and subscribes

  h.remountRail("replacement"); // focus-mode toggle: a NEW rail element
  h.advance(60);

  h.state.selected = modernButton(OURS); // the user opens the Agent tab…
  h.mutate(); // …and its selection class lands on the new rail
  h.advance(500); // …and nothing ever paints (windowMs 300 + slack)

  assert.equal(
    h.reports.length,
    1,
    "starvation after a rail remount must still be reported — this is the whole charter",
  );
  assert.match(h.reports[0], /no panel content exists/);
});

test("#779 P1: a rail already carrying our selection when it mounts is still caught", () => {
  // The other half of the remount, and the reason a class-attribute
  // subscription alone is not enough: when the frontend rebuilds the rail while
  // our tab is the active one, the replacement button is BORN selected. There
  // is no class transition to hear on it — the only observable is that the
  // element appeared. A detector that watches only attribute changes sleeps
  // through this one.
  const h = harness();
  h.state.rail = { tag: "first" };
  h.state.button = true;
  h.advance(60);

  h.state.selected = modernButton(OURS); // our tab is open and healthy…
  h.state.painted = true;
  h.mutate();
  h.advance(20); // …but not yet long enough to retire the watchdog

  h.state.painted = false; // the remount takes our content with it…
  h.remountRail("replacement"); // …and the new rail is born with us selected
  h.advance(500);

  assert.equal(h.reports.length, 1, "a re-render that never comes back is starvation");
});

test("#779 P1: many remounts still produce exactly ONE line, never one per remount", () => {
  // The re-arming-notice flood (#1489) is a live bug in this panel, so a
  // detector that re-binds must be held to the same bar it was built to:
  // one line per genuine starvation, for the life of the page. A fix that
  // re-installs state on every remount would pass the test above and fail here.
  const h = harness();
  h.state.rail = { tag: "first" };
  h.state.button = true;
  h.advance(60);
  h.state.selected = modernButton(OURS);
  h.mutate();
  h.advance(500);
  assert.equal(h.reports.length, 1, "the one line");

  for (let i = 0; i < 8; i += 1) {
    h.remountRail(`remount-${i}`);
    h.state.selected = modernButton(OURS);
    h.mutate();
    h.advance(2000);
  }
  assert.equal(h.reports.length, 1, "eight more remounts, still exactly one line");
  assert.equal(h.timersLeft(), 0, "a fired watchdog holds no timers across remounts");
  assert.equal(h.liveObservers().length, 0, "…and no observers");
});

test("#779 P1: a healthy panel stays silent across remounts, and still retires", () => {
  // The false-positive direction of the same change: re-binding must not turn a
  // perfectly normal focus-mode toggle into a report.
  const h = harness();
  h.state.rail = { tag: "first" };
  h.state.button = true;
  h.advance(60);
  h.state.selected = modernButton(OURS);
  h.state.painted = true;
  h.mutate();
  h.advance(400); // the paint survives the confirmation dwell → satisfied
  assert.equal(h.handle.sample().state, "satisfied");

  h.remountRail("replacement");
  h.state.painted = false; // mid-transition there is genuinely nothing painted
  h.mutate();
  h.advance(20000);
  assert.equal(h.reports.length, 0, "a retired watchdog never speaks again");
  assert.equal(h.timersLeft(), 0);
  assert.equal(h.liveObservers().length, 0, "and it let go of everything");
});

test("#779 P1: no rail element is ever retained, remounted or not", () => {
  // "Nothing detached is held" is the other half of the defect: a subscription
  // pinned to a replaced rail keeps a dead subtree reachable for the life of
  // the page. The structural guarantee is that the watchdog never registers on
  // a rail at all — so there is no reference that can go stale.
  const h = harness();
  h.state.rail = { tag: "first" };
  h.state.button = true;
  h.advance(60);
  assert.equal(h.observers.length, 1, "one subscription, made once");
  assert.notEqual(
    h.observers[0].target,
    h.state.rail,
    "the subscription must not be pinned to the rail element",
  );

  for (let i = 0; i < 5; i += 1) {
    h.remountRail(`remount-${i}`);
    assert.equal(h.staleObservers().length, 0, "nothing is left watching a departed rail");
    assert.equal(h.observers.length, 1, "…and no second subscription piles up");
  }

  h.handle.stop();
  assert.equal(h.liveObservers().length, 0, "stop() disconnects everything");
  assert.equal(h.timersLeft(), 0, "…and leaves no timer behind");
  assert.equal(h.handle.sample().state, "stopped");
});

test("#779 P1: a remount before the rail is ever seen still arms nothing", () => {
  // No-evidence-no-claim survives the change: a page whose rail we never saw
  // must stay silent even if elements come and go, and must still stand down.
  const h = harness();
  h.state.selected = modernButton(OURS); // selected and empty the whole time
  h.mutate();
  h.advance(WATCHDOG_GIVE_UP_MS + 20000);
  assert.equal(h.reports.length, 0, "no rail was ever seen, so nothing may speak");
  assert.equal(h.timersLeft(), 0, "…and the poll stood down at the give-up bound");
});

// ---------------------------------------------------------------------------
// Integration: the watchdog is actually wired at the registration site.
// ---------------------------------------------------------------------------

test("#779 the panel installs the watchdog right after the sidebar guard", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const guardAt = src.indexOf("installSidebarTabGuard(");
  const dogAt = src.indexOf("installSidebarRenderWatchdog({");
  assert.ok(guardAt > 0, "the guard is still installed");
  assert.ok(dogAt > guardAt, "the watchdog is installed after (and only with) the guard");
  assert.match(src, /import \{ installSidebarRenderWatchdog \} from "\.\/lib\/sidebar-render-watchdog\.js"/);
});

test("#779 isPainted at the integration site counts BOTH the root and the failure shell", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const call = src.slice(src.indexOf("installSidebarRenderWatchdog({"));
  const body = call.slice(0, call.indexOf("});") + 3);
  assert.match(body, /\.cmcp-root/, "the panel itself");
  assert.match(body, /\.cmcp-failure-shell/, "the #785 shell — already a voice, not a starvation");
  assert.match(body, /getFrontendVersion/, "the version the whole issue turned on is captured");
  assert.match(body, /__COMFYUI_FRONTEND_VERSION__/);
});

test("#779 the exported bounds are what the reports promise", () => {
  // The report says "~3s" from its inputs; the default must match the constant
  // so a default-config line never claims a window it did not wait.
  assert.equal(RENDER_STARVATION_MS, 3000);
  assert.ok(WATCHDOG_POLL_MS >= 250, "polling is a trickle, not a hot loop");
  assert.ok(WATCHDOG_GIVE_UP_MS >= 30000);
});

test("#779 the watchdog reports NOTHING that DOM absence cannot prove", () => {
  // A structural guard on the module, not on one code path: the only thing this
  // watchdog is allowed to conclude is starvation (provably-selected + empty).
  // An earlier draft also concluded "registerSidebarTab was dropped" from a
  // missing rail button, which a supported filtered rail (LinearView) produces
  // on a completely healthy panel. If a second report ever comes back, it has
  // to justify its evidence here first.
  const src = readFileSync(
    join(HERE, "../../web/js/lib/sidebar-render-watchdog.js"),
    "utf8",
  );
  const reports = src.match(/^export function \w*[Rr]eport\w*\(/gm) || [];
  assert.equal(reports.length, 1, `exactly one report survives, found: ${reports.join(", ")}`);
  assert.match(src, /export function renderStarvationReport\(/);
  assert.ok(
    !/findSidebarTabButton/.test(src),
    "the watchdog must not reason about our rail button's presence at all",
  );
});
