// comfyui-mcp#1136 — the status chip read "disconnected" on a working session.
//
// Measured on the reporting machine: 9180 LISTENING (HTTP 426 Upgrade Required, the
// live single-port bridge) while comfyui-mcp.bridgeUrl.claude = ws://127.0.0.1:52727
// was ECONNREFUSED. With defaultBackend "claude" the panel dialed 52727 forever, so the
// chip truthfully reported a dead socket — just not the one doing the work.
//
// 52727 got there via the one-time pre-per-backend migration, which preserves an
// EPHEMERAL orchestrator port unconditionally; the connect path then classified it as a
// deliberate manual override because it differs from the default, and honoured it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isManualBridgeOverride,
  isInheritedBridgeUrl,
  migratedBridgeUrlKey,
} from "../../web/js/lib/bridge-url-provenance.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULT_URL = "ws://127.0.0.1:9180";
const STALE_MIGRATED = "ws://127.0.0.1:52727";

test("#1136 the reporter's stale migrated port stops outranking the live bridge", () => {
  // The whole bug in one assertion: 52727 differs from the default, so the old rule
  // called it a manual override and dialed it. It was inherited, not chosen.
  assert.equal(
    isManualBridgeOverride({
      wanted: STALE_MIGRATED,
      backendDefault: DEFAULT_URL,
      lastAutoUrl: "",
      migratedUrl: STALE_MIGRATED,
    }),
    false,
  );
});

test("#1136 a port the user actually typed still wins", () => {
  // The override rule exists for this case and must survive intact — otherwise the fix
  // trades one silent wrong target for another.
  assert.equal(
    isManualBridgeOverride({
      wanted: "ws://127.0.0.1:9999",
      backendDefault: DEFAULT_URL,
      lastAutoUrl: "",
      migratedUrl: STALE_MIGRATED,
    }),
    true,
  );
});

test("#1136 a custom port that MATCHES nothing migrated is still honoured", () => {
  assert.equal(
    isManualBridgeOverride({
      wanted: "ws://127.0.0.1:9999",
      backendDefault: DEFAULT_URL,
      lastAutoUrl: "",
      migratedUrl: undefined,
    }),
    true,
  );
});

test("#1136 the pre-existing rule is otherwise unchanged", () => {
  const base = { backendDefault: DEFAULT_URL, migratedUrl: STALE_MIGRATED };
  // empty -> not an override
  assert.equal(isManualBridgeOverride({ ...base, wanted: "", lastAutoUrl: "" }), false);
  assert.equal(isManualBridgeOverride({ ...base, wanted: "   ", lastAutoUrl: "" }), false);
  // equal to the backend default -> not an override
  assert.equal(isManualBridgeOverride({ ...base, wanted: DEFAULT_URL, lastAutoUrl: "" }), false);
  // equal to the last auto-applied url -> not an override
  assert.equal(
    isManualBridgeOverride({ ...base, wanted: "ws://x:1", lastAutoUrl: "ws://x:1" }),
    false,
  );
});

test("#1136 whitespace cannot promote an inherited value into a chosen one", () => {
  // A settings round-trip can add whitespace; a trailing space must not be enough to
  // make the panel start trusting a dead port again.
  assert.equal(
    isManualBridgeOverride({
      wanted: `  ${STALE_MIGRATED} `,
      backendDefault: DEFAULT_URL,
      lastAutoUrl: "",
      migratedUrl: STALE_MIGRATED,
    }),
    false,
  );
});

test("#1136 whitespace in the STORED value cannot re-trust a dead port", () => {
  // The caller trims `wanted`, so that side's trim is redundant — but the migrated
  // value comes back off localStorage untrimmed, and if a settings round-trip padded
  // it the comparison would miss and the stale port would be honoured again. Found by
  // a mutation that survived because the original test only padded the wrong side.
  assert.equal(
    isManualBridgeOverride({
      wanted: STALE_MIGRATED,
      backendDefault: DEFAULT_URL,
      lastAutoUrl: "",
      migratedUrl: `  ${STALE_MIGRATED}
`,
    }),
    false,
  );
});

test("#1136 inheritance is never inferred from empty or non-string values", () => {
  for (const bad of [undefined, null, "", "   ", 0, {}]) {
    assert.equal(isInheritedBridgeUrl(bad, STALE_MIGRATED), false, String(bad));
    assert.equal(isInheritedBridgeUrl(STALE_MIGRATED, bad), false, String(bad));
  }
});

test("#1136 the provenance key is per-backend", () => {
  assert.notEqual(migratedBridgeUrlKey("claude"), migratedBridgeUrlKey("codex"));
  assert.match(migratedBridgeUrlKey("claude"), /claude$/);
});

test("#1136 WIRING: the migration records what it wrote", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(
    src,
    /import \{ isManualBridgeOverride, migratedBridgeUrlKey \} from "\.\/lib\/bridge-url-provenance\.js";/,
  );
  // The record must be written at the SAME place the migration writes the value —
  // otherwise the provenance is lost and the override rule has nothing to consult.
  const at = src.indexOf("setSetting(SETTING_BRIDGE_URL.claude, lu);");
  assert.ok(at > 0, "migration site must exist");
  const block = src.slice(at, at + 700);
  assert.match(block, /lsSet\(migratedBridgeUrlKey\("claude"\), lu\)/);
});

test("#1136 WIRING: BOTH manual-override sites consult provenance", () => {
  // There are two, and they were byte-identical. Fixing one leaves the other dialing
  // the dead port, which is exactly the kind of half fix this file keeps producing.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const uses = src.match(/isManualBridgeOverride\(\{/g) ?? [];
  assert.equal(uses.length, 2, "both override sites must use the shared rule");
  // And the old inline rule must be gone from both.
  const stale =
    src.match(/!!wanted && wanted !== defaultBridgeUrlFor\(selectedBackend\) && wanted !== lastAutoUrl/g) ??
    [];
  assert.equal(stale.length, 0, "no inline override rule may survive");
  assert.equal((src.match(/migratedUrl: lsGet\(migratedBridgeUrlKey\(selectedBackend\)\)/g) ?? []).length, 2);
});
