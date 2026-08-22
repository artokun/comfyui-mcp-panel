/**
 * #1625 — a restart confirmation painted into a transcript the user cannot see
 * is the same failure as not painting at all.
 *
 * `panel_restart_comfyui` blocks on `ask_user`. The panel used to append the card
 * and call `scrollLog()`, which (a) honours stick-to-bottom, so a scrolled-up
 * reader never sees it, and (b) defers to `requestAnimationFrame`, which a
 * backgrounded ComfyUI tab never fires. The orchestrator then waits 90s and
 * reports the card wasn't answered.
 *
 * Two layers, same shape as interactive-card-fence.test.mjs:
 *   1. the shipped helper (web/js/lib/interactive-card-reveal.js);
 *   2. the REAL `paintQuestion` / `paintSecret` bodies, so a painter that goes
 *      back to `scrollLog()` alone fails here rather than only if the helper
 *      changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INTERACTIVE_CARD_REVEAL_RETRY_MS,
  revealInteractiveCard,
} from "../../web/js/lib/interactive-card-reveal.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const bodyOpen = src.indexOf(") {", start);
  if (bodyOpen === -1) return null;
  let depth = 0;
  for (let i = bodyOpen + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. the shipped helper
// ---------------------------------------------------------------------------

test("#1625 the card is brought forward NOW, not on an rAF a hidden tab will never fire", () => {
  const order = [];
  revealInteractiveCard({
    forceStick: () => order.push("stick"),
    openTab: () => order.push("open"),
    scrollNow: () => order.push("scroll"),
    schedule: (fn) => order.push(["scheduled", fn]),
  });
  assert.deepEqual(
    order.slice(0, 3),
    ["stick", "open", "scroll"],
    "stick, tab-forward and scroll all run in this turn — before any timer",
  );
  assert.equal(order.length, 4, "a retry is scheduled, not run inline");
  assert.equal(typeof order[3][1], "function");
});

test("#1625 the retry re-opens the tab: the first activate can miss a store that is not ready", () => {
  // Ask AI / What's New already wait this race out. A confirmation card that
  // paints into a still-detached keep-alive root is the same miss.
  const calls = { open: 0, scroll: 0 };
  let retry;
  let delay;
  revealInteractiveCard({
    openTab: () => {
      calls.open += 1;
    },
    scrollNow: () => {
      calls.scroll += 1;
    },
    schedule: (fn, ms) => {
      retry = fn;
      delay = ms;
    },
  });
  assert.equal(calls.open, 1);
  assert.equal(calls.scroll, 1);
  assert.equal(delay, INTERACTIVE_CARD_REVEAL_RETRY_MS, "retry uses the shipped delay, not a guess");
  retry();
  assert.equal(calls.open, 2, "the retry is another activate, not a no-op");
  assert.equal(calls.scroll, 2, "and another synchronous scroll after the re-attach");
});

test("#1625 a tab-activate throw still scrolls — the card is already in the keep-alive tree", () => {
  const order = [];
  revealInteractiveCard({
    forceStick: () => order.push("stick"),
    openTab: () => {
      throw new Error("no sidebar store");
    },
    scrollNow: () => order.push("scroll"),
    schedule: () => {},
  });
  assert.deepEqual(order, ["stick", "scroll"]);
});

test("#1625 a scroll throw does not skip the retry — the tab-forward may still land", () => {
  let retried = false;
  revealInteractiveCard({
    openTab: () => {},
    scrollNow: () => {
      throw new Error("detached root");
    },
    schedule: (fn) => {
      retried = true;
      fn();
    },
  });
  assert.equal(retried, true);
});

test("#1625 retryMs 0 means one attempt, matching a caller that already waited", () => {
  let scheduled = 0;
  revealInteractiveCard({
    openTab: () => {},
    scrollNow: () => {},
    schedule: () => {
      scheduled += 1;
    },
    retryMs: 0,
  });
  assert.equal(scheduled, 0);
});

// ---------------------------------------------------------------------------
// 2. the REAL painters
// ---------------------------------------------------------------------------

test("#1625 both collecting cards call the reveal helper AFTER they append the card", () => {
  for (const name of ["paintQuestion", "paintSecret"]) {
    const src = namedFunctionSource(panelSrc, name);
    assert.ok(src, `could not locate ${name}`);
    const appendAt = src.indexOf("log.appendChild(card)");
    assert.ok(appendAt > 0, `${name} must append the card to the log`);
    const revealAt = src.indexOf("revealInteractiveCard(", appendAt);
    assert.ok(revealAt > appendAt, `${name} must reveal after the card is in the log`);
    const afterAppend = src.slice(appendAt, revealAt);
    assert.equal(
      afterAppend.includes("scrollLog();"),
      false,
      `${name} must not rAF-scroll in the gap before reveal — that is the hidden-tab miss`,
    );
  }
});

test("#1625 the painters inject the live tab-forward, stick, and synchronous scroll", () => {
  for (const name of ["paintQuestion", "paintSecret"]) {
    const src = namedFunctionSource(panelSrc, name);
    assert.match(src, /openTab:\s*openSidebarTab/, `${name} brings the Agent tab forward`);
    assert.match(src, /stickToBottom = true/, `${name} forces stick so a scrolled-up reader still sees it`);
    assert.match(src, /log\.scrollTop = log\.scrollHeight/, `${name} scrolls NOW, not via rAF`);
    assert.match(src, /schedule:\s*\(fn, ms\) => setTimeout\(fn, ms\)/, `${name} retries with a real timer`);
  }
});

test("#1625 the module is imported — a painter call without the import is a ReferenceError", () => {
  assert.match(
    panelSrc,
    /import \{ revealInteractiveCard \} from "\.\/lib\/interactive-card-reveal\.js";/,
  );
});
