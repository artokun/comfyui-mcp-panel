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

// ── Adding a saved blueprint by the name the library shows ──────────────────
//
// Same root cause as the preflight above: `graph_add_subgraph` built the type as
// prefix + name and called getBlueprint(type). On a hash-keyed store that resolves to
// nothing for the ONE name a user or agent would use — the one the library shows — while
// the opaque hash worked.

const addSite = src.slice(
  src.indexOf("const asType = name.startsWith(prefix)"),
  src.indexOf("const position = placementFor(graph, pos);"),
);

test("#636: the add path resolves a blueprint by display_name", () => {
  assert.ok(addSite.length > 0, "the resolution must exist");
  assert.match(addSite, /d\.display_name === name/, "the library name must be consulted");
  assert.match(addSite, /store\.getBlueprint\(type\)/, "and resolved through the store");
});

test("#636: the caller's string is tried AS A TYPE first", () => {
  // So an exact type or a hash resolves exactly as it did before, and this can only ever
  // add a resolution that previously failed — never change one that already worked.
  // The type lookup is attempted first; the display-name candidate is only CONSULTED
  // after it fails (it is computed earlier, but nothing is resolved from it until then).
  const typeFirst = addSite.indexOf("let type = asType;");
  const displayUsed = addSite.indexOf("displayMatches[0]?.name");
  assert.ok(typeFirst >= 0, "the type attempt must exist");
  assert.ok(displayUsed > typeFirst, "display_name is the FALLBACK, not the first try");
});

test("#636: the refusal names both things the caller could pass", () => {
  // The old message said only "No saved subgraph blueprint X", which on a hash-keyed
  // store was true of the name the user could actually see — unhelpful precisely when it
  // fired most.
  const msg = src.slice(src.indexOf("No saved subgraph blueprint"), src.indexOf("const position = placementFor"));
  assert.match(msg, /display_name/, "the library name is an accepted input and must be named");
  assert.match(msg, /type/, "so is the type");
});

test("#636: an AMBIGUOUS library name refuses rather than guessing", () => {
  // display_name is user-controlled and not unique. Taking the first match could insert a
  // DIFFERENT graph than the one asked for, and a wrong subgraph silently added is far
  // worse than a refusal the caller can resolve by passing the unique type (codex).
  const site = src.slice(
    src.indexOf("const displayMatches ="),
    src.indexOf("const position = placementFor(graph, pos);"),
  );
  assert.match(site, /displayMatches\.length > 1/, "more than one match must be detected");
  assert.match(site, /would be a guess/, "and refused in those words");
  assert.doesNotMatch(site, /\.find\(/, "no first-match shortcut may remain");
});

test("#636: a real store failure is not reported as 'never saved'", () => {
  const site = src.slice(
    src.indexOf("const displayMatches ="),
    src.indexOf("const position = placementFor(graph, pos);"),
  );
  assert.match(site, /lookupError = err;/, "the thrown error must be kept");
  assert.match(site, /the lookup also failed/, "and surfaced when nothing resolves");
});

// ── is_global was false for every blueprint ────────────────────────────────

const listStart = src.indexOf("const blueprints = [...defs].map((d) => {");
const listSite = src.slice(listStart, src.indexOf("});", src.indexOf("is_global: isGlobal")) + 3);

test("#636: is_global asks the STORE, not a property that does not exist", () => {
  // It read `d?.isGlobal === true`. A blueprint's keys are name, display_name, category,
  // main_category, python_module, description, help, deprecated — no isGlobal — so the
  // field was always false, asserting "user blueprint" for every bundled one.
  assert.ok(listSite.length > 0, "the list mapper must exist");
  // The dead READ, not any mention of it — the comment above the fix quotes the old
  // expression on purpose, so the assertion has to name the assignment.
  assert.doesNotMatch(listSite, /is_global: d\?\.isGlobal/, "the dead property read must be gone");
  assert.match(listSite, /store\.isGlobalBlueprint\(bare\)/, "the store predicate must be asked");
});

test("#636: it passes the PREFIX-STRIPPED name, as ComfyUI itself does", () => {
  // subgraphStore.isGlobalBlueprint(name.slice(BLUEPRINT_TYPE_PREFIX.length)) — passing
  // the object instead is what made an earlier probe answer false for everything and
  // look correct.
  assert.match(listSite, /const bare = type\.startsWith\(prefix\)/, "the name must be stripped");
  assert.match(listSite, /isGlobalBlueprint\(bare\)/, "and the stripped form passed");
});

test("#636: an unavailable predicate reports null, never false", () => {
  // "This frontend cannot tell me" and "this is a user blueprint" are different answers,
  // and asserting the second in place of the first IS the defect being fixed.
  assert.match(listSite, /let isGlobal = null;/, "unknown starts as null");
  assert.match(listSite, /isGlobal = null;/, "and a throw returns to null");
  assert.doesNotMatch(listSite, /isGlobal = false/, "absence must never be reported as user-owned");
});

test("#636: an unrecognised prefix does not get asked at all", () => {
  // `prefix` is a fallback — the measured frontend exposes no typePrefix — so a type that
  // does not start with it leaves the name UNSTRIPPED, and the predicate would answer
  // `false` for a question it was never asked properly. That is indistinguishable from a
  // real user blueprint, and nothing at runtime can detect the disagreement, so the only
  // honest answer is null (codex).
  assert.match(
    listSite,
    /type\.startsWith\(prefix\) && typeof store\.isGlobalBlueprint === "function"/,
    "the predicate must be gated on the prefix having matched",
  );
});

// ── the refusal must not advise an impossible remedy ───────────────────────

const refusalSite = src.slice(
  src.indexOf("let collisionIsGlobal = false;"),
  src.indexOf("await store.publishSubgraph(finalName);"),
);

test("#636: a GLOBAL collision is not told to delete it", () => {
  // subgraphStore.deleteBlueprint refuses a bundled blueprint outright, so "delete it and
  // retry" is unfollowable — and on a stock install most blueprints are global, making it
  // the likeliest collision. The wording lives in subgraphCollisionRefusalMessage so it
  // is tested as a string; pin that this site still classifies globality and refuses
  // through that helper (overwrite:true cannot free a bundled name — #1122).
  assert.ok(refusalSite.length > 0, "the refusal must classify the collision");
  assert.match(refusalSite, /subgraphCollisionRefusalMessage/, "the refusal must use the shared wording");
  assert.match(refusalSite, /subgraphSaveCollisionAction/, "and classify before throwing");
});

test("#636: UNKNOWN is not treated as global", () => {
  // Only a positive true narrows the remedy. An older frontend or unreadable predicate
  // keeps the existing wording rather than withholding an option that may well work.
  assert.match(refusalSite, /=== true;/, "globality must be a positive test");
  assert.match(refusalSite, /collisionIsGlobal = false;/, "and anything else falls back");
  assert.match(refusalSite, /startsWith\(prefix\)/, "with the same prefix gate as the listing");
});
