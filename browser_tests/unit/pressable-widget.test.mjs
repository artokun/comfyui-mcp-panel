// panel#757 — a widget missing because a BUTTON has not been pressed must say so.
//
// `panel_set_widget(node, "lora_1", …)` on a freshly added Power Lora Loader
// (rgthree) refused with a bare availability list. `➕ Add Lora` was sitting in
// that list — it is the button that CREATES the slots — but nothing said so, and
// the reporter's agent inferred a typo and fell back to chaining
// `LoraLoaderModelOnly` nodes, losing the stacking UI the user asked for.
//
// The refusal itself is correct and unchanged. This only adds what the message
// already had the evidence to say.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isPressableWidget,
  pressableWidgets,
  pressableWidgetHint,
} from "../../web/js/lib/pressable-widget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const WIDGET_WRITE = join(HERE, "../../web/js/lib/widget-write.js");

/**
 * Modelled on the REAL class, read out of the installed pack:
 * rgthree-comfy/web/comfyui/utils_widgets.js — `RgthreeBetterButtonWidget`
 * sets `this.type = "custom"`, `this.value = ""`, and defines `onMouseClick`.
 *
 * The `type` is the whole reason this test exists. See the type test below.
 */
function rgthreeAddLoraButton() {
  return {
    name: "➕ Add Lora",
    label: "➕ Add Lora",
    type: "custom",
    value: "",
    onMouseClick() {},
    mouseClickCallback() {},
  };
}

/** A freshly added Power Lora Loader, exactly as the report describes it. */
function freshPowerLoraLoader() {
  return {
    id: 153,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      { name: "divider", type: "custom", value: "" },
      { name: "PowerLoraLoaderHeaderWidget", type: "custom", value: "" },
      { name: "divider", type: "custom", value: "" },
      rgthreeAddLoraButton(),
    ],
  };
}

test("#757 rgthree's button is type 'custom', NOT 'button'", () => {
  // The obvious check — `w.type === "button"` — is what the rest of this codebase
  // uses and would NEVER have fired on the node this report is about. Pinning the
  // real value so nobody 'simplifies' the detection back to a type check.
  assert.equal(rgthreeAddLoraButton().type, "custom");
  assert.ok(isPressableWidget(rgthreeAddLoraButton()), "must be detected anyway");
});

test("#757 pressable means it HANDLES A CLICK, not that it is named like one", () => {
  assert.ok(isPressableWidget({ onMouseClick() {} }));
  assert.ok(isPressableWidget({ mouseClickCallback() {} }));
  assert.ok(isPressableWidget({ type: "button" }), "litegraph's canonical button");
});

test("#757 a real widget that merely SOUNDS like a button is not one", () => {
  // "Add Noise" is a genuine boolean on several samplers. A name-matching
  // detector would tell the user to click it, which is worse than saying nothing.
  assert.equal(isPressableWidget({ name: "Add Noise", type: "toggle", value: true }), false);
  assert.equal(isPressableWidget({ name: "➕ Add Lora", type: "combo", value: "x" }), false);
  assert.equal(isPressableWidget(null), false);
  assert.equal(isPressableWidget("not an object"), false);
  assert.equal(isPressableWidget({}), false);
});

test("#757 the hint is EMPTY for an ordinary typo", () => {
  // The single most important assertion here. Appending a button hypothesis to
  // every missing-widget refusal would make the common case noisier and slightly
  // misleading — that is the stated reason this was not bolted on at triage.
  const plainNode = {
    id: 7,
    type: "KSampler",
    widgets: [
      { name: "seed", type: "number", value: 1 },
      { name: "steps", type: "number", value: 20 },
    ],
  };
  assert.equal(pressableWidgetHint(plainNode, "stepss"), "");
  assert.equal(pressableWidgetHint({ id: 1, type: "X", widgets: [] }, "a"), "");
  assert.equal(pressableWidgetHint({ id: 1, type: "X" }, "a"), "");
});

test("#757 the hint NAMES the button and says the panel cannot press it", () => {
  const hint = pressableWidgetHint(freshPowerLoraLoader(), "lora_1");
  assert.match(hint, /➕ Add Lora/);
  assert.match(hint, /cannot activate/);
  assert.match(hint, /ask the user to click/i);
});

test("#757 the hint does not PROMISE that clicking creates the slot", () => {
  // This code cannot know that "lora_1" is one of the widgets that button builds
  // — the caller may still have made a typo on a node that happens to have a
  // button. The wording has to survive being wrong about that.
  const hint = pressableWidgetHint(freshPowerLoraLoader(), "lora_1");
  assert.match(hint, /If "lora_1" is a slot of that kind/);
  assert.doesNotMatch(hint, /will create|creates the widget you asked for/i);
});

test("#757 it says the missing capability out loud", () => {
  // Otherwise the next reasonable move is to hunt for a press tool that does not
  // exist, which is its own dead end.
  assert.match(pressableWidgetHint(freshPowerLoraLoader(), "lora_1"), /no tool to press a widget/i);
});

test("#757 several buttons read as plural, and all are named", () => {
  const node = {
    id: 9,
    type: "Some Grower",
    widgets: [rgthreeAddLoraButton(), { name: "Reset", type: "button", value: "" }],
  };
  const hint = pressableWidgetHint(node, "any_02");
  assert.match(hint, /controls the panel cannot activate/);
  assert.match(hint, /➕ Add Lora/);
  assert.match(hint, /"Reset"/);
  assert.equal(pressableWidgets(node).length, 2);
});

test("#757 WIRING: both missing-widget refusals carry the hint", () => {
  // A pure helper nobody calls is not a fix. Two distinct refusal sites exist and
  // the report's exact text came from the widget-write one.
  const ww = readFileSync(WIDGET_WRITE, "utf8");
  assert.match(ww, /import \{ pressableWidgetHint \} from "\.\/pressable-widget\.js"/);
  assert.ok(
    /has no widget "\$\{widgetName\}"[\s\S]{0,400}?pressableWidgetHint\(targetNode, widgetName\)/.test(ww),
    "widget-write.js refusal must append the hint",
  );

  const panel = readFileSync(PANEL_JS, "utf8");
  assert.match(panel, /import \{ pressableWidgetHint \} from "\.\/lib\/pressable-widget\.js"/);
  assert.ok(
    /has no widget "\$\{widget\}"[\s\S]{0,400}?pressableWidgetHint\(node, widget\)/.test(panel),
    "comfyui-mcp-panel.js refusal must append the hint",
  );
});
