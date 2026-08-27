/**
 * #1764 — the restart confirmation must reach the exact pending bridge command.
 *
 * The panel question painter owns the promise returned from the real `ask_user`
 * command handler. That promise is the only handoff that produces the original
 * rid-correlated reply to `panel_restart_comfyui`; history/DOM work is secondary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PANEL = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const source = readFileSync(PANEL, "utf8").replace(/\r\n/g, "\n");

function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const signatureEnd = src.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `${name} body not found`);
  const open = signatureEnd + 2;
  let depth = 1;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && n === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`could not close ${name}`);
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.className = "";
    this.classList = { add() {}, remove() {} };
    this.style = {};
    this.value = "";
    this.hidden = false;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = children;
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  scrollIntoView() {}
}

function makeQuestionPainter({ record = () => {}, onReveal = () => {} } = {}) {
  const log = new FakeElement("log");
  const newMsgBtn = new FakeElement("button");
  const document = { createElement: (tag) => new FakeElement(tag) };
  const paintQuestion = new Function(
    "document",
    "log",
    "newMsgBtn",
    "clearEmpty",
    "record",
    "scrollLog",
    "revealInteractiveCard",
    "openSidebarTab",
    "stickToBottom",
    "coerceMessageText",
    "renderRichText",
    "isImeComposing",
    "registerInteractiveCard",
    "retireInteractiveCard",
    "tr",
    "INTERACTIVE_ABANDONED",
    `${namedFunctionSource(source, "paintQuestion")}; return paintQuestion;`,
  )(
    document,
    log,
    newMsgBtn,
    () => {},
    record,
    () => {},
    onReveal,
    () => {},
    false,
    (value) => String(value ?? ""),
    (el, text) => { el.textContent = String(text); },
    () => false,
    () => () => {},
    () => {},
    (key, fallback) => fallback,
    Symbol("abandoned"),
  );
  return { log, paintQuestion };
}

test("#1764 the real question painter settles the command before history persistence", async () => {
  const { log, paintQuestion } = makeQuestionPainter({
    record: () => {
      throw new Error("simulated history write failure");
    },
  });
  const answer = paintQuestion(
    {
      question: "Restart ComfyUI now?",
      options: [{ label: "Yes, go ahead" }, { label: "No, cancel" }],
    },
    "socket-1764",
  );
  const card = log.children[0];
  const otherRow = card.children.at(-1);
  const input = otherRow.children[0];
  input.value = "Yes, go ahead";

  assert.doesNotThrow(
    () => otherRow.children[1].listeners.get("click")(),
    "history persistence is presentation-only after the command is settled",
  );
  assert.equal(await answer, "Yes, go ahead", "the transport promise is already settled");
});

test("#1764 production caller path keeps the original ask rid on the answer", () => {
  const bridge = namedFunctionSource(source, "createBridgeClient");
  assert.match(bridge, /result = await onAsk\(msg, thisSock\.__cmcpSocketId \?\? null\)/);
  assert.match(bridge, /reply = \{ rid: msg\.rid, ok: true, result \}/);
  assert.match(bridge, /thisSock\["send"\]\(JSON\.stringify\(reply\)\)/);
  assert.match(bridge, /settleRid\(reply\)/);
});
