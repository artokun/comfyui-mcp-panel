/**
 * panel#1486 — a clean install could not connect: the panel dialled ws://127.0.0.1:9180
 * forever while /comfyui_mcp_panel/status named ws://127.0.0.1:9181.
 *
 * WHAT STATUS ACTUALLY SAYS, because the obvious reading is wrong and the first version
 * of this fix was built on it. `bridge_url` is not a report of where the orchestrator
 * bound — it is `ws://{_BRIDGE_HOST}:{_BRIDGE_PORT}` (`__init__.py:928`) where
 * `_BRIDGE_PORT` is an import-time constant of the ComfyUI process (`__init__.py:64`)
 * with one writer and no `global` declaration. It names the port THIS ComfyUI was
 * configured to probe. An orchestrator that finds 9180 held and binds 9181 is invisible
 * to it, and nothing in the panel can discover that — see the last test.
 *
 * The bug this DOES fix: ComfyUI configured for a non-default port, the orchestrator on
 * that same port, and a panel with no reader for a plain `ws://` advertisement at all —
 * adoption existed only on two POST responses (launcher start, auto-reclaim), which an
 * externally started orchestrator never sends, plus a tunnel reader gated to https+wss.
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
    "ws://127.0.0.1",
  ]) {
    assert.equal(acceptableLoopbackBridgeUrl(url), url, url);
  }
  assert.equal(acceptableLoopbackBridgeUrl("  ws://127.0.0.1:9181  "), "ws://127.0.0.1:9181");
});

test("#1486: a NON-loopback advertisement is never adopted", () => {
  // An advertisement is a hint from a local endpoint, not an instruction. Adopting an
  // arbitrary host would let whatever answers /status redirect this tab's agent traffic.
  for (const url of [
    "ws://192.168.1.50:9181",
    "ws://evil.example.com:9181",
    "ws://127.0.0.1.example.com:9181",
    "ws://localhost@evil.com",
    "ws://localhost:9180@evil.com",
    "wss://127.0.0.1:9181",
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

test("#1486: the reported case adopts the port ComfyUI is configured for", () => {
  // ComfyUI has COMFYUI_MCP_BRIDGE_PORT=9181, the orchestrator is on 9181, `running`
  // corroborates it, and the tab is stuck on its compiled 9180 default.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "http:",
      statusBridgeUrl: "ws://127.0.0.1:9181",
      statusRunning: true,
      currentUrl: "ws://127.0.0.1:9180",
    }),
    "ws://127.0.0.1:9181",
  );
});

test("#1486: an UNCORROBORATED advertisement never moves a tab off a live bridge", () => {
  // The regression the first version of this fix introduced. ComfyUI's env says 9181;
  // the orchestrator actually took 9180 and the tab is correctly on it. Adopting 9181
  // sends the tab to a dead port — and the tick after that sees the advertisement equal
  // to the current URL, returns null, and never comes back. `running` is exactly the
  // fact that separates these, and it is in the same payload.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "http:",
      statusBridgeUrl: "ws://127.0.0.1:9181",
      statusRunning: false,
      currentUrl: "ws://127.0.0.1:9180",
    }),
    null,
  );
  // An older pack that cannot say, or anything non-boolean, is not corroboration either.
  for (const running of [undefined, null, "true", 1, {}]) {
    assert.equal(
      pickAdvertisedBridgeUrl({
        protocol: "http:",
        statusBridgeUrl: "ws://127.0.0.1:9181",
        statusRunning: running,
        currentUrl: "ws://127.0.0.1:9180",
      }),
      null,
      String(running),
    );
  }
});

test("#1486: a port SHIFT is invisible to status, and this fix does not claim otherwise", () => {
  // Orchestrator found 9180 held and bound 9181. `_BRIDGE_PORT` is an import-time
  // constant, so status still says 9180 — identical to what the tab already dials.
  // Nothing here can repair that case, and pretending to would be the false claim the
  // first version of this fix made.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "http:",
      statusBridgeUrl: "ws://127.0.0.1:9180",
      statusRunning: true,
      currentUrl: "ws://127.0.0.1:9180",
    }),
    null,
  );
});

test("#1486: the https/tunnel path keeps its existing precedence", () => {
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "https:",
      secureUrl: "wss://tunnel.example/bridge?token=x",
      statusBridgeUrl: "ws://127.0.0.1:9181",
      statusRunning: true,
      currentUrl: "ws://127.0.0.1:9180",
    }),
    "wss://tunnel.example/bridge?token=x",
  );
  // With no secure URL yet an https page adopts NOTHING rather than downgrading.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "https:",
      secureUrl: null,
      statusBridgeUrl: "ws://127.0.0.1:9181",
      statusRunning: true,
      currentUrl: "ws://127.0.0.1:9180",
    }),
    null,
  );
});

test("#1596 an advertised local_url is adopted even when status.running is false", () => {
  // The orchestrator named the port it bound. That is the fact that keeps a live
  // 9180 session from being stranded when the compiled default becomes 9199.
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "http:",
      localUrl: "ws://127.0.0.1:9180",
      statusBridgeUrl: "ws://127.0.0.1:9199",
      statusRunning: false,
      currentUrl: "ws://127.0.0.1:9199",
    }),
    "ws://127.0.0.1:9180",
  );
});

test("#1596 an advertised local_url does not churn a tab already on it", () => {
  assert.equal(
    pickAdvertisedBridgeUrl({
      protocol: "http:",
      localUrl: "ws://127.0.0.1:9180",
      statusRunning: false,
      currentUrl: "ws://127.0.0.1:9180",
    }),
    null,
  );
});

test("#1486 WIRING: the non-https path reads status, passes `running`, and keeps the guard first", () => {
  // A helper that decides correctly and is never called fixes nothing; a helper handed
  // only half the payload re-introduces the wedge above.
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
  assert.match(fn, /statusRunning: status\?\.running/, "and passes the corroboration with it");
  assert.match(fn, /localUrl: advertised\.local/, "and the orchestrator's advertised loopback");
  assert.match(fn, /pickAdvertisedBridgeUrl\(/, "routed through the decision helper");
  assert.ok(
    fn.indexOf("if (manualOverride) return;") < fn.indexOf("pickAdvertisedBridgeUrl("),
    "manual override is checked before anything is adopted",
  );
  assert.match(src, /from "\.\/lib\/advertised-bridge-url\.js"/);
});
