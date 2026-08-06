// The Training tab must call the CONSOLIDATED train_* tools with an explicit
// action on every path.
//
// 0.50.0 slice 10 folded eighteen train_* tools into three: `train_start`
// (7 actions), `train_prepare_dataset` (8) and `train_doctor` (3). SEVEN of the
// tab's call sites named tools that no longer exist — status, cancel,
// list_flows, job_config, list_datasets, dataset_detail and file — which is the
// whole Training tab: the jobs list, the dataset browser, every thumbnail, the
// capability probe, the monitor poll and Cancel.
//
// WHY A NAME CHECK IS NOT ENOUGH, AND WHY THIS DRIVES THE REAL HANDLERS.
// The vocabulary gate proves `train_start` is a real tool. It cannot prove which
// ACTION reaches it — and after the fold, one wrong action word is a different
// tool. `train_start action:"delete"` DESTROYS A JOB where action:"cancel" stops
// it, and `train_prepare_dataset action:"delete"` destroys a whole staged
// dataset (images and captions) where action:"detail" merely reads it. Both are
// one token away from the calls below, both pass every name-based check, and
// neither is recoverable. Only invoking the handler and reading the frame it
// produced can tell them apart, so this mounts the module against a minimal DOM
// and drives it.
//
// The gate's section 1b (action-as-first-key) is the static half of this and
// catches an OMITTED action across every call site including ones no test
// mounts. It is deliberately blind to the action's VALUE — that is this file.
import test from "node:test";
import assert from "node:assert/strict";

// ── minimal DOM ────────────────────────────────────────────────────────────
// Only what cmcp-training-ui.js and its import chain touch, on the same terms
// as runpod-tool-actions.test.mjs: a fuller shim would let the module lean on
// behaviour this file does not model.
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
  set innerHTML(v) { this._text = String(v ?? ""); this.children = []; }
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
  click() {
    if (typeof this.onclick === "function") this.onclick({ preventDefault() {} });
    this.dispatch("click");
  }
  focus() {}
  get value() { return this._value !== undefined ? this._value : (this.children[0]?.value ?? ""); }
  set value(v) { this._value = v; }
  /** Depth-first walk of everything appended under this node. */
  *walk() {
    for (const c of this.children) {
      if (!(c instanceof El)) continue;
      yield c;
      yield* c.walk();
    }
  }
}

function installDom() {
  const head = new El("head");
  globalThis.document = { createElement: (t) => new El(t), head, body: new El("body") };
  globalThis.Option = class { constructor(label, value) { this.label = label; this.value = value ?? ""; } };
  // Thumbnails construct an Image and never await it here.
  globalThis.Image = class { constructor() { this.style = {}; } };
  return () => {
    delete globalThis.document;
    delete globalThis.Option;
    delete globalThis.Image;
  };
}

/** Every train_* envelope the tab reads, keyed by the (tool, action) PAIR.
 *
 *  Keyed on the pair, not the name, for the same reason the e2e stub is: after
 *  the fold one name carries what were five tools, so a name-keyed fixture
 *  would answer the capability probe with a job listing and quietly make a
 *  wrong-action call look like a working one. */
const REPLIES = new Map(
  Object.entries({
    "train_start:list_flows": { ok: true, flows: [{ id: "character" }], defaultParams: {} },
    "train_start:status": {
      ok: true,
      count: 1,
      jobs: [{ id: "tjob1", name: "test_char", status: "completed", updatedAt: new Date().toISOString() }],
    },
    "train_prepare_dataset:list": {
      ok: true,
      datasets: [{ name: "test_char", imageCount: 2, captionedCount: 2, modified: new Date().toISOString() }],
    },
    "train_prepare_dataset:detail": {
      ok: true,
      name: "test_char",
      datasetPath: "C:/rig/training/datasets/test_char",
      imageCount: 1,
      captionedCount: 1,
      items: [{ file: "a.png", caption: "ohwx" }],
    },
    "train_doctor:doctor": {
      ok: true,
      data: { docker: true, gpu: true, image: true, hints: [], hfTokenSet: true, localFs: true, pod: null },
    },
  }),
);

async function mount(t) {
  const restore = installDom();
  const { createTrainingContent } = await import("../../web/js/cmcp-training-ui.js");
  const calls = [];
  const callTool = (tool, args, opts) => {
    calls.push({ tool, args, opts });
    const payload = REPLIES.get(`${tool}:${args?.action}`);
    // An UNSCRIPTED pair rejects rather than returning a plausible envelope.
    // Returning `{ok:true}` for anything unrecognised is how a fixture certifies
    // a call it never actually modelled.
    if (!payload) return Promise.reject(new Error(`unscripted call ${tool} action:${String(args?.action)}`));
    return Promise.resolve({ ok: true, result: [{ text: JSON.stringify(payload) }] });
  };
  const modal = new El("div");
  modal.querySelectorAll = () => [];
  modal.querySelector = () => null;
  const shell = { modal, close() {}, syncSearch() {} };
  const view = createTrainingContent({ callTool, api: null }, shell, {});
  const root = new El("div");
  view.mount(root);
  t.after(() => { view.teardown(); restore(); });
  return { calls, view, root, subnav: view.subnavExtras() };
}

/** Several macrotask turns, not one: a render awaits its own tool call and its
 *  CONTINUATION issues the next (detail → one thumb per item), so a single turn
 *  would see the first call and none of the follow-ups. Draining is what lets
 *  the assertions below pin the WHOLE slice a gesture produced. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Every call a single gesture produced — not merely the one we hoped for. */
async function gesture(calls, act) {
  const before = calls.length;
  await act();
  await flush();
  return calls.slice(before);
}

const pairs = (produced) => produced.map((c) => `${c.tool}:${String(c.args?.action)}`);

test("Jobs lists via train_start action:status — not the retired train_status", async (t) => {
  const { calls, subnav } = await mount(t);
  const [jobsBtn] = subnav;
  const produced = await gesture(calls, () => jobsBtn.click());
  // EXACTLY one call. Asserting the whole slice, not merely that status is in
  // it: a jobs view that also fired, say, action:"delete" would satisfy a
  // find().
  assert.deepEqual(pairs(produced), ["train_start:status"]);
  const status = produced.find((c) => c.args.action === "status");
  // No `id`: the jobs list is the omit-id form, which returns EVERY job. Passing
  // an id here would silently render one job as if it were the whole list.
  assert.deepEqual(status.args, { action: "status" });
});

test("Datasets lists via train_prepare_dataset action:list, and a row opens action:detail then action:file", async (t) => {
  const { calls, subnav, root } = await mount(t);
  const [, datasetsBtn] = subnav;
  const produced = await gesture(calls, () => datasetsBtn.click());
  assert.deepEqual(pairs(produced), ["train_prepare_dataset:list"]);
  // No `name`: the listing form. action:"detail" is the one that takes a name,
  // and action:"delete" — one word away — destroys the dataset it is given.
  assert.deepEqual(produced[0].args, { action: "list" });

  // The dataset row the listing rendered — found by the data-ref the view stamps
  // on it, so this cannot pass by clicking some other button.
  const row = [...root.walk()].find((e) => e.dataset.ref === "dataset:test_char");
  assert.ok(row, "the datasets view must render a row per staged dataset");
  const opened = await gesture(calls, () => row.click());
  // detail reads the dataset; file inlines ONE thumb, one per item.
  assert.deepEqual(pairs(opened), ["train_prepare_dataset:detail", "train_prepare_dataset:file"]);
  assert.deepEqual(opened[0].args, { action: "detail", name: "test_char" });
  assert.deepEqual(opened[1].args, {
    action: "file",
    path: "C:/rig/training/datasets/test_char/a.png",
  });
});

test("the capability probe is train_start action:list_flows", async (t) => {
  const { calls, view } = await mount(t);
  // Advancing a wizard step re-runs the backend probe. It is asserted through a
  // real entry point rather than by calling the private helper, so a probe that
  // stopped being reached would fail here too.
  const produced = await gesture(calls, () => view.drive.gotoStep(2).catch(() => {}));
  assert.ok(
    produced.some((c) => c.tool === "train_start" && c.args.action === "list_flows"),
    `advancing a step must probe the trainer backend, got ${JSON.stringify(pairs(produced))}`,
  );
  const probe = produced.find((c) => c.args.action === "list_flows");
  // No arguments beyond the action: list_flows is the no-parameter form.
  assert.deepEqual(probe.args, { action: "list_flows" });
});

test("the pod preflight is train_doctor action:doctor — bootstrap and build_image are NOT reachable from here", async (t) => {
  const { calls, view } = await mount(t);
  const produced = await gesture(calls, async () => {
    // No pod in the scripted doctor result, so setTarget("pod") is expected to
    // reject; what is under test is the FRAME it sent on the way.
    await view.drive.setTarget("pod").catch(() => {});
  });
  const doctor = produced.filter((c) => c.tool === "train_doctor");
  assert.equal(doctor.length, 1, `expected one preflight, got ${JSON.stringify(pairs(produced))}`);
  assert.deepEqual(doctor[0].args, { action: "doctor" });
  // Both of the other two actions this name now carries are long, expensive and
  // (per core's admission list) not reachable from the direct-call channel at
  // all: bootstrap runs a ~10 minute install, build_image a multi-GB docker
  // build. A preflight must never send either.
  assert.deepEqual(
    produced.filter((c) => c.args.action === "bootstrap" || c.args.action === "build_image"),
    [],
  );
});

test("every train_* call carries a non-empty action, and names only the three survivors", async (t) => {
  const SURVIVORS = new Set(["train_start", "train_prepare_dataset", "train_doctor"]);
  const { calls, view, subnav, root } = await mount(t);
  const [jobsBtn, datasetsBtn] = subnav;
  view.onActivate();
  await flush();
  jobsBtn.click();
  await flush();
  datasetsBtn.click();
  await flush();
  const row = [...root.walk()].find((e) => e.dataset.ref === "dataset:test_char");
  if (row) row.click();
  await flush();
  await view.drive.setTarget("pod").catch(() => {});
  await flush();

  assert.ok(calls.length >= 5, `expected several calls, got ${calls.length}`);
  for (const c of calls) {
    assert.ok(SURVIVORS.has(c.tool), `${c.tool} is not one of the three tools slice 10 left standing`);
    assert.equal(
      typeof c.args?.action,
      "string",
      `${c.tool} called with no action — REQUIRED on all three survivors, so core rejects the call even though the name is alive`,
    );
    assert.notEqual(c.args.action, "", "an empty action is not a dispatchable action");
  }
});
