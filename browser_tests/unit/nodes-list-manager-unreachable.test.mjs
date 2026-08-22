/**
 * #1645 — `panel_list_nodes` threw when ComfyUI-Manager was unreachable even
 * though the live canvas was connected and `panel_graph_outline` worked.
 *
 * THE REPORTED FAILURE. A read-only `panel_list_nodes({})` returned
 * `Error: ComfyUI-Manager injoignable (le gestionnaire intégré est-il activé ?)`
 * (the French catalogue string for the Manager-not-reachable 404). Inventory of
 * already-loaded custom-node packs should still return an inspectable fallback
 * instead of failing closed.
 *
 * THE MECHANISM. `nodes_list` already retried the absolute legacy
 * `/customnode/installed` on an unreachable dialect-routed GET, then rethrew
 * when that was unreachable too. `searchNodesVia` already degrades past that
 * last throw (#251/#255/#426); list did not.
 *
 * These tests drive the shipped `listNodesVia` (the decision path `nodes_list`
 * now calls), with injected Manager + `/object_info` fetches. The reporter's
 * exact French string is produced from the shipped catalogue, not assumed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tr, __setCatalogForTest } from "../../web/js/lib/i18n.js";
import { classifyManager404 } from "../../web/js/lib/manager-404.js";
import {
  listNodesVia,
  listedNodesResult,
  managerListUnavailableResult,
} from "../../web/js/lib/manager-install.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PANEL = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
const NS = "comfyuiMcpPanel";
const catalogFor = (locale) => {
  const file = JSON.parse(readFileSync(join(ROOT, "locales", locale, "main.json"), "utf8"));
  const inner = file?.[NS];
  assert.ok(inner, `locales/${locale}/main.json must be namespaced under ${NS}`);
  return inner;
};

const INSTALLED_MAP = {
  "ComfyUI-SeedVR2_VideoUpscaler": {
    ver: "1.2.0",
    cnr_id: "seedvr2",
    aux_id: "numz/ComfyUI-SeedVR2_VideoUpscaler",
    enabled: true,
  },
  "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy", enabled: true },
};

const OBJECT_INFO = {
  KSampler: { python_module: "nodes", display_name: "KSampler" },
  CLIPTextEncode: { python_module: "comfy_extras.nodes_clip", display_name: "CLIP Text Encode" },
  ReActorFaceSwap: {
    python_module: "custom_nodes.comfyui-reactor-node",
    display_name: "ReActor",
  },
  ImpactWildcardProcessor: {
    python_module: "custom_nodes.ComfyUI-Impact-Pack.nodes",
    display_name: "Impact Wildcard Processor",
  },
};

const UNREACHABLE = new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)");
UNREACHABLE.managerRouteMissing = true;

const throwUnreachable = async () => {
  throw UNREACHABLE;
};

/** Rebuild the reporter's exact 404 the way managerV2/managerCall do. */
const frenchUnreachable = () => {
  __setCatalogForTest("fr", catalogFor("fr"));
  const { routeMissing, message } = classifyManager404("");
  const err = new Error(message);
  if (routeMissing) err.managerRouteMissing = true;
  return err;
};

test.afterEach(() => __setCatalogForTest("en", {}));

test("#1645 the reporter's exact French string is what the panel produces", () => {
  const err = frenchUnreachable();
  assert.equal(
    err.message,
    "ComfyUI-Manager injoignable (le gestionnaire intégré est-il activé ?)",
  );
  assert.equal(err.managerRouteMissing, true);
  assert.notEqual(
    tr(
      "manager_404.comfyui_manager_not_reachable_is_the_built",
      "ComfyUI-Manager not reachable (is the built-in Manager enabled?)",
    ),
    "ComfyUI-Manager not reachable (is the built-in Manager enabled?)",
    "tr() is genuinely in the path — this is not testing a constant",
  );
});

test("#1645 dialect-routed GET still returns the Manager inventory", async () => {
  const res = await listNodesVia(async () => INSTALLED_MAP, throwUnreachable, { args: {} });
  assert.deepEqual(res, listedNodesResult(INSTALLED_MAP, {}));
  assert.equal("managerReachable" in res, false);
});

test("#1645 absolute legacy route is used when the dialect-routed GET is unreachable", async () => {
  const res = await listNodesVia(throwUnreachable, async () => INSTALLED_MAP, {
    args: { search: "SeedVR2" },
  });
  assert.deepEqual(res, listedNodesResult(INSTALLED_MAP, { search: "SeedVR2" }));
});

test("#1645 BOTH Manager routes unreachable + loaded object_info returns inspectable packs, never throws", async () => {
  const res = await listNodesVia(throwUnreachable, throwUnreachable, {
    args: {},
    objectInfoGet: async () => OBJECT_INFO,
  });
  assert.equal(res.managerReachable, false);
  assert.equal(res.source, "object_info");
  assert.equal("supported" in res, false);
  assert.deepEqual(Object.keys(res.installed).sort(), [
    "ComfyUI-Impact-Pack",
    "comfyui-reactor-node",
  ]);
  assert.deepEqual(res.installed["comfyui-reactor-node"].classes, ["ReActorFaceSwap"]);
  assert.deepEqual(res.installed["ComfyUI-Impact-Pack"].classes, ["ImpactWildcardProcessor"]);
  assert.equal("KSampler" in res.installed, false);
  assert.equal("nodes" in res.installed, false);
  assert.match(res.note, /object_info/);
});

test("#1645 the reporter's French unreachable error degrades to object_info instead of throwing", async () => {
  const err = frenchUnreachable();
  const boom = async () => {
    throw err;
  };
  const res = await listNodesVia(boom, boom, {
    args: {},
    objectInfoGet: async () => OBJECT_INFO,
  });
  assert.equal(res.managerReachable, false);
  assert.equal(res.source, "object_info");
  assert.ok(res.installed["comfyui-reactor-node"]);
});

test("#1645 search still filters the object_info pack inventory", async () => {
  const res = await listNodesVia(throwUnreachable, throwUnreachable, {
    args: { search: "Impact" },
    objectInfoGet: async () => OBJECT_INFO,
  });
  assert.equal(res.search, "Impact");
  assert.equal(res.count, 1);
  assert.deepEqual(Object.keys(res.installed), ["ComfyUI-Impact-Pack"]);
  assert.equal(res.managerReachable, false);
  assert.equal(res.source, "object_info");
});

test("#1645 core-only object_info is still an inspectable inventory, not a throw", async () => {
  const res = await listNodesVia(throwUnreachable, throwUnreachable, {
    args: {},
    objectInfoGet: async () => ({
      KSampler: { python_module: "nodes" },
    }),
  });
  assert.equal(res.managerReachable, false);
  assert.equal(res.source, "object_info");
  assert.deepEqual(res.installed, Object.create(null));
  assert.match(res.note, /object_info/);
});

test("#1645 object_info pack names cannot reach inherited object keys", async () => {
  const res = await listNodesVia(throwUnreachable, throwUnreachable, {
    args: {},
    objectInfoGet: async () => ({
      ProtoNode: { python_module: "custom_nodes.__proto__" },
      ConstructorNode: { python_module: "custom_nodes.constructor" },
      ToStringNode: { python_module: "custom_nodes.toString" },
    }),
  });
  assert.deepEqual(Object.keys(res.installed).sort(), ["__proto__", "constructor", "toString"]);
  assert.deepEqual(res.installed.__proto__.classes, ["ProtoNode"]);
  assert.deepEqual(res.installed.constructor.classes, ["ConstructorNode"]);
  assert.deepEqual(res.installed.toString.classes, ["ToStringNode"]);
  assert.equal(Object.prototype.classes, undefined);
});

test("#1645 a failing object_info fetch degrades to structured unavailable, never throws", async () => {
  const res = await listNodesVia(throwUnreachable, throwUnreachable, {
    args: {},
    objectInfoGet: async () => {
      throw new Error("object_info 503");
    },
  });
  assert.deepEqual(res, managerListUnavailableResult(UNREACHABLE));
  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
  assert.deepEqual(res.installed, {});
  assert.match(res.message, /panel_graph_outline/);
});

test("#1645 a non-map object_info response degrades to structured unavailable", async () => {
  for (const malformed of [null, [], "offline", 204, {}, { error: "backend unavailable" }, { error: { message: "backend unavailable" } }]) {
    const res = await listNodesVia(throwUnreachable, throwUnreachable, {
      args: {},
      objectInfoGet: async () => malformed,
    });
    assert.equal(res.supported, false, `malformed object_info: ${String(malformed)}`);
    assert.equal(res.managerReachable, false);
    assert.deepEqual(res.installed, {});
    assert.equal(res.source, undefined);
  }
});

test("#1645 with no objectInfoGet, BOTH unreachable returns structured unavailable — never throws", async () => {
  const res = await listNodesVia(throwUnreachable, throwUnreachable, { args: {} });
  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
  assert.deepEqual(res.installed, {});
});

test("#1645 a genuine server error still propagates", async () => {
  const boom = async () => {
    throw new Error("Manager customnode/installed: HTTP 500");
  };
  await assert.rejects(
    () => listNodesVia(boom, boom, { args: {} }),
    /HTTP 500/,
    "a real server error must propagate, not degrade to unavailable",
  );
});

test("#1645 a non-unreachable error from the absolute fallback also propagates", async () => {
  const managerCall = async () => {
    throw new Error("Manager customnode/installed: HTTP 403");
  };
  await assert.rejects(
    () => listNodesVia(throwUnreachable, managerCall, { args: {} }),
    /HTTP 403/,
  );
});

test("#1645 nodes_list wires listNodesVia with the live object_info fetch", () => {
  const start = PANEL.indexOf("async nodes_list(");
  assert.notEqual(start, -1, "nodes_list executor must exist");
  const end = PANEL.indexOf("async nodes_install(", start);
  assert.ok(end > start, "nodes_install must follow nodes_list");
  const body = PANEL.slice(start, end);
  assert.match(body, /listNodesVia\(managerGet,\s*managerCall/);
  assert.match(body, /objectInfoGet:\s*fetchObjectInfo/);
  assert.match(body, /retryDuringReconnect/);
});
