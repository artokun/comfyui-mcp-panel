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
  // loadBackends runs on a timer, so the merge is applied repeatedly against the SAME
  // fixed orchestrator baseline. Feeding the merge's own OUTPUT back in as the baseline is
  // the mistake the caller must not make — see the host-only liveness test below.
  let current = null;
  for (let i = 0; i < 5; i++) {
    current = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: HOST });
  }
  assert.deepEqual(ids(current), ids(ORCHESTRATOR), "no drift across repeated refreshes");
});

test("#1083 (codex): a HOST-ONLY provider keeps refreshing its running state", () => {
  // The regression the first draft introduced. A host-only entry is appended to the merged
  // list; if that merged list is then reused as the next baseline, the entry is suddenly
  // "authoritative" and the merge refuses to overwrite it — so a provider that later starts
  // or stops shows stale liveness forever. `backendReady` cannot repair it: that map holds
  // only cli/auth/ready, while the chip and the picker both read `b.running`.
  //
  // Keeping the baseline pinned to the ORCHESTRATOR snapshot is what fixes it — a host-only
  // provider is never in that baseline, so it is re-read from every probe.
  const idle = [...HOST, { backend: "host-only", running: false }];
  const busy = [...HOST, { backend: "host-only", running: true }];

  const first = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: idle });
  assert.equal(first.find((b) => b.backend === "host-only").running, false);

  const second = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: busy });
  assert.equal(
    second.find((b) => b.backend === "host-only").running,
    true,
    "host-only liveness follows the probe instead of freezing at first sight",
  );

  // And the reverse, so this is not passing on a one-way latch.
  const third = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: idle });
  assert.equal(third.find((b) => b.backend === "host-only").running, false);
});

test("#1083 (codex): a ready ack alone is not an authoritative provider list", () => {
  // `readinessFromOrchestrator` is set by a bare `ready` ack that carries NO providers, and
  // the surrounding code documents that such an ack can arrive BEFORE the backends frame.
  // If list authority were inferred from it, a host probe landing in that window would be
  // merged against the claude-only default and treated as authoritative — stranding the
  // picker without the configured providers. Modelled here as the baseline still being null
  // at that moment, which is what the caller now passes.
  const DEFAULT_ONLY = [{ backend: "claude", running: false }];
  const duringWindow = mergeProviderSnapshots({ authoritative: null, probe: HOST });
  assert.deepEqual(ids(duringWindow), ids(HOST), "the probe is used as-is, nothing is invented");
  assert.ok(
    !ids(duringWindow).includes("custom") && ids(DEFAULT_ONLY).length === 1,
    "and no authoritative claim is manufactured from the default list",
  );
  // Once the real frame lands, the full set is protected from the very next probe.
  const afterFrame = mergeProviderSnapshots({ authoritative: ORCHESTRATOR, probe: HOST });
  assert.deepEqual(ids(afterFrame), ids(ORCHESTRATOR));
});
