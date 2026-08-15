/**
 * #1088 — `panel_search_nodes` matched the query as ONE contiguous substring, so any
 * multi-word query returned zero against a catalogue that plainly contains the pack.
 *
 * MEASURED against the reporter's own three packs (they saw 14 hits for "overlay",
 * these are the three they named), on the map shape Manager serves:
 *
 *   "overlay"             -> 3   comfyui-textoverlay, ComfyUI-text-overlay, advanced-textoverlay
 *   "text overlay"        -> 0
 *   "Simple Text Overlay" -> 0
 *
 * The reason is entirely in the SEPARATOR. Pack identity lives in the repo name, which
 * spells the same words `textoverlay` or `text-overlay`; a human types `text overlay`.
 * `hay.includes("text overlay")` is false for both spellings, so a real pack reports as
 * absent — and with `catalogue_size: 5583` alongside it, a 0 reads as "this pack does not
 * exist", which is exactly the conflation #808 exists to prevent. The reporter nearly
 * installed the wrong pack on the strength of it.
 *
 * THE MATCHER IS A SUPERSET, NOT A REPLACEMENT (the property that makes this safe to
 * ship): every term of a query that matched contiguously is still a substring of the same
 * haystack, so nothing that matched before can stop matching. That is asserted below
 * rather than argued, because "more permissive" is the kind of claim that is easy to state
 * and easy to get wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseNodeMappings, parseObjectInfoSearch } from "../../web/js/lib/manager-install.js";

/**
 * The reporter's packs, in Manager's documented MAP shape. Titles deliberately carry the
 * REPO spelling rather than a friendly space-separated one — that is what the live
 * catalogue serves for these three, and a helpful title would hide the whole defect.
 */
const CATALOGUE = {
  "https://github.com/Munkyfoot/comfyui-textoverlay": [
    [],
    { title: "comfyui-textoverlay", description: "Adds a node to overlay text on an image" },
  ],
  "https://github.com/mbrostami/ComfyUI-text-overlay": [
    [],
    { title: "ComfyUI-text-overlay", description: "Overlay node" },
  ],
  "https://github.com/z/advanced-textoverlay": [
    [],
    { title: "advanced-textoverlay", description: "advanced overlay tools" },
  ],
  "https://github.com/y/comfyui-impact-pack": [[], { title: "Impact Pack", description: "detailer nodes" }],
};

const titles = (r) => r.results.map((x) => x.title).sort();

test("#1088 a multi-word query finds the packs a single token already found", () => {
  // The single token is the control: this is the search that worked, and it must keep
  // working identically.
  assert.equal(parseNodeMappings(CATALOGUE, "overlay", 15).count, 3);

  const twoWords = parseNodeMappings(CATALOGUE, "text overlay", 15);
  assert.equal(twoWords.count, 3, '"text overlay" must reach the same three packs');
  assert.deepEqual(titles(twoWords), ["ComfyUI-text-overlay", "advanced-textoverlay", "comfyui-textoverlay"]);
});

test("#1088 every term must match — AND, not OR", () => {
  // OR would be a worse bug than the one being fixed: "impact overlay" would return
  // everything and the caller could not tell a real hit from noise.
  assert.equal(parseNodeMappings(CATALOGUE, "impact overlay", 15).count, 0);
  assert.deepEqual(titles(parseNodeMappings(CATALOGUE, "impact pack", 15)), ["Impact Pack"]);
});

test("#1088 terms match across the id, title and description together", () => {
  // "advanced" is in the id/title, "tools" only in the description. A term-wise matcher
  // that required all terms in ONE field would miss this.
  assert.deepEqual(titles(parseNodeMappings(CATALOGUE, "advanced tools", 15)), ["advanced-textoverlay"]);
});

test("#1088 surrounding and repeated whitespace is not part of the query", () => {
  // The old matcher looked for the literal "  overlay  " and found nothing — a query the
  // caller cannot see is padded, e.g. one assembled from a template.
  assert.equal(parseNodeMappings(CATALOGUE, "  overlay  ", 15).count, 3);
  assert.equal(parseNodeMappings(CATALOGUE, "text\t\noverlay", 15).count, 3);
  // Whitespace-only carries no terms, so it filters nothing — the same answer the empty
  // query already gave, rather than the empty result the literal match produced.
  assert.equal(parseNodeMappings(CATALOGUE, "   ", 15).count, 4);
  assert.equal(parseNodeMappings(CATALOGUE, "", 15).count, 4);
});

test("#1088 the term matcher is a SUPERSET — no contiguous match is lost", () => {
  // The safety property, asserted rather than asserted-in-prose. Every haystack that
  // contained the query contiguously still contains each of its terms.
  const contiguous = ["impact", "impact pack", "overlay", "comfyui-textoverlay", "text-overlay", "advanced overlay"];
  for (const q of contiguous) {
    const hits = parseNodeMappings(CATALOGUE, q, 15).count;
    assert.ok(hits > 0, `"${q}" matched contiguously before and must still match`);
  }
});

test("#1088 catalogue_size is still reported alongside a multi-word miss", () => {
  // #808's discriminator must survive: a genuine no-match still has to be
  // distinguishable from an empty catalogue.
  const miss = parseNodeMappings(CATALOGUE, "definitely not here", 15);
  assert.equal(miss.count, 0);
  assert.equal(miss.catalogue_size, 4);
});

test("#1088 the installed-node fallback tokenises the same way", () => {
  // #426's /object_info search is the route taken when Manager is unreachable. It had the
  // identical contiguous match, so a multi-word query failed there too — and that is the
  // path with NO catalogue_size to hint that the search itself was the problem.
  const objectInfo = {
    SimpleTextOverlay: { display_name: "Simple Text Overlay", category: "image/text", description: "overlay text" },
    KSampler: { display_name: "KSampler", category: "sampling", description: "sample a latent" },
  };
  assert.equal(parseObjectInfoSearch(objectInfo, "simple overlay", 15).count, 1);
  assert.equal(parseObjectInfoSearch(objectInfo, "overlay text", 15).count, 1);
  assert.equal(parseObjectInfoSearch(objectInfo, "sample latent", 15).count, 1);
  // AND still discriminates on this route too.
  assert.equal(parseObjectInfoSearch(objectInfo, "overlay sampling", 15).count, 0);
});
