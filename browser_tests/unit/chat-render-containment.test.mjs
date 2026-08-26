// #1801 — a long Agent transcript must not keep every off-screen message in the
// layout/paint work competing with ComfyUI's graph canvas.
//
// The panel is shipped as one DOM-built bundle, so this is intentionally a
// production-source contract: it protects the CSS rule on the real .cmcp-log
// and proves the message painters still append their existing DOM nodes there.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must remain in the production panel bundle`);
  const next = source.indexOf("\n  function ", start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

test("#1801 contains every direct chat message without changing the feed surface", () => {
  const source = readFileSync(PANEL_JS, "utf8");
  assert.match(source, /log\.className = "cmcp-log"/);
  assert.match(
    source,
    /import \{ createChatScrollStabilizer \} from "\.\/lib\/chat-scroll-stabilizer\.js";/,
  );
  assert.match(
    source,
    /import \{ createChatScrollIntentTracker, updateChatStickiness \} from "\.\/lib\/chat-scroll-intent\.js";/,
  );

  const scrollIntentStart = source.indexOf("const scrollIntent = createChatScrollIntentTracker();");
  assert.ok(scrollIntentStart >= 0, "the production scroll listener must track user intent");
  const scrollListenerEnd = source.indexOf("  const chatScrollStabilizer =", scrollIntentStart);
  const scrollListener = source.slice(scrollIntentStart, scrollListenerEnd);
  assert.match(scrollListener, /scrollIntent\.consume\(\)/);
  assert.match(scrollListener, /scrollIntent\.endProgrammaticScroll\(\)/);
  assert.match(scrollListener, /updateChatStickiness\(/);
  assert.doesNotMatch(scrollListener, /stickToBottom\s*=\s*atBottom\(\)/);
  assert.match(source, /scrollIntent\.noteProgrammaticScroll\(\{ behavior: "smooth" \}\);\s*log\.scrollTo\(/);
  assert.match(source, /beforeScroll: \(\) => scrollIntent\.noteProgrammaticScroll\(\)/);

  const ruleStart = source.indexOf(".cmcp-log > :not(.cmcp-empty) {");
  assert.ok(ruleStart >= 0, "the production chat feed must contain its message rule");
  const ruleEnd = source.indexOf("}", ruleStart);
  assert.ok(ruleEnd > ruleStart, "the containment rule must be complete");
  const rule = source.slice(ruleStart, ruleEnd + 1);
  assert.match(rule, /content-visibility:\s*auto;/);
  assert.match(rule, /contain-intrinsic-size:\s*auto\s+120px;/);

  // These are the production roots appended to .cmcp-log. The direct-child
  // selector intentionally covers bubbles and the non-bubble card variants.
  for (const [name, className] of [
    ["paintUser", "cmcp-bubble user"],
    ["paintAgent", "cmcp-bubble agent"],
    ["paintImage", "cmcp-bubble agent cmcp-imgcard"],
    ["paintVideo", "cmcp-bubble agent cmcp-imgcard"],
    ["paintAudio", "cmcp-bubble agent cmcp-audiocard"],
    ["paintFileLink", "cmcp-bubble agent cmcp-filecard"],
    ["paintCard", "cmcp-card"],
    ["paintQuestion", "cmcp-card cmcp-question"],
    ["paintSecret", "cmcp-card cmcp-secret"],
  ]) {
    const body = functionBody(source, name);
    assert.match(body, new RegExp(`className = "${className.replaceAll(" ", "\\s+")}`));
    assert.match(body, /log\.appendChild\(/, `${name} must still append to the chat log`);
  }

  const replay = functionBody(source, "paintThread");
  const renderTodoAt = replay.indexOf("renderTodo(t.todos");
  const finalScrollAt = replay.indexOf("scrollLog();", renderTodoAt);
  assert.ok(renderTodoAt >= 0, "replay still renders the thread tray");
  assert.ok(finalScrollAt > renderTodoAt, "replay seeds a final post-A2UI scroll correction");
  assert.match(functionBody(source, "mountLiveA2UICard"), /log\.appendChild\(handle\.el\)/);
  assert.match(functionBody(source, "paintA2UIRecord"), /log\.appendChild\(renderA2UIInert\(/);
});
