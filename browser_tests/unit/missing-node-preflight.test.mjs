// comfyui-mcp#1460 — a run queued nodes the server cannot dispatch, one rejection at
// a time.
//
// MEASURED on a live rig: an unregistered type stays on the canvas and is included in
// the prompt by ComfyUI's OWN serializer, with class_type undefined —
//
//   canvas:  { id: "45", type: "TotallyNotInstalledNode", comfyClass: undefined }
//   graphToPrompt() ids: ["1", "45"]
//   prompt["45"].class_type: undefined
//
// which is the reporter's error verbatim. They found four such types sequentially,
// removing and rewiring nodes after each rejection. All four were knowable up front.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  findUnregisteredTypes,
  missingNodeRunRefusal,
} from "../../web/js/lib/missing-node-preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A server that defines `known` and answers {} for everything else. */
const server = (known, { fail = [] } = {}) => async (cls) => {
  if (fail.includes(cls)) throw new Error("network");
  return known.includes(cls) ? { [cls]: { input: {} } } : {};
};

test("#1460 an uninstalled type is reported missing", async () => {
  const { missing, unknown } = await findUnregisteredTypes(
    ["PreviewImage", "FastFilmGrain"],
    server(["PreviewImage"]),
  );
  assert.deepEqual(missing, ["FastFilmGrain"]);
  assert.deepEqual(unknown, []);
});

test("#1460 an unreachable lookup is UNKNOWN, never missing", async () => {
  // The property that keeps this from becoming a new false failure: refusing a run
  // because a metadata probe failed would trade one bad refusal for another.
  const { missing, unknown } = await findUnregisteredTypes(
    ["PreviewImage", "Flaky"],
    server(["PreviewImage"], { fail: ["Flaky"] }),
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(unknown, ["Flaky"]);
});

test("#1460 a null answer is unknown too, not missing", async () => {
  const { missing, unknown } = await findUnregisteredTypes(["X"], async () => null);
  assert.deepEqual(missing, []);
  assert.deepEqual(unknown, ["X"]);
});

test("#1460 it asks once per DISTINCT type", async () => {
  // A canvas with thirty KSamplers must not become thirty requests (#589 budget).
  const asked = [];
  await findUnregisteredTypes(["KSampler", "KSampler", "KSampler", "PreviewImage"], async (c) => {
    asked.push(c);
    return { [c]: {} };
  });
  assert.deepEqual(asked, ["KSampler", "PreviewImage"]);
});

test("#1460 it is bounded", async () => {
  const asked = [];
  const many = Array.from({ length: 500 }, (_, i) => `T${i}`);
  await findUnregisteredTypes(many, async (c) => { asked.push(c); return { [c]: {} }; }, { maxTypes: 10 });
  assert.equal(asked.length, 10);
});

test("#1460 bad inputs yield nothing rather than throwing", async () => {
  for (const [types, fn] of [[null, async () => ({})], [["A"], null], [undefined, undefined]]) {
    const r = await findUnregisteredTypes(types, fn);
    assert.deepEqual(r, { missing: [], unknown: [] });
  }
});

test("#1460 the refusal names EVERY type and the node ids each accounts for", () => {
  // The reporter's actual cost was not knowing which node came next.
  const msg = missingNodeRunRefusal({
    missing: ["FastFilmGrain", "CLIPLoaderGGUF"],
    nodesByType: { FastFilmGrain: [45, 49], CLIPLoaderGGUF: [175] },
  });
  assert.match(msg, /^NOT queued:/);
  assert.match(msg, /"FastFilmGrain" \(node 45, 49\)/);
  assert.match(msg, /"CLIPLoaderGGUF" \(node 175\)/);
  // It explains WHY the server's own error is unhelpful, so this reads as a cause.
  assert.match(msg, /has no class_type/);
  assert.match(msg, /one rejection at a time/);
  // And what to do.
  assert.match(msg, /install_custom_node|ComfyUI-Manager/);
  assert.match(msg, /RESTART ComfyUI/);
  // Nothing was queued — the caller must not go looking for a partial run.
  assert.match(msg, /Nothing was queued/);
});

test("#1460 unchecked types are disclosed but explicitly NOT the reason", () => {
  const msg = missingNodeRunRefusal({
    missing: ["A"],
    nodesByType: { A: [1] },
    unknown: ["B", "C"],
  });
  assert.match(msg, /could NOT be checked/);
  assert.match(msg, /not evidence they are missing/);
  assert.match(msg, /NOT why this refused/);
});

test("#1460 WIRING: graph_run pre-flights before it can queue", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(src, /import \{\s*findUnregisteredTypes,\s*missingNodeRunRefusal,\s*\} from "\.\/lib\/missing-node-preflight\.js";/);
  const at = src.indexOf("async graph_run({");
  assert.ok(at > 0, "graph_run must exist");
  // Wide enough to contain the queue call itself: at 4000 chars `indexOf` returned
  // -1 and the ordering assertion below passed VACUOUSLY. The window is asserted to
  // actually contain both landmarks before they are compared.
  const body = src.slice(at, at + 20000);
  assert.match(body, /findUnregisteredTypes\(/, "the pre-flight runs inside graph_run");
  assert.match(body, /throw new Error\(missingNodeRunRefusal\(/, "and refuses with the full list");
  // It must run BEFORE the queue call, or it protects nothing.
  const preflightAt = body.indexOf("findUnregisteredTypes(");
  const queueAt = body.indexOf("app.queuePrompt(");
  assert.ok(preflightAt > 0, "the pre-flight must be present");
  assert.ok(queueAt > 0, "the queue call must be inside the window, or this proves nothing");
  assert.ok(preflightAt < queueAt, "the pre-flight must precede queuePrompt");
  // Only our refusal escapes: a broken probe must leave the run as it was.
  assert.match(body, /if \(err instanceof Error && \/\^NOT queued:\/\.test\(err\.message\)\) throw err;/);
});
