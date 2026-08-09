// panel#808 — an unreachable Manager catalogue renders as an empty node list, not as
// "could not reach it". Placeholder pinning the CURRENT conflation; the fix follows.
import test from "node:test";
import assert from "node:assert/strict";
import { parseNodeMappings } from "../../web/js/lib/manager-install.js";

test("#808 today: an EMPTY catalogue and a populated one that misses are indistinguishable", () => {
  const populated = { "https://github.com/a/b": [[], { title: "Impact Pack" }] };
  const empty = {};
  // Both collapse to the same "nothing here" answer, so a caller cannot tell whether
  // the query missed or the catalogue was never populated.
  assert.deepEqual(parseNodeMappings(empty, "seedvr2", 15), { count: 0, results: [] });
  assert.deepEqual(parseNodeMappings(populated, "seedvr2", 15), { count: 0, results: [] });
});
