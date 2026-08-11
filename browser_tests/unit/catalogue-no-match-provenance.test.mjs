/**
 * #890 — a blocked registry does not yield an EMPTY catalogue. It yields a FULL one that
 * may be months old, presented identically to a current one, so a user searching for a
 * recently published pack gets "no matches" — indistinguishable from "that pack does not
 * exist". #808 closed the empty case; this is the one it left open, and the likelier one
 * in the field, because Manager works hard never to return empty.
 *
 * WHAT CANNOT BE CLAIMED, and the issue's own follow-up establishes it by measurement:
 * the served catalogue is NOT the bundled `extension-node-map.json` (5583 served vs 4884
 * bundled on a working rig, sharing only ~1800 keys), so a "is this the bundled map"
 * discriminator would never fire and would ship as a check that always passes. Nothing in
 * the payload carries a fetch time or a source, so staleness is not observable and is not
 * asserted here.
 *
 * WHAT CAN: the panel asked for `mode=cache`. That is its own request, not an inference
 * about the response, and it is exactly the fact a reader needs before concluding a pack
 * does not exist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cachedCatalogueNoMatch, searchNodesVia, parseNodeMappings } from "../../web/js/lib/manager-install.js";

/** A populated catalogue in the object shape Manager serves. */
const catalogue = (n) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `https://github.com/someone/pack-${i}`,
      [[`Node${i}`], { title_aux: `Pack ${i}`, id: `pack-${i}` }],
    ]),
  );

test("#890 a no-match over a CACHED catalogue says which catalogue was searched", () => {
  const note = cachedCatalogueNoMatch("brand-new-pack", 5583, "customnode/getmappings?mode=cache");
  assert.equal(note.catalogue_mode, "cache");
  assert.match(note.no_match_note, /"brand-new-pack"/, "names what was searched for");
  assert.match(note.no_match_note, /CACHED copy \(5583 packs\)/, "and what was searched");
  assert.match(note.no_match_note, /published after the cache was last refreshed will not appear/);
  assert.match(note.no_match_note, /refresh the cache from the Manager UI/, "the remedy");
});

test("#890 it claims NOTHING about the cache's age or its source", () => {
  const note = cachedCatalogueNoMatch("x", 5583, "customnode/getmappings?mode=cache");
  assert.match(note.no_match_note, /The panel makes no claim about the cache's age/);
  assert.doesNotMatch(note.no_match_note, /stale|out of date|months/i, "staleness is not observable and is not asserted");
  assert.doesNotMatch(note.no_match_note, /blocked|offline|unreachable/i, "nor the network condition behind it");
  // The three possible sources are NAMED as unknown rather than picked.
  assert.match(note.no_match_note, /whether it came from the network, the on-disk cache or the copy/);
});

test("#890 the mode is read off the ROUTE, so the note cannot outlive the request it describes", () => {
  assert.deepEqual(cachedCatalogueNoMatch("x", 10, "customnode/getmappings?mode=default"), {}, "a live fetch says nothing");
  assert.deepEqual(cachedCatalogueNoMatch("x", 10, "customnode/getmappings"), {}, "no mode, no claim");
  assert.deepEqual(cachedCatalogueNoMatch("x", 10, null), {});
  assert.deepEqual(cachedCatalogueNoMatch("x", 10, undefined), {});
  assert.equal(cachedCatalogueNoMatch("x", 10, "a?mode=cache&extra=1").catalogue_mode, "cache", "other params are fine");
});

test("#890 an unreadable size is omitted rather than printed as garbage", () => {
  for (const size of [null, undefined, NaN, "many", {}]) {
    const note = cachedCatalogueNoMatch("x", size, "r?mode=cache");
    assert.equal(note.catalogue_mode, "cache");
    assert.doesNotMatch(note.no_match_note, /\(null packs\)|\(NaN packs\)|\(undefined packs\)|\[object/);
    assert.match(note.no_match_note, /CACHED copy —/, "the sentence still reads");
  }
});

test("#890 a MATCH is untouched — the note is for the answer that can mislead", async () => {
  const data = catalogue(50);
  const hit = await searchNodesVia(async () => data, async () => data, { query: "pack-7", limit: 15 });
  assert.ok(hit.count > 0, "found something");
  assert.equal("no_match_note" in hit, false, "a result that found packs needs no disclaimer");
  assert.equal("catalogue_mode" in hit, false);
});

test("#890 a no-match through the real search path carries the note", async () => {
  const data = catalogue(5583);
  const miss = await searchNodesVia(async () => data, async () => data, { query: "definitely-not-here", limit: 15 });
  assert.equal(miss.count, 0);
  assert.equal(miss.catalogue_size, 5583, "the #808 fact is still reported");
  assert.equal(miss.catalogue_mode, "cache");
  assert.match(miss.no_match_note, /definitely-not-here/);
});

test("#890 an EMPTY catalogue keeps its own #808 answer, which says something stronger", async () => {
  // "Nothing was searched" is a different and more serious statement than "nothing
  // matched", and it must not be replaced by the softer no-match note.
  const empty = await searchNodesVia(async () => ({}), async () => ({}), { query: "x", limit: 15 });
  assert.equal(empty.catalogue_empty, true);
  assert.equal(empty.searched, false);
  assert.equal("no_match_note" in empty, false);
  assert.match(empty.message, /contains ZERO packs/);
});

test("#890 the parser itself is unchanged — the note is added at the search boundary", () => {
  const parsed = parseNodeMappings(catalogue(20), "nothing-matches", 15);
  assert.equal(parsed.count, 0);
  assert.equal(parsed.catalogue_size, 20);
  assert.equal("no_match_note" in parsed, false, "parseNodeMappings stays a pure parse");
});

test("#890 source guard: the search route still asks for the cache the note describes", () => {
  const src = readFileSync(new URL("../../web/js/lib/manager-install.js", import.meta.url), "utf8");
  assert.match(src, /const route = "customnode\/getmappings\?mode=cache";/, "the route the note reads");
  assert.match(
    src,
    /parsed\.count === 0 \? \{ \.\.\.parsed, \.\.\.cachedCatalogueNoMatch\(query, parsed\.catalogue_size, route\) \} : parsed/,
    "applied only to a no-match, and given the route actually requested",
  );
});
