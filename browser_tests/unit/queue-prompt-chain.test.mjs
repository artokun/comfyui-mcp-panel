// #996 / #1088 — the fallback note collects what discriminates, and CLAIMS NOTHING.
//
// Two reports arrived with the build number and the ComfyUI_frontend version the
// note requested, and neither identified the cause. Measured on a live 1.48.7:
// app.queuePrompt's real implementation takes (number, batchCount, queueNodeIds)
// and the third argument reaches /prompt as partial_execution_targets — but both
// links were shadowed by own properties (a custom node over app.queuePrompt,
// rgthree over api.queuePrompt), so reading the instances reports arity 0 and
// mentions neither `partial` nor `queueNodeIds` while the prototypes do both.
//
// The first version of this module turned those observations into accusations —
// "PATCHED by an extension", "a wrapper that does not forward is the thing to look
// at". Codex review killed both: an own property is SHADOWING (a frontend binding
// in its constructor looks identical), and a shadowed method plus a capable
// prototype does not establish that a wrapper ate anything. These tests pin the
// observations AND the absence of the diagnosis.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeQueuePromptChain,
  describeQueuePromptChainForReport,
  queuePromptChainDeps,
} from "../../web/js/lib/queue-prompt-chain.js";

/** A frontend whose own api.queuePrompt understands the options shape — 1.48.7. */
function makeApi({ shadowed = false } = {}) {
  class Api {
    async queuePrompt(index, prompt, opts) {
      return { index, prompt, partialExecutionTargets: opts?.partialExecutionTargets };
    }
  }
  const api = new Api();
  if (shadowed) {
    // rgthree's shape: forwards through, which is why shadowing alone proves nothing.
    api.queuePrompt = async function (index, prompt, ...args) {
      return Api.prototype.queuePrompt.apply(api, [index, prompt, ...args]);
    };
  }
  return api;
}

function makeApp({ shadowed = false } = {}) {
  class App {
    async queuePrompt(number, batchCount = 1, queueNodeIds) {
      return { number, batchCount, queueNodeIds };
    }
  }
  const app = new App();
  if (shadowed) app.queuePrompt = async function (...args) {
    return App.prototype.queuePrompt.apply(app, args);
  };
  return app;
}

test("#996 reports SHADOWING as shadowing — never as a patch by an extension", () => {
  const clean = describeQueuePromptChain({ app: makeApp(), api: makeApi() });
  assert.equal(clean.appShadowed, false);
  assert.equal(clean.apiShadowed, false);
  assert.match(clean.summary, /comes from the prototype/);

  const shadowed = describeQueuePromptChain({
    app: makeApp({ shadowed: true }),
    api: makeApi({ shadowed: true }),
  });
  assert.equal(shadowed.appShadowed, true);
  assert.equal(shadowed.apiShadowed, true);
  assert.match(shadowed.summary, /is shadowed by an own property/);
  // The accusation codex killed: a frontend that binds its own method in a
  // constructor produces this exact observation.
  assert.doesNotMatch(shadowed.summary, /PATCHED by an extension/i);
});

test("#996 the prototype source check is reported as a source observation", () => {
  const capable = describeQueuePromptChain({ app: makeApp(), api: makeApi() });
  assert.equal(capable.protoMentionsOption, true);
  assert.match(capable.summary, /source mentions partialExecutionTargets/);

  class OldApi {
    async queuePrompt(index, prompt) {
      return { index, prompt };
    }
  }
  const old = describeQueuePromptChain({ app: makeApp(), api: new OldApi() });
  assert.equal(old.protoMentionsOption, false);
  // "does not mention" — NOT "this build cannot do it". A build may support the
  // option through a helper or a minified name.
  assert.match(old.summary, /source does not mention partialExecutionTargets/);
  assert.doesNotMatch(old.summary, /points at the build/i);
});

test("#996 an unreadable prototype is UNKNOWN, not a verdict either way", () => {
  const chain = describeQueuePromptChain({ app: makeApp(), api: {} });
  assert.equal(chain.protoMentionsOption, undefined);
  assert.match(chain.summary, /could not be read/);
});

test("#996 the report states what would settle it, and names no suspect", () => {
  const shadowed = describeQueuePromptChainForReport(
    describeQueuePromptChain({ app: makeApp({ shadowed: true }), api: makeApi({ shadowed: true }) }),
  );
  assert.match(shadowed, /observed, not a diagnosis/);
  assert.match(shadowed, /whether whatever is installed passes its THIRD argument through/);
  // The suspect-naming codex killed.
  assert.doesNotMatch(shadowed, /the thing to look at/i);
  assert.doesNotMatch(shadowed, /PATCHED by an extension/i);
  // codex round 2: nor "something REPLACED it" — a frontend binding its own method
  // in a constructor produces the same own property.
  assert.doesNotMatch(shadowed, /replaced one of those methods/i);
  assert.match(shadowed, /is ordinary/);
  assert.match(shadowed, /where to look, not who to blame/);

  const unshadowed = describeQueuePromptChainForReport(
    describeQueuePromptChain({ app: makeApp(), api: makeApi() }),
  );
  // codex round 2: absence of shadowing rules out ONE PLACEMENT. A wrapper on the
  // prototype leaves no own property, so this must not be read as "the frontend's
  // own code had it".
  assert.match(unshadowed, /rules out one placement only/);
  assert.match(unshadowed, /installed on the PROTOTYPE leaves no own property/);
  assert.doesNotMatch(unshadowed, /reached the frontend's own code and was lost/);
});

test("#996 arity is NOT reported — it reads like a signal and is noise", () => {
  // A default parameter truncates Function.length, so the known-good implementation
  // reports 1 while a correct forwarding wrapper reports 0. Publishing that makes
  // the note easier to misread than the version request it replaces (codex, P2).
  const chain = describeQueuePromptChain({ app: makeApp(), api: makeApi() });
  assert.equal(chain.appArity, undefined);
  assert.doesNotMatch(chain.summary, /arity/i);
  assert.doesNotMatch(describeQueuePromptChainForReport(chain), /arity/i);
});

test("#996 stops asking for the datum that already failed twice", () => {
  const report = describeQueuePromptChainForReport(
    describeQueuePromptChain({ app: makeApp(), api: makeApi() }),
  );
  assert.match(report, /Please include THIS line/);
  assert.match(report, /together with the body keys above/);
  assert.match(report, /twice without identifying the cause/);
});

test("#996 never throws on hostile input — it runs on a failure path", () => {
  // `null` included: destructuring in the signature threw on it (codex round 2).
  for (const bad of [undefined, null, {}, { app: null, api: null }, { app: 1, api: "x" }]) {
    const chain = describeQueuePromptChain(bad);
    assert.equal(typeof chain.summary, "string");
    assert.equal(typeof describeQueuePromptChainForReport(chain), "string");
  }
  // A getter that throws, on either object.
  const hostile = {};
  Object.defineProperty(hostile, "queuePrompt", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => describeQueuePromptChain({ app: hostile, api: hostile }));

  // A callable Proxy whose own-property check throws (codex: the unguarded read).
  const proxy = new Proxy(function () {}, {
    getOwnPropertyDescriptor() {
      throw new Error("nope");
    },
    has() {
      throw new Error("nope");
    },
    get() {
      throw new Error("nope");
    },
  });
  assert.doesNotThrow(() => describeQueuePromptChain({ app: proxy, api: proxy }));
});

test("#996 an empty chain yields an empty report rather than a confident one", () => {
  assert.equal(describeQueuePromptChainForReport(null), "");
});

test("#996 reading the globals cannot throw either — the caller's access is guarded too", () => {
  // codex P1: the probe guarded its own reads while the call site did `app?.api`
  // outside them, so an extension-installed throwing getter crashed the note that
  // was describing the failure.
  const hostileRoot = {};
  Object.defineProperty(hostileRoot, "app", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => queuePromptChainDeps(hostileRoot));
  assert.deepEqual(queuePromptChainDeps(hostileRoot), { app: undefined, api: undefined });

  // And an app whose `api` getter throws.
  const appWithHostileApi = {};
  Object.defineProperty(appWithHostileApi, "api", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => queuePromptChainDeps({ app: appWithHostileApi }));

  assert.deepEqual(queuePromptChainDeps(undefined), { app: undefined, api: undefined });
});

test("#996 an UNREADABLE or absent method is unknown — never 'comes from the prototype'", () => {
  // codex round 3: a failed own-property probe was collapsed to `false` and then
  // reported as a confident negative — the same defect this diagnostic exists to
  // stop making, in its own guard.
  const proxy = new Proxy(function () {}, {
    getOwnPropertyDescriptor() {
      throw new Error("nope");
    },
    get(_t, k) {
      if (k === "queuePrompt") return function () {};
      throw new Error("nope");
    },
  });
  const unreadable = describeQueuePromptChain({ app: proxy, api: proxy });
  assert.equal(unreadable.appShadowed, undefined);
  assert.match(unreadable.summary, /could not be read, or is not there/);
  assert.doesNotMatch(unreadable.summary, /comes from the prototype/);

  // An object with NO queuePrompt is not "from the prototype" either.
  const absent = describeQueuePromptChain({ app: {}, api: {} });
  assert.equal(absent.appShadowed, undefined);
  assert.match(absent.summary, /could not be read, or is not there/);

  // …and the report must not take the "nothing shadows" branch for it.
  const report = describeQueuePromptChainForReport(absent);
  assert.match(report, /could not be read, so where it comes from is unknown/);
  assert.doesNotMatch(report, /rules out one placement only/);
});
