/**
 * #390 — an unanswered 18+ consent card must resolve the command before the
 * enclosing tools/call dies, instead of holding the rid until the transport
 * kills it.
 *
 * The original orchestrator clamp still waited hundreds of seconds (under
 * 300s, past the nested SDK's 60s default). The panel owns the blocking card,
 * so the bound lives on the real question painter's wait — not a copy of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CONSENT_HEADER,
  CONSENT_NESTED_CALL_BUDGET_MS,
  CONSENT_NO_LABEL,
  CONSENT_TRANSPORT_DEADLINE_MS,
  CONSENT_WAIT_MS,
  CONSENT_YES_LABEL,
  adultConsentTimeoutResult,
  isAdultConsentCard,
  waitForAdultConsentAnswer,
} from "../../web/js/lib/adult-consent-wait.js";

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

function consentMsg(overrides = {}) {
  return {
    header: CONSENT_HEADER,
    question: "Adult-content gate — please confirm BOTH that you are at least 18.",
    ask_id: "ask-consent-1",
    options: [
      { label: CONSENT_YES_LABEL, description: "Enable adult content for this session" },
      { label: CONSENT_NO_LABEL, description: "Stay in safe-for-work mode" },
    ],
    ...overrides,
  };
}

function manualTimers() {
  let fire = null;
  let delay = null;
  let armed = false;
  let didClear = false;
  return {
    timers: {
      setTimer: (fn, ms) => {
        fire = fn;
        delay = ms;
        armed = true;
        return 1;
      },
      clearTimer: () => {
        didClear = true;
        fire = null;
      },
    },
    expire: () => {
      assert.ok(fire, "no timer was armed — the bound is not in effect");
      fire();
    },
    delay: () => delay,
    cleared: () => armed && didClear,
  };
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
    this.disabled = false;
    this.textContent = "";
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

function makeQuestionPainter({
  wait = waitForAdultConsentAnswer,
  record = () => {},
} = {}) {
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
    "waitForAdultConsentAnswer",
    `${namedFunctionSource(source, "paintQuestion")}; return paintQuestion;`,
  )(
    document,
    log,
    newMsgBtn,
    () => {},
    record,
    () => {},
    () => {},
    () => {},
    false,
    (value) => String(value ?? ""),
    (el, text) => { el.textContent = String(text); },
    () => false,
    () => () => {},
    () => {},
    (key, fallback) => fallback,
    Symbol("abandoned"),
    wait,
  );
  return { log, paintQuestion };
}

const CONSENT_CARD = consentMsg();
const RESTART_CARD = {
  question: "Restart ComfyUI now?",
  options: [{ label: "Yes, go ahead" }, { label: "No, cancel" }],
};

test("#390 the shipped wait sits inside both transport budgets", () => {
  assert.ok(CONSENT_WAIT_MS > 0, "a non-positive bound is no bound");
  assert.ok(
    CONSENT_WAIT_MS < CONSENT_TRANSPORT_DEADLINE_MS,
    "must resolve before the 300s tools/call kill",
  );
  assert.ok(
    CONSENT_WAIT_MS < CONSENT_NESTED_CALL_BUDGET_MS,
    "must also beat the 60s nested-SDK default the recurrence died on",
  );
  assert.equal(CONSENT_TRANSPORT_DEADLINE_MS, 300_000);
});

test("#390 only the 18+ consent card is bounded — a restart confirm is not", () => {
  assert.equal(isAdultConsentCard(CONSENT_CARD), true);
  assert.equal(isAdultConsentCard(consentMsg({ header: undefined })), true, "option identity is enough");
  assert.equal(isAdultConsentCard(RESTART_CARD), false);
  assert.equal(isAdultConsentCard({ header: CONSENT_HEADER }), true);
  assert.equal(isAdultConsentCard(null), false);
  assert.equal(isAdultConsentCard("yes"), false);
});

test("#390 a timeout result never grants adult mode", () => {
  const out = adultConsentTimeoutResult("ask-consent-1");
  assert.equal(out.nsfw_allowed, false);
  assert.equal(out.timed_out, true);
  assert.equal(out.request_id, "ask-consent-1");
  assert.deepEqual(adultConsentTimeoutResult(""), { nsfw_allowed: false, timed_out: true });
});

test("#390 unanswered consent wait resolves structured timeout instead of hanging", async () => {
  const never = new Promise(() => {});
  const { timers, expire, delay } = manualTimers();
  const pending = waitForAdultConsentAnswer(CONSENT_CARD, never, { timers });
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "must not resolve before the bound fires");
  assert.equal(delay(), CONSENT_WAIT_MS, "the shipped wait, not a guessed one");
  expire();
  const out = await pending;
  assert.equal(out.nsfw_allowed, false);
  assert.equal(out.timed_out, true);
  assert.equal(out.request_id, "ask-consent-1");
});

test("#390 a click before the bound is the answer, not a timeout", async () => {
  const { timers, cleared } = manualTimers();
  let resolveAnswer;
  const answer = new Promise((res) => { resolveAnswer = res; });
  const pending = waitForAdultConsentAnswer(CONSENT_CARD, answer, { timers });
  resolveAnswer(CONSENT_YES_LABEL);
  assert.equal(await pending, CONSENT_YES_LABEL);
  assert.equal(cleared(), true, "the bound must not fire after a real pick");
});

test("#390 a non-consent question is returned UNCHANGED — no bound is armed", async () => {
  const { timers, delay } = manualTimers();
  const original = Promise.resolve("Yes, go ahead");
  const out = waitForAdultConsentAnswer(RESTART_CARD, original, { timers });
  assert.equal(out, original, "same promise object — not wrapped");
  assert.equal(delay(), null, "no timer");
  assert.equal(await out, "Yes, go ahead");
});

test("#390 the painter imports and returns the shipped consent wait", () => {
  assert.match(
    source,
    /import \{ waitForAdultConsentAnswer \} from "\.\/lib\/adult-consent-wait\.js";/,
  );
  const paint = namedFunctionSource(source, "paintQuestion");
  assert.match(paint, /waitForAdultConsentAnswer\(msg, promise,/);
  assert.match(paint, /handedToCaller\.then\(unregister, unregister\)/);
  assert.match(paint, /return handedToCaller;/);
  assert.match(
    namedFunctionSource(source, "createBridgeClient"),
    /result = await onAsk\(msg, thisSock\.__cmcpSocketId \?\? null\)/,
    "the executor still awaits the painter's promise — that is the command duration",
  );
});

test("#390 the REAL painter's unanswered consent card settles before the transport deadline", { timeout: 1000 }, async () => {
  const { timers, expire, delay } = manualTimers();
  const wait = (msg, promise, opts = {}) =>
    waitForAdultConsentAnswer(msg, promise, { ...opts, timers, waitMs: opts.waitMs ?? CONSENT_WAIT_MS });
  const { log, paintQuestion } = makeQuestionPainter({ wait });
  const pending = paintQuestion(CONSENT_CARD, "socket-390");
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "unfixed hang: the painter returned an unbounded promise");
  assert.ok(log.children.length >= 1, "the gate still rendered");
  assert.equal(delay(), CONSENT_WAIT_MS);
  expire();
  const out = await pending;
  assert.equal(out.nsfw_allowed, false, "timeout must not grant");
  assert.equal(out.timed_out, true);
  assert.equal(out.request_id, "ask-consent-1");
  assert.ok(
    log.children[0].children.some((c) => /No answer in time/.test(c.textContent)),
    "the card says the wait ended, so a late click is not a silent no-op",
  );
});

test("#390 the REAL painter still hands a consent click through as the option label", { timeout: 1000 }, async () => {
  const { timers } = manualTimers();
  const wait = (msg, promise, opts = {}) =>
    waitForAdultConsentAnswer(msg, promise, { ...opts, timers });
  const { log, paintQuestion } = makeQuestionPainter({ wait });
  const pending = paintQuestion(CONSENT_CARD, "socket-390-yes");
  const card = log.children[0];
  const btnRow = card.children.find((el) => el.children.some((c) => c.tagName === "button"));
  const yes = btnRow.children[0];
  yes.listeners.get("click")();
  assert.equal(await pending, CONSENT_YES_LABEL);
});
