// #996 / #1088 — the fallback note asks for what actually discriminates.
//
// Two reports arrived with the build number and the ComfyUI_frontend version the
// note requested, and neither identified the cause. Measured on 1.48.7:
// app.queuePrompt's real signature is (number, batchCount, queueNodeIds) and the
// third argument DOES reach /prompt as partial_execution_targets — but BOTH links
// are routinely patched by extensions (a custom node wraps app.queuePrompt,
// rgthree wraps api.queuePrompt). A wrapper that forwards its arguments is
// harmless; one that does not drops the scope with no error anywhere. None of that
// is visible in a version number.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeQueuePromptChain,
  describeQueuePromptChainForReport,
} from "../../web/js/lib/queue-prompt-chain.js";

/** A frontend whose own api.queuePrompt understands the options shape — 1.48.7. */
function makeApi({ patched = false } = {}) {
  class Api {
    async queuePrompt(index, prompt, opts) {
      return { index, prompt, partial: opts?.partialExecutionTargets };
    }
  }
  const api = new Api();
  if (patched) {
    // rgthree's shape: arity 2 plus a rest param, forwarding through.
    api.queuePrompt = async function (index, prompt, ...args) {
      return Api.prototype.queuePrompt.apply(api, [index, prompt, ...args]);
    };
  }
  return api;
}

function makeApp({ patched = false } = {}) {
  class App {
    async queuePrompt(number, batchCount = 1, queueNodeIds) {
      return { number, batchCount, queueNodeIds };
    }
  }
  const app = new App();
  if (patched) {
    app.queuePrompt = async function (...args) {
      return App.prototype.queuePrompt.apply(app, args);
    };
  }
  return app;
}

test("#996 reports whether each link is patched, reading past the instance", () => {
  const clean = describeQueuePromptChain({ app: makeApp(), api: makeApi() });
  assert.equal(clean.appPatched, false);
  assert.equal(clean.apiPatched, false);
  // A default parameter truncates Function.length, so the real signature
  // (number, batchCount = 1, queueNodeIds) reports 1 — which is what the live
  // frontend reported when measured. Arity is a WEAK signal here, which is why
  // the report leans on patched-or-not and on the prototype's own support.
  assert.equal(clean.appArity, 1);
  assert.equal(clean.frontendSupportsOptions, true);

  const patched = describeQueuePromptChain({
    app: makeApp({ patched: true }),
    api: makeApi({ patched: true }),
  });
  assert.equal(patched.appPatched, true);
  assert.equal(patched.apiPatched, true);
  // The measured trap: a patched instance reports the WRAPPER's arity, not the
  // real signature. Reading `app.queuePrompt` alone is how one concludes the
  // capability is gone when it is not.
  assert.equal(patched.appArity, 0);
  assert.equal(patched.apiArity, 2);
  // …while the frontend's own api.queuePrompt still supports the options shape.
  assert.equal(patched.frontendSupportsOptions, true);
});

test("#996 separates 'this build cannot' from 'something dropped it'", () => {
  const oldFrontend = describeQueuePromptChain({
    app: makeApp(),
    api: (() => {
      class OldApi {
        async queuePrompt(index, prompt) {
          return { index, prompt };
        }
      }
      return new OldApi();
    })(),
  });
  assert.equal(oldFrontend.frontendSupportsOptions, false);

  const report = describeQueuePromptChainForReport(oldFrontend);
  assert.match(report, /points at the build rather than at an extension/);
  assert.doesNotMatch(report, /wrapper that does not forward/);
});

test("#996 points at the wrapper when the frontend DOES support the scope", () => {
  const chain = describeQueuePromptChain({
    app: makeApp({ patched: true }),
    api: makeApi({ patched: true }),
  });
  const report = describeQueuePromptChainForReport(chain);
  assert.match(report, /a wrapper that does not forward its arguments is the thing to look at/);
  assert.match(report, /fn\(index, prompt, \.\.\.args\)/);
});

test("#996 stops asking for the datum that already failed twice", () => {
  const report = describeQueuePromptChainForReport(
    describeQueuePromptChain({ app: makeApp(), api: makeApi() }),
  );
  assert.match(report, /Please include THIS line/);
  assert.match(report, /has already been reported twice without identifying the cause/);
});

test("#996 never throws on a hostile or absent chain — it runs on a failure path", () => {
  for (const bad of [undefined, {}, { app: null, api: null }, { app: 1, api: "x" }]) {
    const chain = describeQueuePromptChain(bad);
    assert.equal(typeof chain.summary, "string");
    assert.equal(typeof describeQueuePromptChainForReport(chain), "string");
  }
  // A getter that throws must not take the run down with it.
  const hostile = {};
  Object.defineProperty(hostile, "queuePrompt", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => describeQueuePromptChain({ app: {}, api: hostile }));
});

test("#996 an empty chain yields an empty report rather than a confident one", () => {
  assert.equal(describeQueuePromptChainForReport(null), "");
});
