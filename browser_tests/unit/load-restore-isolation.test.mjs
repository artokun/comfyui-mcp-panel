/**
 * Unit tests for web/js/lib/load-restore-isolation.js — run with `node --test`.
 *
 * Models the REAL bug from #1260: a workflow reload through LiteGraph's
 * restore (create every node, then `node.configure(info)` in `nodes` order,
 * then links/groups) aborted at the FIRST node whose configure threw — an
 * Impact-Pack FaceDetailer whose widgets are built asynchronously — leaving
 * every later node at construction defaults and links/groups never applied,
 * while the load reported a clean success.
 *
 * These drive the SAME wrapper graph_load installs around app.loadGraphData
 * (installNodeConfigureIsolation) and the SAME post-load retry
 * (retryNodeRestores), against a fake LiteGraph/LGraphNode pair that
 * reproduces the prototype-dispatched configure loop.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  installNodeConfigureIsolation,
  retryNodeRestores,
} from "../../web/js/lib/load-restore-isolation.js";

/** A minimal LiteGraph/LGraphNode pair: configure dispatches through the
 *  prototype, exactly as litegraph's restore loop calls it. */
function makeLiteGraph() {
  class LGraphNode {
    constructor(id) {
      this.id = id;
      this.configured = [];
    }
    configure(info) {
      this.configured.push(info);
      return "configured";
    }
  }
  return { LGraphNode };
}

test("#1260: a throw from one node's configure is contained — later nodes restore, the throw is recorded", () => {
  const LG = makeLiteGraph();
  const base = LG.LGraphNode.prototype.configure;
  LG.LGraphNode.prototype.configure = function (info) {
    if (info.id === 15) throw new TypeError("widgets not built yet");
    return base.call(this, info);
  };

  const isolation = installNodeConfigureIsolation(LG);
  assert.ok(isolation, "isolation installs on a prototype-dispatched configure");
  const nodes = [new LG.LGraphNode(15), new LG.LGraphNode(16), new LG.LGraphNode(17)];
  const infos = [
    { id: 15, type: "FaceDetailer" },
    { id: 16, type: "SaveImage" },
    { id: 17, type: "MarkdownNote" },
  ];
  try {
    // litegraph's restore loop, in `nodes` order — the loop that used to abort.
    for (let i = 0; i < nodes.length; i++) nodes[i].configure(infos[i]);
  } finally {
    isolation.restore();
  }

  assert.equal(isolation.failures.length, 1, "exactly the throwing node was recorded");
  const f = isolation.failures[0];
  assert.equal(f.id, 15);
  assert.equal(f.type, "FaceDetailer");
  assert.equal(f.error, "widgets not built yet");
  assert.deepEqual(f.info, { id: 15, type: "FaceDetailer" }, "the serialized data rides along for the retry");
  assert.deepEqual(nodes[1].configured, [infos[1]], "the node AFTER the throw restored normally");
  assert.deepEqual(nodes[2].configured, [infos[2]], "every later node restored normally");
});

test("the wrapper preserves a non-throwing configure's return value and `this`", () => {
  const LG = makeLiteGraph();
  const isolation = installNodeConfigureIsolation(LG);
  try {
    const node = new LG.LGraphNode(3);
    const ret = node.configure({ id: 3, type: "KSampler" });
    assert.equal(ret, "configured");
    assert.deepEqual(node.configured, [{ id: 3, type: "KSampler" }]);
  } finally {
    isolation.restore();
  }
  assert.equal(isolation.failures.length, 0);
});

test("restore() puts the original back, and a later throw propagates again", () => {
  const LG = makeLiteGraph();
  const original = LG.LGraphNode.prototype.configure;
  const isolation = installNodeConfigureIsolation(LG);
  assert.notEqual(LG.LGraphNode.prototype.configure, original, "wrapper is installed");
  isolation.restore();
  assert.equal(LG.LGraphNode.prototype.configure, original, "original is restored");

  const second = installNodeConfigureIsolation(LG);
  second.restore();
  LG.LGraphNode.prototype.configure = function () {
    throw new Error("post-restore boom");
  };
  assert.throws(
    () => LG.LGraphNode.prototype.configure.call(new LG.LGraphNode(1), { id: 1 }),
    /post-restore boom/,
    "with no active wrapper, a configure throw propagates exactly as unwrapped",
  );
});

test("install returns null when there is nothing to wrap (fail-open, pre-fix behaviour)", () => {
  assert.equal(installNodeConfigureIsolation(null), null);
  assert.equal(installNodeConfigureIsolation({}), null);
  assert.equal(installNodeConfigureIsolation({ LGraphNode: {} }), null);
});

test("chained isolations: restoring the INNER one first does not drop the outer's containment", () => {
  const LG = makeLiteGraph();
  const base = LG.LGraphNode.prototype.configure;
  LG.LGraphNode.prototype.configure = function (info) {
    if (info.id === 7) throw new Error("chain boom");
    return base.call(this, info);
  };
  const inner = installNodeConfigureIsolation(LG);
  const outer = installNodeConfigureIsolation(LG);
  const outerWrapper = LG.LGraphNode.prototype.configure;
  const node = new LG.LGraphNode(7);

  node.configure({ id: 7, type: "X" });
  assert.equal(inner.failures.length, 1, "the INNERMOST wrapper swallows and records the throw first");
  assert.equal(outer.failures.length, 0, "the outer wrapper never saw it — the inner swallowed first");

  inner.restore(); // out of order: the OUTER wrapper is still installed
  assert.equal(
    LG.LGraphNode.prototype.configure,
    outerWrapper,
    "the inner restore must not clobber the outer wrapper",
  );
  node.configure({ id: 7, type: "X" });
  assert.equal(outer.failures.length, 1, "with the inner deactivated, the outer now contains the throw");
  assert.equal(inner.failures.length, 1, "the deactivated inner records nothing further");

  outer.restore();
  assert.throws(
    () => node.configure({ id: 7, type: "X" }),
    /chain boom/,
    "once every wrapper is restored or deactivated, throws propagate again",
  );
  assert.equal(node.configure({ id: 8, type: "Y" }), "configured", "non-throwing nodes are unaffected");
});

test("#1260 retry: a node whose widgets exist by retry time restores; a still-throwing node is disclosed with the NEW error", () => {
  const LG = makeLiteGraph();
  const healed = new LG.LGraphNode(15);
  healed.type = "FaceDetailer";
  const stubborn = new LG.LGraphNode(21);
  stubborn.type = "MarkdownNote";
  stubborn.configure = () => {
    throw new Error("still broken");
  };
  const graph = {
    getNodeById(id) {
      if (id === 15) return healed;
      if (id === 21) return stubborn;
      return null;
    },
  };
  const failures = [
    { id: 15, type: "FaceDetailer", error: "widgets not built yet", info: { id: 15, widgets_values: [768] } },
    { id: 21, type: "MarkdownNote", error: "first boom", info: { id: 21, widgets_values: ["hi"] } },
    { id: 99, type: "Ghost", error: "creation failed too", info: { id: 99 } },
  ];
  const { restored, failed } = retryNodeRestores(graph, failures);
  assert.deepEqual(restored, [{ id: 15, type: "FaceDetailer" }]);
  assert.deepEqual(healed.configured, [{ id: 15, widgets_values: [768] }], "the serialized data was re-applied");
  assert.equal(failed.length, 2);
  assert.equal(failed[0].error, "still broken", "the retry's error replaces the stale load-time error");
  assert.equal(failed[0].retry, undefined, "a node that IS on the graph gets no retry marker");
  assert.equal(failed[1].retry, "node-not-on-graph", "a node that never landed is told apart from a re-throw");
});

test("retry tolerates a missing graph and empty failures (nothing to heal, nothing to disclose)", () => {
  assert.deepEqual(retryNodeRestores(null, []), { restored: [], failed: [] });
  assert.deepEqual(retryNodeRestores(undefined, undefined), { restored: [], failed: [] });
});
