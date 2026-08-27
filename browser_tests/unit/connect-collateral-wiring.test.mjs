/**
 * WIRING pins for the graph_connect collateral verdict (artokun/comfyui-mcp#2380).
 *
 * connect-collateral.test.mjs proves the verdict logic is correct. It cannot prove
 * graph_connect ever CALLS it — a perfectly-tested verifier that no production path
 * reaches would leave #2380 exactly as reported, with the suite green. These pins read
 * the panel source and assert the call sites exist on BOTH return paths.
 *
 * Read with CRLF normalized: the panel tree is CRLF, so a multi-line anchor taken from
 * `git show` never matches the working file (that mismatch silently disarmed four pins
 * in comfyui-mcp-panel#1880 — they passed on CI and were dead on Windows).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** The body of graph_connect only — so a match in graph_disconnect (which has had this
 *  check since #668) can never stand in for one on the connect path. */
const CONNECT_BODY = (() => {
  const start = SRC.indexOf("graph_connect({ from_node_id");
  assert.ok(start > 0, "graph_connect not found — this pin has lost its subject");
  const end = SRC.indexOf("graph_disconnect({ node_id, input })", start);
  assert.ok(end > start, "graph_disconnect not found after graph_connect");
  return SRC.slice(start, end);
})();

test("graph_connect snapshots the whole graph BEFORE the mutation", () => {
  const snap = CONNECT_BODY.indexOf("const graphBefore = snapshotGraphState(graph);");
  assert.ok(snap > 0, "no pre-mutation snapshot on the connect path");
  const mutate = CONNECT_BODY.indexOf("origin[\"connect\"](outIdx, target, inIdx)");
  assert.ok(mutate > 0, "the connect mutation site moved — re-anchor this pin");
  assert.ok(
    snap < mutate,
    "the snapshot must be taken BEFORE the wire is made, or it compares the graph to itself",
  );
});

test("BOTH return paths compute a verdict — the success path is the reported one", () => {
  assert.ok(
    /const verdict = verifyConnect\(graph, graphBefore, \{/.test(CONNECT_BODY),
    "success path does not call verifyConnect",
  );
  assert.ok(
    /const landedVerdict = verifyConnect\(graph, graphBefore, \{/.test(CONNECT_BODY),
    "throw-but-landed path does not call verifyConnect",
  );
  assert.equal(
    CONNECT_BODY.match(/verifyConnect\(/g).length,
    2,
    "one verdict per node-to-node return path. The subgraph-RAIL paths are deliberately " +
      "out of scope here and tracked separately — see the PR.",
  );
});

test("the throw path names the LANDED link id too, not only connect()'s return", () => {
  assert.ok(
    /intendedLinkIds: \[link\?\.id, landed\.linkId\]/.test(CONNECT_BODY),
    "a re-slotted link carries a different id; naming only link.id reports it as collateral",
  );
});

test("both paths pass the replaced link, so a connect's own displacement is excluded", () => {
  assert.equal(
    (CONNECT_BODY.match(/replacedLinkId: prevLinkId,/g) ?? []).length,
    2,
    "without this the wire connect legitimately displaces is cried as collateral every time",
  );
});

test("both paths surface the verdict to the caller", () => {
  assert.ok(
    /\.\.\.\(collateral\.length \? \{ collateral_changes: collateral \} : \{\}\)/.test(CONNECT_BODY),
    "success path computes a verdict but does not put it in the payload",
  );
  assert.ok(
    /\.\.\.\(landedCollateral\.length \? \{ collateral_changes: landedCollateral \} : \{\}\)/.test(
      CONNECT_BODY,
    ),
    "throw path computes a verdict but does not put it in the payload",
  );
  assert.equal(
    (CONNECT_BODY.match(/connectCollateralWarning\(/g) ?? []).length,
    2,
    "each node path must carry the warning sentence, not just the bullets",
  );

});

test("the verdict never REFUSES — the mutation has already happened", () => {
  // #1272's lesson: reporting failure for a connect that landed invites a destructive
  // retry. A `throw` keyed on the collateral verdict would reintroduce exactly that.
  const afterVerdict = CONNECT_BODY.slice(CONNECT_BODY.indexOf("const verdict = verifyConnect"));
  assert.ok(
    !/if \(!verdict\.ok\)[\s\S]{0,200}throw new Error/.test(afterVerdict),
    "collateral must be DISCLOSED, never thrown on",
  );
});
