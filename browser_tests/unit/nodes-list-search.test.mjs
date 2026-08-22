/**
 * #1496 — `panel_list_nodes` rejected `search` at the MCP schema (`{}` + strict)
 * with Unrecognized key. The panel half: when `search` (reporter) or `query`
 * (the panel_search_nodes alias) arrives on `nodes_list`, filter the installed
 * payload instead of dumping every pack. A miss discloses total so it cannot
 * be read as "nothing is installed".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  filterInstalledPayload,
  installedListQuery,
  listedNodesResult,
} from "../../web/js/lib/manager-install.js";

const PANEL = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");
const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

/** The reporter's pack plus a couple of neighbours, in Manager v4's map shape. */
const INSTALLED_MAP = {
  "ComfyUI-SeedVR2_VideoUpscaler": {
    ver: "1.2.0",
    cnr_id: "seedvr2",
    aux_id: "numz/ComfyUI-SeedVR2_VideoUpscaler",
    enabled: true,
  },
  "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy", enabled: true },
  "ComfyUI-Manager": { ver: "3.10", cnr_id: "comfyui-manager", enabled: true },
};

const INSTALLED_ARRAY = [
  { title: "ComfyUI-SeedVR2_VideoUpscaler", cnr_id: "seedvr2" },
  { title: "rgthree-comfy", cnr_id: "rgthree-comfy" },
  "ComfyUI-Manager",
];

test("#1496 the reporter's search:SeedVR2 keeps that pack and drops the rest", () => {
  const res = listedNodesResult(INSTALLED_MAP, { search: "SeedVR2" });
  assert.equal(res.search, "SeedVR2");
  assert.equal(res.count, 1);
  assert.equal(res.total, 3);
  assert.deepEqual(Object.keys(res.installed), ["ComfyUI-SeedVR2_VideoUpscaler"]);
  assert.equal(res.installed["ComfyUI-SeedVR2_VideoUpscaler"].cnr_id, "seedvr2");
  assert.equal(res.note, undefined, "a hit must not carry the miss note");
});

test("#1496 query is accepted as the panel_search_nodes alias", () => {
  const res = listedNodesResult(INSTALLED_MAP, { query: "seedvr2" });
  assert.equal(res.query, "seedvr2");
  assert.equal(res.search, undefined);
  assert.equal(res.count, 1);
  assert.deepEqual(Object.keys(res.installed), ["ComfyUI-SeedVR2_VideoUpscaler"]);
});

test("#1496 search wins when both keys are non-empty", () => {
  const res = listedNodesResult(INSTALLED_MAP, { search: "SeedVR2", query: "rgthree" });
  assert.equal(res.search, "SeedVR2");
  assert.equal(res.query, undefined);
  assert.equal(res.count, 1);
  assert.deepEqual(Object.keys(res.installed), ["ComfyUI-SeedVR2_VideoUpscaler"]);
});

test("#1496 no filter returns the raw payload unchanged — no count/total/note", () => {
  const res = listedNodesResult(INSTALLED_MAP, {});
  assert.equal(res.installed, INSTALLED_MAP);
  assert.equal(res.search, undefined);
  assert.equal(res.query, undefined);
  assert.equal(res.count, undefined);
  assert.equal(res.total, undefined);
  assert.equal(res.note, undefined);
});

test("#1496 whitespace-only search is not a filter", () => {
  assert.deepEqual(installedListQuery({ search: "   " }), { key: null, value: "" });
  const res = listedNodesResult(INSTALLED_MAP, { search: "  \n" });
  assert.equal(res.installed, INSTALLED_MAP);
  assert.equal(res.count, undefined);
});

test("#1496 a miss discloses total so it cannot be read as nothing installed", () => {
  const res = listedNodesResult(INSTALLED_MAP, { search: "definitely-not-here" });
  assert.equal(res.count, 0);
  assert.equal(res.total, 3);
  assert.deepEqual(res.installed, Object.create(null));
  assert.match(res.note, /0 of 3 installed packs matched search "definitely-not-here"/);
  assert.match(res.note, /panel_search_nodes/);
  assert.match(res.note, /query/);
});

test("#1496 terms are AND — SeedVR2 rgthree matches neither pack", () => {
  const res = listedNodesResult(INSTALLED_MAP, { search: "SeedVR2 rgthree" });
  assert.equal(res.count, 0);
  assert.equal(res.total, 3);
});

test("#1496 legacy array shape is filtered the same way", () => {
  const res = listedNodesResult(INSTALLED_ARRAY, { search: "SeedVR2" });
  assert.equal(res.count, 1);
  assert.equal(res.total, 3);
  assert.equal(res.installed.length, 1);
  assert.equal(res.installed[0].cnr_id, "seedvr2");
});

test("#1496 cnr_id / aux_id are in the haystack, not just the module key", () => {
  const byCnr = listedNodesResult(INSTALLED_MAP, { search: "numz" });
  assert.deepEqual(Object.keys(byCnr.installed), ["ComfyUI-SeedVR2_VideoUpscaler"]);
  const byAux = filterInstalledPayload(INSTALLED_MAP, "comfyui-manager");
  assert.equal(byAux.count, 1);
  assert.ok(byAux.installed["ComfyUI-Manager"]);
});

test("#1496 a non-string search is ignored rather than stringified", () => {
  assert.deepEqual(installedListQuery({ search: true }), { key: null, value: "" });
  assert.equal(listedNodesResult(INSTALLED_MAP, { search: 1 }).installed, INSTALLED_MAP);
});

test("#1496 README names the accepted keys", () => {
  const row = README.split("\n").find((l) => l.includes("`panel_list_nodes`"));
  assert.ok(row, "the tool table must list panel_list_nodes");
  assert.match(row, /`search`/);
  assert.match(row, /`query`/);
});

test("#1496 nodes_list feeds the command args through listNodesVia", () => {
  const start = PANEL.indexOf("async nodes_list(");
  assert.notEqual(start, -1, "nodes_list executor must exist");
  const end = PANEL.indexOf("async nodes_install(", start);
  assert.ok(end > start, "nodes_install must follow nodes_list");
  const body = PANEL.slice(start, end);
  assert.match(body, /async nodes_list\(args\s*=\s*\{\}\)/);
  assert.match(
    body,
    /listNodesVia\(managerGet,\s*managerCall,\s*\{\s*args,\s*objectInfoGet:\s*fetchObjectInfo\s*\}\)/,
  );
});
