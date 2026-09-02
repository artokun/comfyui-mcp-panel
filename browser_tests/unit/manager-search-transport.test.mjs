/**
 * #2024 — panel_search_nodes returned supported:false / managerReachable:false
 * for a browser-origin "Failed to fetch" on /v2/customnode/getmappings?mode=cache,
 * with no HTTP response. The agent saw an opaque transport failure and could not
 * tell a missing pack from a panel-origin fetch that never completed.
 *
 * The shipped behaviour:
 *   1. A tagged/wrapped transport failure still retries the ABSOLUTE legacy
 *      `/customnode/getmappings?mode=cache` route (the wrap does not contain
 *      "not reachable", which used to skip that rung).
 *   2. When BOTH routes fail with transport, the structured miss is not a bare
 *      "Failed to fetch": `message` starts with the #1472 wrap so MCP #2492's
 *      host-HTTP fallback can extractText() it, names both mapping routes, and
 *      does not diagnose this as merely a disabled Manager.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isManagerTransportWrap,
  managerFetchFailureMessage,
} from "../../web/js/lib/manager-fetch-failure.js";
import {
  isManagerUnreachable,
  markManagerUnreachable,
  managerUnavailableResult,
  SEARCH_MAPPINGS_ROUTE,
  SEARCH_MAPPINGS_ROUTES,
  searchNodesVia,
} from "../../web/js/lib/manager-install.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const GETMAPPINGS_MAP = {
  "https://github.com/1038lab/ComfyUI-RMBG": [
    ["RMBG"],
    { title: "ComfyUI-RMBG", description: "Background removal" },
  ],
};

const OBJECT_INFO = {
  KSampler: { display_name: "KSampler", category: "sampling", description: "" },
};

function transportWrap(route = SEARCH_MAPPINGS_ROUTE, { prefix, tag = true } = {}) {
  const cause = new TypeError("Failed to fetch");
  const err = new Error(managerFetchFailureMessage(route, cause, prefix ? { prefix } : undefined), {
    cause,
  });
  return tag ? markManagerUnreachable(err) : err;
}

/**
 * Mirror of comfyui-mcp `isManagerTransportFetchFailure` (MCP #2492). The panel
 * result's extractable `message` must match this or the orchestrator host-HTTP
 * fallback never fires on a successful structured miss.
 */
function extractText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && typeof value.message === "string") return value.message;
  return "";
}

function isMcpHostHttpTransportFailure(value) {
  const text = extractText(value).replace(/^(?:Error:\s*)+/i, "").trim();
  if (!text) return false;
  const match = /^ComfyUI-Manager request to (\S+) did not complete:\s*([\s\S]+)$/i.exec(text);
  if (!match) return false;
  const path = match[1] ?? "";
  const cause = (match[2] ?? "").trim();
  if (!/\/(?:v2\/)?customnode\/(?:getmappings|installed)(?:\?|$)/i.test(path)) return false;
  if (/^AbortError\b/i.test(cause)) return false;
  if (/\bHTTP\s*\d{3}\b/.test(cause)) return false;
  return (
    /^(?:TypeError:\s*)?Failed to fetch\b/i.test(cause) ||
    /^fetch failed\.?$/i.test(cause) ||
    /^NetworkError\b/i.test(cause)
  );
}

test("#2024 a transport Failed to fetch is never the only outcome", async () => {
  const wrap = transportWrap();
  const boom = async () => {
    throw wrap;
  };
  const res = await searchNodesVia(boom, boom, { query: "Spectrum MiniMax H3" });

  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
  assert.equal(res.transportFailure, true);
  assert.equal(res.query, "Spectrum MiniMax H3");
  assert.notEqual(res.reason, "Failed to fetch");
  assert.notEqual(res.message, "Failed to fetch");
  assert.notEqual(res.message, wrap.message, "message must add the search-route diagnostics");
  assert.match(res.reason, /customnode\/getmappings/);
  assert.match(res.message, /customnode\/getmappings/);
  assert.match(res.message, /did not complete/);
  assert.match(res.message, /TRANSPORT failure/);
  assert.match(res.message, /no HTTP/);
  assert.deepEqual(res.routesAttempted, SEARCH_MAPPINGS_ROUTES);
  assert.match(res.message, /panel_list_nodes/);
  assert.doesNotMatch(res.message, /^Failed to fetch/);
});

test("#2024 the structured miss is visible to MCP #2492 host-HTTP fallback", async () => {
  const wrap = transportWrap();
  const res = await searchNodesVia(
    async () => {
      throw wrap;
    },
    async () => {
      throw wrap;
    },
    { query: "Spectrum MiniMax H3" },
  );
  assert.equal(
    isMcpHostHttpTransportFailure(res),
    true,
    "extractText(result) must start with the wrap so searchPanelNodes host-HTTP-falls-back",
  );
  assert.match(res.message, /^ComfyUI-Manager request to \S+ did not complete:\s*(?:TypeError:\s*)?Failed to fetch\b/);
  assert.match(res.message, /not proof Manager is disabled/);
  assert.match(res.message, /not proof the pack is missing/);
  assert.match(res.message, /legacy absolute route/);
  assert.match(res.message, /host HTTP/);
});

test("#2024 a bare tagged Failed to fetch is reconstructed into the wrap, not left opaque", () => {
  const err = markManagerUnreachable(new TypeError("Failed to fetch"));
  const res = managerUnavailableResult("Spectrum MiniMax H3", err);
  assert.equal(res.transportFailure, true);
  assert.equal(isMcpHostHttpTransportFailure(res), true);
  assert.notEqual(res.message, "Failed to fetch");
  assert.match(res.message, /\/v2\/customnode\/getmappings\?mode=cache/);
});

test("#2024 a bridge-added Error prefix cannot bury the transport wrap", () => {
  const cause = transportWrap();
  const prefixed = new Error(`Error: ${cause.message}`);
  const res = managerUnavailableResult("Spectrum MiniMax H3", prefixed);
  assert.equal(res.transportFailure, true);
  assert.match(res.message, /^ComfyUI-Manager request to \/v2\/customnode\/getmappings\?mode=cache/);
  assert.match(res.message, /TRANSPORT failure/);
});

test("#2024 v2 transport wrap still uses the absolute legacy getmappings route", async () => {
  const wrap = transportWrap(SEARCH_MAPPINGS_ROUTE);
  assert.equal(isManagerUnreachable(wrap), true);
  assert.ok(!/not reachable/i.test(wrap.message), "the reporter wrap is not the 404 wording");
  let legacyRoute;
  const res = await searchNodesVia(
    async () => {
      throw wrap;
    },
    async (route) => {
      legacyRoute = route;
      return GETMAPPINGS_MAP;
    },
    { query: "RMBG" },
  );
  assert.equal(legacyRoute, SEARCH_MAPPINGS_ROUTE);
  assert.equal(res.count, 1);
  assert.equal(res.results[0].title, "ComfyUI-RMBG");
  assert.equal(res.supported, undefined);
  assert.equal(res.transportFailure, undefined);
});

test("#2024 an UNTAGGED wrap still opens the legacy GET fallback", async () => {
  const wrap = transportWrap(SEARCH_MAPPINGS_ROUTE, { tag: false });
  assert.equal(wrap.managerTransportUnreachable, undefined);
  assert.equal(isManagerTransportWrap(wrap), true);
  assert.equal(isManagerUnreachable(wrap), true);
  const res = await searchNodesVia(
    async () => {
      throw wrap;
    },
    async () => GETMAPPINGS_MAP,
    { query: "RMBG" },
  );
  assert.equal(res.count, 1);
});

test("#2024 object_info still wins when installed nodes match the query", async () => {
  const wrap = transportWrap();
  const boom = async () => {
    throw wrap;
  };
  const res = await searchNodesVia(boom, boom, {
    query: "KSampler",
    objectInfoGet: async () => OBJECT_INFO,
  });
  assert.equal(res.supported, true);
  assert.equal(res.source, "object_info");
  assert.equal(res.installedOnly, true);
  assert.equal(res.count, 1);
  assert.equal(res.transportFailure, undefined);
});

test("#2024 a genuine HTTP 500 still propagates", async () => {
  const boom = async () => {
    throw new Error("Manager customnode/getmappings: HTTP 500");
  };
  await assert.rejects(() => searchNodesVia(boom, boom, { query: "x" }), /HTTP 500/);
});

test("#2024 WIRING: nodes_search still goes through searchNodesVia", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const fnMatch = src.match(/async nodes_search\(\{ query, limit \}\) \{[\s\S]*?\n  \},/);
  assert.ok(fnMatch, "could not locate the production nodes_search handler");
  assert.match(fnMatch[0], /return searchNodesVia\(managerGet, managerCall,/);
  assert.match(fnMatch[0], /objectInfoGet: fetchObjectInfo/);
});
