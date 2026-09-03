// Production-path harness for validationBanner — the turn-start injection that tells the
// agent what the user's canvas looks like. Kept outside a *.test.mjs module so other
// production-path regressions can drive the shipped function without importing and
// running this file's callers' test cases.
//
// Extracted the same way _graph-get-errors-harness.mjs extracts its executor: the real
// function body, run with injected dependencies, so a test observes what SHIPS rather
// than a re-implementation of it.
import { PANEL_SRC } from "./_panel-constants.mjs";
import { pruneContradictedNodeErrorMaps } from "../../web/js/lib/asset-staleness.js";

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`${signature} not found in panel source`);
  const open = source.indexOf("{", source.indexOf(")", start));
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

const VALIDATION_BANNER_SOURCE = extractFunctionBody(PANEL_SRC, "async function validationBanner() {");

const VALIDATION_BANNER_DEPS = [
  "app",
  "lastExecFailure",
  "lastInjectedValidationSig",
  "monotonicNow",
  "getErrorsStepBudgetMs",
  "getGraphCtx",
  "activeWorkflowRef",
  "hasRawMissingAssetCandidates",
  "GET_ERRORS_REFRESH_CAP_MS",
  "GET_ERRORS_STEP_CAP_MS",
  "nodeDefsRefreshConfirmed",
  "refreshMissingAssetTrust",
  "refreshComfyNodeDefs",
  "withRefreshTimeout",
  "nodeDefRefreshInFlight",
  "graphReadBindingChanged",
  "collectMissingAssets",
  "filterServerConfirmedInputSubfolderMedia",
  "collectAllGraphs",
  "adjudicateRecordedMissingNodeTypes",
  "isRegisteredNodeType",
  "LiteGraph",
  "coerceMessageText",
  "pruneContradictedNodeErrorMaps",
];

const makeValidationBanner = new Function(
  ...VALIDATION_BANNER_DEPS,
  `return (${VALIDATION_BANNER_SOURCE.replace(/^async function validationBanner\(\)/, "async function ()")});`,
);

const noMissing = () => ({ models: [], media: [], nodeTypes: [], nodeCount: 0 });

/** Run the SHIPPED validationBanner. Returns the banner text it would inject. */
export async function runProductionValidationBanner({
  lastNodeErrors = null,
  rootGraph = null,
  lastExecFailure = null,
  collectMissingAssets = noMissing,
  graphReadBindingChanged = () => false,
} = {}) {
  const deps = {
    app: { lastNodeErrors },
    lastExecFailure,
    lastInjectedValidationSig: null,
    monotonicNow: () => 0,
    getErrorsStepBudgetMs: () => 1000,
    getGraphCtx: () => ({ rootGraph }),
    activeWorkflowRef: () => "wf",
    hasRawMissingAssetCandidates: () => false,
    GET_ERRORS_REFRESH_CAP_MS: 18000,
    GET_ERRORS_STEP_CAP_MS: 4000,
    nodeDefsRefreshConfirmed: false,
    refreshMissingAssetTrust: async () => false,
    refreshComfyNodeDefs: () => {},
    withRefreshTimeout: () => {},
    nodeDefRefreshInFlight: null,
    graphReadBindingChanged,
    collectMissingAssets,
    filterServerConfirmedInputSubfolderMedia: async (media) => media,
    collectAllGraphs: (value) => [value],
    adjudicateRecordedMissingNodeTypes: (types) => ({ stillMissing: types, stalePlaceholders: [] }),
    isRegisteredNodeType: () => false,
    LiteGraph: {},
    coerceMessageText: (value) => String(value ?? ""),
    pruneContradictedNodeErrorMaps,
  };
  const banner = makeValidationBanner(...VALIDATION_BANNER_DEPS.map((name) => deps[name]));
  return banner();
}
