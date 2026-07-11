import { test } from "node:test";
import assert from "node:assert/strict";
import { validateA2UISpec, isAllowedImageSrc, A2UI_CAPS } from "../web/js/cmcp-a2ui.js";

const ok = (spec) => {
  const r = validateA2UISpec(spec);
  assert.equal(r.ok, true, JSON.stringify(r.errors ?? []));
  return r.spec;
};
const bad = (spec, needle) => {
  const r = validateA2UISpec(spec);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes(needle)), `expected error containing "${needle}", got ${JSON.stringify(r.errors)}`);
};

const minimal = () => ({
  root: "c1",
  components: [
    { id: "c1", type: "Column", children: ["t", "b"] },
    { id: "t", type: "Text", text: "hi" },
    { id: "b", type: "Button", label: "Go", reply: "go" },
  ],
});

test("accepts a minimal valid card", () => {
  const spec = ok(minimal());
  assert.equal(spec.surface, "inline"); // default applied
});

test("rejects non-object / missing root / missing components", () => {
  bad(null, "spec must be an object");
  bad({ components: [] }, "root");
  bad({ root: "x" }, "components");
});

test("rejects unknown component type", () => {
  const s = minimal();
  s.components.push({ id: "z", type: "Script", text: "evil" });
  bad(s, "unknown type");
});

test("rejects dangling child / root refs and duplicate ids", () => {
  const s = minimal();
  s.components[0].children = ["t", "missing"];
  bad(s, "unknown component id");
  const d = minimal();
  d.components.push({ id: "t", type: "Text", text: "dup" });
  bad(d, "duplicate id");
  bad({ root: "nope", components: [{ id: "c1", type: "Text", text: "x" }] }, "unknown component id");
});

test("rejects reference cycles and over-depth nesting", () => {
  bad(
    { root: "a", components: [
      { id: "a", type: "Column", children: ["b"] },
      { id: "b", type: "Column", children: ["a"] },
    ] },
    "cycle",
  );
  // depth cap: chain deeper than A2UI_CAPS.maxDepth
  const comps = [];
  for (let i = 0; i <= A2UI_CAPS.maxDepth + 1; i++) {
    comps.push({ id: `n${i}`, type: "Column", children: i <= A2UI_CAPS.maxDepth ? [`n${i + 1}`] : [] });
  }
  bad({ root: "n0", components: comps }, "depth");
});

test("enforces caps: component count, graph nodes, chart points, option count, string lengths", () => {
  const many = { root: "c", components: [{ id: "c", type: "Column", children: [] }] };
  for (let i = 0; i < A2UI_CAPS.maxComponents; i++) {
    many.components.push({ id: `t${i}`, type: "Text", text: "x" });
    many.components[0].children.push(`t${i}`);
  }
  bad(many, "components");

  bad({ root: "g", components: [{ id: "g", type: "comfy:graph",
    nodes: Array.from({ length: A2UI_CAPS.maxGraphNodes + 1 }, (_, i) => ({ id: `n${i}`, label: "n" })),
    edges: [] }] }, "graph nodes");

  bad({ root: "ch", components: [{ id: "ch", type: "comfy:chart", kind: "line",
    series: [{ label: "s", values: Array.from({ length: A2UI_CAPS.maxChartPoints + 1 }, () => 1) }] }] }, "points");

  bad({ root: "s", components: [{ id: "s", type: "Select", label: "L", name: "n",
    options: Array.from({ length: A2UI_CAPS.maxSelectOptions + 1 }, (_, i) => ({ label: `o${i}` })) }] }, "options");

  bad({ root: "t", components: [{ id: "t", type: "Text", text: "x".repeat(A2UI_CAPS.maxTextLen + 1) }] }, "too long");
});

test("graph edges must reference declared node ids", () => {
  bad({ root: "g", components: [{ id: "g", type: "comfy:graph",
    nodes: [{ id: "a", label: "A" }],
    edges: [{ from: "a", to: "ghost" }] }] }, "unknown graph node");
});

test("rejects empty graph-node ids (server/panel lockstep)", () => {
  bad({ root: "g", components: [{ id: "g", type: "comfy:graph",
    nodes: [{ id: "", label: "x" }] }] }, "graph node id");
});

test("image src origin restriction", () => {
  assert.equal(isAllowedImageSrc("/view?filename=x.png&type=output"), true);
  assert.equal(isAllowedImageSrc("/api/view?filename=x.png"), true);
  assert.equal(isAllowedImageSrc("blob:http://127.0.0.1:8188/abc"), true);
  assert.equal(isAllowedImageSrc("data:image/png;base64,AAAA"), true);
  assert.equal(isAllowedImageSrc("https://evil.example/x.png"), false);
  assert.equal(isAllowedImageSrc("javascript:alert(1)"), false);
  assert.equal(isAllowedImageSrc("data:text/html,<b>x</b>"), false);
  bad({ root: "i", components: [{ id: "i", type: "Image", src: "https://evil.example/x.png" }] }, "image src");
});

test("surface enum and unknown top-level surface value", () => {
  ok({ ...minimal(), surface: "wide" });
  bad({ ...minimal(), surface: "fullscreen" }, "surface");
});

test("rejects repeated child references that inflate the render tree", () => {
  bad({ root: "col", components: [
    { id: "col", type: "Column", children: Array(50000).fill("t") },
    { id: "t", type: "Text", text: "x" },
  ] }, "children");
  bad({ root: "a", components: [
    { id: "a", type: "Column", children: Array(10).fill("b") },
    { id: "b", type: "Column", children: Array(10).fill("c") },
    { id: "c", type: "Text", text: "x" },
  ] }, "instances");
});

test("caps image INSTANCES in the render tree, not just declared Images", () => {
  bad({ root: "col", components: [
    { id: "col", type: "Column", children: ["i", "i", "i", "i", "i"] },
    { id: "i", type: "Image", src: "/view?filename=x.png" },
  ] }, "image instances");
});

test("returned spec is detached plain data (no TOCTOU via getters or later mutation)", () => {
  let calls = 0;
  const comp = { id: "t", type: "Text" };
  Object.defineProperty(comp, "text", { enumerable: true, get() { return calls++ === 0 ? "hi" : "x".repeat(999999); } });
  const raw = { root: "c", components: [{ id: "c", type: "Column", children: ["t"] }, comp] };
  const r = validateA2UISpec(raw);
  assert.equal(r.ok, true);
  assert.equal(r.spec.components[1].text, "hi");
  raw.components[0].children.push("t");
  assert.equal(r.spec.components[0].children.length, 1);
});

test("rejects cyclic raw objects and over-long chart x arrays; NaN values rejected explicitly", () => {
  const cyc = { root: "c", components: [{ id: "c", type: "Text", text: "x" }] };
  cyc.self = cyc;
  bad(cyc, "JSON-serializable");
  bad({ root: "ch", components: [{ id: "ch", type: "comfy:chart", kind: "bar",
    x: Array.from({ length: A2UI_CAPS.maxChartPoints + 1 }, () => "l"),
    series: [{ label: "s", values: [1] }] }] }, "x labels");
  bad({ root: "ch", components: [{ id: "ch", type: "comfy:chart", kind: "line",
    series: [{ label: "s", values: [1, NaN] }] }] }, "finite");
});
