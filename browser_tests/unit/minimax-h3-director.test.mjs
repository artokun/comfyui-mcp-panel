/**
 * #1679 — MiniMaxH3Director.prompt is a derived readout of the node's in-memory builderState.
 * The safe behavior is a narrow refusal with the verified PrimitiveNode workaround.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MINIMAX_H3_DIRECTOR_TYPE,
  MINIMAX_H3_DIRECTOR_PROMPT_WIDGET,
  classifyMiniMaxH3DirectorWrite,
  miniMaxH3DirectorPromptRefusal,
} from "../../web/js/lib/minimax-h3-director.js";

test("#1679: the Director prompt base widget is classified as derived", () => {
  assert.equal(
    classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, MINIMAX_H3_DIRECTOR_PROMPT_WIDGET),
    "derived",
  );
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prompt.0"), null);
});

test("#1679: other MiniMax widgets remain writable", () => {
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "duration"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "builder_state"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "timeline_data"), null);
});

test("#1679: the exact prompt name is required on the exact node type", () => {
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: "MiniMaxH3PromptBuilder" }, "prompt"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: "OtherMiniMaxH3Director" }, "prompt"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prompt_text"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prefix.prompt"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prompt_extra"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "Prompt"), null);
});

test("#1679: malformed nodes and widget names fail closed without throwing", () => {
  for (const node of [null, undefined, {}, { type: 42 }, "MiniMaxH3Director", []]) {
    assert.equal(classifyMiniMaxH3DirectorWrite(node, "prompt"), null);
  }
  for (const widgetName of [null, undefined, 42, {}, [], "", ".prompt"]) {
    assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, widgetName), null);
  }
  // This is a scalar prompt widget, not a composite. Suffix-shaped addresses must not
  // broaden the refusal beyond the exact widget the issue describes.
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prompt."), null);
});

test("#1679: classifying the derived write is side-effect free", () => {
  const node = {
    id: 17,
    type: MINIMAX_H3_DIRECTOR_TYPE,
    builderState: { prompt: "old" },
    widgets: [{ name: "prompt", value: "old" }],
  };
  const before = structuredClone(node);
  assert.equal(classifyMiniMaxH3DirectorWrite(node, "prompt"), "derived");
  assert.deepEqual(node, before);
});

test("#1679: the refusal names external_prompt_overwrite and the PrimitiveNode workaround", () => {
  const message = miniMaxH3DirectorPromptRefusal("prompt", 17);
  assert.match(message, /panel_set_widget/);
  assert.match(message, /MiniMaxH3Director node 17/);
  assert.match(message, /DERIVED/);
  assert.match(message, /builderState/);
  assert.match(message, /external_prompt_overwrite/);
  assert.match(message, /PrimitiveNode STRING/);
  assert.match(message, /before any graph mutation/);
});

test("#1679: graph_set_widget wires the refusal before its first await and generic write", () => {
  const source = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    source,
    /import \{\s*classifyMiniMaxH3DirectorWrite,\s*miniMaxH3DirectorPromptRefusal,\s*\} from "\.\/lib\/minimax-h3-director\.js";/,
  );
  const handler = source.slice(source.indexOf("async graph_set_widget("));
  assert.ok(handler.startsWith("async graph_set_widget("), "graph_set_widget handler not found");
  const guardAt = handler.indexOf("classifyMiniMaxH3DirectorWrite(node, widget)");
  const firstAwaitAt = handler.indexOf("await ");
  const genericWriteAt = handler.indexOf("await runSetWidget(");
  assert.ok(guardAt > 0, "Director guard is not called from graph_set_widget");
  assert.ok(firstAwaitAt > 0, "graph_set_widget await site not found");
  assert.ok(genericWriteAt > 0, "generic write call site not found");
  assert.ok(guardAt < firstAwaitAt, "Director refusal must run before any await");
  assert.ok(guardAt < genericWriteAt, "Director refusal must run before the generic write");
  assert.match(
    handler.slice(guardAt, firstAwaitAt),
    /throw new Error\(miniMaxH3DirectorPromptRefusal\(widget, node\.id\)\)/,
  );
});
