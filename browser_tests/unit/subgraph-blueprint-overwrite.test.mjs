// #1122 — graph_save_subgraph must be able to REPLACE a user-published blueprint
// without a human Save dialog, and must never infer that from a name collision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collisionSharesPublishKey,
  replacedBlueprintIdentity,
  subgraphCollisionRefusalMessage,
  subgraphSaveCollisionAction,
  withBlueprintOverwriteConfirm,
} from "../../web/js/lib/subgraph-blueprint-overwrite.js";

test("#1122: a collision without overwrite:true still refuses", () => {
  assert.equal(
    subgraphSaveCollisionAction({ hasCollision: true, overwrite: false, isGlobal: false }),
    "refuse-collision",
  );
  assert.equal(
    subgraphSaveCollisionAction({ hasCollision: true, isGlobal: false }),
    "refuse-collision",
    "omitted overwrite must not be treated as consent",
  );
});

test("#1122: overwrite is NEVER inferred from a truthy non-true value", () => {
  for (const overwrite of [1, "true", "yes", {}, []]) {
    assert.equal(
      subgraphSaveCollisionAction({ hasCollision: true, overwrite, isGlobal: false }),
      "refuse-collision",
      JSON.stringify(overwrite),
    );
  }
});

test("#1122: overwrite:true on a user blueprint is the replace path", () => {
  assert.equal(
    subgraphSaveCollisionAction({
      hasCollision: true,
      overwrite: true,
      isGlobal: false,
    }),
    "overwrite",
  );
});

test("#1122: a GLOBAL blueprint stays non-overwritable even with overwrite:true", () => {
  assert.equal(
    subgraphSaveCollisionAction({
      hasCollision: true,
      overwrite: true,
      isGlobal: true,
    }),
    "refuse-global",
  );
});

test("#1122: unknown globality is not treated as global", () => {
  // Same rule as the #636 listing: only a positive true narrows the remedy.
  for (const isGlobal of [false, null, undefined]) {
    assert.equal(
      subgraphSaveCollisionAction({
        hasCollision: true,
        overwrite: true,
        isGlobal,
      }),
      "overwrite",
      String(isGlobal),
    );
  }
});

test("#1122: no collision is a normal publish, even with overwrite:true", () => {
  assert.equal(
    subgraphSaveCollisionAction({ hasCollision: false, overwrite: true }),
    "publish",
  );
});

test("#1122: an ambiguous library name refuses rather than guessing which to replace", () => {
  assert.equal(
    subgraphSaveCollisionAction({
      hasCollision: true,
      overwrite: true,
      isGlobal: false,
      matchCount: 2,
    }),
    "refuse-ambiguous",
  );
});

test("#1122: a display_name-only hit is not an in-place replace", () => {
  assert.equal(
    subgraphSaveCollisionAction({
      hasCollision: true,
      overwrite: true,
      isGlobal: false,
      sameCacheKey: false,
    }),
    "refuse-keyed-differently",
  );
});

test("#1122: collisionSharesPublishKey matches type / bare name, not display_name alone", () => {
  const names = {
    fullType: "SubgraphBlueprint.Mine",
    finalName: "Mine",
  };
  assert.equal(collisionSharesPublishKey({ name: "SubgraphBlueprint.Mine" }, names), true);
  assert.equal(collisionSharesPublishKey({ name: "Mine" }, names), true);
  assert.equal(
    collisionSharesPublishKey(
      { name: "SubgraphBlueprint.deadbeef", display_name: "Mine" },
      names,
    ),
    false,
    "a hash-keyed entry would CREATE a second file if published under Mine",
  );
  assert.equal(collisionSharesPublishKey(null, names), false);
});

test("#1122: the reply identity names what was replaced", () => {
  assert.deepEqual(
    replacedBlueprintIdentity({
      name: "SubgraphBlueprint.Save_Video",
      display_name: "Save Video",
    }),
    {
      name: "Save_Video",
      type: "SubgraphBlueprint.Save_Video",
      display_name: "Save Video",
    },
  );
});

test("#1122: the collision refusal names overwrite:true as the programmatic option", () => {
  const msg = subgraphCollisionRefusalMessage({
    action: "refuse-collision",
    finalName: "Mine",
    collisionType: "SubgraphBlueprint.Mine",
  });
  assert.match(msg, /overwrite:true/);
  assert.match(msg, /already exists \(type "SubgraphBlueprint.Mine"\)/);
  assert.match(msg, /different name/);
});

test("#1122: a GLOBAL refusal still says the name cannot be freed", () => {
  const msg = subgraphCollisionRefusalMessage({
    action: "refuse-global",
    finalName: "Text to Image",
    collisionType: "SubgraphBlueprint.04849b7409f059f520924d",
  });
  assert.match(msg, /ships WITH ComfyUI/);
  assert.match(msg, /Save under a different one/);
  assert.doesNotMatch(msg, /overwrite:true/, "a bundled blueprint cannot be freed by the flag");
});

test("#1122: auto-confirm answers overwriteBlueprint and no other type", async () => {
  const calls = [];
  const store = {
    showDialog(options) {
      calls.push(options);
      return { shown: true };
    },
  };
  let confirmed = false;
  await withBlueprintOverwriteConfirm(store, async () => {
    store.showDialog({
      key: "global-prompt",
      props: { type: "overwriteBlueprint", onConfirm: () => { confirmed = true; } },
    });
    const other = store.showDialog({ props: { type: "delete", onConfirm: () => {} } });
    assert.equal(other.shown, true, "non-overwrite dialogs must still go through");
  });
  assert.equal(confirmed, true);
  assert.equal(calls.length, 1, "overwriteBlueprint must not reach the real showDialog");
  assert.equal(calls[0].props.type, "delete");
});

test("#1122: auto-confirm restores showDialog even when the publish throws", async () => {
  const orig = function origShowDialog() { return "orig"; };
  const store = { showDialog: orig };
  await assert.rejects(
    () => withBlueprintOverwriteConfirm(store, async () => {
      store.showDialog({ props: { type: "overwriteBlueprint", onConfirm: () => {} } });
      throw new Error("publish failed");
    }),
    /publish failed/,
  );
  assert.equal(store.showDialog, orig);
});

test("#1122: auto-confirm refuses rather than hang when there is no dialog store", async () => {
  await assert.rejects(
    () => withBlueprintOverwriteConfirm(null, async () => {}),
    /no dialog store/,
  );
});

test("#1122: auto-confirm refuses if ComfyUI never asked to overwrite", async () => {
  const orig = function origShowDialog() { return "orig"; };
  const store = { showDialog: orig };
  await assert.rejects(
    () => withBlueprintOverwriteConfirm(store, async () => "published"),
    /did not ask to overwrite/,
  );
  assert.equal(store.showDialog, orig, "must restore even on the unanswered path");
});

// ── wiring: the panel actually uses this path ───────────────────────────────

const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const saveSite = src.slice(
  src.indexOf("async graph_save_subgraph("),
  src.indexOf("graph_list_subgraphs({ filter, limit } = {})"),
);

test("#1122: graph_save_subgraph accepts overwrite", () => {
  assert.match(saveSite, /async graph_save_subgraph\(\{ node_id, name, overwrite \} = \{\}\)/);
});

test("#1122: overwrite goes through the auto-confirm helper, not a human dialog", () => {
  assert.match(saveSite, /withBlueprintOverwriteConfirm/);
  assert.match(saveSite, /getPiniaStore\("dialog"\)/);
  assert.match(saveSite, /replaced:/);
});

test("#1122: the no-flag refusal still ends at publishSubgraph so #636 slices stay valid", () => {
  // blueprint-collision.test.mjs slices up to this exact call. Keep it as the
  // non-overwrite publish so those tests continue to pin the preflight.
  assert.match(saveSite, /await store\.publishSubgraph\(finalName\);/);
});
