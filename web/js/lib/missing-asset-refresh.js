// The graph error path refreshes node definitions before it trusts live combo
// membership. Keep that small ordering decision independently executable so its
// production consumer can be tested without evaluating the whole panel IIFE.

/**
 * Return whether this graph-error scan may trust the live combo lists.
 *
 * The caller owns the shared graph-error budget. A refresh that fails, times out,
 * or leaves another refresh in the single-flight slot is deliberately not trusted:
 * the collector must keep the raw missing candidate visible.
 */
export async function refreshMissingAssetTrust({
  refreshBudgetMs,
  refreshComfyNodeDefs,
  withRefreshTimeout,
  getRefreshInFlight,
}) {
  let comboTrustedForQuery = false;
  try {
    if (refreshBudgetMs > 0) {
      comboTrustedForQuery = await withRefreshTimeout(
        refreshComfyNodeDefs(undefined, { force: true }),
        refreshBudgetMs,
      );
      comboTrustedForQuery = comboTrustedForQuery && getRefreshInFlight() === null;
    }
  } catch {
    // A timeout or rejection must fail closed and leave the raw candidate reported.
    comboTrustedForQuery = false;
  }
  return comboTrustedForQuery === true;
}
