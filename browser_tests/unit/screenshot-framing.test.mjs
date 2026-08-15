// panel#754(2) — a screenshot frames the WHOLE GRAPH, and never said so.
//
// The reporter centred on node 42, zoomed to 0.55, then took three screenshots.
// All three came back pixel-identical fit-all framing of a 175-node graph; the
// only frame-to-frame difference was the FPS counter. They concluded the
// screenshot "does not follow the viewport" and filed it.
//
// The code is doing what it was built to do: fit-all, then restore the caller's
// scale and offset. What was missing is that the reply never mentioned it — size,
// renderer and which-graph were all reported, and the FRAMING, the one thing that
// explains three identical images, was not. So the only way to learn it was the
// experiment they ran.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describeScreenshotFraming } from "../../web/js/lib/screenshot-framing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

test("#754 it states the mode, and the counts it framed", () => {
  const f = describeScreenshotFraming({ nodes: 175, groups: 4 });
  assert.equal(f.mode, "fit-all");
  assert.equal(f.nodes, 175);
  assert.equal(f.groups, 4);
});

test("#754 it says the viewport is NOT used, and is restored", () => {
  // Both halves matter. "Not used" explains the identical images; "restored" is
  // why panel_canvas state survives a capture — without it a reader would
  // reasonably assume the screenshot had clobbered their view.
  const note = describeScreenshotFraming({ nodes: 175, groups: 0 }).note;
  assert.match(note, /does NOT use the current viewport/);
  assert.match(note, /restores the scale and offset you had/);
});

test("#754 it names the exact thing the reporter tested", () => {
  // center_on_node + zoom returning success while screenshots stay identical is
  // the whole report. Saying it outright is what saves the next person the three
  // captures.
  const note = describeScreenshotFraming({ nodes: 10, groups: 0 }).note;
  assert.match(note, /center_on_node/);
  assert.match(note, /zoom/);
  assert.match(note, /identical is expected, not a failure/);
});

test("#754 it points at what DOES work for one node", () => {
  // A dead end plus no alternative is how someone ends up re-filing. Reading a
  // single node's state is available today; capturing one is not.
  const note = describeScreenshotFraming({ nodes: 1, groups: 0 }).note;
  assert.match(note, /no way to capture a single node/);
  assert.match(note, /panel_query_graph/);
});

test("#754 counts are sanitised, never NaN or negative in the prose", () => {
  for (const bad of [{}, { nodes: NaN, groups: undefined }, { nodes: -3, groups: -1 }]) {
    const f = describeScreenshotFraming(bad);
    assert.ok(Number.isInteger(f.nodes) && f.nodes >= 0, `bad nodes for ${JSON.stringify(bad)}`);
    assert.ok(Number.isInteger(f.groups) && f.groups >= 0);
    assert.doesNotMatch(f.note, /NaN|undefined|-\d/);
  }
  assert.equal(describeScreenshotFraming(undefined).nodes, 0);
  assert.equal(describeScreenshotFraming({ nodes: 3.7 }).nodes, 3);
});

test("#754 WIRING: graph_screenshot returns it, with the counts it actually framed", () => {
  // A helper nobody calls changes nothing, and the counts must come from the
  // same arrays the bounds were computed over — reporting a different number
  // than was framed would be its own small lie.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /import \{ describeScreenshotFraming \} from "\.\/lib\/screenshot-framing\.js"/,
  );
  const i = src.indexOf("graph_screenshot({ padding } = {})");
  assert.ok(i > 0, "graph_screenshot must be findable");
  const body = src.slice(i, src.indexOf("\n  },", i));
  assert.match(
    body,
    /framing: describeScreenshotFraming\(\{ nodes: nodes\.length, groups: groups\.length \}\)/,
  );
  // The same arrays the bounds loop uses.
  assert.match(body, /for \(const n of nodes\)/);
  assert.match(body, /for \(const g of groups\)/);
});

test("#754 the capture still RESTORES the viewport — the claim must stay true", () => {
  // The note promises the caller's scale and offset come back. If that restore
  // were ever dropped, the disclosure would become a false statement, which is
  // worse than the silence it replaced.
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("graph_screenshot({ padding } = {})");
  const body = src.slice(i, src.indexOf("\n  },", i));
  assert.match(body, /const saved = \{ scale: ds\.scale, ox: ds\.offset\[0\], oy: ds\.offset\[1\] \}/);
  assert.match(body, /ds\.scale = saved\.scale/);
  assert.match(body, /ds\.offset\[0\] = saved\.ox/);
  assert.match(body, /ds\.offset\[1\] = saved\.oy/);
});
