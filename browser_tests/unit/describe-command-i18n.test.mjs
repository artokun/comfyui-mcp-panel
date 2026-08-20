/**
 * `describeCommand` — the activity-card summaries — in twelve languages.
 *
 * This function is the panel's REFERENCE IMPLEMENTATION for counted text, so what is
 * pinned here is the plural CONTRACT, not the individual wordings:
 *
 *   - English still renders exactly what it rendered before the strings were keyed, so a
 *     translated panel is not silently a reworded English one.
 *   - A one-form language (ko/ja/zh) gets its single form for EVERY number, and a
 *     four-form language (ru) gets the right one of the four. Neither is reachable from
 *     `n === 1 ? "" : "s"`, which is what these strings used to do.
 *   - And that hand-rolled form has not crept back in. That last check is on SOURCE text
 *     because it has to be: a re-introduced `${n === 1 ? "" : "s"}` renders perfect English,
 *     so every behavioural assertion an English-reading author would write stays green
 *     while nine languages read wrong. Verified by mutation — putting the ternary back into
 *     one case turns this test red.
 *
 * The real shipped function is extracted from the panel source and run against the real
 * `tr`, so this exercises the code the panel runs rather than a copy of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tr, __setCatalogForTest } from "../../web/js/lib/i18n.js";
import { graphErrorsFindingCounts, graphErrorsResultIsClean } from "../../web/js/lib/asset-staleness.js";

// Line endings are normalised because they are not the same on every checkout: git stores
// this file LF and hands Windows working trees CRLF, so an extraction anchored on "\n}\n"
// finds nothing there and the whole file fails at import with a misleading message.
const panelSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const start = panelSrc.indexOf("\nfunction describeCommand(cmd, msg, reply) {");
assert.notEqual(start, -1, "describeCommand must still exist in the panel source");
const end = panelSrc.indexOf("\n}\n", start);
assert.notEqual(end, -1, "could not find the end of describeCommand");
const describeCommandSrc = panelSrc.slice(start + 1, end + 2);

/** The real shipped describeCommand, wired to the real translator and the real helpers. */
const describeCommand = new Function(
  "tr",
  "graphErrorsFindingCounts",
  "graphErrorsResultIsClean",
  `"use strict";\n${describeCommandSrc}\nreturn describeCommand;`,
)(tr, graphErrorsFindingCounts, graphErrorsResultIsClean);

const say = (cmd, result) => describeCommand(cmd, {}, { ok: true, result }).text;

test("English is unchanged by being keyed — same words, both plural forms", () => {
  __setCatalogForTest("en", {});
  assert.equal(say("graph_get_state", { node_count: 1 }), "Read graph — 1 node");
  assert.equal(say("graph_get_state", { node_count: 4 }), "Read graph — 4 nodes");
  assert.equal(say("graph_clear", { cleared: 1 }), "Cleared canvas — removed 1 node (one Ctrl+Z restores all)");
  assert.equal(say("graph_clear", { cleared: 3 }), "Cleared canvas — removed 3 nodes (one Ctrl+Z restores all)");
  assert.equal(say("graph_find_nodes", { count: 5, total: 20, truncated: true }), "Found 5+ of 20 nodes");
  // #1310 — outline/query used to fall through to JSON.stringify(result), which
  // painted budget_overrun / groups_omitted in the activity card.
  assert.equal(say("graph_outline", { node_count: 12, degraded_reason: "raise max_chars" }), "Read graph — 12 nodes");
  assert.equal(say("graph_query", { total: 20, shown: 8, truncated: true, budget_overrun: "huge" }), "Found 8+ of 20 nodes");
  // Two independent counts in one sentence — nodes and columns pluralise separately.
  assert.equal(say("graph_auto_layout", { node_count: 1, columns: 1 }), "Auto-arranged 1 node (1 column)");
  assert.equal(say("graph_auto_layout", { node_count: 9, columns: 1 }), "Auto-arranged 9 nodes (1 column)");
  assert.equal(say("graph_auto_layout", { node_count: 1, columns: 4 }), "Auto-arranged 1 node (4 columns)");
});

test("a number that is not a count never selects a plural form", () => {
  // `{n}` on the batch multiplier, not `{count}` — a numeric `count` is what switches `tr`
  // into plural lookup, so a stray rename here would start silently picking forms.
  __setCatalogForTest("en", {});
  assert.equal(say("graph_run", { queued: true, batch_count: 4 }), "Queued workflow ×4");
  assert.equal(say("graph_screenshot", { width: 1024, height: 768 }), "Captured workflow image (1024×768)");
});

test("Korean gets its single form for every number", () => {
  // The exact case `n === 1 ? "" : "s"` cannot express: Korean has ONE plural category, so
  // a catalog that supplies only `_other` must serve 1 and 4 alike.
  __setCatalogForTest("ko", { panel: { read_graph_nodes_other: "그래프 읽음 — 노드 {count}개" } });
  assert.equal(say("graph_get_state", { node_count: 1 }), "그래프 읽음 — 노드 1개");
  assert.equal(say("graph_get_state", { node_count: 4 }), "그래프 읽음 — 노드 4개");
});

test("Russian gets the right one of its four forms", () => {
  __setCatalogForTest("ru", {
    panel: {
      read_graph_nodes_one: "Граф прочитан — {count} узел",
      read_graph_nodes_few: "Граф прочитан — {count} узла",
      read_graph_nodes_many: "Граф прочитан — {count} узлов",
      read_graph_nodes_other: "Граф прочитан — {count} узла",
    },
  });
  assert.equal(say("graph_get_state", { node_count: 1 }), "Граф прочитан — 1 узел");
  assert.equal(say("graph_get_state", { node_count: 3 }), "Граф прочитан — 3 узла");
  assert.equal(say("graph_get_state", { node_count: 5 }), "Граф прочитан — 5 узлов");
});

test("a count can drive the FORM without being rendered", () => {
  // The cleaned-slot line shows the slot NAMES, never the number — but the number is still
  // what decides "slot" vs "slots", which is only knowable to Intl.
  __setCatalogForTest("en", {});
  assert.equal(
    say("graph_remove_node", { removed: { type: "T", id: 3 }, cleaned_boundary_slots: { inputs: ["a"], outputs: [] } }),
    "Removed T (id 3) — cleaned orphaned boundary slot a",
  );
  assert.equal(
    say("graph_remove_node", { removed: { type: "T", id: 3 }, cleaned_boundary_slots: { inputs: ["a"], outputs: ["b"] } }),
    "Removed T (id 3) — cleaned orphaned boundary slots a, b",
  );
  assert.equal(
    say("graph_remove_node", { removed: [{ type: "T", id: 3 }, { type: "U", id: 8 }] }),
    "Removed 2 nodes (one Ctrl+Z restores all)",
  );
  assert.equal(
    say("graph_remove_node", {
      removed: [{ type: "T", id: 3 }],
      not_removed: [{ id: 8 }],
    }),
    "Removed T (id 3) — 1 still on the canvas",
  );
});

test("an untranslated locale degrades to correct English, never to a raw key", () => {
  __setCatalogForTest("ja", {});
  for (const [cmd, result] of [
    ["graph_get_state", { node_count: 2 }],
    ["graph_move_group", { group: { id: 1, title: "Outer" }, moved: { nodes: 0, groups: 0, reroutes: 0 } }],
    ["graph_get_errors", { errored_count: 0 }],
    ["free_vram", {}],
  ]) {
    const text = say(cmd, result);
    assert.doesNotMatch(text, /panel\./, `${cmd} leaked a translation key into the UI`);
    assert.ok(text.length > 0, `${cmd} rendered nothing`);
  }
  // A failed command still says which command failed, and passes the tool's own error
  // text through untranslated.
  const failed = describeCommand("graph_run", {}, { ok: false, error: "ECONNREFUSED" });
  assert.equal(failed.text, "graph_run failed");
  assert.equal(failed.detail, "ECONNREFUSED");
});

test("no hand-rolled English pluralisation survives in describeCommand", () => {
  // Comment lines are stripped first: the function's own header documents the banned
  // pattern by quoting it, and matching that would make the guard unfalsifiable.
  const code = describeCommandSrc
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /\?\s*""\s*:\s*"s"/, 'a `? "" : "s"` suffix hack is back');

  // Every `=== 1` ternary must pick between TRANSLATED calls, never between literals.
  //
  // Checking the shape of the branches rather than banning `=== 1` outright is deliberate,
  // in both directions. Too narrow (an earlier draft matched `=== 1 ? "`) and the original
  // graph_edit_node — `edited.length === 1 ? \`node ${…}\` : \`${…} nodes\`` — slips
  // straight back in, because it used BACKTICKS. Too broad (banning `=== 1` at all) and it
  // blocks the legitimate branch graph_edit_node needs today, where the two arms state
  // different FACTS, not different grammatical numbers. `tr(…) : tr(…)` cannot be the
  // defect by construction: the English lives in a fallback the catalog can override.
  // MUTATION-VERIFIED in both the double-quoted and the backtick shape.
  for (const m of code.matchAll(/[=!]==\s*1\s*\?\s*/g)) {
    const arm = code.slice(m.index + m[0].length, m.index + m[0].length + 500).trimStart();
    assert.ok(
      arm.startsWith("tr("),
      `an \`=== 1\` ternary picks a bare literal instead of a tr() call: …${code.slice(m.index - 60, m.index + 80)}…`,
    );
  }
  // And it must actually be translating: a version that simply deleted the counted text
  // would pass every check above.
  assert.ok(code.split("tr(").length - 1 >= 30, "describeCommand should route its prose through tr()");
});

test("a plural category is never used as a stand-in for 'exactly one'", () => {
  // `one` is a CLDR category, not the number 1: Russian routes 21/31/101 to it and Arabic
  // routes 2 to `two`. A summary whose `one:` form named a single node id (as an earlier
  // draft's did) therefore reported a 21-node batch as one edit of the first node, with the
  // other 20 dropped. The fix branches on the data, so Russian n=21 must still say 21.
  __setCatalogForTest("ru", {
    panel: {
      edited_one_node_presentation: "Изменено оформление узла {node_id}",
      edited_nodes_presentation_one: "Изменено оформление {count} узла",
      edited_nodes_presentation_few: "Изменено оформление {count} узлов",
      edited_nodes_presentation_many: "Изменено оформление {count} узлов",
      edited_nodes_presentation_other: "Изменено оформление {count} узла",
    },
  });
  const many = Array.from({ length: 21 }, (_, i) => ({ after: { node_id: i + 1 } }));
  assert.equal(say("graph_edit_node", { edited: many }), "Изменено оформление 21 узла");
  assert.equal(say("graph_edit_node", { edited: [{ after: { node_id: 7 } }] }), "Изменено оформление узла 7");

  // English is unchanged by the split.
  __setCatalogForTest("en", {});
  assert.equal(say("graph_edit_node", { edited: [{ after: { node_id: 7 } }] }), "Edited node 7 presentation");
  assert.equal(say("graph_edit_node", { edited: many }), "Edited 21 nodes presentation");
  assert.equal(say("graph_edit_node", { edited: [] }), "Edited 0 nodes presentation");
});

test("user data in a summary is never mistaken for a placeholder", () => {
  // These lines interpolate things the USER named — a group title, a widget value — into a
  // template that has other holes in it. Substituting one variable at a time expands any
  // placeholder that a value happens to contain, so a group actually titled "{id}" rendered
  // as `Created group “7” (id 7)`: the title silently replaced by an unrelated field.
  // ComfyUI's own dynamic-prompt syntax puts braces in widget values routinely.
  __setCatalogForTest("en", {});
  assert.equal(
    say("graph_create_group", { group: { title: "{id}", id: 7 } }),
    "Created group “{id}” (id 7)",
  );
  assert.equal(
    say("graph_set_widget", { set: { widget: "text", value: "a {node_id} b", node_id: 12, previous: null } }),
    'Set text = "a {node_id} b" on node 12',
  );
});

test("#1310 graph_query / the default do not dump the raw tool payload", () => {
  __setCatalogForTest("en", {});
  const query = describeCommand(
    "graph_query",
    {},
    { ok: true, result: { total: 4, shown: 4, budget_overrun: "max_chars", groups_omitted: 3 } },
  );
  assert.equal(query.detail, undefined);
  assert.doesNotMatch(String(query.text), /budget_overrun|groups_omitted|max_chars/);

  const fallback = describeCommand(
    "some_new_cmd",
    {},
    { ok: true, result: { budget_overrun: "secret", groups_omitted: 3 } },
  );
  assert.equal(fallback.detail, undefined);
  assert.equal(fallback.text, "some_new_cmd");
});

test("#1126: the summary discloses an unvalidated write, scoped to the widget it is about", () => {
  // Driven through the REAL extracted describeCommand, not matched in source: a wiring scan
  // cannot tell a live branch from a dead one, and this text is the only line most users
  // read about a write nothing compared to anything.
  __setCatalogForTest("en", {});
  const plain = say("graph_set_widget", { set: { widget: "model", value: "x.fbx", node_id: 4, previous: "" } });
  assert.equal(plain, 'Set model = "x.fbx" on node 4', "an ordinary write is unchanged");

  const unread = say("graph_set_widget", {
    option_list_unreadable: true,
    set: { widget: "model", value: "F:/x.fbx", node_id: 4, previous: "" },
  });
  assert.match(unread, /^Set model = "F:\/x\.fbx" on node 4/);
  assert.match(unread, /NOT validated/);
  // Scoped: the claim is about THIS widget's own list, which is the only list that went
  // unread. An unqualified "nothing checked the value" is false when a rail did.
  assert.match(unread, /this combo's own option list could not be read/);
});

test("#1126: a value the parent RAIL validated is NOT reported as wholly unchecked", () => {
  // The promoted case. The sibling cross-check compares the value against the rail's list
  // and proceeds only on membership, so "nothing checked the value" would be false in
  // precisely the case where the most checking happened.
  __setCatalogForTest("en", {});
  const railChecked = say("graph_set_widget", {
    option_list_unreadable: true,
    promoted_rail_validated: true,
    set: { widget: "model_alias", value: "b.fbx", node_id: 320, previous: "" },
  });
  assert.match(railChecked, /^Set model_alias = "b\.fbx" on node 320/);
  assert.match(railChecked, /this combo's own option list could not be read/);
  assert.match(railChecked, /checked against the parent subgraph rail's list/);
  // It must NOT keep asserting that nothing checked it.
  assert.doesNotMatch(railChecked, /nothing checked the value/);
  assert.doesNotMatch(railChecked, /NOT validated/);
});

// ------------------------------------------- #1492: the side effects it did NOT run

/** The reported reply shape: wrapper 1512, promoted BOOLEAN, inner status switch 2448. */
const skippedInnerCallback = (promotedExtra) => ({
  set: {
    widget: "enabled_3",
    value: false,
    node_id: 1512,
    previous: true,
    inner_previous: true,
    promoted_from: {
      subgraph_node_id: 1512,
      inner_node_id: 2448,
      parent_widget_synced: true,
      value_scope: "instance",
      ...promotedExtra,
    },
  },
});

test("#1492: a write that skipped the shared inner callback SAYS SO, with the warning icon", () => {
  // The card is the one line a user actually reads. Rendered as a plain "Set … " success,
  // it asserts the opposite of what happened: the value landed on this instance and the
  // inner switch that flips another node between ACTIVE and BYPASS never ran.
  __setCatalogForTest("en", {});
  const card = describeCommand(
    "graph_set_widget",
    {},
    {
      ok: true,
      result: skippedInnerCallback({
        inner_callback_not_invoked: true,
        inner_callback_note: "…the lib's long-form note, which the card does not print…",
      }),
    },
  );
  assert.match(card.text, /^Set enabled_3 = false on node 1512/);
  assert.match(card.text, /the shared inner node's own callback did NOT run/);
  assert.match(card.text, /may still be stale/);
  assert.equal(card.icon, "pi-exclamation-triangle", "a half-applied change must not read as a clean success");
});

test("#1492: an instance-scoped write that skipped NOTHING still renders the plain success line", () => {
  // The over-claim to avoid on the rendering side. Most instance-scoped promoted writes
  // skip nothing at all, and a warning triangle on every one of them is a warning nobody
  // reads by the time the real one arrives.
  __setCatalogForTest("en", {});
  const card = describeCommand("graph_set_widget", {}, { ok: true, result: skippedInnerCallback({}) });
  assert.equal(card.text, "Set enabled_3 = false on node 1512");
  assert.equal(card.icon, "pi-sliders-h");
});

test("#1492: the disclosure is TRANSLATED — it renders from the shipped catalog, not from English", () => {
  // A disclosure that only exists in English is a disclosure eleven of twelve panels do
  // not show. Driven from the REAL ja catalog on disk, so a key that was added to the
  // code and never shipped to the locales fails here rather than at a user's screen.
  const ja = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../locales/ja/main.json", import.meta.url)), "utf8"),
  ).comfyuiMcpPanel;
  const clause = ja.panel.set_widget_inner_callback_not_invoked;
  assert.ok(clause && clause.length > 0, "ja must ship the disclosure clause");
  __setCatalogForTest("ja", ja);
  const card = describeCommand(
    "graph_set_widget",
    {},
    { ok: true, result: skippedInnerCallback({ inner_callback_not_invoked: true }) },
  );
  assert.ok(card.text.includes(clause), "the ja card must render the ja clause");
  assert.doesNotMatch(card.text, /the shared inner node's own callback did NOT run/, "and not the English one");
  assert.doesNotMatch(card.text, /panel\./, "and never a raw key");
  __setCatalogForTest("en", {});
});
