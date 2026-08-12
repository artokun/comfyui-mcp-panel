import test from "node:test";
import assert from "node:assert/strict";

import { mergeProviderSnapshots } from "../../web/js/lib/provider-snapshot-merge.js";

// The reported shape: the orchestrator supplies the full set, then the ComfyUI host's
// shorter `_BACKEND_PORTS` response arrives and used to replace it wholesale.
const ORCHESTRATOR = [
  { backend: "claude", running: true, ready: true },
  { backend: "chatgpt", running: false, ready: true },
  { backend: "openrouter", running: false, ready: true },
  { backend: "lmstudio", running: false, ready: true },
  { backend: "llamacpp", running: false, ready: true },
  { backend: "custom", running: false, ready: true },
  { backend: "copilot", running: false, ready: true },
];
// The host knows nothing past openrouter.
const HOST = [
  { backend: "claude", running: false },
  { backend: "chatgpt", running: false },
  { backend: "openrouter", running: false },
];

const ids = (list) => list.map((b) => b.backend);

test("#1083: a host probe cannot delete providers from an authoritative snapshot", () => {
  const merged = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: HOST });
  assert.deepEqual(ids(merged), ids(ORCHESTRATOR), "all seven providers survive the host refresh");
  for (const id of ["lmstudio", "llamacpp", "custom", "copilot"]) {
    assert.ok(
      merged.some((b) => b.backend === id),
      `${id} is still selectable — without this there is no UI path back to a Custom endpoint`,
    );
  }
});

test("#1083: the probe cannot DOWNGRADE a provider the orchestrator reported", () => {
  // The same ruling applyReadiness already makes: the host cannot see the agent machine,
  // so its view of a provider it half-knows is not an improvement. `claude` is running per
  // the orchestrator and idle per the host; the orchestrator wins.
  const merged = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: HOST });
  const claude = merged.find((b) => b.backend === "claude");
  assert.equal(claude.running, true, "orchestrator liveness is not overwritten by the host");
  assert.equal(claude.ready, true, "orchestrator readiness is not overwritten by the host");
});

test("#1083: a provider only the HOST knows about is ADDED, never dropped", () => {
  // Additive is safe — it cannot make the list shorter, which is the whole invariant.
  const merged = mergeProviderSnapshots({
    authoritative: ORCHESTRATOR,
    probe: [...HOST, { backend: "brand-new", running: true }],
  });
  assert.deepEqual(ids(merged), [...ids(ORCHESTRATOR), "brand-new"]);
});

test("#1083: with NO authoritative snapshot the probe is used as-is (unchanged behaviour)", () => {
  // A panel that has not connected yet has only the host to go on. This is the path that
  // must not change, or a fresh panel would render nothing.
  assert.deepEqual(ids(mergeProviderSnapshots({ authoritative: null, probe: HOST })), ids(HOST));
  assert.deepEqual(ids(mergeProviderSnapshots({ authoritative: [], probe: HOST })), ids(HOST));
  assert.deepEqual(ids(mergeProviderSnapshots({ probe: HOST })), ids(HOST));
});

test("#1083: malformed input never throws and never invents a provider", () => {
  assert.deepEqual(mergeProviderSnapshots(), []);
  assert.deepEqual(mergeProviderSnapshots({ authoritative: "nope", probe: "nope" }), []);
  // Entries without a usable id are dropped rather than rendered as a nameless chip.
  assert.deepEqual(
    ids(mergeProviderSnapshots({ authoritative: null, probe: [null, {}, { backend: "" }, { backend: "ok" }] })),
    ["ok"],
  );
});

test("#1083: a duplicated id yields ONE chip, first writer wins", () => {
  const merged = mergeProviderSnapshots({
    authoritative: [
      { backend: "custom", running: true },
      { backend: "custom", running: false },
    ],
    probe: [{ backend: "custom", running: false }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].running, true);
});

test("#1083: merging is stable — repeated host refreshes converge, never grow or shrink", () => {
  // loadBackends runs on a timer, so the merge is applied to its own output repeatedly.
  let current = ORCHESTRATOR;
  for (let i = 0; i < 5; i++) {
    current = mergeProviderSnapshots({ authoritative: current, probe: HOST });
  }
  assert.deepEqual(ids(current), ids(ORCHESTRATOR), "no drift across repeated refreshes");
});
