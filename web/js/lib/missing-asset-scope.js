/**
 * panel#745 — panel_get_errors reports missing MODELS from a scan that only ever
 * ran at workflow LOAD, so a loader added afterwards is invisible to it.
 *
 * ComfyUI populates the `missingModel`/`missingMedia` Pinia stores when a workflow
 * is loaded. The panel reads them (four read sites, zero writes) and its own logic
 * only ever SUBTRACTS — isStaleAssetCandidate drops a candidate whose file has
 * since appeared. There is no counterpart that finds new ones. So the reporter's
 * newly added LoraLoaderModelOnly, holding an unavailable basename, was absent
 * from both `nodes[]` and `missing_models[]` while four load-time nodes reported
 * correctly.
 *
 * THIS IS THE DISCLOSURE HALF ONLY. Actually scanning the live graph is the real
 * fix and is deliberately not done here: judging a combo value requires a TRUSTED
 * /object_info refresh, the refresh is gated on the store already having
 * candidates, and getting that wrong reports every combo on the canvas as missing
 * — mass false positives on the error surface, which is worse than the omission.
 * Saying "this answer has a known blind spot" costs nothing and cannot misfire.
 *
 * FIRES ONLY WHEN IT MATTERS. An unmodified workflow has not changed since the
 * scan ran, so the scan is current and a caveat would be noise on every call.
 * `isModified` is the exact, non-heuristic signal for "edits happened after the
 * scan" — which is precisely the window in which the answer can be incomplete.
 */

/** True when the missing-asset answer may be incomplete: the workflow has been
 *  edited since the load-time scan that produced it. Absent/unknown modification
 *  state does NOT trigger it — an unobserved edit is not an observed one, and a
 *  caveat on every call trains readers to skip it. */
export function missingAssetScanMayBeStale(activeWorkflow) {
  return activeWorkflow?.isModified === true;
}

/** The caveat itself. Names the blind spot, the reason, and the check that closes
 *  it — a limitation without a workaround is a dead end. */
export function missingAssetScopeNote() {
  return (
    "SCOPE: missing-model/media detection comes from the scan ComfyUI runs when a workflow is " +
    "LOADED, and this workflow has been edited since. Nodes or widget values added after the " +
    "load are NOT re-scanned, so a loader added this session pointing at an unavailable file " +
    "will not appear above. An empty missing_models list is therefore not proof that nothing " +
    "is missing. To check a node you added, read it with panel_query_graph {ids:[…], " +
    "fields:'detail'} and compare its value against the combo's options."
  );
}
