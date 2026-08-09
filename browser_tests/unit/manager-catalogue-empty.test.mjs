// panel#808 — an unreachable Manager catalogue rendered as an empty node list rather
// than as "could not reach it".
//
// THE REPORTED FAILURE. A Chinese-speaking user was told to update the panel through
// ComfyUI Manager and replied "我这边搜不到任何内容" — I can't find anything when I search.
// That was read as a stale cache; a blocked registry fits the evidence better. Three
// rounds of advice were spent sending them at a door that could not open, and neither
// side could see it from the symptom, because EMPTY AND UNREACHABLE LOOK IDENTICAL.
//
// THE MECHANISM. `searchNodesVia` requests `customnode/getmappings?mode=cache`. When that
// answers HTTP 200 with `{}`, `parseNodeMappings` filters zero entries and returns
// `count: 0` — exactly what a healthy catalogue returns when the query matches nothing.
// The reader takes the first for the second, concludes the pack does not exist, and keeps
// trying variations of a search that cannot succeed.
//
// WHEN `{}` ACTUALLY HAPPENS — read out of ComfyUI-Manager's own source
// (glob/manager_core.py, `get_data_by_mode`) rather than assumed, because the first cut of
// this fix assumed wrong:
//
//   • A NETWORK failure does NOT empty the catalogue. The `except` branch falls back to
//     the bundled `extension-node-map.json` inside the Manager package — 2.2 MB and
//     populated on a stock install — so a blocked channel yields a full, if stale, list.
//   • `{}` comes from the `network_mode == 'offline'` path with neither a cache file nor
//     a local file, or from a data file that is itself empty/unreadable.
//
// So zero packs means Manager assembled a catalogue from NONE of its three sources, which
// is genuinely anomalous and is what keeps this branch free of false positives.
//
// THE DISCRIMINATOR is local and needs no new signal from Manager: how many packs the
// payload CONTAINED, before the query filter.
//
// WHAT IS DELIBERATELY NOT CLAIMED. The panel does not make the channel request, so it
// never observed DNS/timeout/TLS and must not report one — and it names Manager's actual
// DEFAULT_CHANNEL host, not api.comfy.org, which serves a different thing. These tests pin
// both. The related gap they do NOT close: because Manager degrades to the bundled copy, a
// genuinely blocked channel surfaces as a STALE catalogue, and the panel cannot yet tell
// stale from current.
import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogueSize,
  emptyCatalogueResult,
  parseNodeMappings,
  searchNodesVia,
} from "../../web/js/lib/manager-install.js";

/** A catalogue in the documented MAP shape: repo URL -> [ [classes…], meta ]. */
const POPULATED = {
  "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
    [],
    { title: "Impact Pack", description: "detailer and background tools" },
  ],
  "https://github.com/rgthree/rgthree-comfy": [[], { title: "rgthree-comfy" }],
};

// ---------------------------------------------------------------------------
// 1. The discriminator itself.
// ---------------------------------------------------------------------------

test("#808 catalogueSize counts packs RAW — before ids, before the query filter", () => {
  assert.equal(catalogueSize(POPULATED), 2);
  assert.equal(catalogueSize([{ id: "a" }, { id: "b" }, { id: "c" }]), 3);
  assert.equal(catalogueSize({}), 0);
  assert.equal(catalogueSize([]), 0);
  // A body that is not a catalogue at all carries no packs either.
  assert.equal(catalogueSize(null), 0);
  assert.equal(catalogueSize(undefined), 0);
  assert.equal(catalogueSize("<html>proxy sign-in</html>"), 0);
  // Entries with no installable id still COUNT as packs: a parse fault is a different
  // problem from an empty catalogue, and folding them together would hide both.
  assert.equal(catalogueSize({ "https://github.com/a/b": [[], {}] }), 1);
});

test("#808 parseNodeMappings reports catalogue_size alongside the matches", () => {
  // Populated catalogue, query matches nothing: count 0, but TWO packs were searched.
  const missed = parseNodeMappings(POPULATED, "seedvr2", 15);
  assert.equal(missed.count, 0);
  assert.equal(missed.catalogue_size, 2);

  // Empty catalogue: count 0 and NOTHING was searched. Same count, different fact.
  const empty = parseNodeMappings({}, "seedvr2", 15);
  assert.equal(empty.count, 0);
  assert.equal(empty.catalogue_size, 0);

  // A hit is unchanged, and still reports what it searched.
  const hit = parseNodeMappings(POPULATED, "impact", 15);
  assert.equal(hit.count, 1);
  assert.equal(hit.catalogue_size, 2);
});

// ---------------------------------------------------------------------------
// 2. The flow: which of the three states each payload produces.
// ---------------------------------------------------------------------------

const get = (payload) => async () => payload;
const throwing = () => async () => {
  throw new Error("not reachable");
};

test("#808 an EMPTY catalogue no longer reads as 'no matches'", async () => {
  const res = await searchNodesVia(get({}), throwing(), { query: "seedvr2" });

  assert.equal(res.catalogue_empty, true);
  assert.equal(res.searched, false, "the caller must be able to see nothing was searched");
  assert.equal(res.count, 0);
  assert.deepEqual(res.results, []);
  // Manager itself WAS reachable — this is not the Manager-unavailable case.
  assert.equal(res.managerReachable, true);
  assert.equal(res.supported, true);
  assert.equal(res.query, "seedvr2");
});

test("#808 a POPULATED catalogue that misses is still an ordinary no-match", async () => {
  // The regression this fix must not cause: a healthy catalogue returns count 0 all the
  // time, and that has to keep reading as the plain no-match it is.
  const res = await searchNodesVia(get(POPULATED), throwing(), { query: "seedvr2" });

  assert.equal(res.count, 0);
  assert.equal(res.catalogue_size, 2);
  assert.notEqual(res.catalogue_empty, true);
  assert.equal(res.searched, undefined, "no 'nothing was searched' claim — it did search");
  assert.equal(res.message, undefined, "a no-match needs no explanation");
});

test("#808 a normal hit is untouched", async () => {
  const res = await searchNodesVia(get(POPULATED), throwing(), { query: "impact" });
  assert.equal(res.count, 1);
  assert.equal(res.results[0].id, "https://github.com/ltdrdata/ComfyUI-Impact-Pack");
  assert.notEqual(res.catalogue_empty, true);
});

test("#808 an UNREACHABLE Manager keeps its own distinct result (#251/#255 intact)", async () => {
  // Three states, three answers. This one must not be absorbed into the new branch:
  // Manager could not be reached at all, which has a different remedy.
  const res = await searchNodesVia(throwing(), throwing(), { query: "seedvr2" });

  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
  assert.notEqual(res.catalogue_empty, true);
  assert.match(res.message, /could not\s+be reached/);
});

test("#808 the object_info fallback still wins over the empty-catalogue branch", async () => {
  // #426: when Manager is unreachable but installed nodes match, the agent gets those.
  // The new branch is about a REACHABLE Manager and must not intercept this path.
  const objectInfoGet = async () => ({
    SeedVR2VideoUpscaler: { display_name: "SeedVR2 Video Upscaler", category: "upscaling" },
  });
  const res = await searchNodesVia(throwing(), throwing(), {
    query: "seedvr2",
    objectInfoGet,
  });

  assert.equal(res.supported, true);
  assert.equal(res.source, "object_info");
  assert.equal(res.installedOnly, true);
  assert.equal(res.count, 1);
  assert.notEqual(res.catalogue_empty, true);
});

test("#808 a non-catalogue 200 body (a proxy sign-in page) is reported as empty, not as a miss", async () => {
  const res = await searchNodesVia(get("<html>sign in</html>"), throwing(), { query: "x" });
  assert.equal(res.catalogue_empty, true);
  assert.equal(res.searched, false);
});

// ---------------------------------------------------------------------------
// 3. The message. This is the deliverable — the report is about what the user is told.
// ---------------------------------------------------------------------------

test("#808 the message says nothing was searched, and that no conclusion follows", () => {
  const m = emptyCatalogueResult("seedvr2").message;
  assert.match(m, /nothing was actually searched/i);
  assert.match(m, /says NOTHING about whether "seedvr2" exists/);
  assert.match(m, /not "no matches"/i);
});

test("#808 the message names the host THIS catalogue comes from — and not the wrong one", () => {
  // The report's core ask: without a host, a user behind a national or corporate filter
  // has no way to connect "empty list" to "my network blocks this".
  //
  // The host has to be the RIGHT one. Verified against ComfyUI-Manager's own source:
  // DEFAULT_CHANNEL = "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main".
  // api.comfy.org serves pack INSTALLS, not this mapping — naming it would send a
  // filtered user to check something irrelevant, which fails the report's ask as surely
  // as naming no host at all.
  const m = emptyCatalogueResult("seedvr2").message;
  assert.match(m, /raw\.githubusercontent\.com\/ltdrdata\/ComfyUI-Manager/);
  assert.doesNotMatch(m, /api\.comfy\.org/);
  assert.match(m, /filtering/i);
});

test("#808 the message states the causes Manager's source actually produces", () => {
  // Read out of glob/manager_core.py `get_data_by_mode`: a NETWORK error falls back to
  // the bundled extension-node-map.json (populated), so it does NOT empty the list.
  // `{}` comes from network_mode 'offline' with no cache and no local file. Leading with
  // "your network is filtered" would therefore assert a cause the code contradicts.
  const m = emptyCatalogueResult("seedvr2").message;
  assert.match(m, /network_mode 'offline'/);
  assert.match(m, /missing or unreadable/);
  // All three sources are named, because "empty" means all three produced nothing.
  assert.match(m, /channel/i);
  assert.match(m, /cache/i);
  assert.match(m, /bundled/i);
});

test("#808 the cheap remedy comes BEFORE the network conclusion", () => {
  // A cache that never populated is the likelier cause, and sending that user to a VPN
  // is the same class of wrong answer as sending a blocked user to a retry.
  const m = emptyCatalogueResult("seedvr2").message;
  const refresh = m.search(/refresh the cache/i);
  const network = m.search(/behind corporate, campus or national network/i);
  assert.ok(refresh >= 0, "the cache-refresh remedy is offered");
  assert.ok(network >= 0, "the network cause is named");
  assert.ok(refresh < network, "cheap-and-likely first, network conclusion second");
});

test("#808 the message does NOT claim a transport failure the panel never observed", () => {
  // The panel does not make the registry request — Manager does. Asserting DNS/timeout/
  // TLS here would be inventing an observation, which is the failure mode #695/#700 were
  // filed about pointing the other way.
  const m = emptyCatalogueResult("seedvr2").message;
  for (const invented of [/\bDNS\b/, /ENOTFOUND/, /timed out/i, /\bTLS\b/, /certificate/i]) {
    assert.doesNotMatch(m, invented);
  }
});

test("#808 a missing query still produces a coherent message", () => {
  const m = emptyCatalogueResult(undefined).message;
  assert.match(m, /whether a pack exists/);
  assert.doesNotMatch(m, /undefined/);
  assert.equal(emptyCatalogueResult(undefined).query, "");
});
