// comfyui-mcp#1400 — the frontend's virtual-node registry, served headlessly.
//
// `check_runtime` (the paid-API classifier in comfyui-mcp) is headless: it has a
// graph and /object_info and no node instances, so a third-party VIRTUAL node
// (rgthree's Label / Fast Groups toggles, KJNodes' Get/Set bus) read as
// "unknown" and collapsed the whole verdict. This module is the authority it
// could not consult: the types THIS page's LiteGraph registry proves virtual, by
// constructing one probe instance of each registered class and reading the same
// `isVirtualNode === true` flag ComfyUI's own serializer reads (see
// lib/frontend-virtual-nodes.js for the derivation).
//
// EVERY positive test below is paired with its fail-closed twin: a class that
// does not set the flag, sets it non-exactly, carries backend provenance, or
// throws on construction must yield NOTHING — the headless classifier keeps its
// cautious "unknown" for those, which is the direction that costs a question,
// never a wrong "free".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { collectFrontendVirtualTypes, isFrontendVirtualRegisteredType } from "../../web/js/lib/virtual-registry.js";
import { commandIsCanvasIndependent } from "../../web/js/lib/workflow-chat-identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PANEL = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");

// ── the classes under probe ──────────────────────────────────────────────────

/** A KJNodes-style virtual class: the flag is set unconditionally in the ctor. */
class KjStyleBusNode {
  constructor() {
    this.properties = {};
    this.isVirtualNode = true;
  }
}

/** An rgthree-style virtual class: its base ctor THROWS on the default title, so
 *  a probe that passes no title never sees the flag. */
class RgthreeStyleVirtualNode {
  constructor(title = "__NEED_CLASS_TITLE__") {
    if (title === "__NEED_CLASS_TITLE__") throw new Error("needs overrides");
    this.title = title;
    this.isVirtualNode = true;
  }
}

/** A frontend-registered class that is NOT virtual (a canvas tool, a widget). */
class FrontendToolNode {
  constructor() {
    this.isVirtualNode = false;
  }
}

/** The flag, but not EXACTLY true — a placeholder cannot forge proof. */
class LooseFlagNode {
  constructor() {
    this.isVirtualNode = "true";
  }
}

/** A backend-derived class (registerNodesFromDefs stamps static .nodeData) —
 *  even a hypothetical one whose instances carry the flag is /object_info's
 *  question and must never be probed into this list. */
class BackendDefNode {
  constructor() {
    this.isVirtualNode = true; // unreachable: the probe must never construct this
  }
  static probeConstructed = false;
}
BackendDefNode.nodeData = { name: "BackendDefNode" };

/** A class that cannot be bare-constructed (needs graph context). */
class NeedsContextNode {
  constructor() {
    throw new Error("needs the live graph");
  }
}

test("#1400 a constructor-flagged class is reported virtual", () => {
  const registry = { GetNode: KjStyleBusNode, "Label (rgthree)": RgthreeStyleVirtualNode };
  assert.deepEqual(collectFrontendVirtualTypes(registry), ["GetNode", "Label (rgthree)"]);
});

test("#1956 isFrontendVirtualRegisteredType proves Bookmark (rgthree) and rejects a defless husk", () => {
  class BookmarkRgthree {
    constructor(title = "__NEED_CLASS_TITLE__") {
      if (title === "__NEED_CLASS_TITLE__") throw new Error("needs overrides");
      this.isVirtualNode = true;
    }
  }
  function DeflessHusk() {}
  const registry = {
    "Bookmark (rgthree)": BookmarkRgthree,
    RemovedBackendNode: DeflessHusk,
    GetNode: KjStyleBusNode,
  };
  assert.equal(isFrontendVirtualRegisteredType(registry, "Bookmark (rgthree)"), true);
  assert.equal(isFrontendVirtualRegisteredType(registry, "RemovedBackendNode"), false);
  assert.equal(isFrontendVirtualRegisteredType(registry, "GetNode"), true);
  assert.equal(isFrontendVirtualRegisteredType(registry, "NotRegistered"), false);
});

test("#1400 the probe passes a title — an rgthree-style sentinel-throwing ctor is covered", () => {
  // Constructed bare, this class throws before setting the flag; the collector's
  // whole point for rgthree is that it probes with an argument.
  assert.throws(() => new RgthreeStyleVirtualNode());
  assert.deepEqual(collectFrontendVirtualTypes({ "Label (rgthree)": RgthreeStyleVirtualNode }), [
    "Label (rgthree)",
  ]);
});

test("#1400 a registered class WITHOUT the exact flag is not reported", () => {
  const registry = { ToolNode: FrontendToolNode, Loose: LooseFlagNode };
  assert.deepEqual(collectFrontendVirtualTypes(registry), []);
});

test("#1400 a class with backend provenance is never even constructed", () => {
  BackendDefNode.probeConstructed = false;
  class Probed extends BackendDefNode {
    constructor() {
      BackendDefNode.probeConstructed = true;
      super();
    }
  }
  Probed.nodeData = BackendDefNode.nodeData;
  assert.deepEqual(collectFrontendVirtualTypes({ BackendDefNode: Probed }), []);
  assert.equal(BackendDefNode.probeConstructed, false);
});

test("#1400 a class with a static comfyClass marker is likewise skipped", () => {
  class ComfyClassMarked extends KjStyleBusNode {}
  ComfyClassMarked.comfyClass = "GetNode";
  assert.deepEqual(collectFrontendVirtualTypes({ GetNode: ComfyClassMarked }), []);
});

test("#1400 a throwing constructor proves nothing and is skipped", () => {
  const registry = { Fragile: NeedsContextNode, GetNode: KjStyleBusNode };
  assert.deepEqual(collectFrontendVirtualTypes(registry), ["GetNode"]);
});

test("#1400 non-function entries and throwing getters exempt nothing", () => {
  const registry = Object.create(null);
  registry.NotAClass = { isVirtualNode: true };
  Object.defineProperty(registry, "ThrowsOnRead", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  registry.GetNode = KjStyleBusNode;
  assert.deepEqual(collectFrontendVirtualTypes(registry), ["GetNode"]);
});

test("#1400 an unreadable registry yields an empty list, never a partial one", () => {
  for (const bad of [null, undefined, 42, "registry", []]) {
    assert.deepEqual(collectFrontendVirtualTypes(bad), [], JSON.stringify(bad));
  }
});

test("#1400 the placeholder rig (panel#1284): a type with NO registered class lists nothing", () => {
  // The tab never loaded the pack's JS, so litegraph minted defless placeholders
  // on the canvas and the registry holds no class at all. There is nothing to
  // probe — and crucially nothing is CLAIMED. This is the case a name allowlist
  // gets wrong.
  assert.deepEqual(collectFrontendVirtualTypes({ KSampler: FrontendToolNode }), []);
});

// ── the wiring: the answer must actually leave this page ─────────────────────

test("#1400 graph_get_virtual_types is a registered bridge command", () => {
  // Source-level, like the other executor wiring assertions in this suite: the
  // handler must sit in GRAPH_TOOL_EXECUTORS or the dispatch answers "Unknown
  // command".
  assert.match(PANEL, /graph_get_virtual_types\(\)\s*\{/);
  assert.match(PANEL, /virtual_types/);
});

test("#1400 the command reads the registry, not the canvas", () => {
  // The handler body must take LiteGraph's registered_node_types — a canvas read
  // would make it answer for the ACTIVE workflow, which the canvas-independence
  // registration below then mis-describes.
  const start = PANEL.indexOf("graph_get_virtual_types() {");
  const handler = PANEL.slice(start, PANEL.indexOf("\n  },", start) + 1);
  assert.match(handler, /registered_node_types/);
  assert.doesNotMatch(handler, /getGraphCtx/);
});

test("#1400 the command is canvas-independent, or the hello-time pull is fenced", () => {
  // The orchestrator pulls this on hello, before any workflow stamp exists to
  // agree with; a canvas-targeted command is refused in exactly that position.
  assert.equal(commandIsCanvasIndependent("graph_get_virtual_types"), true);
});
