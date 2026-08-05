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

/**
 * Every call a single gesture produced — not merely the one we hoped for.
 *
 * `calls.find(a => a.action === "stop")` proves the expected frame EXISTS; it
 * cannot prove no OTHER frame went with it. A Stop handler that emitted stop and
 * then a spurious start would satisfy it while leaving the pod running and
 * billing, which is the exact outcome the user pressed Stop to avoid. So each
 * gesture is measured against a snapshot taken immediately before it, and the
 * whole slice is asserted.
 */
async function gesture(calls, act) {
  const before = calls.length;
  await act();
  await flush();
  return calls.slice(before);
}

/** The one call a gesture must produce, asserted exactly. */
function onlyCall(produced, args, opts) {
  assert.equal(produced.length, 1, `expected exactly one call, got ${JSON.stringify(produced)}`);
  assert.equal(produced[0].tool, "runpod", "slice 8 folded every runpod_* name into `runpod`");
  assert.deepEqual(produced[0].args, args);
  if (opts !== undefined) assert.deepEqual(produced[0].opts, opts);
  return produced[0];
}

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
  const produced = await gesture(calls, () => el.connectBtn.click());
  onlyCall(produced, { action: "connect", pod_id: "abc123" });
});

test("Start sends runpod action:start, Stop sends action:stop — not transposed", async (t) => {
  const status = { watching: true, pod_id: "abc123", status: "RUNNING" };
  {
    const { calls, view, el } = await mount(t, { status });
    view.onActivate();
    await flush();
    const produced = await gesture(calls, () => el.startBtn.click());
    onlyCall(produced, { action: "start", pod_id: "abc123" });
  }
  {
    const { calls, view, el } = await mount(t, { status });
    view.onActivate();
    await flush();
    const produced = await gesture(calls, () => el.stopBtn.click());
    // Exactly one call: a trailing spurious `start` here would resume billing on
    // the pod the user just asked to stop.
    onlyCall(produced, { action: "stop", pod_id: "abc123" });
  }
});

test("Use Local sends runpod action:use_local", async (t) => {
  const { calls, view, el } = await mount(t, {
    status: { watching: true, pod_id: "abc123", status: "RUNNING" },
    target: { is_local: false },
  });
  view.onActivate();
  await flush();
  const produced = await gesture(calls, () => el.localBtn.click());
  onlyCall(produced, { action: "use_local" });
});

test("Deploy sends runpod action:create only after the second, confirming click", async (t) => {
  const { calls, view, el } = await mount(t);
  view.onActivate();
  await flush();
  const arming = await gesture(calls, () => el.deployBtn.click());
  assert.deepEqual(arming, [], "arming must issue NO call — a deploy bills GPU-time");
  // The arming cool-down ignores a confirm that lands too soon; wait it out.
  await new Promise((r) => setTimeout(r, 700));
  const produced = await gesture(calls, () => el.deployBtn.click());
  // Deploy legitimately re-lists afterwards to show the new pod, so this cannot
  // use onlyCall(). It is still pinned exactly: the create must come first, must
  // happen EXACTLY ONCE (two creates = two pods = double billing, which an
  // allowed-set check alone would wave through), and every remaining call in the
  // slice must be the follow-up list and nothing else.
  assert.equal(produced[0].tool, "runpod");
  assert.deepEqual(produced[0].args, { action: "create" });
  assert.equal(produced[0].opts?.timeout, 120000, "deploy keeps its long timeout");
  assert.equal(
    produced.filter((c) => c.args.action === "create").length,
    1,
    "a confirmed deploy must create exactly one pod",
  );
  assert.deepEqual(
    produced.slice(1).filter((c) => c.tool !== "runpod" || c.args.action !== "list"),
    [],
    "confirming a deploy must not also start/stop/connect anything",
  );
});

test("the referral link sends runpod action:deploy_link", async (t) => {
  const { calls, view, el } = await mount(t);
  view.onActivate();
  await flush();
  const produced = await gesture(calls, () => el.linkBtn.dispatch("click"));
  onlyCall(produced, { action: "deploy_link" });
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
