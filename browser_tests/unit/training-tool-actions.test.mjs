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
  insertBefore(node, ref) {
    const at = this.children.indexOf(ref);
    this.children.splice(at === -1 ? this.children.length : at, 0, node);
    return node;
  }
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
  // Cancel is confirm-gated. Answering YES is the hostile setting for this
  // suite: a NO would make the destructive-frame assertions vacuous.
  globalThis.confirm = () => true;
  globalThis.alert = () => {};
  return () => {
    delete globalThis.document;
    delete globalThis.Option;
    delete globalThis.Image;
    delete globalThis.confirm;
    delete globalThis.alert;
  };
}

/** The first descendant whose class list contains `cls`. */
const byClass = (root, cls) => [...root.walk()].find((e) => e.className.split(/\s+/).includes(cls));
/** The first descendant whose own text is exactly `text`. */
const byText = (root, text) => [...root.walk()].find((e) => e.textContent === text);

/** Every train_* envelope the tab reads, keyed by the (tool, action) PAIR.
 *
 *  Keyed on the pair, not the name, for the same reason the e2e stub is: after
 *  the fold one name carries what were five tools, so a name-keyed fixture
 *  would answer the capability probe with a job listing and quietly make a
 *  wrong-action call look like a working one. */
const REPLIES = new Map(
  Object.entries({
    "train_start:list_flows": { ok: true, flows: [{ id: "character" }], defaultParams: {} },
    // Both forms of action:"status". With an `id` core returns the ONE job;
    // without, every job. The fixture must honour that split or the monitor
    // reads a jobs array where it expects a job.
    "train_start:status": {
      ok: true,
      count: 1,
      jobs: [{ id: "tjob1", name: "test_char", model: "flux1-dev", status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    },
    "train_start:status#id": {
      ok: true,
      job: {
        id: "tjob1", name: "test_char", model: "flux1-dev", status: "running",
        progress: { samples: [], step: 40, totalSteps: 200, loss: 0.42 },
        log: ["40/200"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    },
    "train_start:job_config": {
      ok: true,
      params: { steps: 2000 },
      flow: "character",
      model: "flux1-dev",
      trigger: "ohwx",
      datasetPath: "C:/rig/training/datasets/test_char",
    },
    "train_start:cancel": { ok: true },
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

/** 1x1 transparent GIF — enough to be recognisable in a data: URL. */
const PIXEL_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Actions whose result is NOT a text-wrapped JSON envelope.
 *
 * `train_prepare_dataset action:"file"` returns an MCP IMAGE content block, and
 * the thumbnail path reads `.type`/`.mimeType`/`.data` off it directly rather
 * than through callJson. Modelling it as JSON would let a caller that never
 * finds an image block still look healthy — the thumb loader swallows its own
 * failure and renders nothing, so an unmodelled reply certifies a broken
 * thumbnail path as working.
 */
const RAW_REPLIES = new Map([
  ["train_prepare_dataset:file", [{ type: "image", mimeType: "image/gif", data: PIXEL_B64 }]],
]);

async function mount(t) {
  const restore = installDom();
  const { createTrainingContent } = await import("../../web/js/cmcp-training-ui.js");
  const calls = [];
  const callTool = (tool, args, opts) => {
    calls.push({ tool, args, opts });
    const key = `${tool}:${args?.action}`;
    const raw = RAW_REPLIES.get(key);
    if (raw) return Promise.resolve({ ok: true, result: raw });
    const payload = REPLIES.get(args?.id ? `${key}#id` : key) ?? REPLIES.get(key);
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

test("Jobs lists via train_start action:status — the retired standalone status tool is gone", async (t) => {
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
  // The RESPONSE must land, not merely the request. The thumb loader swallows
  // its own failure and renders nothing, so asserting only that the frame was
  // sent would stay green with every thumbnail broken — including under a
  // content-block regression, which is exactly what a fold could cause.
  const img = [...root.walk()].find((e) => e.tagName === "IMG");
  assert.ok(img, "the dataset detail view must render a thumb from the inlined bytes");
  assert.equal(img.src, `data:image/gif;base64,${PIXEL_B64}`);
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

test("Cancel run sends train_start action:cancel — NOT action:delete, which destroys the job", async (t) => {
  const { calls, subnav, root, view } = await mount(t);
  const [jobsBtn] = subnav;
  await gesture(calls, () => jobsBtn.click());
  // Open the running job's monitor by clicking its real row in the jobs list.
  const jobRow = byClass(root, "cmcp-tr-jobrow");
  assert.ok(jobRow, "the jobs view must render a row per job");
  const opened = await gesture(calls, () => jobRow.click());
  // Entering the monitor reads the settings the job ran with and polls it.
  assert.deepEqual(
    [...new Set(pairs(opened))].sort(),
    ["train_start:job_config", "train_start:status"],
  );
  assert.deepEqual(
    opened.find((c) => c.args.action === "job_config").args,
    { action: "job_config", id: "tjob1" },
  );
  // The id-scoped status form — omitting the id here would poll EVERY job and
  // render the wrong one's progress.
  assert.deepEqual(
    opened.find((c) => c.args.action === "status").args,
    { action: "status", id: "tjob1" },
  );

  const cancelBtn = byText(root, "Cancel run");
  assert.ok(cancelBtn, "the monitor must offer a Cancel control");
  // Stop the poll first so the slice this gesture produces is the cancel alone
  // and a timer tick cannot smuggle a frame into it.
  view.onDeactivate();
  const produced = await gesture(calls, () => cancelBtn.click());
  assert.equal(produced.length, 1, `Cancel must send exactly one frame, got ${JSON.stringify(pairs(produced))}`);
  assert.equal(produced[0].tool, "train_start");
  // The whole args object, not just the action: `delete` is one word away on
  // the same tool with the same `id`, and it destroys the job's record and
  // outputs instead of stopping the run.
  assert.deepEqual(produced[0].args, { action: "cancel", id: "tjob1" });
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
