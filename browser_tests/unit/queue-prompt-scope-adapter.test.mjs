// #1998 — 1.41.21-shaped queuePrompt wrappers drop the third argument.
// Native ComfyApp stores queueNodeIds on the queue item and later passes
// { partialExecutionTargets } to api.queuePrompt. The adapter restores that
// target through the live wrappers for this run's mark, and request-body
// repair remains the last fallback when a wrapper never calls through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  installQueuePromptScopeAdapter,
  mergeQueuePromptScopeOptions,
} from "../../web/js/lib/queue-prompt-scope-adapter.js";

const MARK = 2 ** 30 - 2;
const TARGETS = ["259"];

test("#1998 mergeQueuePromptScopeOptions writes partialExecutionTargets without stripping other keys", () => {
  assert.deepEqual(mergeQueuePromptScopeOptions(undefined, TARGETS), {
    partialExecutionTargets: TARGETS,
  });
  assert.deepEqual(mergeQueuePromptScopeOptions({ previewMethod: "taesd" }, TARGETS), {
    previewMethod: "taesd",
    partialExecutionTargets: TARGETS,
  });
  const already = { partialExecutionTargets: ["14"] };
  assert.equal(mergeQueuePromptScopeOptions(already, TARGETS).partialExecutionTargets, already.partialExecutionTargets);
  assert.deepEqual(mergeQueuePromptScopeOptions(["259"], TARGETS), {
    partialExecutionTargets: TARGETS,
  });
});

test("#1998 adapter is a no-op without targets and never throws on hostile input", () => {
  const restoreEmpty = installQueuePromptScopeAdapter({});
  assert.equal(typeof restoreEmpty, "function");
  restoreEmpty();
  restoreEmpty();

  const hostile = {};
  Object.defineProperty(hostile, "queuePrompt", {
    get() {
      throw new Error("boom");
    },
  });
  Object.defineProperty(hostile, "queueItems", {
    get() {
      throw new Error("boom");
    },
  });
  const restore = installQueuePromptScopeAdapter({
    app: hostile,
    api: hostile,
    targets: TARGETS,
    queueMark: MARK,
  });
  restore();
});

test("#1998 queueItems pop restores queueNodeIds for this run's mark only", () => {
  const ours = { number: MARK, batchCount: 1 };
  const foreign = { number: 0, batchCount: 1 };
  const kept = { number: MARK, batchCount: 1, queueNodeIds: ["14"] };
  const app = {
    queueItems: [kept, foreign, ours],
    queuePrompt: async () => {},
  };
  const restore = installQueuePromptScopeAdapter({
    app,
    targets: TARGETS,
    queueMark: MARK,
  });
  try {
    assert.deepEqual(app.queueItems.pop().queueNodeIds, TARGETS);
    assert.equal(app.queueItems.pop().queueNodeIds, undefined);
    assert.deepEqual(app.queueItems.pop().queueNodeIds, ["14"]);
  } finally {
    restore();
  }
  app.queueItems.push({ number: MARK, batchCount: 1 });
  assert.equal(app.queueItems.pop().queueNodeIds, undefined, "restore must uninstall the pop hook");
});

test("#1998 api.queuePrompt wrap injects partialExecutionTargets for this run's mark", async () => {
  const seen = [];
  const api = {
    async queuePrompt(number, prompt, options) {
      seen.push({ number, prompt, options });
      return true;
    },
  };
  const restore = installQueuePromptScopeAdapter({
    api,
    targets: TARGETS,
    queueMark: MARK,
  });
  try {
    await api.queuePrompt(MARK, { output: {} });
    await api.queuePrompt(0, { output: {} });
    await api.queuePrompt(MARK, { output: {} }, { previewMethod: "taesd" });
  } finally {
    restore();
  }
  assert.deepEqual(seen[0].options.partialExecutionTargets, TARGETS);
  assert.equal(seen[1].options, undefined);
  assert.deepEqual(seen[2].options, {
    previewMethod: "taesd",
    partialExecutionTargets: TARGETS,
  });
});

test("#1998 two-arg app wrapper still stores queueNodeIds on the 1.41.21 queue item", async () => {
  class NativeApp {
    constructor() {
      this.queueItems = [];
      this.last = null;
    }
    async queuePrompt(number, batchCount = 1, queueNodeIds) {
      this.queueItems.push({ number, batchCount, queueNodeIds });
      this.last = this.queueItems.pop();
      return true;
    }
  }
  const app = new NativeApp();
  const native = NativeApp.prototype.queuePrompt;
  app.queuePrompt = async function (number, batch) {
    return native.apply(app, [number, batch]);
  };

  const restore = installQueuePromptScopeAdapter({
    app,
    targets: TARGETS,
    queueMark: MARK,
  });
  try {
    await app.queuePrompt(MARK, 1, TARGETS);
  } finally {
    restore();
  }
  assert.deepEqual(app.last.queueNodeIds, TARGETS);
});

test("#1998 dispatchScopedRun actually installs the adapter", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../web/js/lib/run-scope-guard.js", import.meta.url)),
    "utf8",
  );
  assert.match(source, /installQueuePromptScopeAdapter/);
  assert.match(source, /restoreQueuePromptAdapter\(\)/);
  assert.match(source, /adapterMarks\.mark = mark/);
});
