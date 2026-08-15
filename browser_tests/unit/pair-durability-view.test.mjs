// panel#749 — the pairing modal must show whether the URL survives a restart.
//
// The orchestrator already ships `durability` on the `pair_url` frame
// (comfyui-mcp#1020 for #875); the panel ignored it, so the user saw a bare QR
// with no expiry information. A user reported this as "updating the npm version
// bricks my communication with the agent" — the version was never the cause.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pairDurabilityView } from "../../web/js/lib/pair-durability-view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const DURABLE = {
  survivesRestart: true,
  rotates: [],
  note: "This URL survives an orchestrator restart: COMFYUI_MCP_PAIR_TOKEN is pinned…",
};
const ROTATING = {
  survivesRestart: false,
  rotates: ["hostname", "token"],
  note: "This URL stops working when the orchestrator restarts — both its hostname and its token are regenerated…",
};

test("#749 a durable URL is a QUIET confirmation", () => {
  const v = pairDurabilityView(DURABLE);
  assert.equal(v.tone, "ok");
  assert.equal(v.icon, "✓");
  assert.equal(v.note, DURABLE.note, "the orchestrator's sentence, verbatim");
});

test("#749 a rotating URL is a VISIBLE caution", () => {
  const v = pairDurabilityView(ROTATING);
  assert.equal(v.tone, "warn");
  assert.equal(v.icon, "⚠");
  assert.deepEqual(v.rotates, ["hostname", "token"]);
  assert.equal(v.note, ROTATING.note);
});

test("#749 the note is passed through, never paraphrased", () => {
  // Two spellings of one explanation drift, and this side is the one WITHOUT the
  // facts — it cannot see whether the token is pinned or the restarter is armed.
  const custom = { survivesRestart: false, rotates: ["token"], note: "ANY SENTENCE AT ALL" };
  assert.equal(pairDurabilityView(custom).note, "ANY SENTENCE AT ALL");
});

test("#749 an ABSENT durability renders NOTHING — never a reassuring tick", () => {
  // An older orchestrator does not send the field. Silence is the honest answer;
  // inventing either verdict would be a claim about config the panel cannot see.
  for (const absent of [undefined, null, "", 0, false, "yes", 42]) {
    assert.equal(pairDurabilityView(absent), null, `${JSON.stringify(absent)} must render nothing`);
  }
  // Present but with no usable sentence is the same case.
  assert.equal(pairDurabilityView({ survivesRestart: true }), null);
  assert.equal(pairDurabilityView({ survivesRestart: true, note: "   " }), null);
});

test("#749 only a STRICT true reads as durable — anything else falls to caution", () => {
  // This is the reassuring branch, and reassurance is the only direction where
  // being wrong costs the user a phone that silently stops working. A truthy
  // non-true value must not buy the tick.
  for (const flag of [1, "true", "yes", {}, [], undefined, null]) {
    const v = pairDurabilityView({ survivesRestart: flag, rotates: [], note: "n" });
    assert.equal(v.tone, "warn", `survivesRestart=${JSON.stringify(flag)} must not read as durable`);
  }
  assert.equal(pairDurabilityView({ survivesRestart: true, rotates: [], note: "n" }).tone, "ok");
});

test("#749 a malformed rotates list cannot crash the modal", () => {
  assert.deepEqual(pairDurabilityView({ survivesRestart: false, rotates: "token", note: "n" }).rotates, []);
  assert.deepEqual(
    pairDurabilityView({ survivesRestart: false, rotates: ["token", 7, null], note: "n" }).rotates,
    ["token"],
  );
});

test("#749 WIRING: the modal renders it and clears it between requests", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ pairDurabilityView \} from "\.\/lib\/pair-durability-view\.js"/);
  // painted from the frame the orchestrator sent…
  assert.match(src, /const dur = pairDurabilityView\(res\.durability\)/);
  assert.match(src, /durabilityLine\.textContent = `\$\{dur\.icon\} \$\{dur\.note\}`/);
  // …and RESET on every new request, or a mode switch would leave the previous
  // mode's verdict sitting under the new QR (LAN is durable, tunnel is not —
  // exactly the pair a user toggles between).
  assert.match(src, /durabilityLine\.hidden = true;\s*\r?\n\s*durabilityLine\.textContent = "";/);
  // and it is actually in the modal
  assert.match(src, /qrWrap\.append\(canvas, statusMsg, urlLine, durabilityLine\)/);
});
