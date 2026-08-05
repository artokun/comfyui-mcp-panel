// The RunPod control panel must call the CONSOLIDATED `runpod` tool with an
// explicit action on every button.
//
// 0.50.0 slice 8 folded eleven runpod_* tools into `runpod` (8 actions) and
// `runpod_watch` (3). Seven call sites here named tools that no longer exist, so
// the entire control panel — connect, start, stop, use-local, deploy, the pod
// dropdown and the referral link — returned tool-not-found against core main.
//
// WHY THIS DRIVES THE REAL BUTTONS rather than asserting over the source text.
// The vocabulary gate already proves the NAME `runpod` is real, and a grep would
// prove the string `action` appears nearby. Neither can prove that the Stop
// button sends action:"stop" rather than action:"start" — a transposition that
// costs money, since `start` resumes billing on a pod the user asked to stop.
// Only invoking the handler and reading the frame it produced shows that, so
// this mounts the module against a minimal DOM and clicks.
//
// The `action` argument is load-bearing beyond dispatch: the orchestrator's
// direct-call admission (call-tool-admission.ts) is ACTION-scoped for `runpod`,
// so a call carrying the right name and no action is refused outright rather
// than defaulted. That is why assertion 8 pins "every call carries one".
import test from "node:test";
import assert from "node:assert/strict";

// ── minimal DOM ────────────────────────────────────────────────────────────
// Only what cmcp-runpod-ui.js touches. Kept deliberately small: a fuller shim
// would let the module rely on behaviour this file does not actually model.
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._listeners = new Map();
    this._text = "";
    this._className = "";
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes().add(x)),
      remove: (...c) => c.forEach((x) => this._classes().delete(x)),
      toggle: (c, on) => (on ? this._classes().add(c) : this._classes().delete(c)),
      contains: (c) => this._classes().has(c),
    };
  }
  _classes() {
    const set = new Set(this._className.split(/\s+/).filter(Boolean));
    const sync = () => (this._className = [...set].join(" "));
    return { add: (c) => (set.add(c), sync()), delete: (c) => (set.delete(c), sync()), has: (c) => set.has(c) };
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  set innerHTML(v) { this._text = String(v ?? ""); this.children = []; this._value = undefined; }
  get innerHTML() { return this._text; }
  append(...kids) { this.children.push(...kids); }
  appendChild(k) { this.children.push(k); return k; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatch(type, ev = {}) {
    for (const fn of this._listeners.get(type) ?? []) fn({ preventDefault() {}, ...ev });
  }
  click() { this.dispatch("click"); }
  focus() {}
  // <select>: value defaults to the first option, as in a real select.
  get value() { return this._value !== undefined ? this._value : (this.children[0]?.value ?? ""); }
  set value(v) { this._value = v; }
}
class Opt {
  constructor(label, value) { this.label = label; this.value = value ?? ""; }
}

function installDom() {
  const head = new El("head");
  globalThis.document = { createElement: (t) => new El(t), head, body: new El("body") };
  globalThis.Option = Opt;
  return () => { delete globalThis.document; delete globalThis.Option; };
}

// The module builds its elements in a fixed order; grab them off the mounted tree.
function handles(mountEl) {
  const [, , , connectRow, , actions, linkRow] = mountEl.children;
  const [podSelect, refreshBtn, connectBtn] = connectRow.children;
  const [startBtn, stopBtn, localBtn, deployBtn] = actions.children;
  return { podSelect, refreshBtn, connectBtn, startBtn, stopBtn, localBtn, deployBtn, linkBtn: linkRow.children[0] };
}

async function mount(t, opts) {
  const restore = installDom();
  const { createLocalContent } = await import("../../web/js/cmcp-runpod-ui.js");
  const calls = [];
  const callTool = (tool, args, o) => {
    calls.push({ tool, args, opts: o });
    const text =
      tool === "runpod" && args?.action === "list"
        ? "**My Pod** `abc123` — RUNNING · RTX 4090"
        : "ok";
    return Promise.resolve({ ok: true, result: [{ text }] });
  };
  const view = createLocalContent(
    {
      callTool,
      getStatus: () => opts?.status ?? null,
      getTarget: () => opts?.target ?? null,
      openUrl: () => {},
    },
    null,
    {},
  );
  const root = new El("div");
  view.mount(root);
  const el = handles(root.children[0]);
  // Registered, not left to the end of the test body: a FAILING assertion throws
  // past any trailing teardown, and the 1s countdown interval then keeps the
  // event loop alive forever — so the suite hangs instead of reporting which
  // assertion failed. Found by mutating the deploy-arming guard.
  t.after(() => { view.teardown(); restore(); });
  return { calls, view, el };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("the pod dropdown lists via runpod action:list", async (t) => {
  const { calls, view } = await mount(t);
  view.onActivate();
  await flush();
  const list = calls.filter((c) => c.args?.action === "list");
  assert.equal(list.length, 1, "activating the tab loads the pod list once");
  assert.equal(list[0].tool, "runpod");
  assert.deepEqual(list[0].args, { action: "list" });
});

test("Connect sends runpod action:connect with the selected pod id", async (t) => {
  const { calls, view, el } = await mount(t);
  view.onActivate();
  await flush();
  el.connectBtn.click();
  await flush();
  const c = calls.find((x) => x.args?.action === "connect");
  assert.ok(c, "Connect must issue a connect action");
  assert.equal(c.tool, "runpod");
  assert.equal(c.args.pod_id, "abc123", "the pod id from the dropdown must be forwarded");
});

test("Start sends runpod action:start, Stop sends action:stop — not transposed", async (t) => {
  const status = { watching: true, pod_id: "abc123", status: "RUNNING" };
  {
    const { calls, view, el } = await mount(t, { status });
    view.onActivate();
    await flush();
    el.startBtn.click();
    await flush();
    const c = calls.find((x) => x.args?.action && x.args.action !== "list");
    assert.equal(c.tool, "runpod");
    assert.equal(c.args.action, "start", "Start must not send stop");
    assert.equal(c.args.pod_id, "abc123");
  }
  {
    const { calls, view, el } = await mount(t, { status });
    view.onActivate();
    await flush();
    el.stopBtn.click();
    await flush();
    const c = calls.find((x) => x.args?.action && x.args.action !== "list");
    assert.equal(c.tool, "runpod");
    assert.equal(c.args.action, "stop", "Stop must not send start — start RESUMES billing");
    assert.equal(c.args.pod_id, "abc123");
  }
});

test("Use Local sends runpod action:use_local", async (t) => {
  const { calls, view, el } = await mount(t, {
    status: { watching: true, pod_id: "abc123", status: "RUNNING" },
    target: { is_local: false },
  });
  view.onActivate();
  await flush();
  el.localBtn.click();
  await flush();
  const c = calls.find((x) => x.args?.action === "use_local");
  assert.ok(c, "Use Local must issue use_local");
  assert.equal(c.tool, "runpod");
});

test("Deploy sends runpod action:create only after the second, confirming click", async (t) => {
  const { calls, view, el } = await mount(t);
  view.onActivate();
  await flush();
  el.deployBtn.click(); // arms
  await flush();
  assert.equal(
    calls.filter((x) => x.args?.action === "create").length,
    0,
    "arming must not deploy — a deploy bills GPU-time",
  );
  // The arming cool-down ignores a confirm that lands too soon; wait it out.
  await new Promise((r) => setTimeout(r, 700));
  el.deployBtn.click(); // confirms
  await flush();
  const c = calls.find((x) => x.args?.action === "create");
  assert.ok(c, "the confirming click must deploy");
  assert.equal(c.tool, "runpod");
  assert.equal(c.opts?.timeout, 120000, "deploy keeps its long timeout");
});

test("the referral link sends runpod action:deploy_link", async (t) => {
  const { calls, view, el } = await mount(t);
  view.onActivate();
  await flush();
  el.linkBtn.dispatch("click");
  await flush();
  const c = calls.find((x) => x.args?.action === "deploy_link");
  assert.ok(c, "the referral link must issue deploy_link");
  assert.equal(c.tool, "runpod");
});

test("every runpod call carries a non-empty action — a bare name is refused server-side", async (t) => {
  const status = { watching: true, pod_id: "abc123", status: "RUNNING" };
  const { calls, view, el } = await mount(t, { status, target: { is_local: false } });
  view.onActivate();
  await flush();
  for (const b of [el.connectBtn, el.startBtn, el.stopBtn, el.localBtn, el.refreshBtn]) {
    b.click();
    await flush();
  }
  el.linkBtn.dispatch("click");
  await flush();
  assert.ok(calls.length >= 6, `expected several calls, got ${calls.length}`);
  for (const c of calls) {
    assert.equal(c.tool, "runpod", `unexpected tool ${c.tool} — slice 8 folded them all into runpod`);
    assert.equal(
      typeof c.args?.action,
      "string",
      `call to ${c.tool} carries no action; admission refuses it outright`,
    );
    assert.notEqual(c.args.action, "", "an empty action is not a dispatchable action");
  }
});
