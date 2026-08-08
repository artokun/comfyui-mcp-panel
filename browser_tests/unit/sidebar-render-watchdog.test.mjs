// panel#779 — the silence detector: a selected Agent tab with nothing painted,
// or a registered tab whose button never appears, must produce ONE console line
// naming both versions and what to do.
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
  TAB_APPEAR_DEADLINE_MS,
  WATCHDOG_POLL_MS,
  WATCHDOG_GIVE_UP_MS,
  renderStarvationReport,
  tabNeverAppearedReport,
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
  assert.match(line, /--front-end-version comfyanonymous\/ComfyUI@/, "the workaround, in paste-able form");
});

test("#779 the appearance line is distinct and equally complete", () => {
  const line = tabNeverAppearedReport({
    panelVersion: "0.11.44",
    frontendVersion: "1.53.0",
    waitedMs: 10000,
  });
  assert.match(line, /^\[comfyui-mcp-panel\]/);
  assert.match(line, /button never\s+appeared/);
  assert.match(line, /~10s/);
  assert.match(line, /0\.11\.44/);
  assert.match(line, /1\.53\.0/);
  assert.match(line, /NOT a connection problem/i);
  assert.match(line, /github\.com\/artokun\/comfyui-mcp-panel\/issues/);
  assert.match(line, /--front-end-version comfyanonymous\/ComfyUI@/);
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
    line.includes(`--front-end-version comfyanonymous/ComfyUI@${newest}`),
    `the recommended pin should be ${newest} (the newest verified frontend)`,
  );
  for (const v of VERIFIED_FRONTENDS) {
    assert.ok(line.includes(v), `every verified frontend is named as known-good (missing ${v})`);
  }
});

// ---------------------------------------------------------------------------
// The state machine. Times in ms; WINDOW below for readability.
// ---------------------------------------------------------------------------

const WINDOW = RENDER_STARVATION_MS;
const ours = { state: "id", id: OURS };
const other = { state: "id", id: "workflows" };
const unknown = { state: "unknown" };
const none = { state: "none" };

function machine(onStarve = () => {}) {
  return createRenderWatchdog({ tabId: OURS, onStarve });
}

test("#779 the healthy path retires the watchdog for good", () => {
  const m = machine(() => assert.fail("must not fire"));
  assert.equal(m.sample(ours, true, 0).state, "satisfied");
  // Retired means RETIRED: even a later selected-and-empty eternity says nothing.
  assert.equal(m.sample(ours, false, WINDOW * 100).state, "satisfied");
  assert.equal(m.fired(), false);
});

test("#779 selected-and-empty shorter than the window never fires (slow first build)", () => {
  const m = machine(() => assert.fail("must not fire"));
  assert.equal(m.sample(ours, false, 0).state, "armed");
  assert.equal(m.sample(ours, false, WINDOW - 1).state, "armed");
  // The build lands just inside the deadline — a loaded machine, not a fault.
  assert.equal(m.sample(ours, true, WINDOW - 1).state, "satisfied");
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
function harness({ windowMs = 300, appearDeadlineMs = 1000, pollMs = 50, giveUpMs = 6000 } = {}) {
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
      const o = { cb, observe() {}, disconnect() {} };
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
    appearDeadlineMs,
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

  /** Fire every live MutationObserver callback, as a rail class change would. */
  function mutate() {
    for (const o of observers) o.cb();
  }

  return { state, reports, advance, mutate, handle, timersLeft: () => timers.length };
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
  assert.equal(h.handle.sample().state, "satisfied");
  h.advance(20000);
  assert.equal(h.reports.length, 0, "a satisfied watchdog never speaks");
  assert.equal(h.timersLeft(), 0, "…and holds no timers");
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

test("#779 installer: a rail with no button for the deadline says the appearance line", () => {
  const h = harness();
  h.state.rail = {}; // the rail exists…
  // …but our button never joins it, and nothing is ever selectable.
  h.advance(1500); // past appearDeadlineMs (1000)
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0], /button never\s+appeared/);
  assert.match(h.reports[0], /9\.9\.9/);
  h.advance(20000);
  assert.equal(h.reports.length, 1);
  assert.equal(h.timersLeft(), 0, "spoken once, then fully stood down");
});

test("#779 installer: no rail at all is 'I cannot tell' — permanent silence", () => {
  const h = harness();
  h.advance(WATCHDOG_GIVE_UP_MS + 20000);
  assert.equal(h.reports.length, 0);
  assert.equal(h.timersLeft(), 0, "gave up without a word — no rail, no evidence");
});

test("#779 installer: a button that appears late but within the deadline is fine", () => {
  const h = harness();
  h.state.rail = {};
  h.advance(600); // rail seen, button still absent — inside the deadline
  h.state.button = true;
  h.advance(20000);
  assert.equal(h.reports.length, 0, "slow rail population is not a contract break");
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
  // The report says "~3s"/"~10s" from its inputs; the defaults must match the
  // constants so a default-config line never claims a window it did not wait.
  assert.equal(RENDER_STARVATION_MS, 3000);
  assert.equal(TAB_APPEAR_DEADLINE_MS, 10000);
  assert.ok(WATCHDOG_POLL_MS >= 250, "polling is a trickle, not a hot loop");
  assert.ok(WATCHDOG_GIVE_UP_MS >= 30000);
});
