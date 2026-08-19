/**
 * #1122 — programmatic overwrite of a user-published subgraph blueprint.
 *
 * `graph_save_subgraph` already preflights a name collision so ComfyUI's
 * `publishSubgraph()` cannot pop `confirmOverwrite()` and hang a programmatic
 * call. That left no way to UPDATE a published blueprint: there is no delete
 * tool, and overwrite was refused. This module is the opt-in path:
 *
 *   - overwrite is NEVER inferred from a collision; the caller must pass
 *     `overwrite === true`
 *   - a bundled/global blueprint stays non-overwritable
 *   - ComfyUI's overwrite dialog is answered programmatically (type
 *     `overwriteBlueprint` only) so a human Save dialog never appears
 */

/** @typedef {"publish" | "overwrite" | "refuse-global" | "refuse-collision" | "refuse-ambiguous" | "refuse-keyed-differently"} SubgraphSaveCollisionAction */

/**
 * Decide what a colliding `graph_save_subgraph` call may do.
 *
 * @param {{
 *   hasCollision?: boolean,
 *   overwrite?: unknown,
 *   isGlobal?: boolean | null,
 *   matchCount?: number,
 *   sameCacheKey?: boolean,
 * }} [opts]
 * @returns {SubgraphSaveCollisionAction}
 */
export function subgraphSaveCollisionAction({
  hasCollision = false,
  overwrite,
  isGlobal = false,
  matchCount = 1,
  sameCacheKey = true,
} = {}) {
  if (!hasCollision) return "publish";
  // Only a POSITIVE true is global: unknown/unreadable stays overwritable-if-opted-in
  // rather than withholding a user-blueprint option that may well work (#636).
  if (isGlobal === true) return "refuse-global";
  if (overwrite !== true) return "refuse-collision";
  if (matchCount > 1) return "refuse-ambiguous";
  // A display_name hit whose stored type is a different key (hash-named) would make
  // publishSubgraph CREATE a second file instead of replacing the existing one.
  if (sameCacheKey !== true) return "refuse-keyed-differently";
  return "overwrite";
}

/**
 * True when the colliding library entry is keyed the way `publishSubgraph(name)`
 * looks it up — full type or prefix-stripped name — not merely by display_name.
 *
 * @param {object | null | undefined} collision
 * @param {{ fullType: string, finalName: string, prefix?: string }} names
 */
export function collisionSharesPublishKey(collision, { fullType, finalName, prefix = "SubgraphBlueprint." }) {
  if (!collision) return false;
  const type = typeof collision.name === "string" ? collision.name : "";
  const bare = type.startsWith(prefix) ? type.slice(prefix.length) : type;
  return type === fullType || bare === finalName;
}

/**
 * Identity of the library entry an overwrite is about to replace.
 *
 * @param {object | null | undefined} collision
 * @param {{ prefix?: string }} [opts]
 */
export function replacedBlueprintIdentity(collision, { prefix = "SubgraphBlueprint." } = {}) {
  const type = typeof collision?.name === "string" ? collision.name : null;
  const t = type ?? "";
  const name = t.startsWith(prefix) ? t.slice(prefix.length) : t;
  return {
    name: name || null,
    type,
    display_name: typeof collision?.display_name === "string" ? collision.display_name : null,
  };
}

/**
 * Agent-facing refusal. Global wording keeps the #636 phrases the unit tests pin.
 *
 * @param {{
 *   action: SubgraphSaveCollisionAction,
 *   finalName: string,
 *   collisionType?: string | null,
 * }} opts
 */
export function subgraphCollisionRefusalMessage({ action, finalName, collisionType }) {
  const typeBit =
    typeof collisionType === "string" && collisionType
      ? ` (type "${collisionType}")`
      : "";
  if (action === "refuse-global") {
    return (
      `a subgraph blueprint named "${finalName}" already exists${typeBit} and this ` +
      `tool will not replace it — replacing one programmatically would need ComfyUI's overwrite ` +
      `dialog, which cannot be answered from here. ` +
      `That one ships WITH ComfyUI, and ComfyUI refuses to delete a bundled blueprint — so ` +
      `there is no way to free the name. Save under a different one.`
    );
  }
  if (action === "refuse-ambiguous") {
    return (
      `a subgraph blueprint named "${finalName}" already exists${typeBit} and matches more ` +
      `than one library entry, so replacing one would be a guess. Pass the unique \`type\` ` +
      `from panel_list_subgraphs, or save under a different name.`
    );
  }
  if (action === "refuse-keyed-differently") {
    return (
      `a subgraph blueprint named "${finalName}" already exists${typeBit}, but ComfyUI ` +
      `stores it under that type rather than the requested name, so publishing again would ` +
      `create a second blueprint instead of replacing it. Save under a different name, or ` +
      `pass a name that matches the stored type.`
    );
  }
  return (
    `a subgraph blueprint named "${finalName}" already exists${typeBit} and this ` +
    `tool will not replace it — replacing one programmatically would need ComfyUI's overwrite ` +
    `dialog, which cannot be answered from here. ` +
    `Either save under a different name, pass overwrite:true to replace this user blueprint ` +
    `in place, or delete "${finalName}" from the subgraph library in the ComfyUI UI first ` +
    `and then retry this call.`
  );
}

/**
 * Run `publishSubgraph` while auto-confirming ComfyUI's overwriteBlueprint dialog
 * so a human never has to. Any other dialog type still goes through.
 *
 * @template T
 * @param {{ showDialog?: Function } | null | undefined} dialogStore  Pinia id "dialog"
 * @param {() => (T | Promise<T>)} run
 * @returns {Promise<T>}
 */
export async function withBlueprintOverwriteConfirm(dialogStore, run) {
  if (!dialogStore || typeof dialogStore.showDialog !== "function") {
    throw new Error(
      "cannot overwrite a subgraph blueprint programmatically: this ComfyUI frontend has no " +
        "dialog store to auto-confirm, and publishSubgraph would hang on the overwrite dialog. " +
        "Save under a different name instead.",
    );
  }
  const orig = dialogStore.showDialog;
  let answered = false;
  function patched(options) {
    if (options?.props?.type === "overwriteBlueprint") {
      answered = true;
      const onConfirm = options.props.onConfirm;
      if (typeof onConfirm === "function") onConfirm(true);
      return { key: options?.key ?? "overwriteBlueprint", visible: false };
    }
    return orig.call(dialogStore, options);
  }
  try {
    dialogStore.showDialog = patched;
  } catch {
    throw new Error(
      "cannot overwrite a subgraph blueprint programmatically: the dialog store's showDialog " +
        "could not be intercepted. Save under a different name instead.",
    );
  }
  if (dialogStore.showDialog !== patched) {
    throw new Error(
      "cannot overwrite a subgraph blueprint programmatically: the dialog store's showDialog " +
        "could not be intercepted. Save under a different name instead.",
    );
  }
  try {
    const result = await run();
    if (!answered) {
      throw new Error(
        "overwrite:true was set, but ComfyUI did not ask to overwrite this blueprint, so " +
          "nothing is being reported as replaced. The name may not be the library key. Check " +
          "panel_list_subgraphs and pass the stored type, or save under a different name.",
      );
    }
    return result;
  } finally {
    try {
      dialogStore.showDialog = orig;
    } catch {
      // best-effort restore; a later call must not keep auto-confirming
    }
  }
}
