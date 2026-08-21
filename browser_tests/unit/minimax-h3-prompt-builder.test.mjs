/**
 * #1549 — MiniMaxH3PromptBuilder's editor Save writes prompt_text and builder_state
 * together. Two panel_set_widget calls can split across a render fence. These tests
 * drive the shipped lib (the same function graph_set_widget returns) so a prompt_text
 * write cannot leave builder_state on the previous editor JSON.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MINIMAX_H3_PROMPT_BUILDER_TYPE,
  MINIMAX_H3_PROMPT_TEXT_WIDGET,
  MINIMAX_H3_BUILDER_STATE_WIDGET,
  MiniMaxH3PromptBuilderWriteError,
  isMiniMaxH3PromptBuilderNode,
  classifyMiniMaxH3PromptBuilderWrite,
  defaultMiniMaxH3BuilderState,
  normaliseMiniMaxH3BuilderState,
  generateMiniMaxH3Prompt,
  parseMiniMaxH3BuilderState,
  parseMiniMaxH3GeneratedPrompt,
  applyMiniMaxH3PromptBuilderWrite,
} from "../../web/js/lib/minimax-h3-prompt-builder.js";

const TYPE = MINIMAX_H3_PROMPT_BUILDER_TYPE;

function t2vaState(over = {}) {
  return normaliseMiniMaxH3BuilderState({
    version: 1,
    mode: "T2VA",
    imd: "a lantern swings over wet cobblestones",
    soundscape: "rain on stone, distant wheels",
    music: "low strings",
    ...over,
  });
}

function makeNode({
  id = 12,
  type = TYPE,
  prompt = "",
  state = defaultMiniMaxH3BuilderState(),
  omit = [],
} = {}) {
  const promptWidget = { name: MINIMAX_H3_PROMPT_TEXT_WIDGET, value: prompt };
  const stateWidget = {
    name: MINIMAX_H3_BUILDER_STATE_WIDGET,
    value: typeof state === "string" ? state : JSON.stringify(state),
  };
  const widgets = [];
  if (!omit.includes(MINIMAX_H3_PROMPT_TEXT_WIDGET)) widgets.push(promptWidget);
  if (!omit.includes(MINIMAX_H3_BUILDER_STATE_WIDGET)) widgets.push(stateWidget);
  widgets.push({ name: "Edit prompt…", value: null });
  const node = { id, type, widgets, _mmh3Draft: { dirty: true } };
  return { node, promptWidget, stateWidget };
}

function landedPrompt(node) {
  return node.widgets.find((w) => w.name === MINIMAX_H3_PROMPT_TEXT_WIDGET).value;
}

function landedState(node) {
  return parseMiniMaxH3BuilderState(
    node.widgets.find((w) => w.name === MINIMAX_H3_BUILDER_STATE_WIDGET).value,
  );
}

test("#1549: classify matches the two Save widgets on MiniMaxH3PromptBuilder only", () => {
  const { node } = makeNode();
  assert.equal(isMiniMaxH3PromptBuilderNode(node), true);
  assert.equal(isMiniMaxH3PromptBuilderNode({ comfyClass: TYPE, type: "virtual" }), true);
  assert.equal(classifyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_BUILDER_STATE_WIDGET), "master");
  assert.equal(classifyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_PROMPT_TEXT_WIDGET), "output");
  assert.equal(classifyMiniMaxH3PromptBuilderWrite(node, "prompt_text.0"), "output");
  assert.equal(classifyMiniMaxH3PromptBuilderWrite(node, "Edit prompt…"), null);
  assert.equal(classifyMiniMaxH3PromptBuilderWrite({ id: 1, type: "KSampler", widgets: node.widgets }, MINIMAX_H3_PROMPT_TEXT_WIDGET), null);
});

test("#1549: generate() of a T2VA state round-trips through the labeled parser", () => {
  const state = t2vaState();
  const prompt = generateMiniMaxH3Prompt(state);
  const parsed = parseMiniMaxH3GeneratedPrompt(prompt, defaultMiniMaxH3BuilderState());
  assert.ok(parsed, "labeled T2VA prompt must parse");
  assert.equal(generateMiniMaxH3Prompt(parsed), prompt);
  assert.equal(parsed.imd, state.imd);
  assert.equal(parsed.soundscape, state.soundscape);
  assert.equal(parsed.music, state.music);
});

test("#1549: writing builder_state also writes generate(state) onto prompt_text", () => {
  const oldState = t2vaState({ imd: "old scene" });
  const newState = t2vaState({ imd: "new scene", soundscape: "wind", music: "piano" });
  const { node, promptWidget, stateWidget } = makeNode({
    prompt: generateMiniMaxH3Prompt(oldState),
    state: oldState,
  });
  const order = [];
  const hooks = {
    beforeChange: () => order.push("before"),
    afterChange: () => order.push("after"),
    setDirty: () => order.push("dirty"),
  };
  const origPromptSet = Object.getOwnPropertyDescriptor(promptWidget, "value");
  const origStateSet = Object.getOwnPropertyDescriptor(stateWidget, "value");
  let promptVal = promptWidget.value;
  let stateVal = stateWidget.value;
  Object.defineProperty(promptWidget, "value", {
    get: () => promptVal,
    set(v) {
      order.push("prompt");
      promptVal = v;
    },
    configurable: true,
  });
  Object.defineProperty(stateWidget, "value", {
    get: () => stateVal,
    set(v) {
      order.push("state");
      stateVal = v;
    },
    configurable: true,
  });

  const result = applyMiniMaxH3PromptBuilderWrite(
    node,
    MINIMAX_H3_BUILDER_STATE_WIDGET,
    JSON.stringify(newState),
    hooks,
  );

  assert.equal(result instanceof Promise, false, "the pair is assigned synchronously — no await between widgets");
  assert.deepEqual(order, ["before", "prompt", "state", "after", "dirty"]);
  assert.equal(promptVal, generateMiniMaxH3Prompt(newState));
  assert.equal(generateMiniMaxH3Prompt(parseMiniMaxH3BuilderState(stateVal)), promptVal);
  assert.equal(node._mmh3Draft, null);
  assert.deepEqual(result.minimax_h3_prompt_builder.synced, [
    MINIMAX_H3_PROMPT_TEXT_WIDGET,
    MINIMAX_H3_BUILDER_STATE_WIDGET,
  ]);
  Object.defineProperty(promptWidget, "value", origPromptSet);
  Object.defineProperty(stateWidget, "value", origStateSet);
});

test("#1549 reporter: prompt_text write leaves builder_state consistent, not the old editor JSON", () => {
  const oldState = t2vaState({ imd: "old scene", soundscape: "rain", music: "piano" });
  const newState = t2vaState({ imd: "new scene", soundscape: "wind", music: "strings" });
  const oldPrompt = generateMiniMaxH3Prompt(oldState);
  const newPrompt = generateMiniMaxH3Prompt(newState);
  assert.notEqual(oldPrompt, newPrompt);

  const { node } = makeNode({ prompt: oldPrompt, state: oldState });
  applyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_PROMPT_TEXT_WIDGET, newPrompt);

  assert.equal(landedPrompt(node), newPrompt);
  const landed = landedState(node);
  assert.notEqual(landed.imd, oldState.imd, "editor state is not left on the previous scene");
  assert.equal(generateMiniMaxH3Prompt(landed), newPrompt);
});

test("#1549: prompt_text + companion builder_state writes both values in one envelope", () => {
  const oldState = t2vaState({ imd: "old" });
  const newState = t2vaState({ imd: "companion scene", soundscape: "hail", music: "N/A" });
  const newPrompt = generateMiniMaxH3Prompt(newState);
  const { node } = makeNode({ prompt: generateMiniMaxH3Prompt(oldState), state: oldState });

  applyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_PROMPT_TEXT_WIDGET, newPrompt, {
    builder_state: JSON.stringify(newState),
  });

  assert.equal(landedPrompt(node), newPrompt);
  const landed = landedState(node);
  assert.equal(landed.imd, newState.imd);
  assert.equal(landed.soundscape, newState.soundscape);
  assert.equal(JSON.stringify(landedState(node).off), JSON.stringify(normaliseMiniMaxH3BuilderState(newState).off));
});

test("#1549: a throwing second assignment restores the first — nothing stays half-written", () => {
  const oldState = t2vaState({ imd: "old" });
  const oldPrompt = generateMiniMaxH3Prompt(oldState);
  const { node, promptWidget, stateWidget } = makeNode({ prompt: oldPrompt, state: oldState });
  let currentState = stateWidget.value;
  Object.defineProperty(stateWidget, "value", {
    get: () => currentState,
    set(v) {
      if (v !== currentState) throw new Error("poisoned builder_state setter");
      currentState = v;
    },
    configurable: true,
  });
  const prevPrompt = promptWidget.value;
  assert.throws(
    () =>
      applyMiniMaxH3PromptBuilderWrite(
        node,
        MINIMAX_H3_BUILDER_STATE_WIDGET,
        JSON.stringify(t2vaState({ imd: "new" })),
      ),
    /poisoned builder_state setter/,
  );
  assert.equal(promptWidget.value, prevPrompt);
});

test("#1549: invalid builder_state JSON is refused before any undo step", () => {
  const oldState = t2vaState();
  const { node, promptWidget, stateWidget } = makeNode({
    prompt: generateMiniMaxH3Prompt(oldState),
    state: oldState,
  });
  let before = 0;
  assert.throws(
    () =>
      applyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_BUILDER_STATE_WIDGET, "not-json", {
        beforeChange: () => {
          before += 1;
        },
      }),
    MiniMaxH3PromptBuilderWriteError,
  );
  assert.equal(before, 0);
  assert.equal(promptWidget.value, generateMiniMaxH3Prompt(oldState));
  assert.equal(stateWidget.value, JSON.stringify(oldState));
});

test("#1549: a missing companion widget refuses and does not write the other", () => {
  const oldPrompt = "keep me";
  const { node, promptWidget } = makeNode({ prompt: oldPrompt, omit: [MINIMAX_H3_BUILDER_STATE_WIDGET] });
  assert.throws(
    () => applyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_PROMPT_TEXT_WIDGET, "new prompt"),
    /missing the widget/,
  );
  assert.equal(promptWidget.value, oldPrompt);
});

test("#1549: unstructured prompt_text still updates builder_state in the same envelope", () => {
  const oldState = t2vaState({ imd: "old scene" });
  const { node } = makeNode({ prompt: generateMiniMaxH3Prompt(oldState), state: oldState });
  const free = "a red fox walks through snow at dusk";
  applyMiniMaxH3PromptBuilderWrite(node, MINIMAX_H3_PROMPT_TEXT_WIDGET, free);
  assert.equal(landedPrompt(node), free);
  assert.equal(landedState(node).imd, free);
  assert.notEqual(landedState(node).imd, oldState.imd);
});

test("#1549: the route is WIRED into graph_set_widget, ahead of the generic write path", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    src,
    /import \{\s*classifyMiniMaxH3PromptBuilderWrite,\s*applyMiniMaxH3PromptBuilderWrite,\s*\} from "\.\/lib\/minimax-h3-prompt-builder\.js";/,
  );
  const handler = src.slice(src.indexOf("async graph_set_widget("));
  assert.ok(handler.startsWith("async graph_set_widget("), "graph_set_widget handler not found");
  const routeAt = handler.indexOf("classifyMiniMaxH3PromptBuilderWrite(node, widget)");
  const writeAt = handler.indexOf("await runSetWidget(");
  assert.ok(routeAt > 0, "the MiniMax route is not called from graph_set_widget");
  assert.ok(writeAt > 0, "runSetWidget call site not found in graph_set_widget");
  assert.ok(routeAt < writeAt, "the pair write must run BEFORE runSetWidget");
  assert.match(
    handler.slice(routeAt, writeAt),
    /return applyMiniMaxH3PromptBuilderWrite\(node, widget, value/,
  );
});
