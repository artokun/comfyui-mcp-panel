/**
 * panel#1486 — a clean install could not connect when the orchestrator bound a port
 * other than 9180.
 *
 * Both sides default to 9180, so the panel's compiled fallback was never stale. The gap
 * was adoption: the orchestrator advertises the port it ACTUALLY bound via
 * `/comfyui_mcp_panel/status`, and the only two readers of an advertised `bridge_url`
 * were POST responses (the panel's own launcher start, and the auto-reclaim). An
 * orchestrator started externally — `npx comfyui-mcp connect` in a terminal — sends
 * neither, and the remaining reader was `https:`-gated and `wss://`-only for the tunnel.
 * So the tab dialled `ws://127.0.0.1:9180` forever while status said 9181.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  acceptableLoopbackBridgeUrl,
  pickAdvertisedBridgeUrl,
} from "../../web/js/lib/advertised-bridge-url.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

test("#1486: a loopback ws:// advertisement is adoptable", () => {
  for (const url of [
    "ws://127.0.0.1:9181",
    "ws://127.0.0.1:9181/",
    "ws://localhost:9181",
    "ws://[::1]:9181",
    "ws://127.0.0.1", // no port — still loopback
  ]) {
    assert.equal(acceptableLoopbackBridgeUrl(url), url, url);
  }
  // Surrounding whitespace is not a different endpoint.
  assert.equal(acceptableLoopbackBridgeUrl("  ws://127.0.0.1:9181  "), "ws://127.0.0.1:9181");
});

test("#1486: a NON-loopback advertisement is never adopted", () => {
  // An advertisement is a hint from a local endpoint, not an instruction. Adopting an
  // arbitrary host would let whatever answers /status redirect this tab's agent traffic.
  for (const url of [
    "ws://192.168.1.50:9181",
    "ws://evil.example.com:9181",
    "ws://127.0.0.1.example.com:9181", // prefix that only LOOKS like loopback
    "wss://127.0.0.1:9181", // the tunnel path, which has its own reader and token handling
    "http://127.0.0.1:9181",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(acceptableLoopbackBridgeUrl(url), null, String(url));
  }
});

test("#1486: the reporter's exact case adopts the advertised port", () => {
  // Status says 9181; the tab is dialling its compiled 9180 default.
  const next = pickAdvertisedBridgeUrl({
    protocol: "http:",
    secureUrl: null,
    statusBridgeUrl: "ws://127.0.0.1:9181",
    currentUrl: "ws://127.0.0.1:9180",
  });
  assert.equal(next, "ws://127.0.0.1:9181");
});

test("#1486: an advertisement matching what is already dialled changes nothing", () => {
  // Otherwise every poll would churn the socket for a no-op.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "http:",
      statusBridgeUrl: "ws://127.0.0.1:9180",
      currentUrl: "ws://127.0.0.1:9180",
    }),
    null,
  );
});

test("#1486: the https/tunnel path keeps its existing precedence", () => {
  // On an https page the secure wss URL still wins, and a plain loopback advertisement
  // is NOT substituted for it — that path is token-gated and changing it is a separate
  // question from this fix.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "https:",
      secureUrl: "wss://tunnel.example/bridge?token=x",
      statusBridgeUrl: "ws://127.0.0.1:9181",
      currentUrl: "ws://127.0.0.1:9180",
    }),
    "wss://tunnel.example/bridge?token=x",
  );
  // And with no secure URL yet, an https page adopts NOTHING rather than downgrading.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "https:",
      secureUrl: null,
      statusBridgeUrl: "ws://127.0.0.1:9181",
      currentUrl: "ws://127.0.0.1:9180",
    }),
    null,
  );
});

test("#1486 WIRING: the non-https path actually reads status, and the guard still runs first", () => {
  // A helper that decides correctly and is never called fixes nothing. The old code
  // returned on `location.protocol !== "https:"` BEFORE reading anything, so the
  // regression to guard against is that early return coming back.
  const src = readFileSync(PANEL_JS, "utf8");
  const fn = src.slice(
    src.indexOf("async function reclaimAdvertisedBridgeUrl()"),
    src.indexOf("async function readOrchestratorStatus()"),
  );
  assert.ok(fn.length > 0, "located reclaimAdvertisedBridgeUrl");

  assert.doesNotMatch(
    fn,
    /if \(location\.protocol !== "https:"\) return;/,
    "the early return that made a loopback advertisement unreadable must not come back",
  );
  assert.match(fn, /readOrchestratorStatus\(\)/, "the non-https path reads the advertisement");
  assert.match(fn, /pickAdvertisedBridgeUrl\(/, "and routes it through the decision helper");

  // The manual-override guard must still precede any adoption: a user-typed Advanced
  // Bridge URL is never clobbered, and moving the https gate must not have reordered it.
  assert.ok(
    fn.indexOf("if (manualOverride) return;") < fn.indexOf("pickAdvertisedBridgeUrl("),
    "manual override is checked before anything is adopted",
  );
  assert.match(src, /import \{ pickAdvertisedBridgeUrl \} from "\.\/lib\/advertised-bridge-url\.js";/);
});
