/**
 * #1679 / #1935 — MiniMaxH3Director.prompt, builder_state, and timeline_data are derived
 * write-backs of the node's in-memory builderState. The safe behavior is a narrow refusal
 * with the verified PrimitiveNode / external_prompt_overwrite workaround.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MINIMAX_H3_DIRECTOR_TYPE,
  MINIMAX_H3_DIRECTOR_PROMPT_WIDGET,
  MINIMAX_H3_DIRECTOR_TIMELINE_WIDGET,
  MINIMAX_H3_DIRECTOR_BUILDER_STATE_WIDGET,
  MINIMAX_H3_DIRECTOR_DERIVED_WIDGETS,
  isMiniMaxH3DirectorNode,
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

test("#1935 reporter: timeline_data and builder_state are derived, not a successful write", () => {
  // The reported write: panel_set_widget on timeline_data (including nested builder_state
  // and resolved_prompt) returned success while prompt + builder_state stayed on the
  // previous text. Direct writes to those two were then overwritten by emit().
  assert.equal(
    classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, MINIMAX_H3_DIRECTOR_TIMELINE_WIDGET),
    "derived",
  );
  assert.equal(
    classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, MINIMAX_H3_DIRECTOR_BUILDER_STATE_WIDGET),
    "derived",
  );
  assert.deepEqual([...MINIMAX_H3_DIRECTOR_DERIVED_WIDGETS], ["prompt", "builder_state", "timeline_data"]);
});

test("#1679/#1935: ordinary Director widgets remain writable", () => {
  for (const widget of ["duration", "width", "height", "mode", "frame_rate", "ref_image_size"]) {
    assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, widget), null, widget);
  }
});

test("#1679: the exact prompt name is required on the exact node type", () => {
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: "MiniMaxH3PromptBuilder" }, "prompt"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: "OtherMiniMaxH3Director" }, "prompt"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: "MiniMaxH3DirectorV2" }, "timeline_data"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prompt_text"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prefix.prompt"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "prompt_extra"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "Prompt"), null);
});

test("#1935: suffix-shaped addresses do not broaden the refusal past the exact widgets", () => {
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "timeline_data.builder_state"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "builder_state.imd"), null);
  assert.equal(classifyMiniMaxH3DirectorWrite({ type: MINIMAX_H3_DIRECTOR_TYPE }, "timeline_data."), null);
});

test("isMiniMaxH3DirectorNode matches on type or comfyClass, nothing else", () => {
  assert.equal(isMiniMaxH3DirectorNode({ type: MINIMAX_H3_DIRECTOR_TYPE }), true);
  assert.equal(isMiniMaxH3DirectorNode({ comfyClass: MINIMAX_H3_DIRECTOR_TYPE }), true);
  // EITHER field matching is enough — a non-Director `type` must NOT mask a matching
  // `comfyClass` (the `type ?? comfyClass` bug the LTX #314 review caught).
  assert.equal(isMiniMaxH3DirectorNode({ type: "SomeVirtualType", comfyClass: MINIMAX_H3_DIRECTOR_TYPE }), true);
  assert.equal(
    classifyMiniMaxH3DirectorWrite(
      { type: "SomeVirtualType", comfyClass: MINIMAX_H3_DIRECTOR_TYPE },
      MINIMAX_H3_DIRECTOR_TIMELINE_WIDGET,
    ),
    "derived",
  );
  assert.equal(isMiniMaxH3DirectorNode({ type: "KSampler" }), false);
  assert.equal(isMiniMaxH3DirectorNode(null), false);
  assert.equal(isMiniMaxH3DirectorNode({}), false);
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

test("#1679/#1935: classifying the derived write is side-effect free", () => {
  const node = {
    id: 17,
    type: MINIMAX_H3_DIRECTOR_TYPE,
    builderState: { prompt: "old" },
    widgets: [
      { name: "prompt", value: "old" },
      { name: "builder_state", value: '{"imd":"old"}' },
      { name: "timeline_data", value: '{"builder_state":{"imd":"old"}}' },
    ],
  };
  const before = structuredClone(node);
  assert.equal(classifyMiniMaxH3DirectorWrite(node, "prompt"), "derived");
  assert.equal(classifyMiniMaxH3DirectorWrite(node, "timeline_data"), "derived");
  assert.equal(classifyMiniMaxH3DirectorWrite(node, "builder_state"), "derived");
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

test("#1935: a timeline_data refusal names the stale-prompt mechanism and the workaround", () => {
  const message = miniMaxH3DirectorPromptRefusal("timeline_data", 17);
  assert.match(message, /panel_set_widget cannot drive "timeline_data" on MiniMaxH3Director node 17/);
  assert.match(message, /timeline_data, builder_state, and prompt/);
  assert.match(message, /#1935/);
  assert.match(message, /does not mean the prompt/);
  assert.match(message, /external_prompt_overwrite/);
  assert.match(message, /PrimitiveNode STRING/);
  assert.match(message, /before any graph mutation/);
  assert.match(message, /other widgets/);
});

test("#1679/#1935: graph_set_widget wires the refusal before its first await and generic write", () => {
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
