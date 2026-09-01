/**
 * #1995 — a queued run must not be reported as user-rejected, and an applied
 * widget write must not be reported as a hard timeout with no receipt.
 *
 * These drive the SHIPPED ack helpers (web/js/lib/delivery-ack.js) plus the
 * run/widget result wiring, so deleting either — the rewrite that forbids a
 * false rejected/timeout, or the call sites that actually use it — fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { honestRunAck, honestWidgetAck } from "../../web/js/lib/delivery-ack.js";
import {
  awaitFrontendWidgetFlush,
  FRONTEND_WIDGET_FLUSH_MS,
} from "../../web/js/lib/set-widget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");
const SET_WIDGET_SRC = readFileSync(join(HERE, "../../web/js/lib/set-widget.js"), "utf8");

const QUEUED_PROMPT_ID = "a0afaf59-18bf-4246-b445-beff69a20d12";
const USER_REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected";

test("#1995 a minted prompt id is never reported as user-rejected", () => {
  const out = honestRunAck({
    queued: false,
    prompt_id: QUEUED_PROMPT_ID,
    error: USER_REJECTED,
  });
  assert.equal(out.queued, true, "a queued prompt is queued, not refused");
  assert.equal(out.prompt_id, QUEUED_PROMPT_ID);
  assert.equal(out.error, undefined, "user-rejected language is stripped once a receipt exists");
  assert.doesNotMatch(JSON.stringify(out), /rejected|doesn't want/i);
});

test("#1995 a lost run ack without a receipt is unknown, not user-rejected", () => {
  const out = honestRunAck({
    queued: false,
    error: USER_REJECTED,
  });
  assert.equal(out.queued_unknown, true);
  assert.notEqual(out.queued, false, "no receipt means unknown, not a definite refusal");
  assert.doesNotMatch(String(out.error), /rejected|doesn't want/i);
  assert.match(String(out.retry_guidance), /queue/i);
});

test("#1995 a rewritten run ack keeps queue-time disclosures", () => {
  const feeds = [{ node_id: 12, widget: "text", origin_type: "PrimitiveNode" }];
  const withId = honestRunAck({
    queued: false,
    prompt_id: QUEUED_PROMPT_ID,
    error: USER_REJECTED,
    virtual_source_feeds: feeds,
    virtual_source_note: "the stored inner value executes",
  });
  assert.equal(withId.queued, true);
  assert.deepEqual(withId.virtual_source_feeds, feeds);
  assert.match(withId.virtual_source_note, /stored inner value/);

  const lost = honestRunAck({
    queued: false,
    error: USER_REJECTED,
    virtual_source_feeds: feeds,
    virtual_source_note: "the stored inner value executes",
  });
  assert.equal(lost.queued_unknown, true);
  assert.deepEqual(lost.virtual_source_feeds, feeds, "a lost ack must not drop the queue-time scan");
  assert.match(lost.virtual_source_note, /stored inner value/);
});

test("#1995 a genuine refusal without a prompt id stays a refusal", () => {
  const out = honestRunAck({
    queued: false,
    error: "node 12 is not an output node",
  });
  assert.equal(out.queued, false);
  assert.match(out.error, /not an output node/);
});

test("#1995 a clean queued accept is unchanged", () => {
  const accept = { queued: true, prompt_id: QUEUED_PROMPT_ID, batch_count: 1 };
  assert.equal(honestRunAck(accept), accept);
});

test("#1995 a mixed top-level refusal that already carries the id is unchanged", () => {
  const mixed = {
    queued: false,
    prompt_id: QUEUED_PROMPT_ID,
    error: "prompt outputs failed validation",
    error_type: "prompt_outputs_failed_validation",
  };
  assert.equal(honestRunAck(mixed), mixed);
});

test("#1995 an applied widget write is never a hard timeout with no receipt", () => {
  const set = { node_id: 181, widget: "duration", value: 6 };
  const out = honestWidgetAck({ set }, { timeout: true });
  assert.equal(out.applied, true);
  assert.equal(out.set.value, 6);
  assert.equal(out.set.node_id, 181);
  assert.equal(out.error, undefined, "an applied write is a receipt, not a timeout error");
  assert.match(String(out.ack_note), /applied/i);
});

test("#1995 an ordinary applied write keeps its receipt", () => {
  const set = { node_id: 132, widget: "cfg", value: 1.2 };
  const out = honestWidgetAck({ set, warning: "advisory" });
  assert.equal(out.applied, true);
  assert.equal(out.set.value, 1.2);
  assert.equal(out.warning, "advisory");
  assert.equal(out.error, undefined);
});

test("#1995 a widget timeout with no write receipt stays unknown, not applied", () => {
  const out = honestWidgetAck({}, { timeout: true });
  assert.equal(out.applied, false);
  assert.match(String(out.error), /receipt/i);
  assert.doesNotMatch(String(out.error), /rejected/i);
});

test("#1995 a frontend flush whose animation frame never fires still settles", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  const timers = [];
  try {
    const flushed = awaitFrontendWidgetFlush({
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
    });
    assert.equal(timers.length, 1, "the bound must arm instead of waiting forever on rAF");
    timers[0]();
    await flushed;
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("#1995 the flush bound is short of the 30s relay window", () => {
  assert.equal(FRONTEND_WIDGET_FLUSH_MS, 250);
  assert.ok(FRONTEND_WIDGET_FLUSH_MS < 30000);
});

test("#1995 wiring: graph_run returns through honestRunAck", () => {
  assert.match(PANEL_SRC, /if \(rejection\) return honestRunAck\(downgradeUnstableRunResult\(rejection, dispatchIdentityComparison\)\);/);
  assert.match(PANEL_SRC, /return honestRunAck\(downgradeUnstableRunResult\(accept, dispatchIdentityComparison\)\);/);
  assert.match(PANEL_SRC, /import \{ honestRunAck \} from "\.\/lib\/delivery-ack\.js";/);
});

test("#1995 wiring: the widget write path acks through honestWidgetAck after a bounded flush", () => {
  assert.match(SET_WIDGET_SRC, /withTimeout\(flush, FRONTEND_WIDGET_FLUSH_MS/);
  assert.match(SET_WIDGET_SRC, /return withWarning\(honestWidgetAck\(\{ set, \.\.\.extraResult \}\)\);/);
  assert.match(SET_WIDGET_SRC, /from "\.\/delivery-ack\.js";/);
});
