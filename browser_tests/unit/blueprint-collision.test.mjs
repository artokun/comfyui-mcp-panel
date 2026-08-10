// #636 — the blueprint collision preflight must see a collision on a HASH-NAMED store.
//
// graph_save_subgraph refuses a name collision rather than letting publishSubgraph()
// reach its own confirmOverwrite() dialog, which would hang a programmatic call on UI or
// replace a blueprint the caller never named.
//
// Measured on ComfyUI 0.31 (91 blueprints on this install):
//   store.typePrefix   -> absent, so the panel's "SubgraphBlueprint." fallback is used
//   89 of 91 names     -> SubgraphBlueprint.<content hash>
//   display_name       -> the name the user actually typed ("Text to Image")
//
// So both name-derived tests compare a NAME against a HASH and can never match. The
// preflight was blind on this frontend — exactly the failure its own comment predicted
// for "a frontend that names blueprints differently".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const site = src.slice(
  src.indexOf("const bareName = (d) => {"),
  src.indexOf("await store.publishSubgraph(finalName);"),
);

/** The preflight's own predicate, lifted so it is tested rather than described. */
const matchesRequested = (d, { fullType, finalName }) => {
  const prefix = "SubgraphBlueprint.";
  const bare = (x) => {
    const t = typeof x?.name === "string" ? x.name : "";
    return t.startsWith(prefix) ? t.slice(prefix.length) : t;
  };
  const display = (x) => (typeof x?.display_name === "string" ? x.display_name : "");
  return d?.name === fullType || bare(d) === finalName || display(d) === finalName;
};

test("#636: a HASH-named blueprint is matched by its display name", () => {
  // The shape this install actually serves.
  const stored = {
    name: "SubgraphBlueprint.04849b7409f059f520924d",
    display_name: "Text to Image",
  };
  const req = { fullType: "SubgraphBlueprint.Text to Image", finalName: "Text to Image" };
  assert.equal(matchesRequested(stored, req), true, "the collision must be seen");
  // …and the two name-derived tests, alone, cannot see it — which is why the third exists.
  assert.notEqual(stored.name, req.fullType);
  assert.notEqual(stored.name.slice("SubgraphBlueprint.".length), req.finalName);
});

test("#636: the older name-keyed shapes still match", () => {
  const req = { fullType: "SubgraphBlueprint.Save_Video", finalName: "Save_Video" };
  for (const stored of [
    { name: "SubgraphBlueprint.Save_Video" }, // full stored key
    { name: "Save_Video" }, // prefix-stripped
    { name: "SubgraphBlueprint.deadbeef", display_name: "Save_Video" }, // hashed
  ]) {
    assert.equal(matchesRequested(stored, req), true, JSON.stringify(stored));
  }
});

test("#636: an unrelated blueprint is NOT a collision", () => {
  const req = { fullType: "SubgraphBlueprint.Mine", finalName: "Mine" };
  for (const stored of [
    { name: "SubgraphBlueprint.abc123", display_name: "Something Else" },
    { name: "SubgraphBlueprint.Other" },
    { name: "SubgraphBlueprint.abc123" }, // hashed, no display_name at all
    {},
  ]) {
    assert.equal(matchesRequested(stored, req), false, JSON.stringify(stored));
  }
});

test("#636: the panel actually uses the display-name test", () => {
  // Without this the predicate above is a description of code that does not exist.
  assert.match(site, /display_name/, "the preflight must read display_name");
  assert.match(
    site,
    /displayName\(d\) === finalName/,
    "and compare it against the requested name",
  );
});
