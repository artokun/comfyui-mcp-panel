// comfyui-mcp-panel#1264 — a timed-out workflow_open left the switch fence stuck.
//
// workflow_open's re-baseline step (clearSpuriousOpenModified) awaits ONE
// animation frame while holding a reload step of the switch/reload section.
// rAF does not fire in a hidden or occluded tab, and a step in flight is
// deliberately immune to the section's 30s age-out (that immunity exists so a
// genuine load cannot lose the fence mid-write) — so on a backgrounded tab the
// frame wait never settled, the fence latched forever, every graph/workflow
// command was refused, and neither the open's reply nor its open receipt could
// be delivered until a manual page reload. The reporters' only workaround was
// F5.
//
// The fix bounds the frame wait with the repo's one bounded-step primitive: a
// starved frame degrades to a timer fallback (the tab keeps a cosmetic
// modified flag — the LOUD direction) instead of wedging the bridge. These
// tests pin both halves:
//
//   1. the primitive's guarantee the fix relies on — a never-settling step
//      resolves through its fallback instead of pending forever;
//   2. the SHIPPING nextFrame in the bundle routing its rAF wait through that
//      primitive with a positive bound that stays well under the bridge's
//      15s reply window, so the open's reply/receipt can still land.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { withTimeout } from "../../web/js/lib/bounded-step.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");

test("#1264 a step that never settles resolves through its fallback instead of wedging", async () => {
  const outcome = await withTimeout(new Promise(() => {}), 25, () => "fallback");
  assert.equal(outcome, "fallback", "a starved frame must degrade, never pend forever");
});

test("#1264 a late-settling step is dropped once the bound has fired", async () => {
  let late = null;
  const slow = new Promise((resolve) => setTimeout(() => {
    late = "late";
    resolve("late");
  }, 50));
  const outcome = await withTimeout(slow, 10, () => "fallback");
  assert.equal(outcome, "fallback");
  await slow;
  assert.equal(late, "late", "the bounded work is not cancelled — only the WAIT is bounded");
});

test("#1264 the shipping nextFrame bounds its rAF wait with the shared primitive", () => {
  const decl = source.indexOf("function nextFrame()");
  assert.ok(decl > 0, "nextFrame exists in the bundle");
  const body = source.slice(decl, decl + 1200);
  assert.match(
    body,
    /withTimeout\(/,
    "the frame wait must route through the bounded-step primitive — " +
      "an unbounded rAF await never settles in a hidden tab and latches the switch fence",
  );
  const budget = source.match(/NEXT_FRAME_FALLBACK_MS\s*=\s*(\d+)/);
  assert.ok(budget, "the fallback budget is a named, reviewable constant");
  const ms = Number(budget[1]);
  assert.ok(ms > 0, "the bound must be positive — a non-positive one disables it");
  assert.ok(
    ms < 15000,
    `the bound (${ms}ms) must stay well under the bridge's 15s reply window so the open's ` +
      "reply and open receipt can still be delivered when the frame is starved",
  );
  assert.ok(
    source.indexOf("NEXT_FRAME_FALLBACK_MS") < decl,
    "the budget constant is declared before its use",
  );
});
