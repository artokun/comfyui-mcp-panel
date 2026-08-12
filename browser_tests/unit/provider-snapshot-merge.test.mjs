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

test("#1083: the probe cannot downgrade a provider's READINESS", () => {
  // The same ruling applyReadiness already makes: the host cannot see the agent machine, so
  // its readiness for a provider it half-knows would false-flag a connected provider as
  // "CLI not installed".
  const merged = mergeProviderSnapshots({
    authoritative: ORCHESTRATOR,
    probe: [{ backend: "claude", running: false, ready: false, cli: false }],
  });
  const claude = merged.find((b) => b.backend === "claude");
  assert.equal(claude.ready, true, "orchestrator readiness survives");
  assert.equal(claude.cli, undefined, "and a host-invented cli flag is not adopted");
});

test("#1083 (codex): a SHARED provider's running state still follows the probe", () => {
  // The second freeze codex found, one id-set over from the first. Refusing the probe's
  // fields wholesale meant `claude` — present in BOTH snapshots — kept whatever liveness it
  // had when the orchestrator frame landed, permanently. The chip and the model popup both
  // read `b.running`, and the host probe is what re-reads it on a timer.
  const idle = mergeProviderSnapshots({
    authoritative: ORCHESTRATOR, // claude: running true
    probe: [{ backend: "claude", running: false }],
  });
  assert.equal(idle.find((b) => b.backend === "claude").running, false, "stop is seen");

  const busy = mergeProviderSnapshots({
    authoritative: ORCHESTRATOR.map((b) => (b.backend === "claude" ? { ...b, running: false } : b)),
    probe: [{ backend: "claude", running: true }],
  });
  assert.equal(busy.find((b) => b.backend === "claude").running, true, "start is seen too");

  // Membership and position are still the authoritative snapshot's.
  assert.deepEqual(ids(idle), ids(ORCHESTRATOR));
});

test("#1083 (codex): an explicitly EMPTY authoritative snapshot is honoured", () => {
  // `backends: []` is a provider report whose content is "none", not a frame that said
  // nothing. Requiring non-empty left a dropped-to-zero orchestrator with its old list
  // authoritative forever, so host probes kept re-asserting providers that no longer exist.
  assert.deepEqual(ids(mergeProviderSnapshots({ authoritative: [], probe: HOST })), ids(HOST));
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

test("#1083: a duplicated id yields ONE chip", () => {
  // A malformed authoritative snapshot must not paint the same provider twice; within it,
  // the first entry wins. The probe then refreshes that single entry's live fields as it
  // does for any shared id, so `running` follows the probe — see the shared-liveness test.
  const merged = mergeProviderSnapshots({
    authoritative: [
      { backend: "custom", running: true, ready: true },
      { backend: "custom", running: false, ready: false },
    ],
    probe: [{ backend: "custom", running: false }],
  });
  assert.equal(merged.length, 1, "one chip, not two");
  assert.equal(merged[0].ready, true, "the FIRST authoritative entry won, not the second");
  assert.equal(merged[0].running, false, "and the probe still refreshed its liveness");
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
