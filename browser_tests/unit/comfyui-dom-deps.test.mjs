// panel#779 — every reach into ComfyUI's OWN DOM must be declared.
//
// ComfyUI 1.50 moved a sidebar tab's id from a CSS class to `data-testid`. The
// panel read that class in two places: one blanked the panel for a new user
// (#784), the other only degraded so nobody noticed (#786). Both were found by
// hand afterwards, by diffing two frontend bundles. That is luck, not a process.
//
// This gate makes the surface finite and attributed, so "check our DOM
// assumptions against the new frontend" becomes a task someone can complete.
// It cannot tell you a selector STOPPED MATCHING — only a real frontend can —
// but it can stop the list from growing silently.

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import {
  COMFYUI_DOM_DEPS,
  VERIFIED_FRONTENDS,
  declaredSelectors,
} from "../../web/js/lib/comfyui-dom-deps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_JS = join(HERE, "../../web/js");

const DOM_API = /(?:querySelector|querySelectorAll|closest|matches)\(\s*(['"`])(.*?)\1/g;

/**
 * Does this selector target markup we do NOT own?
 *
 * A class or id reference that is not cmcp-namespaced. Bare tag selectors
 * (`audio`, `pre`, `button`) are excluded because we only ever run those inside
 * our own root, and `[data-…]` hooks are ours by construction — including them
 * would bury the ten that matter under forty that do not.
 */
function isForeignSelector(sel) {
  if (sel.includes("cmcp")) return false;
  return /(^|[\s,>+~(])[.#][A-Za-z_-]/.test(sel) || /\[(class|id)[*~^$|]?=/.test(sel);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "vendor") continue; // third-party bundles are not ours to declare
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

function scanForeign() {
  const found = new Map();
  for (const file of walk(WEB_JS)) {
    const rel = relative(join(HERE, "../.."), file).split(sep).join("/");
    const text = readFileSync(file, "utf8");
    DOM_API.lastIndex = 0;
    let m;
    while ((m = DOM_API.exec(text))) {
      const sel = m[2];
      if (!isForeignSelector(sel)) continue;
      if (!found.has(sel)) found.set(sel, new Set());
      found.get(sel).add(rel);
    }
  }
  return found;
}

test("#779 the scan finds a surface at all", () => {
  // Guards the gate itself: if the pattern stopped matching, every assertion
  // below would pass vacuously on an empty set.
  const found = scanForeign();
  assert.ok(found.size >= 8, `expected the known ComfyUI DOM surface, got ${found.size}`);
});

test("#779 every ComfyUI selector the panel uses is DECLARED", () => {
  const declared = declaredSelectors();
  const found = scanForeign();
  const undeclared = [...found.entries()]
    .filter(([sel]) => !declared.has(sel))
    .map(([sel, files]) => `${JSON.stringify(sel)}  (${[...files].sort()[0]})`);
  assert.deepEqual(
    undeclared,
    [],
    "these reach into ComfyUI's DOM without being declared in " +
      "web/js/lib/comfyui-dom-deps.js. Add each with what it is for, its fallback, " +
      "and the frontend versions you CHECKED it against:\n" +
      undeclared.join("\n"),
  );
});

test("#779 the registry has no entries the panel no longer uses", () => {
  // A stale entry is worse than a missing one: it makes the surface look larger
  // than it is, and the next reviewer wastes time checking dead selectors.
  const found = scanForeign();
  const stale = [...declaredSelectors()].filter((s) => !found.has(s));
  assert.deepEqual(stale, [], `declared but unused — delete these:\n${stale.join("\n")}`);
});

test("#779 every entry says what it is FOR and what it was checked against", () => {
  // "verified" records versions someone actually grepped the bundle for. An
  // entry without one is a guess wearing a registry's clothes.
  for (const d of COMFYUI_DOM_DEPS) {
    assert.ok(d.why && d.why.split(/\s+/).length >= 6, `${d.selector}: needs a real reason`);
    assert.ok(Array.isArray(d.verified) && d.verified.length > 0, `${d.selector}: no verified versions`);
    for (const v of d.verified) {
      assert.match(v, /^\d+\.\d+\.\d+$/, `${d.selector}: "${v}" is not a frontend version`);
    }
  }
});

test("#779 the selector that caused the outage is declared WITH its history", () => {
  // The one that moved. Its entry has to carry why data-testid is tried first,
  // or the next person "simplifies" it back to a class lookup.
  const cls = COMFYUI_DOM_DEPS.find((d) => d.selector.includes("class~="));
  assert.ok(cls, "the <=1.49 class form must be declared");
  assert.match(cls.why, /1\.50/, "…and must say what 1.50 changed");
  assert.match(cls.why, /data-testid/);
});

test("#779 VERIFIED_FRONTENDS spans both sides of the break", () => {
  // 1.47.12 works, 1.50.3 was the outage. A registry checked against only one of
  // them proves nothing about skew, which is the whole reason it exists.
  assert.ok(VERIFIED_FRONTENDS.includes("1.47.12"));
  assert.ok(VERIFIED_FRONTENDS.includes("1.50.3"));
});
