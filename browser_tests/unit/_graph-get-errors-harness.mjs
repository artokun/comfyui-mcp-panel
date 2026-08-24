// Production-path harness for graph_get_errors. Kept outside a *.test.mjs module so other
// production-path regressions can drive the shipped executor without importing and running
// this file's unrelated test cases.
import { PANEL_SRC } from "./_panel-constants.mjs";
import { findNodeByScopedId, findVisibleNodeByScopedId } from "../../web/js/lib/asset-staleness.js";
import { applyRuntimeExecFailure, boundExecFailurePayload } from "../../web/js/lib/exec-error-bounds.js";
import { createObjectInfoCache } from "../../web/js/lib/object-info-cache.js";
import { createObjectInfoSnapshot } from "../../web/js/lib/object-info-snapshot.js";
import { createVerifiedNodeDefCache } from "../../web/js/lib/verified-node-def-cache.js";

function extractExecutorMethod(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`${signature} not found in panel source`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i + 2);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

const GRAPH_GET_ERRORS_SOURCE = extractExecutorMethod(PANEL_SRC, "  async graph_get_errors() {");
const GRAPH_GET_ERRORS_DEPS = [
  "monotonicNow",
  "getErrorsStepBudgetMs",
  "hasRawMissingAssetCandidates",
  "GET_ERRORS_REFRESH_CAP_MS",
  "refreshMissingAssetTrust",
  "refreshComfyNodeDefs",
  "withRefreshTimeout",
  "getRefreshInFlight",
  "nodeDefRefreshInFlight",
  "getGraphCtx",
  "objectInfoCache",
  "objectInfoSnapshot",
  "verifiedNodeDefCache",
  "assertGraphBoundToActiveWorkflow",
  "graphCommandBindingBar",
  "collectMissingAssets",
  "activeWorkflowRef",
  "GET_ERRORS_STEP_CAP_MS",
  "filterServerConfirmedInputSubfolderMedia",
  "inputAssetServerUsesWindowsPaths",
  "scanComboAvailability",
  "fetchSingleNodeInfo",
  "probeInputAssetPresence",
  "graphReadBindingChanged",
  "collectAllGraphs",
  "adjudicateRecordedMissingNodeTypes",
  "isRegisteredNodeType",
  "LiteGraph",
  "findVisibleNodeByScopedId",
  "findNodeByScopedId",
  "getPiniaStore",
  "combineNodeErrorMaps",
  "coerceMessageText",
  "lastExecFailure",
  "applyRuntimeExecFailure",
  "collectUnexplainedRedOutlines",
  "summarizeNode",
  "tr",
  "describeActiveGraph",
  "MAX_STATE_NODES",
  "fixedCapNote",
  "missingAssetScanMayBeStale",
  "missingAssetScopeNote",
  "comboAvailabilityNote",
  "uncheckedNodesNote",
  "stalePlaceholderNote",
  "boundExecFailurePayload",
  "collectMissingNodeTypeReasons",
];

const makeGraphGetErrors = new Function(
  ...GRAPH_GET_ERRORS_DEPS,
  `return ({ ${GRAPH_GET_ERRORS_SOURCE} }).graph_get_errors;`,
);

export async function runProductionGraphGetErrors({
  graph,
  rootGraph,
  lastExecFailure,
  scan = async () => null,
  fetchSingleNodeInfo = () => {},
  // The extracted executor's default scan is a no-op test double. Give it a
  // usable budget so callers that are not exercising live-scan exhaustion retain
  // their clean-note assertions.
  stepBudget = () => 1000,
  monotonicNow = () => 0,
  objectInfoCache = createObjectInfoCache(),
  objectInfoSnapshot = createObjectInfoSnapshot(),
  verifiedNodeDefCache = createVerifiedNodeDefCache(),
}) {
  const deps = {
    monotonicNow,
    getErrorsStepBudgetMs: stepBudget,
    hasRawMissingAssetCandidates: () => false,
    GET_ERRORS_REFRESH_CAP_MS: 18000,
    refreshMissingAssetTrust: async () => false,
    refreshComfyNodeDefs: () => {},
    withRefreshTimeout: () => {},
    getRefreshInFlight: () => null,
    nodeDefRefreshInFlight: null,
    getGraphCtx: () => ({ app: { lastNodeErrors: null }, graph, rootGraph }),
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
    assertGraphBoundToActiveWorkflow: () => {},
    graphCommandBindingBar: () => ({}),
    collectMissingAssets: () => ({ models: [], media: [], nodeTypes: [], nodeCount: 0 }),
    activeWorkflowRef: () => null,
    GET_ERRORS_STEP_CAP_MS: 4000,
    filterServerConfirmedInputSubfolderMedia: async (media) => media,
    inputAssetServerUsesWindowsPaths: async () => false,
    scanComboAvailability: scan,
    fetchSingleNodeInfo,
    probeInputAssetPresence: () => {},
    graphReadBindingChanged: () => false,
    collectAllGraphs: (value) => [value],
    adjudicateRecordedMissingNodeTypes: (types) => ({ stillMissing: types, stalePlaceholders: [] }),
    isRegisteredNodeType: () => false,
    LiteGraph: {},
    findVisibleNodeByScopedId,
    findNodeByScopedId,
    getPiniaStore: () => null,
    combineNodeErrorMaps: () => null,
    coerceMessageText: (value) => String(value ?? ""),
    lastExecFailure,
    applyRuntimeExecFailure,
    collectUnexplainedRedOutlines: () => [],
    summarizeNode: (node) => ({ id: node.id, type: node.type }),
    tr: (_key, fallback) => fallback,
    describeActiveGraph: () => ({ scope: "root" }),
    MAX_STATE_NODES: 50,
    fixedCapNote: () => "cap",
    missingAssetScanMayBeStale: () => false,
    missingAssetScopeNote: () => "stale",
    comboAvailabilityNote: () => "combo",
    uncheckedNodesNote: () => "unchecked",
    stalePlaceholderNote: () => "placeholder",
    boundExecFailurePayload,
    collectMissingNodeTypeReasons: () => [],
  };
  const executor = makeGraphGetErrors(...GRAPH_GET_ERRORS_DEPS.map((name) => deps[name]));
  return executor();
}
