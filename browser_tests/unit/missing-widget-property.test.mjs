/**
 * #1956 — panel_set_widget on an rgthree Fast Groups PROPERTY must name
 * panel_set_property, not a pressable-widget dead end, and must not duplicate
 * the available-widget name.
 *
 * The refusal itself is correct (matchTitle is not a widget). The defect was
 * the guidance: "ask the user to click" + `RGTHREE_TOGGLE_AND_NAV` listed twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";
import { missingWidgetMessage, uniqueWidgetNames } from "../../web/js/lib/missing-widget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_WRITE = join(HERE, "../../web/js/lib/widget-write.js");
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const HOOKS = {};
const BYPASSER = "Fast Groups Bypasser (rgthree)";
const MUTER = "Fast Groups Muter (rgthree)";

function fastGroupsNode({ type = BYPASSER, extraWidgets = [] } = {}) {
  return {
    id: 12,
    type,
    properties: { matchTitle: "", matchColors: "", sort: "position", toggleRestriction: "default" },
    widgets: [
      { name: "RGTHREE_TOGGLE_AND_NAV", type: "custom", value: "", onMouseClick() {} },
      { name: "RGTHREE_TOGGLE_AND_NAV", type: "custom", value: "", onMouseClick() {} },
      ...extraWidgets,
    ],
  };
}

function assertPropertyRoute(err, widgetName) {
  assert.ok(err instanceof WidgetWriteError);
  assert.match(err.message, new RegExp(`has no widget "${widgetName}"`));
  assert.match(err.message, /panel_set_property/);
  assert.match(err.message, /PROPERTY/i);
  assert.match(err.message, /matchTitle\/matchColors\/sort\/toggleRestriction/);
  assert.doesNotMatch(err.message, /ask the user to click/i);
  assert.doesNotMatch(err.message, /no tool to press a widget/i);
  assert.doesNotMatch(err.message, /RGTHREE_TOGGLE_AND_NAV, RGTHREE_TOGGLE_AND_NAV/);
  const available = err.message.match(/available: ([^)]*)/);
  assert.ok(available, "must still list available widgets");
  const names = available[1].split(", ").filter(Boolean);
  assert.equal(names.filter((n) => n === "RGTHREE_TOGGLE_AND_NAV").length, 1);
  return true;
}

test("#1956 uniqueWidgetNames lists a repeated Fast Groups row once", () => {
  assert.deepEqual(uniqueWidgetNames(fastGroupsNode().widgets), ["RGTHREE_TOGGLE_AND_NAV"]);
});

test("#1956 set_widget on Fast Groups matchTitle points at panel_set_property", () => {
  assert.throws(
    () => applyWidgetWrite(fastGroupsNode(), "matchTitle", "Loaders", HOOKS),
    (err) => assertPropertyRoute(err, "matchTitle"),
  );
});

for (const name of ["matchColors", "sort", "toggleRestriction"]) {
  test(`#1956 set_widget on Fast Groups ${name} points at panel_set_property`, () => {
    assert.throws(
      () => applyWidgetWrite(fastGroupsNode(), name, "x", HOOKS),
      (err) => assertPropertyRoute(err, name),
    );
  });
}

test("#1956 Fast Groups Muter matchTitle is the same property route", () => {
  assert.throws(
    () => applyWidgetWrite(fastGroupsNode({ type: MUTER }), "matchTitle", "Loaders", HOOKS),
    (err) => assertPropertyRoute(err, "matchTitle"),
  );
});

test("#1956 Fast Groups known properties route even without a properties bag", () => {
  const node = { id: 3, type: BYPASSER, widgets: [{ name: "RGTHREE_TOGGLE_AND_NAV", onMouseClick() {} }] };
  const msg = missingWidgetMessage(node, "matchTitle");
  assert.match(msg, /panel_set_property/);
  assert.doesNotMatch(msg, /ask the user to click/i);
});

test("#1956 a genuine typo on Fast Groups still gets the pressable hint, not a property route", () => {
  const msg = missingWidgetMessage(fastGroupsNode(), "matchTittle");
  assert.doesNotMatch(msg, /panel_set_property/);
  assert.match(msg, /cannot activate|no widget "matchTittle"/);
});

test("#1956 a property on an ordinary node still names panel_set_property", () => {
  const node = {
    id: 8,
    type: "KSampler",
    properties: { promptState: "" },
    widgets: [{ name: "seed", type: "number", value: 1 }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "promptState", "x", HOOKS),
    (err) => {
      assert.match(err.message, /panel_set_property/);
      assert.doesNotMatch(err.message, /ask the user to click/i);
      return true;
    },
  );
});

test("#1956 a Power Lora Loader missing slot still gets the pressable hint", () => {
  const node = {
    id: 153,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "➕ Add Lora", type: "custom", value: "", onMouseClick() {} }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", "x.safetensors", HOOKS),
    (err) => {
      assert.match(err.message, /no tool to press a widget/i);
      assert.doesNotMatch(err.message, /panel_set_property/);
      return true;
    },
  );
});

test("#1956 WIRING: both missing-widget refusals use missingWidgetMessage", () => {
  const ww = readFileSync(WIDGET_WRITE, "utf8");
  assert.match(ww, /import \{ missingWidgetMessage \} from "\.\/missing-widget\.js"/);
  assert.match(ww, /missingWidgetMessage\(targetNode, widgetName\)/);

  const panel = readFileSync(PANEL_JS, "utf8");
  assert.match(panel, /import \{ missingWidgetMessage \} from "\.\/lib\/missing-widget\.js"/);
  assert.match(panel, /missingWidgetMessage\(node, widget\)/);
});
