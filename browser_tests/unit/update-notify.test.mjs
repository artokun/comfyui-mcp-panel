/**
 * #1942 — in-app update notify: what it fixes, and one-click install+restart
 * only on a local host client.
 *
 * #1943/#1944 — a remote / tunnelled / mobile client must not be offered a
 * host-mutating action, and must not be shown the notice at all. The half-measure
 * ("tell them, hide the button") is the thing #1944 exists to reject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PANEL_REGISTRY_ID,
  PANEL_REGISTRY_URL,
  UPDATE_NOTICE_DISMISS_KEY,
  classifyClientContext,
  dismissToken,
  fetchPublishedPanelVersions,
  isDismissed,
  isLoopbackHostname,
  isMobileUserAgent,
  isTunnelHostname,
  parseRegistryNode,
  parseRegistryVersions,
  pickInstallableLatest,
  resolveUpdateState,
  shouldOfferHostMutation,
  shouldSurfaceUpdateNotice,
  summarizeChangelogMarkdown,
  summarizePendingVersions,
  versionsBetween,
} from "../../web/js/lib/update-notify.js";

const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const rel = (version, status = "NodeVersionStatusActive", changelog = "") => ({
  version,
  status,
  changelog,
});

// ---------------------------------------------------------------------------
// Client context
// ---------------------------------------------------------------------------

test("#1943 loopback desktop is the local host client", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1", "LOCALHOST"]) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
    assert.equal(
      classifyClientContext({ hostname, userAgent: "Mozilla/5.0 Chrome/120" }),
      "local",
      hostname,
    );
  }
});

test("#1943 a LAN, hostname, or empty origin is remote", () => {
  for (const hostname of ["192.168.1.10", "10.0.0.5", "172.16.0.2", "comfy.local", "gpu-box", ""]) {
    assert.equal(
      classifyClientContext({ hostname, userAgent: "Mozilla/5.0 Chrome/120" }),
      "remote",
      hostname,
    );
  }
  assert.equal(classifyClientContext({}), "remote");
});

test("#1943/#1944 a tunnel hostname is remote even on a desktop UA", () => {
  for (const hostname of [
    "abc.trycloudflare.com",
    "x.ngrok-free.app",
    "x.ngrok.io",
    "foo.loca.lt",
    "host.tailscale.net",
    "box.ts.net",
  ]) {
    assert.equal(isTunnelHostname(hostname), true, hostname);
    assert.equal(
      classifyClientContext({ hostname, userAgent: "Mozilla/5.0 Chrome/120" }),
      "remote",
      hostname,
    );
  }
});

test("#1944 a mobile UA is remote even on loopback", () => {
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14)"), true);
  assert.equal(
    classifyClientContext({
      hostname: "127.0.0.1",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605",
    }),
    "remote",
    "a phone pointed at loopback is still not the host session",
  );
});

test("#1944 remote never surfaces the notice and never offers install+restart", () => {
  assert.equal(shouldSurfaceUpdateNotice("remote"), false);
  assert.equal(shouldOfferHostMutation("remote"), false);
  assert.equal(shouldSurfaceUpdateNotice("local"), true);
  assert.equal(shouldOfferHostMutation("local"), true);
  // No degrade path: informing without the button is the half-measure #1944 rejects.
  assert.equal(shouldSurfaceUpdateNotice("remote"), shouldOfferHostMutation("remote"));
});

// ---------------------------------------------------------------------------
// Version state
// ---------------------------------------------------------------------------

test("#1942 a newer installable release is an update", () => {
  const s = resolveUpdateState({ running: "0.15.114", installed: "0.15.114", latest: "0.15.117" });
  assert.equal(s.kind, "update");
  assert.equal(s.targetVersion, "0.15.117");
});

test("#1942 disk-vs-running skew is a restart, not a silent mismatch", () => {
  // The session that filed the issue: ENVIRONMENT said 0.15.112, pyproject said 0.15.113.
  const s = resolveUpdateState({ running: "0.15.112", installed: "0.15.113", latest: "0.15.113" });
  assert.equal(s.kind, "restart");
  assert.equal(s.targetVersion, "0.15.113");
});

test("#1942 files already at latest while the tab still runs old code is restart", () => {
  const s = resolveUpdateState({ running: "0.15.114", installed: "0.15.117", latest: "0.15.117" });
  assert.equal(s.kind, "restart");
});

test("#1942 a git checkout newer than the Registry is not offered as a downgrade", () => {
  assert.equal(
    resolveUpdateState({ running: "0.15.119", installed: "0.15.119", latest: "0.15.117" }).kind,
    "none",
  );
  assert.equal(
    resolveUpdateState({ running: "0.15.119", installed: "0.15.119", latest: "0.15.119" }).kind,
    "none",
  );
});

test("#1942 an unknown probe never invents an update", () => {
  assert.equal(resolveUpdateState({ running: "0.15.119" }).kind, "none");
  assert.equal(resolveUpdateState({ running: "0.15.119", installed: null, latest: "" }).kind, "none");
  assert.equal(resolveUpdateState({}).kind, "none");
  assert.equal(resolveUpdateState({ running: "0.15.112", installed: "nope", latest: "also-nope" }).kind, "none");
});

test("#1942 disk skew still surfaces when the Registry is unreachable", () => {
  assert.equal(
    resolveUpdateState({ running: "0.15.112", installed: "0.15.113" }).kind,
    "restart",
  );
});

test("#1942 a newer published cut beats an already-updated disk", () => {
  const s = resolveUpdateState({ running: "0.15.110", installed: "0.15.112", latest: "0.15.117" });
  assert.equal(s.kind, "update");
  assert.equal(s.targetVersion, "0.15.117");
});

test("#1942 pending/flagged Registry cuts are not the installable latest", () => {
  const versions = [
    rel("0.15.119", "NodeVersionStatusPending"),
    rel("0.15.118", "NodeVersionStatusPending"),
    rel("0.15.117", "NodeVersionStatusActive"),
    rel("0.15.112", "NodeVersionStatusFlagged"),
  ];
  assert.equal(pickInstallableLatest(versions).version, "0.15.117");
  assert.equal(pickInstallableLatest([]), null);
  assert.equal(pickInstallableLatest(null), null);
});

test("#1942 Registry payloads that are junk produce nothing, never a throw", () => {
  assert.deepEqual(parseRegistryNode(null), { latest: null });
  assert.deepEqual(parseRegistryNode({ latest_version: { version: 7 } }), { latest: null });
  assert.deepEqual(parseRegistryVersions(null), []);
  assert.deepEqual(parseRegistryVersions([null, {}, { version: "x" }]), []);
  const parsed = parseRegistryNode({
    latest_version: { version: "v0.15.117", status: "NodeVersionStatusActive", changelog: "### Fixed\n- a" },
  });
  assert.equal(parsed.latest.version, "0.15.117");
});

test("#1942 the dismiss token is per kind+version, so a later cut re-notifies", () => {
  const token = dismissToken("update", "0.15.117");
  assert.equal(token, "update:0.15.117");
  assert.equal(isDismissed(token, "update", "0.15.117"), true);
  assert.equal(isDismissed(token, "update", "0.15.118"), false);
  assert.equal(isDismissed(token, "restart", "0.15.117"), false);
  assert.equal(isDismissed(null, "update", "0.15.117"), false);
  assert.equal(dismissToken("none", "0.15.117"), "");
});

// ---------------------------------------------------------------------------
// What the update fixes
// ---------------------------------------------------------------------------

test("#1942 Registry changelog markdown becomes sectioned headlines", () => {
  const entries = summarizeChangelogMarkdown(
    [
      "### Fixed",
      "- **keep `is_subgraph` on oversized stubs** so wide root nodes stay writable (#1938). Extra.",
      "- panel_unpack_subgraph no longer crashes",
      "### Changed",
      "",
      "- a release tag proves the tagged tree",
    ].join("\n"),
    { version: "0.15.115" },
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].section, "Fixed");
  assert.equal(entries[0].version, "0.15.115");
  assert.match(entries[0].text, /keep is_subgraph/);
  assert.doesNotMatch(entries[0].text, /Extra/);
  assert.equal(entries[2].section, "Changed");
});

test("#1942 pending notes are the versions between running and the target", () => {
  const versions = [
    rel("0.15.117", "NodeVersionStatusActive", "### Fixed\n- do not capture the previous tab (#1951)"),
    rel("0.15.116", "NodeVersionStatusActive", "### Fixed\n- disclose connect changes (#1928)"),
    rel("0.15.115", "NodeVersionStatusActive", "### Fixed\n- keep is_subgraph (#1938)"),
  ];
  const picked = versionsBetween(versions, { from: "0.15.115", to: "0.15.117" });
  assert.deepEqual(picked.map((v) => v.version), ["0.15.117", "0.15.116"]);
  const entries = summarizePendingVersions(versions, { from: "0.15.115", to: "0.15.117" });
  assert.equal(entries.length, 2);
  assert.match(entries[0].text, /previous tab/);
  assert.match(entries[1].text, /connect changes/);
});

test("#1942 an empty changelog is an empty list, not a fabricated note", () => {
  assert.deepEqual(summarizeChangelogMarkdown(""), []);
  assert.deepEqual(summarizeChangelogMarkdown("### Changed\n\n"), []);
  assert.deepEqual(summarizePendingVersions(null, { from: "0.1.0", to: "0.2.0" }), []);
});

test("#1942 fetchPublishedPanelVersions never hits the network in tests and fails open", async () => {
  const calls = [];
  const published = await fetchPublishedPanelVersions({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/versions")) {
        return {
          ok: true,
          json: async () => [
            rel("0.15.119", "NodeVersionStatusPending"),
            rel("0.15.117", "NodeVersionStatusActive", "### Fixed\n- a"),
          ],
        };
      }
      return {
        ok: true,
        json: async () => ({ latest_version: rel("0.15.115", "NodeVersionStatusActive") }),
      };
    },
  });
  assert.equal(published.latest.version, "0.15.117");
  assert.ok(calls.some((u) => u === PANEL_REGISTRY_URL));
  assert.equal(PANEL_REGISTRY_ID, "comfyui-agent-panel");

  assert.deepEqual(await fetchPublishedPanelVersions({}), { versions: [], latest: null });
  assert.deepEqual(
    await fetchPublishedPanelVersions({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    { versions: [], latest: null },
  );
});

// ---------------------------------------------------------------------------
// Wiring pins — a correct helper that the panel never calls is the #758-class miss
// ---------------------------------------------------------------------------

test("#1942 the panel imports the notify helpers and gates on client context", () => {
  assert.match(
    PANEL_SRC,
    /from "\.\/lib\/update-notify\.js"/,
    "the panel must import the shipped helpers, not a local copy",
  );
  assert.match(PANEL_SRC, /classifyClientContext\(/);
  assert.match(PANEL_SRC, /shouldSurfaceUpdateNotice\(/);
  assert.match(PANEL_SRC, /shouldOfferHostMutation\(/);
  assert.match(PANEL_SRC, /resolveUpdateState\(/);
  assert.match(PANEL_SRC, /fetchPublishedPanelVersions\(/);
});

test("#1944 a remote client returns before the notice is painted", () => {
  const fnStart = PANEL_SRC.indexOf("async function notifyAvailablePanelUpdate(");
  assert.notEqual(fnStart, -1, "notifyAvailablePanelUpdate must exist");
  const body = PANEL_SRC.slice(fnStart, PANEL_SRC.indexOf("\n  function ", fnStart + 10));
  const surface = body.indexOf("shouldSurfaceUpdateNotice(");
  const earlyReturn = body.indexOf("return;", surface);
  const paint = body.indexOf("dataset.testid = \"panel-update-available\"");
  assert.ok(surface !== -1 && earlyReturn !== -1, "the surface gate must be able to return");
  assert.ok(paint > earlyReturn, "the notice is painted only after the remote client has been filtered out");
  assert.doesNotMatch(
    body,
    /Install it from the panel on the host machine/,
    "no degrade-to-info copy — that is the #1944 half-measure",
  );
});

test("#1942 the local action is graph_update_node then comfy_reboot, not a new installer", () => {
  const fnStart = PANEL_SRC.indexOf("async function applyPanelUpdate(");
  assert.notEqual(fnStart, -1, "applyPanelUpdate must exist");
  const body = PANEL_SRC.slice(fnStart, PANEL_SRC.indexOf("\n  async function notifyAvailablePanelUpdate(", fnStart));
  assert.match(body, /GRAPH_TOOL_EXECUTORS\.graph_update_node/);
  assert.match(body, /GRAPH_TOOL_EXECUTORS\.comfy_reboot/);
  assert.match(body, /comfyui-agent-panel/);
  assert.match(body, /shouldOfferHostMutation\(/);
  const update = body.indexOf("graph_update_node");
  const reboot = body.indexOf("comfy_reboot");
  assert.ok(update !== -1 && reboot > update, "install is queued before the restart");
});

test("#1942 the notice is scheduled on mount the way what's-new is, and is not awaited", () => {
  const kick = PANEL_SRC.indexOf("announcePanelUpdate();");
  assert.notEqual(kick, -1);
  const notify = PANEL_SRC.indexOf("void notifyAvailablePanelUpdate();", kick);
  assert.ok(notify !== -1 && notify - kick < 800, "the pending-update check rides the same mount as what's-new");
  assert.match(PANEL_SRC, /dataset\.testid = "panel-update-available"/);
  assert.match(PANEL_SRC, /dataset\.testid = "panel-update-badge"/);
  assert.match(PANEL_SRC, /lsGet\(UPDATE_NOTICE_DISMISS_KEY\)/);
  assert.match(PANEL_SRC, /lsSet\(UPDATE_NOTICE_DISMISS_KEY,/);
  assert.equal(UPDATE_NOTICE_DISMISS_KEY, "comfyui-mcp.panel.updateNoticeDismissed");
});
