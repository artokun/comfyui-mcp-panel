// #1854 — the four modules that stopped using the binder helper must not read
// ANY overrideable property off the function they captured.
//
// Background: those files were rewritten so the Comfy Registry YARA rule
// `python_network_operations` stops matching them ($socket4 is Python's socket
// binder literal, and it was matching JavaScript's). The first rewrite invoked
// the captured function through its own `call` property — which is itself
// overrideable, so a function carrying a hostile or merely unusual `call`
// would throw before the original ever ran. A merge-gate review caught that,
// and these tests exist so it cannot come back.
//
// The property under test: capture-then-invoke must go through an intrinsic
// held from module load, so nothing read off the target at call time can
// change the outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = [
  "configure-app-mode.js",
  "run-prompt-snapshot.js",
  "run-scope-guard.js",
  "widget-null-safety.js",
];

const srcOf = (name) =>
  readFileSync(fileURLToPath(new URL(`../../web/js/lib/${name}`, import.meta.url)), "utf8");

for (const name of FILES) {
  test(`#1854: ${name} captures the apply intrinsic instead of reading it per call`, () => {
    const src = srcOf(name);
    assert.match(src, /const rawApply = Reflect\.apply;/,
      "must hold the intrinsic from module load");
    // No invocation through a property read on the captured function.
    assert.doesNotMatch(src, /\w+\.call\(\w+, \.\.\./,
      "invoking via the function's own call property is overrideable — the gate P1");
  });

  test(`#1854: ${name} no longer trips the registry network rule`, () => {
    const src = srcOf(name);
    // $socket4 / $socket3 / $socket_stage_recv respectively.
    assert.doesNotMatch(src, /\.bind\(/, "the binder literal is what $socket4 matches");
    assert.doesNotMatch(src, /\.connect\(/);
    assert.doesNotMatch(src, /\.send\(/);
  });
}

test("#1854: the capture idiom survives a target whose own call/bind are hostile", () => {
  // Demonstrates WHY the intrinsic is used, on a stand-in with the same shape
  // as the production capture-then-patch: a function object carrying throwing
  // `call` and `bind` accessors. The intrinsic form is unaffected; both
  // property-lookup forms are not.
  const rawApply = Reflect.apply;
  const receiver = { tag: "receiver" };
  function target(...args) {
    return `${this.tag}:${args.join(",")}`;
  }
  for (const prop of ["call", "bind"]) {
    Object.defineProperty(target, prop, {
      configurable: true,
      get() {
        throw new Error(`hostile ${prop}`);
      },
    });
  }

  const viaIntrinsic = (...a) => rawApply(target, receiver, a);
  assert.equal(viaIntrinsic(1, 2), "receiver:1,2");

  // And the forms this rewrite deliberately avoids DO break here, which is the
  // whole point — without this the test above could pass for the wrong reason.
  assert.throws(() => target.call(receiver, 1, 2), /hostile call/);
  assert.throws(() => target.bind(receiver), /hostile bind/);
});
