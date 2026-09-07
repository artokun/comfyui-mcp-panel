// Production-path harness for graph_get_errors. Kept outside a *.test.mjs module so other
// production-path regressions can drive the shipped executor without importing and running
// this file's unrelated test cases.
import { PANEL_SRC } from "./_panel-constants.mjs";
import {
  combineNodeErrorMaps,
  findNodeByScopedId,
  findVisibleNodeByScopedId,
  graphGetErrorsLiveScanStale,
  pruneContradictedNodeErrorMaps,
  recordedMissingTypesOnLiveGraph,
} from "../../web/js/lib/asset-staleness.js";
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
  "graphGetErrorsLiveScanStale",
  "collectAllGraphs",
  "adjudicateRecordedMissingNodeTypes",
  "recordedMissingTypesOnLiveGraph",
  "isRegisteredNodeType",
  "LiteGraph",
  "findVisibleNodeByScopedId",
  "findNodeByScopedId",
  "getPiniaStore",
  "combineNodeErrorMaps",
  "pruneContradictedNodeErrorMaps",
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
  lastNodeErrors = null,
  storeNodeErrors = null,
  scan = async () => null,
  fetchSingleNodeInfo = () => {},
  // The extracted executor's default scan is a no-op test double. Give it a
  // usable budget so callers that are not exercising live-scan exhaustion retain
  // their clean-note assertions.
  stepBudget = () => 1000,
  monotonicNow = () => 0,
  hasRawMissingAssetCandidates = () => false,
  refreshMissingAssetTrust = async () => false,
  refreshComfyNodeDefs = () => {},
  withRefreshTimeout = () => {},
  getRefreshInFlight = () => null,
  collectMissingAssets = () => ({ models: [], media: [], nodeTypes: [], nodeCount: 0 }),
  filterServerConfirmedInputSubfolderMedia = async (media) => media,
  inputAssetServerUsesWindowsPaths = async () => false,
  objectInfoCache = createObjectInfoCache(),
  objectInfoSnapshot = createObjectInfoSnapshot(),
  verifiedNodeDefCache = createVerifiedNodeDefCache(),
  collectAllGraphs = (value) => [value],
  graphReadBindingChanged = () => false,
  activeWorkflowRef = () => null,
  graphGetErrorsLiveScanStale: graphGetErrorsLiveScanStaleOverride,
  recordedMissingTypesOnLiveGraph: recordedMissingTypesOnLiveGraphOverride,
  adjudicateRecordedMissingNodeTypes = (types) => ({ stillMissing: types, stalePlaceholders: [] }),
  collectMissingNodeTypeReasons = () => [],
}) {
  const deps = {
    monotonicNow,
    getErrorsStepBudgetMs: stepBudget,
    hasRawMissingAssetCandidates,
    GET_ERRORS_REFRESH_CAP_MS: 18000,
    refreshMissingAssetTrust,
    refreshComfyNodeDefs,
    withRefreshTimeout,
    getRefreshInFlight,
    nodeDefRefreshInFlight: null,
    getGraphCtx: () => ({ app: { lastNodeErrors }, graph, rootGraph }),
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
    assertGraphBoundToActiveWorkflow: () => {},
    graphCommandBindingBar: () => ({}),
    collectMissingAssets,
    activeWorkflowRef,
    GET_ERRORS_STEP_CAP_MS: 4000,
    filterServerConfirmedInputSubfolderMedia,
    inputAssetServerUsesWindowsPaths,
    scanComboAvailability: scan,
    fetchSingleNodeInfo,
    probeInputAssetPresence: () => {},
    graphReadBindingChanged,
    graphGetErrorsLiveScanStale:
      graphGetErrorsLiveScanStaleOverride ?? graphGetErrorsLiveScanStale,
    collectAllGraphs,
    adjudicateRecordedMissingNodeTypes,
    recordedMissingTypesOnLiveGraph:
      recordedMissingTypesOnLiveGraphOverride ?? recordedMissingTypesOnLiveGraph,
    isRegisteredNodeType: () => false,
    LiteGraph: {},
    findVisibleNodeByScopedId,
    findNodeByScopedId,
    // The real validation-map union and the real live-graph correlation, so a
    // production-path test drives the SHIPPED pruning rather than a stub of it.
    getPiniaStore: () => (storeNodeErrors ? { lastNodeErrors: storeNodeErrors } : null),
    combineNodeErrorMaps,
    pruneContradictedNodeErrorMaps,
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
    collectMissingNodeTypeReasons,
  };
  const executor = makeGraphGetErrors(...GRAPH_GET_ERRORS_DEPS.map((name) => deps[name]));
  return executor();
}
