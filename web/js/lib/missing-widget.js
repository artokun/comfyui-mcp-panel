/**
 * #1956 — the missing-widget refusal must be a route, not a dead end.
 *
 * Two misdirections showed up on rgthree Fast Groups Bypasser:
 *   1. `matchTitle` is a LiteGraph PROPERTY, not a widget. The refusal listed
 *      duplicate toggle-row names and appended the #757 pressable-widget hint
 *      ("ask the user to click"), which sent the agent to bother the user instead
 *      of `panel_set_property`.
 *   2. Fast Groups names every group-toggle row `RGTHREE_TOGGLE_AND_NAV`, so the
 *      available-list repeated the same name.
 *
 * The refusal itself is unchanged (still fail-closed). This only names the
 * documented property route when the requested name is a property, and lists
 * each widget name once.
 */
import { pressableWidgetHint } from "./pressable-widget.js";

const RGTHREE_FAST_GROUPS_TYPES = new Set([
  "Fast Groups Bypasser (rgthree)",
  "Fast Groups Muter (rgthree)",
]);

export const RGTHREE_FAST_GROUPS_PROPERTY_NAMES = [
  "matchTitle",
  "matchColors",
  "sort",
  "toggleRestriction",
];

const FAST_GROUPS_PROPERTY_SET = new Set(RGTHREE_FAST_GROUPS_PROPERTY_NAMES);

function nodeType(node) {
  try {
    const t = node?.type ?? node?.comfyClass;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

/** True when `name` is a property on this node, not a widget. */
export function isNodePropertyName(node, name) {
  if (typeof name !== "string" || !name) return false;
  if (RGTHREE_FAST_GROUPS_TYPES.has(nodeType(node)) && FAST_GROUPS_PROPERTY_SET.has(name)) {
    return true;
  }
  let props;
  try {
    props = node?.properties;
  } catch {
    return false;
  }
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;
  try {
    return Object.prototype.hasOwnProperty.call(props, name);
  } catch {
    return false;
  }
}

/** Widget names in draw order, each name once. */
export function uniqueWidgetNames(widgets) {
  const seen = new Set();
  const names = [];
  for (const w of Array.isArray(widgets) ? widgets : []) {
    let n;
    try {
      n = w?.name;
    } catch {
      continue;
    }
    if (typeof n !== "string" || !n || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  return names;
}

function propertyRouteHint(node, widgetName) {
  const fastGroups = FAST_GROUPS_PROPERTY_SET.has(widgetName) || RGTHREE_FAST_GROUPS_TYPES.has(nodeType(node));
  const known = RGTHREE_FAST_GROUPS_PROPERTY_NAMES.join("/");
  return (
    ` "${widgetName}" is a node PROPERTY, not a widget — set it with panel_set_property` +
    ` (name: "${widgetName}"), not panel_set_widget.` +
    (fastGroups
      ? ` On rgthree Fast Groups Bypasser/Muter, ${known} are properties.`
      : "")
  );
}

/**
 * The missing-widget refusal text. Fail-closed: the caller still throws.
 *
 * @param {object} node
 * @param {string} widgetName
 */
export function missingWidgetMessage(node, widgetName) {
  const names = uniqueWidgetNames(node?.widgets);
  const available = names.join(", ") || "none";
  const head =
    `Node ${node?.id} (${node?.type}) has no widget "${widgetName}" (available: ${available}).`;
  if (isNodePropertyName(node, widgetName)) return head + propertyRouteHint(node, widgetName);
  return head + pressableWidgetHint(node, widgetName);
}
