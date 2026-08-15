// mcp#884/#897: the conversation is ALWAYS panel-owned. The orchestrator keys and
// persists ONE agent session per backend across every panel, tab and workflow, so a
// per-workflow chat is a bug, not a mode — a user left in `workflow` or `ask` scope
// gets several panel transcripts all mapping onto the single session the
// orchestrator actually runs, and the transcripts silently diverge from the agent's
// real context.
//
// WHY THIS FILE EXISTS. The retirement was previously pinned only by Playwright
// specs, which are NOT in CI (they need a live ComfyUI on :8188). A mutation test
// proved the gap: restoring `chatScopeMode()`'s old "read the stored setting" body
// left the ENTIRE unit suite green (4401/4401). Nothing in CI could tell that the
// retired scopes had come back.
//
// The load-bearing test below therefore EXTRACTS the shipped `chatScopeMode` and
// CALLS it, following the repo's "real panel source" convention (see
// context-ring-scope.test.mjs). It deliberately does not assert on the source text:
// a body of `if (false) return getSetting(...)` matches any regex written about it
// and still ships the right behaviour, while a body that genuinely reads the setting
// must FAIL — and only running it can tell those apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// Newlines normalized: checked out with CRLF on Windows, and the extraction below
// anchors on a column-0 closing brace.
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");

/** The shipped `chatScopeMode`, ready to call. It is top-level, so its closing brace
 *  is the next column-0 `}`. The slice is proven to span the whole function before it
 *  is evaluated — a truncated slice would otherwise be a syntax error or, worse, a
 *  half-function that happens to parse. */
function loadChatScopeMode(getSetting) {
  const start = SRC.indexOf("function chatScopeMode() {");
  assert.notEqual(start, -1, "chatScopeMode() must exist in the panel source");
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "chatScopeMode() must be closed at a column-0 brace");
  const body = SRC.slice(start, end + 2);
  assert.match(body, /\n\}$/, "the extracted slice does not end at the function's own brace");
  // `getSetting` is injected rather than left to the global scope so that a body which
  // reads the retired setting RUNS the stub and returns its value (failing the
  // assertions below) instead of throwing a ReferenceError — a throw would look like a
  // different defect and could be "fixed" by loosening the test.
  return new Function("getSetting", `${body}\nreturn chatScopeMode;`)(getSetting);
}

// Every value an older build could have persisted into the retired setting, plus the
// shapes a corrupted or hand-edited store can produce.
const STORED_VALUES = [
  "workflow",
  "ask",
  "panel",
  undefined,
  null,
  "",
  "WORKFLOW",
  "Workflow",
  " workflow ",
  0,
  false,
  {},
  ["workflow"],
];

test("chatScopeMode() is panel-owned for EVERY stored value a retired scope could have left", () => {
  for (const stored of STORED_VALUES) {
    const reads = [];
    const chatScopeMode = loadChatScopeMode((id) => {
      reads.push(id);
      return stored;
    });
    assert.equal(
      chatScopeMode(),
      "panel",
      `a stored scope of ${JSON.stringify(stored) ?? String(stored)} must be ignored, not honored`,
    );
  }
});

test("chatScopeMode() does not consult the settings store at all", () => {
  // Stronger than "the answer is panel": the retired value is not merely overridden,
  // it is never read. A body that reads the setting and then coerces the result back
  // to "panel" would pass the test above and would be one edit away from honoring it
  // again; this pins that there is no live read to re-enable.
  const reads = [];
  const chatScopeMode = loadChatScopeMode((id) => {
    reads.push(id);
    return "workflow";
  });
  assert.equal(chatScopeMode(), "panel");
  assert.deepEqual(reads, [], `chatScopeMode() read settings: ${reads.join(", ")}`);
});

test("no Settings row offers a chat conversation scope any more", () => {
  // Defense in depth for the other direction: even with chatScopeMode() hard-wired, a
  // re-added combo would be a visible, clickable control that silently does nothing —
  // and the obvious "fix" for that is to wire it back up.
  const start = SRC.indexOf("function panelSettingsList() {");
  assert.notEqual(start, -1, "panelSettingsList() must exist");
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "panelSettingsList() must be closed");
  const body = SRC.slice(start, end);
  // Prove the slice reaches the end of the registered list before concluding anything
  // from its ABSENCE of a row (settings-i18n-keys.test.mjs uses the same guard): a
  // truncated body would make this test vacuously pass.
  assert.match(body, /\n {2}\];\s*$/, "the extracted settings body does not end at the returned array");

  assert.ok(
    !body.includes("SETTING_CHAT_SCOPE"),
    "the retired chat-scope setting must not be registered",
  );
  for (const retired of ["comfyui-mcp.chatScope", "comfyui-mcp.sessionFollowsPanel"]) {
    assert.ok(!body.includes(retired), `the retired setting id ${retired} must not be registered`);
  }
});

test("the retired scope machinery has no live caller left", () => {
  // `applyChatScope` was the combo's onChange target and the one path that could flip
  // scope at runtime; `askModeFollowsPanel` was the "ask" mode's answer. Either one
  // surviving as live code is a way back to per-workflow sessions behind the
  // orchestrator's back. Comments are allowed to explain the removal — code is not.
  const code = SRC.split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  for (const name of ["applyChatScope", "askModeFollowsPanel"]) {
    assert.ok(!code.includes(name), `${name} must not survive as live code`);
  }
});
