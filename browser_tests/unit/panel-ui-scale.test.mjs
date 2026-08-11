import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The REAL clamp, not a copy of it. An earlier version of this file
// reimplemented the arithmetic and therefore tested itself: mutating the
// panel's own `Number.isFinite` guard changed nothing here. Extracting it to a
// module is what makes these assertions mean something.
import {
  panelUiScaleFraction,
  PANEL_UI_SCALE_MIN,
  PANEL_UI_SCALE_MAX,
} from "../../web/js/lib/ui-scale.js";

// #753 — the sidebar had no way to make its text bigger, and the workaround a
// user would reach for does not work: `.cmcp-root` sets `font-size: 0.8125rem`,
// but the inner rules are `rem`, which resolve against the PAGE root rather
// than the panel. Overriding `.cmcp-root { font-size }` therefore moves only the
// few elements that inherit; every rem-sized label stays exactly as it was.
//
// The setting scales the panel with `zoom`, which is the one lever that moves
// all of it at once. These pin the parts that are easy to get quietly wrong: the
// clamp, the height compensation that keeps a zoomed panel inside its parent,
// and the fact that the scale is applied at MOUNT and not only on change.

const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

// ── the clamp ──────────────────────────────────────────────────────────────

test("100% is 1 — the default changes nothing", () => {
  assert.equal(panelUiScaleFraction(100), 1);
});

test("a value in range scales proportionally", () => {
  assert.equal(panelUiScaleFraction(150), 1.5);
  assert.equal(panelUiScaleFraction(250), 2.5);
});

test("out-of-range values are clamped, never applied raw", () => {
  // A stored value from an older/edited settings file must not be able to leave
  // the panel microscopic or off-screen.
  assert.equal(panelUiScaleFraction(0), 1);
  assert.equal(panelUiScaleFraction(-500), 1);
  assert.equal(panelUiScaleFraction(10_000), 2.5);
});

test("an unreadable value reads as 100%, not as zero", () => {
  // `Number(null)` is 0 and `Number([])` is 0 — a clamp that trusted Number()
  // alone would collapse the panel for a corrupt setting rather than ignore it.
  for (const raw of [undefined, null, "", "abc", NaN, {}, [], () => {}]) {
    assert.equal(panelUiScaleFraction(raw), 1, `raw ${String(raw)}`);
  }
});

// ── the height, which needs NO compensation ───────────────────────

test("the root keeps a plain 100% height — dividing by the scale is the bug", () => {
  // Measured in Chrome, both ways: a percentage height inside a zoomed element
  // ALREADY resolves against the parent in the zoomed coordinate space. The
  // `calc(100% / scale)` that shipped first applied that correction a second
  // time — at 175% a 619px parent gave a 202px root — and left the composer
  // stranded mid-panel above a band of empty space.
  // No slicing and no escapes: assert on the exact rule text. Anchoring by
  // indexOf found the COMMENT that quotes this selector, and an escaped newline
  // did not survive being generated.
  assert.ok(
    PANEL.includes("display: flex; flex-direction: column; height: 100%; min-height: 0;"),
    "the root must keep a plain 100% height",
  );
  assert.ok(
    !PANEL.includes("calc(100% / var(--cmcp-ui-scale"),
    "the scale division must not come back",
  );
});

test("nothing writes the --cmcp-ui-scale variable any more", () => {
  // It existed only to feed that calc. Leaving it behind would invite someone to
  // reintroduce the division it was for.
  assert.ok(!PANEL.includes("--cmcp-ui-scale"), "the variable and its calc go together");
});

test("the zoom is still what does the scaling", () => {
  const fn = PANEL.slice(
    PANEL.indexOf("function applyPanelUiScale(raw, target) {"),
    PANEL.indexOf("function getSetting(id)"),
  );
  assert.ok(fn.length > 0);
  assert.ok(fn.includes("root.style.zoom = String(scale)"), "zoom is what scales the panel");
});
test("a scale of exactly 1 clears the zoom rather than writing a no-op", () => {
  const fn = PANEL.slice(
    PANEL.indexOf("function applyPanelUiScale(raw, target) {"),
    PANEL.indexOf("function getSetting(id)"),
  );
  assert.match(fn, /if \(scale === 1\) root\.style\.removeProperty\("zoom"\)/);
});

test("a frontend that refuses the style write does not break the panel", () => {
  const fn = PANEL.slice(
    PANEL.indexOf("function applyPanelUiScale(raw, target) {"),
    PANEL.indexOf("function getSetting(id)"),
  );
  assert.match(fn, /try \{[\s\S]*\} catch \{/);
});

// ── the wiring ─────────────────────────────────────────────────────────────

test("the scale is applied when a panel MOUNTS, not only when the slider moves", () => {
  // A saved scale has to reach a panel that mounts later — a reload, or a
  // workflow switch that re-mounts the sidebar. Applying it only in onChange
  // would make the setting appear to forget itself on every reload.
  const build = PANEL.slice(PANEL.indexOf("function buildPanel() {"), PANEL.indexOf("function buildPanel() {") + 1200);
  // …and it must pass the ROOT (codex): buildPanel creates the element and mounts
  // it later, so a document query at that moment finds every panel except the one
  // being built, and the saved scale would apply to nothing.
  assert.ok(
    build.includes("applyPanelUiScale(getSetting(SETTING_UI_SCALE), root)"),
    "the mount-time apply must target the freshly built, still-detached root",
  );
});

test("the panel uses the shared clamp rather than its own arithmetic", () => {
  assert.ok(PANEL.includes("panelUiScaleFraction(raw)"), "the panel must call the shared clamp");
  // A substring, not a regex: a path contains `/`, and generating a regex
  // literal for it is how this line broke in the first place.
  assert.ok(PANEL.includes('from "./lib/ui-scale.js"'), "the panel must import the shared module");
  assert.ok(PANEL_UI_SCALE_MIN === 100 && PANEL_UI_SCALE_MAX === 250);
});

test("the setting is registered with the panel's own id namespace and range", () => {
  assert.match(PANEL, /const SETTING_UI_SCALE = "comfyui-mcp\.uiScale";/);
  assert.match(PANEL, /id: SETTING_UI_SCALE/);
  assert.match(PANEL, /attrs: \{ min: PANEL_UI_SCALE_MIN, max: PANEL_UI_SCALE_MAX, step: 5 \}/);
  assert.match(PANEL, /defaultValue: 100/);
});

test("onChange applies immediately and is NOT gated on settingsArmed", () => {
  // The armed gate exists for settings that SEED the panel's runtime, so a
  // hydration pass cannot re-seed them. This one writes nothing but CSS, and a
  // user dragging the slider expects the panel to move while they drag.
  const entry = PANEL.slice(PANEL.indexOf("id: SETTING_UI_SCALE"), PANEL.indexOf("id: SETTING_STALL_S"));
  assert.match(entry, /onChange: \(value\) => \{[\s\S]*applyPanelUiScale\(value\)/);
  // The GUARD, not the word: the comment above the handler explains why the
  // guard is absent, so matching the identifier would fail on the explanation.
  // A plain substring, NOT a regex: the guard text contains `(` and `||`, which
  // are regex syntax — an unescaped version of this assertion parses as an
  // alternation, matches nothing, and can never fail.
  assert.ok(
    !entry.includes("if (suppressSettingOnChange || !settingsArmed) return;"),
    "the UI-scale handler must not be gated on settingsArmed",
  );
});

test("the tooltip names the knob that now DOES work, and what it does not cover", () => {
  // The original confusion was that the obvious fix silently did nothing, and the
  // tooltip existed to say so. #753 removed the trap: every inner font size is
  // calc(var(--cmcp-fs) * k), so there is a working knob to name instead of a dead end
  // to warn about. The warning must not survive the thing it warned about — a tooltip
  // that still says overrides do not work is now the misleading one.
  const entry = PANEL.slice(PANEL.indexOf("id: SETTING_UI_SCALE"), PANEL.indexOf("id: SETTING_STALL_S"));
  assert.match(entry, /--cmcp-fs/, "names the variable");
  assert.match(entry, /0\.8125rem/, "and its default, so a user can compute a target");
  assert.ok(
    !/does NOT \?" \+/.test(entry) && !/most text ignores it/.test(entry),
    "the retracted claim that overrides cannot work is gone",
  );
  // It scales TEXT. Spacing is still rem on purpose, and saying otherwise would have
  // users expect a denser panel that never arrives.
  assert.match(entry, /does not scale spacing, icons, or/);
  // ...and the fixed-pixel elements. A tooltip promising "every panel font size" would be
  // wrong: a training caption and a few rules carry literal px (codex).
  assert.match(entry, /fixed pixel size/);
  assert.ok(!/scales every panel font/.test(entry), "no absolute claim");
});
