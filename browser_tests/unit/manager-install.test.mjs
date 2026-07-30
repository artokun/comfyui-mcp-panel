// Unit tests for the per-dialect custom-node install routing
// (web/js/lib/manager-install.js). Regression coverage for issues #187/#182/#184
// and the codex round-2 finding: ssh:// and git:// URLs (via id OR repository)
// must resolve to the repo NAME and the correct per-dialect payload.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ManagerInstall from "../../web/js/lib/manager-install.js";
const {
  looksLikeGitUrl,
  gitRepoName,
  installGitUrl,
  buildInstallRequest,
  parseInstalled,
  nodeInstalledMatches,
  queueDrained,
  isReadableInstalledList,
  queueFailureSignal,
  classifyInstallOutcome,
  installedListRoute,
  isManagerUnreachable,
  isMethodNotAllowed,
  legacyUpdateBody,
  rebootCandidates,
  parseNodeMappings,
  managerUnavailableResult,
  searchNodesVia,
} = ManagerInstall;

test("looksLikeGitUrl recognizes every git protocol", () => {
  for (const u of [
    "https://github.com/foo/bar",
    "http://example.com/foo/bar.git",
    "ssh://git@github.com/foo/bar",
    "git://github.com/foo/bar",
    "git+https://github.com/foo/bar.git",
    "git@github.com:foo/bar.git",
    "git@github.com:foo/bar",
    "something.git",
  ]) {
    assert.equal(looksLikeGitUrl(u), true, `expected git URL: ${u}`);
  }
  for (const id of ["rgthree-comfy", "comfyui-manager", "author/pack", ""]) {
    assert.equal(looksLikeGitUrl(id), false, `expected registry id: ${id}`);
  }
  assert.equal(looksLikeGitUrl(undefined), false);
});

test("gitRepoName derives the repo name for every form", () => {
  assert.equal(gitRepoName("https://github.com/foo/bar"), "bar");
  assert.equal(gitRepoName("https://github.com/foo/bar.git"), "bar");
  assert.equal(gitRepoName("https://github.com/foo/bar/"), "bar");
  assert.equal(gitRepoName("https://github.com/foo/bar?x=1#frag"), "bar");
  assert.equal(gitRepoName("ssh://git@github.com/foo/bar"), "bar");
  assert.equal(gitRepoName("ssh://git@github.com/foo/bar.git"), "bar");
  assert.equal(gitRepoName("git://github.com/foo/bar.git"), "bar");
  assert.equal(gitRepoName("git+https://github.com/foo/bar.git"), "bar");
  assert.equal(gitRepoName("git@github.com:foo/bar.git"), "bar");
  assert.equal(gitRepoName("git@github.com:foo/bar"), "bar");
});

test("installGitUrl accepts a git URL via id OR repository, null for registry id", () => {
  assert.equal(installGitUrl({ id: "ssh://git@github.com/foo/bar" }), "ssh://git@github.com/foo/bar");
  assert.equal(installGitUrl({ repository: "git://github.com/foo/bar" }), "git://github.com/foo/bar");
  assert.equal(installGitUrl({ id: "rgthree-comfy" }), null);
  assert.equal(installGitUrl({}), null);
});

// --- v2 (Manager v4) ---------------------------------------------------------
test("v2 git URL → id is repo name, no files, channel dev (via id and via repository)", () => {
  for (const src of [
    { id: "ssh://git@github.com/foo/bar" },
    { repository: "ssh://git@github.com/foo/bar" },
    { id: "git://github.com/foo/bar.git" },
    { repository: "git://github.com/foo/bar.git" },
  ]) {
    const req = buildInstallRequest("v2", src, "uid-1");
    assert.equal(req.envelope, "task");
    assert.equal(req.params.id, "bar", `id should be repo name for ${JSON.stringify(src)}`);
    assert.equal(req.params.selected_version, "nightly");
    assert.equal(req.params.channel, "dev");
    assert.equal(req.params.mode, "cache");
    assert.ok(!("files" in req.params), "v4 must NOT send files");
    assert.ok(!looksLikeGitUrl(req.params.id), "id must not be a full URL");
  }
});

test("v2 registry id keeps the versioned body", () => {
  const req = buildInstallRequest("v2", { id: "rgthree-comfy" }, "uid-1");
  assert.equal(req.params.id, "rgthree-comfy");
  assert.equal(req.params.selected_version, "latest");
  assert.equal(req.params.mode, "remote");
  assert.equal(req.params.channel, "default");
});

// --- v2-batch + legacy (3.x semantics) --------------------------------------
for (const dialect of ["v2-batch", "legacy"]) {
  test(`${dialect} git URL → native files install, id is repo name (via id and repository)`, () => {
    for (const [src, url] of [
      [{ id: "ssh://git@github.com/foo/bar" }, "ssh://git@github.com/foo/bar"],
      [{ repository: "ssh://git@github.com/foo/bar" }, "ssh://git@github.com/foo/bar"],
      [{ id: "git://github.com/foo/bar.git" }, "git://github.com/foo/bar.git"],
      [{ repository: "git://github.com/foo/bar.git" }, "git://github.com/foo/bar.git"],
    ]) {
      const req = buildInstallRequest(dialect, src, "uid-1");
      assert.equal(req.envelope, dialect === "v2-batch" ? "batch" : "legacy");
      assert.equal(req.body.id, "bar");
      assert.equal(req.body.version, "unknown");
      assert.equal(req.body.selected_version, "unknown");
      assert.deepEqual(req.body.files, [url]);
      assert.equal(req.body.ui_id, "uid-1");
      assert.ok(!looksLikeGitUrl(req.body.id), "id must not be a full URL");
    }
  });

  test(`${dialect} registry id → versioned body, no files`, () => {
    const req = buildInstallRequest(dialect, { id: "rgthree-comfy" }, "uid-1");
    assert.equal(req.body.id, "rgthree-comfy");
    assert.equal(req.body.selected_version, "latest");
    assert.ok(!("files" in req.body), "registry install must NOT send files");
  });
}

// --- #232: verify the pack actually landed (no silent success) --------------
// parseInstalled tolerates the Manager's several installed-nodes shapes.
test("parseInstalled normalizes the v4 map shape", () => {
  const nodes = parseInstalled({
    "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy", aux_id: "rgthree/rgthree-comfy", enabled: true },
    "10S_Nodes": { ver: "nightly", aux_id: "TenStrip/10S-Comfy-nodes" },
  });
  assert.equal(nodes.length, 2);
  const rg = nodes.find((n) => n.module === "rgthree-comfy");
  assert.equal(rg.cnrId, "rgthree-comfy");
  assert.equal(rg.auxId, "rgthree/rgthree-comfy");
});

test("parseInstalled normalizes the legacy array shape (and bare strings)", () => {
  const nodes = parseInstalled([
    { title: "ComfyUI-Impact-Pack", cnr_id: "comfyui-impact-pack" },
    "rgthree-comfy",
  ]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].module, "ComfyUI-Impact-Pack");
  assert.equal(nodes[1].module, "rgthree-comfy");
});

test("nodeInstalledMatches accepts a full git URL directly and matches by repo name", () => {
  const installed = { "rgthree-comfy": { cnr_id: "rgthree-comfy" } };
  assert.equal(
    nodeInstalledMatches("https://github.com/rgthree/rgthree-comfy", installed),
    true,
  );
  assert.equal(nodeInstalledMatches(undefined, installed), false);
  assert.equal(nodeInstalledMatches("rgthree-comfy", {}), false);
});

// --- queueDrained: POSITIVE evidence only (codex round 2 #1) ----------------
test("queueDrained requires a well-formed stopped status with coherent counts", () => {
  assert.equal(queueDrained({ is_processing: false, done_count: 1, total_count: 1 }), true);
  assert.equal(queueDrained({ is_processing: false, done_count: 2, total_count: 1 }), true);
  // Absence / malformed / missing counts ⇒ NOT drained.
  assert.equal(queueDrained(null), false, "null is not drained");
  assert.equal(queueDrained({}), false, "empty object is not drained");
  assert.equal(queueDrained({ error_count: 1 }), false, "no is_processing/counts ⇒ not drained");
  assert.equal(queueDrained({ is_processing: false }), false, "no counts ⇒ not drained");
  assert.equal(queueDrained({ is_processing: false, done_count: 0 }), false, "missing total ⇒ not drained");
  assert.equal(queueDrained({ is_processing: true, done_count: 1, total_count: 1 }), false, "still processing");
  assert.equal(queueDrained({ is_processing: false, done_count: 0, total_count: 2 }), false, "done<total");
  assert.equal(queueDrained("done"), false, "primitive ⇒ not drained");
  assert.equal(queueDrained([]), false, "array ⇒ not drained");
});

// --- isReadableInstalledList: validate SHAPE, not just container (codex r4) --
test("isReadableInstalledList trusts only a well-formed installed list", () => {
  // Empty array/map ⇒ legitimately "nothing installed" ⇒ readable.
  assert.equal(isReadableInstalledList([]), true);
  assert.equal(isReadableInstalledList({}), true);
  // Real map of entry objects ⇒ readable.
  assert.equal(isReadableInstalledList({ "rgthree-comfy": { cnr_id: "rgthree-comfy" } }), true);
  assert.equal(isReadableInstalledList({ "10S_Nodes": { ver: "nightly" } }), true);
  // Real array of entry objects / legacy bare strings ⇒ readable.
  assert.equal(isReadableInstalledList([{ module: "x", cnr_id: "x" }]), true);
  assert.equal(isReadableInstalledList(["rgthree-comfy", "comfyui-manager"]), true);
  // Error envelope ⇒ NOT readable.
  assert.equal(isReadableInstalledList({ error: "unavailable" }), false);
  assert.equal(isReadableInstalledList({ detail: "nope" }), false);
  assert.equal(isReadableInstalledList({ message: "boom" }), false);
  // No-entry-shape object / junk arrays ⇒ NOT readable.
  assert.equal(isReadableInstalledList({ foo: "bar" }), false);
  assert.equal(isReadableInstalledList([null]), false);
  assert.equal(isReadableInstalledList([123]), false);
  assert.equal(isReadableInstalledList([{ module: "x" }, null]), false);
  // Container/primitive guards.
  assert.equal(isReadableInstalledList(null), false);
  assert.equal(isReadableInstalledList(undefined), false);
  assert.equal(isReadableInstalledList("ok"), false);
  assert.equal(isReadableInstalledList(42), false);
});

// --- queueFailureSignal: explicit evidence OR batch failed[] ----------------
test("queueFailureSignal fires only on explicit evidence (status or batch)", () => {
  assert.equal(queueFailureSignal({ error_count: 1 }), true);
  assert.equal(queueFailureSignal({ failed_count: 2 }), true);
  assert.equal(queueFailureSignal({ failed: ["x"] }), true);
  // batch failed[] naming the target is evidence.
  assert.equal(queueFailureSignal({}, ["bar"], "bar"), true);
  assert.equal(queueFailureSignal({}, ["other"], "bar"), false, "batch failed for a different id");
  assert.equal(queueFailureSignal({}, [], "bar"), false);
  // A clean/absent status is NOT failure evidence (the #232 trap).
  assert.equal(queueFailureSignal({ is_processing: false, done_count: 1, total_count: 1 }), false);
  assert.equal(queueFailureSignal({ error_count: 0, failed: [] }), false);
  assert.equal(queueFailureSignal(null), false);
});

// --- classifyInstallOutcome: TRI-STATE, no false success / no false failure --
// Exercises the EXACT status/list shapes codex named, per dialect. The handler
// verifies buildInstallRequest's id (already the repo NAME for a git URL) and
// computes renameProne the same way we mirror here.
const DRAINED = { is_processing: false, done_count: 1, total_count: 1 };
const FAIL_STATUS = { is_processing: false, done_count: 1, total_count: 1, error_count: 1 };
// Mirror the handler's renameProne derivation exactly.
const renameProneOf = (args) => !!installGitUrl(args) || String(args.id ?? "").includes("/");

for (const dialect of ["v2", "v2-batch", "legacy"]) {
  // Build the classifier input the handler would pass for these args.
  const inputFor = (args) => {
    const req = buildInstallRequest(dialect, args, "uid-1");
    return {
      target: dialect === "v2" ? req.params.id : req.body.id,
      dialect,
      renameProne: renameProneOf(args),
    };
  };

  test(`${dialect}: drained + pack present ⇒ installed (registry)`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "rgthree-comfy" }),
      status: DRAINED,
      installed: { "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy" } },
    });
    assert.equal(o.state, "installed");
  });

  test(`${dialect}: drained + pack present ⇒ installed (git URL, repo-name dir)`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ repository: "https://github.com/rgthree/rgthree-comfy.git" }),
      status: DRAINED,
      installed: { "rgthree-comfy": { ver: "nightly", aux_id: "rgthree/rgthree-comfy" } },
    });
    assert.equal(o.state, "installed");
  });

  // Identifiable (claimed registry id) + drained + definitively absent + failure
  // evidence ⇒ the ONE case that hard-fails.
  test(`${dialect}: identifiable id, drained + absent + explicit failure ⇒ failed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "no-such-registry-pack" }),
      status: FAIL_STATUS,
      installed: { "rgthree-comfy": { cnr_id: "rgthree-comfy" } }, // real list, our pack absent
    });
    assert.equal(o.state, "failed");
    assert.match(o.message, /FAILED/);
  });

  test(`${dialect}: drained + absent + NO failure signal ⇒ unverified`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "rgthree-comfy" }),
      status: DRAINED,
      installed: { "some-other-pack": { cnr_id: "some-other-pack" } },
    });
    assert.equal(o.state, "unverified");
  });

  // codex r3: a rename-prone (git URL) install that is absent-by-name is
  // INCONCLUSIVE even WITH a failure signal — never failed.
  test(`${dialect}: git URL, drained + absent-by-name + failure signal ⇒ unverified, NOT failed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      status: FAIL_STATUS,
      installed: {}, // can't rule out a renamed dir landing later/elsewhere
    });
    assert.notEqual(o.state, "failed");
    assert.equal(o.state, "unverified");
  });

  // codex r3 exact case: renamed-dir pack PRESENT-but-unmatched + error_count ⇒
  // NOT failed (a genuine install must never be reported failed).
  test(`${dialect}: git URL renamed-dir present-unmatched + error_count ⇒ NOT failed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      status: FAIL_STATUS,
      installed: { "10S_Nodes": { ver: "nightly" } }, // it DID install, renamed dir
    });
    assert.notEqual(o.state, "failed");
    assert.equal(o.state, "unverified");
  });

  // codex r3: owner/repo id is ALSO rename-prone (10S-Comfy-nodes → 10S_Nodes).
  test(`${dialect}: owner/repo id renamed-dir + error_count ⇒ NOT failed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "TenStrip/10S-Comfy-nodes" }),
      status: FAIL_STATUS,
      installed: { "10S_Nodes": { ver: "nightly" } },
    });
    assert.notEqual(o.state, "failed");
    assert.equal(o.state, "unverified");
  });

  // codex #1: {error_count:1} alone is NOT a drain → must NOT become failed.
  test(`${dialect}: {error_count:1} but NOT drained ⇒ unverified, never failed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "no-such-registry-pack" }),
      status: { error_count: 1 }, // no is_processing:false + counts ⇒ not a positive drain
      installed: {},
    });
    assert.equal(o.state, "unverified");
    assert.notEqual(o.state, "failed");
  });

  // codex #1: null / {} / primitive status ⇒ never drained ⇒ unverified.
  for (const [label, status] of [["null", null], ["empty {}", {}], ["primitive", "done"]]) {
    test(`${dialect}: ${label} status ⇒ unverified (no false drain)`, () => {
      const o = classifyInstallOutcome({
        ...inputFor({ id: "rgthree-comfy" }),
        status,
        installed: { "rgthree-comfy": { cnr_id: "rgthree-comfy" } }, // even if present!
      });
      assert.equal(o.state, "unverified");
      assert.notEqual(o.state, "installed");
    });
  }

  // codex #2: still-processing MUST NOT report installed even if the pack is
  // already present (could be a stale/partial dir).
  test(`${dialect}: still processing + pack present ⇒ unverified, NOT installed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "rgthree-comfy" }),
      status: { is_processing: true, done_count: 0, total_count: 1 },
      installed: { "rgthree-comfy": { cnr_id: "rgthree-comfy" } },
    });
    assert.equal(o.state, "unverified");
    assert.notEqual(o.state, "installed");
    assert.match(o.message, /still in progress/);
  });

  // codex #3: a null/primitive list (200 but malformed) with a failure status
  // must be unverified, not failed — even for an identifiable id.
  test(`${dialect}: drained + null list + failure status ⇒ unverified (malformed list)`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "no-such-registry-pack" }),
      status: FAIL_STATUS,
      installed: null, // 200 but empty body coerced to null
    });
    assert.equal(o.state, "unverified");
  });

  // codex r4: a "200 but malformed" body (error envelope / junk array/object)
  // is NOT a trustworthy installed list — must stay unverified even for an
  // IDENTIFIABLE id with a drained failure status (would otherwise false-fail).
  for (const [label, installed] of [
    ["error envelope {error}", { error: "unavailable" }],
    ["error envelope {detail}", { detail: "nope" }],
    ["[null]", [null]],
    ["[123]", [123]],
    ["no-entry-shape {foo:bar}", { foo: "bar" }],
  ]) {
    test(`${dialect}: identifiable id + drained failure + ${label} ⇒ unverified, NOT failed`, () => {
      const o = classifyInstallOutcome({
        ...inputFor({ id: "no-such-registry-pack" }),
        status: FAIL_STATUS,
        installed,
      });
      assert.notEqual(o.state, "failed");
      assert.equal(o.state, "unverified");
    });
  }

  test(`${dialect}: listError (fetch threw) ⇒ unverified, never failed`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ id: "no-such-registry-pack" }),
      status: FAIL_STATUS,
      installed: null,
      listError: true,
    });
    assert.equal(o.state, "unverified");
  });

  // #232 point 3: RENAMED install dir, no failure signal ⇒ unverified.
  test(`${dialect}: RENAMED install dir (10S-Comfy-nodes → 10S_Nodes), no failure ⇒ unverified`, () => {
    const o = classifyInstallOutcome({
      ...inputFor({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      status: DRAINED,
      installed: { "10S_Nodes": { ver: "nightly" } },
    });
    assert.notEqual(o.state, "failed");
    assert.equal(o.state, "unverified");
  });
}

// --- codex #4: the v2-batch synchronous failed[] FEEDS the gate as evidence,
// never an early throw; the tri-state (incl. identifiability) still applies. --
const batchTarget = buildInstallRequest("v2-batch", { id: "rgthree-comfy" }, "u").body.id;

test("v2-batch: identifiable id + batch failed[] + drained + absent ⇒ failed (through the gate)", () => {
  const o = classifyInstallOutcome({
    target: batchTarget,
    dialect: "v2-batch",
    renameProne: false, // claimed registry id ⇒ identifiable
    status: DRAINED, // no error_count on status — the ONLY evidence is batchFailed
    installed: { "other-pack": { cnr_id: "other-pack" } },
    batchFailed: [batchTarget],
  });
  assert.equal(o.state, "failed");
});

test("v2-batch: batch failed[] but NOT drained ⇒ unverified (evidence still gated)", () => {
  const o = classifyInstallOutcome({
    target: batchTarget,
    dialect: "v2-batch",
    renameProne: false,
    status: { is_processing: true }, // not drained
    installed: {},
    batchFailed: [batchTarget],
  });
  assert.equal(o.state, "unverified");
});

test("v2-batch: batch failed[] but the pack IS present ⇒ installed (evidence ≠ absence)", () => {
  const o = classifyInstallOutcome({
    target: batchTarget,
    dialect: "v2-batch",
    renameProne: false,
    status: DRAINED,
    installed: { "rgthree-comfy": { cnr_id: "rgthree-comfy" } },
    batchFailed: [batchTarget], // stale/ignored — presence wins
  });
  assert.equal(o.state, "installed");
});

// codex r3: stale batchFailed[target] with a RENAMED pack present ⇒ NOT failed.
test("v2-batch: git URL, stale batch failed[] + renamed-dir present ⇒ NOT failed", () => {
  const gitTarget = buildInstallRequest(
    "v2-batch",
    { repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" },
    "u",
  ).body.id;
  const o = classifyInstallOutcome({
    target: gitTarget,
    dialect: "v2-batch",
    renameProne: true, // git install ⇒ rename-prone
    status: DRAINED,
    installed: { "10S_Nodes": { ver: "nightly" } }, // it DID install
    batchFailed: [gitTarget], // stale evidence — must NOT hard-fail a genuine install
  });
  assert.notEqual(o.state, "failed");
  assert.equal(o.state, "unverified");
});

// --- codex round 5: handler WIRING guard ------------------------------------
// The install runtime lives in comfyui-mcp-panel.js (waitForQueueDrain,
// verifyInstalled, nodes_install) and calls manager-install.js exports at MODULE
// scope. That file can't load under `node` (Comfy frontend globals), and the
// direct-import unit tests above can't see its import statement — so a missing
// import (e.g. queueDrained omitted → ReferenceError on the first status poll,
// failing EVERY install) slipped past. This guard reads the panel SOURCE and
// asserts every manager-install export it CALLS is actually imported.
test("comfyui-mcp-panel imports every manager-install export it calls (no ReferenceError)", () => {
  const panelPath = fileURLToPath(
    new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  );
  const src = readFileSync(panelPath, "utf8");

  const importMatch = src.match(
    /import\s*\{([^}]*)\}\s*from\s*["']\.\/lib\/manager-install\.js["']/,
  );
  assert.ok(importMatch, "panel must import from ./lib/manager-install.js");
  const imported = new Set(
    importMatch[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean),
  );

  // Source with the import statement removed, so an imported name isn't counted
  // as its own "call site".
  const body = src.replace(importMatch[0], "");
  const exports = Object.keys(ManagerInstall).filter(
    (k) => typeof ManagerInstall[k] === "function",
  );

  const usedButNotImported = exports.filter(
    (name) => new RegExp(`\\b${name}\\s*\\(`).test(body) && !imported.has(name),
  );
  assert.deepEqual(
    usedButNotImported,
    [],
    `panel calls these manager-install exports without importing them: ${usedButNotImported.join(", ")}`,
  );

  // Sanity: the four we know the handler uses must be present (guards against
  // the regex silently matching nothing if the import shape changes).
  for (const name of ["buildInstallRequest", "classifyInstallOutcome", "installGitUrl", "queueDrained"]) {
    assert.ok(imported.has(name), `expected panel to import ${name}`);
  }
});

// Also drive the REAL waitForQueueDrain source against a mock managerGet, so the
// drain loop's use of queueDrained is exercised end-to-end (a missing binding
// would throw here too). We extract the function text from the panel source and
// evaluate it with queueDrained + a stubbed managerGet in scope — mirroring the
// module's own dependency wiring.
test("waitForQueueDrain (real panel source) returns a drained status without ReferenceError", async () => {
  const panelPath = fileURLToPath(
    new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  );
  const src = readFileSync(panelPath, "utf8");

  const fnMatch = src.match(
    /async function waitForQueueDrain\([\s\S]*?\n\}/,
  );
  assert.ok(fnMatch, "could not locate waitForQueueDrain in panel source");

  // Provide the exact free identifiers the function closes over at module scope.
  const MANAGER_FETCH_TIMEOUT_MS = 15000;
  const boundedDelay = (ms, deadline) =>
    new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now()))));
  let polls = 0;
  const managerGet = async () => {
    // First poll: still processing; second: positively drained.
    polls += 1;
    return polls < 2
      ? { is_processing: true, done_count: 0, total_count: 1 }
      : { is_processing: false, done_count: 1, total_count: 1 };
  };
  const factory = new Function(
    "queueDrained",
    "managerGet",
    "MANAGER_FETCH_TIMEOUT_MS",
    "boundedDelay",
    "AbortSignal",
    `${fnMatch[0]}\nreturn waitForQueueDrain;`,
  );
  const realWait = factory(queueDrained, managerGet, MANAGER_FETCH_TIMEOUT_MS, boundedDelay, AbortSignal);

  const status = await realWait({ timeoutMs: 5000, intervalMs: 10 });
  assert.equal(queueDrained(status), true, "should return a positively-drained status");
  assert.ok(polls >= 2, "should have polled until drained");
});

// ---------------------------------------------------------------------------
// 3.x-LEGACY dialect completeness (#423 list / #424 update-self / #425 restart)
// ---------------------------------------------------------------------------

test("#423 installedListRoute passes ?mode=default and no /v2 prefix (managerGet/Call add it)", () => {
  const route = installedListRoute();
  assert.equal(route, "customnode/installed?mode=default");
  assert.ok(!route.startsWith("/v2"), "route must not carry a /v2 prefix");
  assert.ok(!route.startsWith("/"), "route is a tail managerGet/managerCall prefix");
});

test("#423 isManagerUnreachable flags 404 / not-reachable → triggers the absolute legacy list fallback", () => {
  assert.equal(isManagerUnreachable(new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)")), true);
  assert.equal(isManagerUnreachable(new Error("Manager customnode/installed: HTTP 404")), true);
  // A genuine server error must NOT be swallowed by the fallback.
  assert.equal(isManagerUnreachable(new Error("Manager customnode/installed: HTTP 500")), false);
  assert.equal(isManagerUnreachable(new Error("Manager manager/queue/update: HTTP 405")), false);
});

test("#423 legacy list payload parses via parseInstalled (map + array shapes)", () => {
  // released 3.x /customnode/installed returns the get_installed_node_packs MAP.
  const legacyMap = {
    "ComfyUI-Manager": { ver: "3.10", cnr_id: "comfyui-manager", enabled: true },
    "rgthree-comfy": { ver: "1.0", cnr_id: "rgthree-comfy", enabled: true },
  };
  const parsed = parseInstalled(legacyMap);
  assert.equal(parsed.length, 2);
  assert.ok(nodeInstalledMatches("comfyui-manager", parsed), "Manager itself resolves from the legacy map");
});

test("#424 isMethodNotAllowed detects the /v2 envelope 405 that legacy self-update must dodge", () => {
  assert.equal(isMethodNotAllowed(new Error("Manager manager/queue/task: HTTP 405")), true);
  assert.equal(isMethodNotAllowed(new Error("405 Method Not Allowed")), true);
  assert.equal(isMethodNotAllowed(new Error("Manager manager/queue/task: HTTP 403")), false);
  assert.equal(isMethodNotAllowed(new Error("boom")), false);
});

test("#424 legacyUpdateBody targets the Manager self-update by id (unified_update keys off id)", () => {
  // released-3.x update route: version !== 'unknown' ⇒ node_name = id.
  assert.deepEqual(legacyUpdateBody({ ui_id: "u1", id: "comfyui-manager", version: "latest" }), {
    ui_id: "u1",
    id: "comfyui-manager",
    version: "latest",
  });
  // nightly is preserved; anything else normalizes to latest.
  assert.equal(legacyUpdateBody({ id: "x", version: "nightly" }).version, "nightly");
  assert.equal(legacyUpdateBody({ id: "x", version: undefined }).version, "latest");
  assert.equal(legacyUpdateBody({ id: "x", version: "1.2.3" }).version, "latest");
});

test("#425 rebootCandidates puts POST /manager/reboot first for legacy (never GET-only)", () => {
  const legacy = rebootCandidates("legacy");
  assert.deepEqual(legacy[0], { route: "/manager/reboot", method: "POST" });
  // The released 3.x Manager has NO GET /manager/reboot — a POST route must be
  // tried before the very-old GET fallback.
  const idxPost = legacy.findIndex((c) => c.route === "/manager/reboot" && c.method === "POST");
  const idxGet = legacy.findIndex((c) => c.route === "/manager/reboot" && c.method === "GET");
  assert.ok(idxPost >= 0 && idxPost < idxGet, "legacy POST reboot precedes the GET fallback");
});

test("#425 rebootCandidates keeps POST /v2/manager/reboot first for pip dialects", () => {
  for (const dialect of ["v2", "v2-batch", null, undefined]) {
    const cands = rebootCandidates(dialect);
    assert.deepEqual(cands[0], { route: "/v2/manager/reboot", method: "POST" });
    // POST /manager/reboot is still present as a fallback for a legacy-UI build.
    assert.ok(
      cands.some((c) => c.route === "/manager/reboot" && c.method === "POST"),
      `dialect ${dialect} must still offer POST /manager/reboot`,
    );
  }
});

// ---------------------------------------------------------------------------
// #251/#255 — panel_search_nodes degrades gracefully against an unreachable /
// legacy ComfyUI-Manager instead of surfacing a raw throw that blocks the whole
// install-discovery flow. searchNodesVia is dependency-injected with the panel's
// managerGet (dialect-routed) + managerCall (absolute) so the REAL decision path
// is exercised here.
// ---------------------------------------------------------------------------

const GETMAPPINGS_MAP = {
  "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation": [
    ["RIFE VFI"],
    { title: "ComfyUI Frame Interpolation", description: "RIFE frame interpolation and more" },
  ],
  "https://github.com/1038lab/ComfyUI-RMBG": [
    ["RMBG", "BiRefNet"],
    { title: "ComfyUI-RMBG", description: "Background removal with BiRefNet / RMBG" },
  ],
};
const UNREACHABLE = new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)");

test("#251 nodes_search returns results when the dialect-routed GET works", async () => {
  const managerGet = async () => GETMAPPINGS_MAP;
  const managerCall = async () => {
    throw new Error("absolute route should not be reached");
  };
  const res = await searchNodesVia(managerGet, managerCall, { query: "RIFE" });
  assert.equal(res.count, 1);
  assert.equal(res.results[0].title, "ComfyUI Frame Interpolation");
});

test("#255 nodes_search falls back to the ABSOLUTE legacy route when /v2 is unreachable", async () => {
  // Legacy-UI pip build (or real 3.x Manager): dialect-routed /v2 GET 404s /
  // throws "not reachable" while the absolute /customnode/getmappings serves.
  const managerGet = async () => {
    throw UNREACHABLE;
  };
  const managerCall = async () => GETMAPPINGS_MAP;
  const res = await searchNodesVia(managerGet, managerCall, { query: "BiRefNet" });
  assert.equal(res.count, 1);
  assert.equal(res.results[0].id.includes("RMBG"), true);
});

test("#251/#255 nodes_search returns a structured {supported:false} result when BOTH routes are unreachable — never throws", async () => {
  const throwUnreachable = async () => {
    throw UNREACHABLE;
  };
  const res = await searchNodesVia(throwUnreachable, throwUnreachable, {
    query: "RIFE frame interpolation",
  });
  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
  assert.equal(res.count, 0);
  assert.deepEqual(res.results, []);
  assert.equal(res.query, "RIFE frame interpolation");
  assert.match(res.message, /Manager/i);
  assert.match(res.message, /panel_list_nodes/);
});

test("#251/#255 nodes_search does NOT swallow a genuine server error (HTTP 500 propagates)", async () => {
  const boom = async () => {
    throw new Error("Manager customnode/getmappings: HTTP 500");
  };
  await assert.rejects(
    () => searchNodesVia(boom, boom, { query: "x" }),
    /HTTP 500/,
    "a real server error must propagate, not degrade to supported:false",
  );
});

test("#251/#255 a non-unreachable error from the absolute fallback also propagates", async () => {
  const managerGet = async () => {
    throw UNREACHABLE;
  };
  const managerCall = async () => {
    throw new Error("Manager customnode/getmappings: HTTP 403");
  };
  await assert.rejects(
    () => searchNodesVia(managerGet, managerCall, { query: "x" }),
    /HTTP 403/,
  );
});

test("parseNodeMappings handles array + map shapes and caps the limit", () => {
  const arr = [
    { id: "a/one", title: "One", description: "first" },
    { id: "b/two", title: "Two", description: "second" },
  ];
  assert.equal(parseNodeMappings(arr, "", 15).count, 2);
  assert.equal(parseNodeMappings(GETMAPPINGS_MAP, "", 15).count, 2);
  // Filter is case-insensitive across id/title/description.
  assert.equal(parseNodeMappings(GETMAPPINGS_MAP, "background", 15).count, 1);
  // limit capped at 40; default 15.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `p/${i}`, title: `t${i}` }));
  assert.equal(parseNodeMappings(many, "", 999).results.length, 40);
  assert.equal(parseNodeMappings(many, "").results.length, 15);
});

test("managerUnavailableResult is a safe, actionable structured payload", () => {
  const r = managerUnavailableResult(undefined, UNREACHABLE);
  assert.equal(r.supported, false);
  assert.equal(r.query, "");
  assert.equal(r.reason, UNREACHABLE.message);
});
