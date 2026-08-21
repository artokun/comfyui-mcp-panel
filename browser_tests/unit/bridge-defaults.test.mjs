/**
 * panel#1596 — 9180 collided with Logitech G HUB; the default is 9199 and a
 * saved exact 9180 migrates as default, while any other URL is a pin.
 *
 * Drives the shipped helpers. Assertions compare through those helpers rather
 * than restating their tables, except for the port numbers that ARE the contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BRIDGE_URL,
  LEGACY_BRIDGE_URL,
  LEGACY_9180_BRIDGE_URL,
  defaultDialOrder,
  isDefaultBridgeUrl,
  resolvedDefaultBridgeUrl,
} from "../../web/js/lib/bridge-defaults.js";
import { bridgeFallbackPlan } from "../../web/js/lib/bridge-liveness-fallback.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

test("#1596 the compiled default is 9199, 9180 is the legacy second URL", () => {
  assert.match(DEFAULT_BRIDGE_URL, /:9199$/);
  assert.match(LEGACY_9180_BRIDGE_URL, /:9180$/);
  assert.match(LEGACY_BRIDGE_URL, /:9101$/);
  const order = defaultDialOrder();
  assert.deepEqual(order, [DEFAULT_BRIDGE_URL, LEGACY_9180_BRIDGE_URL]);
});

test("#1596 a saved exact 9180 migrates as default; a custom URL does not", () => {
  assert.equal(isDefaultBridgeUrl("ws://127.0.0.1:9180"), true);
  assert.equal(isDefaultBridgeUrl("ws://127.0.0.1:9180/"), true);
  assert.equal(isDefaultBridgeUrl("  ws://127.0.0.1:9101  "), true);
  assert.equal(isDefaultBridgeUrl(DEFAULT_BRIDGE_URL), true);
  assert.equal(resolvedDefaultBridgeUrl("ws://127.0.0.1:9180"), DEFAULT_BRIDGE_URL);
  assert.equal(resolvedDefaultBridgeUrl(""), DEFAULT_BRIDGE_URL);
  assert.equal(resolvedDefaultBridgeUrl(null), DEFAULT_BRIDGE_URL);

  const pin = "ws://127.0.0.1:7777";
  assert.equal(isDefaultBridgeUrl(pin), false);
  assert.equal(isDefaultBridgeUrl("ws://localhost:9180"), false, "localhost is a pin, not the compiled default");
  assert.equal(resolvedDefaultBridgeUrl(pin), pin);
});

test("#1596 dial order when nothing advertised is [9199, 9180]", () => {
  const order = defaultDialOrder();
  assert.equal(order[0], DEFAULT_BRIDGE_URL);
  assert.equal(order[1], LEGACY_9180_BRIDGE_URL);
  // Handshake, not TCP: after 9199 fails the next candidate is 9180. The panel
  // records both the failed URL and the fallback (showExternalHintOnce).
  const attempted = new Set();
  const first = bridgeFallbackPlan({
    configured: DEFAULT_BRIDGE_URL,
    fallbacks: defaultDialOrder(),
    attempted,
  });
  assert.ok(first);
  assert.equal(first.url, LEGACY_9180_BRIDGE_URL);
  attempted.add(DEFAULT_BRIDGE_URL);
  attempted.add(first.key);
  assert.equal(
    bridgeFallbackPlan({
      configured: first.url,
      fallbacks: defaultDialOrder(),
      attempted,
    }),
    null,
    "two default ports cannot loop",
  );
});

test("#1596 a custom pin is never moved onto the default list", () => {
  // isDefaultBridgeUrl is the pin test connectAgent uses. The fallback path may
  // still try the default when a pin is DEAD (#1136); that is liveness, not
  // migration. Migration itself must leave a custom URL untouched.
  assert.equal(resolvedDefaultBridgeUrl("ws://127.0.0.1:5555"), "ws://127.0.0.1:5555");
});

test("#1596 WIRING: the panel imports the shipped defaults and dials the advertised local URL first", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /from "\.\/lib\/bridge-defaults\.js"/);
  assert.match(src, /resolvedDefaultBridgeUrl/);
  assert.match(src, /isDefaultBridgeUrl/);
  assert.match(src, /defaultDialOrder/);
  assert.match(src, /LEGACY_9180_BRIDGE_URL/);
  // Advertised local_url is the first loopback dial, before any compiled default.
  assert.match(src, /advertised\.local/);
  assert.match(src, /localUrl: advertised\.local/);
  // Do not resurrect a kill path.
  assert.doesNotMatch(src, /taskkill/i);
});
