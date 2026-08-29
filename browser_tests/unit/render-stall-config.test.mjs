// #183 — exercise the shipped stall configuration path, not a reimplementation of it.
// The panel source is a browser extension module with ComfyUI-only dependencies, so the
// tests lift the exact small production functions and payload expressions out of that file.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RENDER_STALL_SECONDS,
  RENDER_STALL_SECONDS_MAX,
  RENDER_STALL_SECONDS_MIN,
  normalizeRenderStallSeconds,
} from "../../web/js/lib/render-stall-config.js";

const PANEL = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing shipped function ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if ((c === "/" && next === "/")) {
      lineComment = true;
      i += 1;
      continue;
    }
    if ((c === "/" && next === "*")) {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated shipped function ${signature}`);
}

const stallSettingSource = extractFunction(PANEL, "function stallSettingSeconds() {");
const sendStallConfigSource = extractFunction(PANEL, "function sendStallConfig() {");

function shippedStallSetting(getSetting) {
  const factory = new Function(
    "getSetting",
    "normalizeRenderStallSeconds",
    `const SETTING_STALL_S = "comfyui-mcp.stallWarningSeconds";\n${stallSettingSource}\nreturn stallSettingSeconds;`,
  );
  return factory(getSetting, normalizeRenderStallSeconds)();
}

test("#183 normalization preserves the user range and uses the long-node-safe default", () => {
  assert.equal(DEFAULT_RENDER_STALL_SECONDS, 600);
  assert.equal(RENDER_STALL_SECONDS_MIN, 15);
  assert.equal(RENDER_STALL_SECONDS_MAX, 3600);
  assert.equal(normalizeRenderStallSeconds(undefined), DEFAULT_RENDER_STALL_SECONDS);
  assert.equal(normalizeRenderStallSeconds("not-a-number"), DEFAULT_RENDER_STALL_SECONDS);
  assert.equal(normalizeRenderStallSeconds(0), DEFAULT_RENDER_STALL_SECONDS);
  assert.equal(normalizeRenderStallSeconds(14), RENDER_STALL_SECONDS_MIN);
  assert.equal(normalizeRenderStallSeconds(17.6), 18);
  assert.equal(normalizeRenderStallSeconds(9999), RENDER_STALL_SECONDS_MAX);
});

test("#183 the shipped setting reader returns the default and reads the persisted setting", () => {
  const seen = [];
  const unset = shippedStallSetting((id) => {
    seen.push(id);
    return undefined;
  });
  assert.equal(unset, DEFAULT_RENDER_STALL_SECONDS);
  assert.deepEqual(seen, ["comfyui-mcp.stallWarningSeconds"]);

  assert.equal(shippedStallSetting(() => 900), 900);
  assert.equal(shippedStallSetting(() => 1), RENDER_STALL_SECONDS_MIN);
  assert.equal(shippedStallSetting(() => 99999), RENDER_STALL_SECONDS_MAX);
});

test("#183 the setting row advertises and registers the same default/range", () => {
  const start = PANEL.indexOf("id: SETTING_STALL_S");
  const end = PANEL.indexOf("\n    },", start);
  assert.ok(start >= 0 && end > start, "the render-stall setting row must exist");
  const row = PANEL.slice(start, end);
  assert.match(row, /Default 600s/);
  assert.match(row, /attrs: \{ min: RENDER_STALL_SECONDS_MIN, max: RENDER_STALL_SECONDS_MAX, step: 5 \}/);
  assert.match(row, /defaultValue: DEFAULT_RENDER_STALL_SECONDS/);
});

test("#183 the shipped live bridge sender carries the normalized threshold", () => {
  const factory = new Function(
    "client",
    "stallSettingSeconds",
    `${sendStallConfigSource}\nreturn sendStallConfig;`,
  );
  const disconnected = { isConnected: () => false, sendFrame: () => assert.fail("must not send while disconnected") };
  factory(disconnected, () => DEFAULT_RENDER_STALL_SECONDS)();

  const frames = [];
  const connected = { isConnected: () => true, sendFrame: (frame) => frames.push(frame) };
  factory(connected, () => 900)();
  assert.deepEqual(frames, [{ type: "set_config", stall_seconds: 900 }]);
});

test("#183 every production /connect payload carries the long-node-safe default", () => {
  const expressions = [...PANEL.matchAll(
    /body: JSON\.stringify\((\{[^\n]*stall_seconds: stallSettingSeconds\(\)[^\n]*\})\),/g,
  )].map((match) => match[1]);
  assert.equal(expressions.length, 3, "auto-reclaim, forced-reclaim, and regular connect must all be covered");

  for (const expression of expressions) {
    const payload = new Function(
      "selectedBackend",
      "stallSettingSeconds",
      "remoteUrlSetting",
      `return ${expression};`,
    )("codex", () => DEFAULT_RENDER_STALL_SECONDS, () => "");
    assert.equal(payload.backend, "codex");
    assert.equal(payload.stall_seconds, DEFAULT_RENDER_STALL_SECONDS);
  }
});
