// Unit tests for the per-dialect custom-node install routing
// (web/js/lib/manager-install.js). Regression coverage for issues #187/#182/#184
// and the codex round-2 finding: ssh:// and git:// URLs (via id OR repository)
// must resolve to the repo NAME and the correct per-dialect payload.
import test from "node:test";
import assert from "node:assert/strict";

import {
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
} from "../../web/js/lib/manager-install.js";

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

// --- isReadableInstalledList: only a real array/map (codex round 2 #3) ------
test("isReadableInstalledList trusts only a well-formed array or map", () => {
  assert.equal(isReadableInstalledList([]), true);
  assert.equal(isReadableInstalledList({}), true);
  assert.equal(isReadableInstalledList({ "rgthree-comfy": {} }), true);
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
// Exercises the EXACT status/list shapes codex round 2 named, per dialect. The
// handler verifies buildInstallRequest's id (already the repo NAME for a git URL).
const DRAINED = { is_processing: false, done_count: 1, total_count: 1 };
for (const dialect of ["v2", "v2-batch", "legacy"]) {
  const targetOf = (args) => {
    const req = buildInstallRequest(dialect, args, "uid-1");
    return dialect === "v2" ? req.params.id : req.body.id;
  };

  test(`${dialect}: drained + pack present ⇒ installed (registry)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      status: DRAINED,
      installed: { "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy" } },
    });
    assert.equal(o.state, "installed");
  });

  test(`${dialect}: drained + pack present ⇒ installed (git URL, repo-name dir)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/rgthree/rgthree-comfy.git" }),
      dialect,
      status: DRAINED,
      installed: { "rgthree-comfy": { ver: "nightly", aux_id: "rgthree/rgthree-comfy" } },
    });
    assert.equal(o.state, "installed");
  });

  test(`${dialect}: drained + absent + explicit failure ⇒ failed`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      dialect,
      status: { is_processing: false, done_count: 1, total_count: 1, error_count: 1 },
      installed: {}, // nothing landed — exactly the #232 report
    });
    assert.equal(o.state, "failed");
    assert.match(o.message, /FAILED/);
  });

  test(`${dialect}: drained + absent + NO failure signal ⇒ unverified`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      status: DRAINED,
      installed: { "some-other-pack": {} },
    });
    assert.equal(o.state, "unverified");
  });

  // codex #1: {error_count:1} alone is NOT a drain → must NOT become failed.
  test(`${dialect}: {error_count:1} but NOT drained ⇒ unverified, never failed`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      status: { error_count: 1 }, // no is_processing:false + counts ⇒ not a positive drain
      installed: {},
    });
    assert.equal(o.state, "unverified");
    assert.notEqual(o.state, "failed");
  });

  // codex #1: null / {} status ⇒ never drained ⇒ unverified.
  for (const [label, status] of [["null", null], ["empty {}", {}], ["primitive", "done"]]) {
    test(`${dialect}: ${label} status ⇒ unverified (no false drain)`, () => {
      const o = classifyInstallOutcome({
        target: targetOf({ id: "rgthree-comfy" }),
        dialect,
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
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      status: { is_processing: true, done_count: 0, total_count: 1 },
      installed: { "rgthree-comfy": { cnr_id: "rgthree-comfy" } },
    });
    assert.equal(o.state, "unverified");
    assert.notEqual(o.state, "installed");
    assert.match(o.message, /still in progress/);
  });

  // codex #3: a null/primitive list (200 but malformed) with a failure status
  // must be unverified, not failed.
  test(`${dialect}: drained + null list + failure status ⇒ unverified (malformed list)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      status: { is_processing: false, done_count: 1, total_count: 1, error_count: 1 },
      installed: null, // 200 but empty body coerced to null
    });
    assert.equal(o.state, "unverified");
  });

  test(`${dialect}: listError (fetch threw) ⇒ unverified, never failed`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      status: { is_processing: false, done_count: 1, total_count: 1, error_count: 1 },
      installed: null,
      listError: true,
    });
    assert.equal(o.state, "unverified");
  });

  // codex #3 / #232 point 3: RENAMED install dir — genuine install, bare module
  // name ≠ repo name ⇒ unverified, NEVER a hard fail.
  test(`${dialect}: RENAMED install dir (10S-Comfy-nodes → 10S_Nodes) ⇒ unverified, NOT failed`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      dialect,
      status: DRAINED, // drained, no failure signal
      installed: { "10S_Nodes": { ver: "nightly" } }, // it DID land, under a renamed dir
    });
    assert.notEqual(o.state, "failed");
    assert.equal(o.state, "unverified");
  });
}

// --- codex #4: the v2-batch synchronous failed[] FEEDS the gate as evidence,
// never an early throw; the tri-state still applies. ------------------------
test("v2-batch: batch failed[] + drained + absent ⇒ failed (through the gate)", () => {
  const target = buildInstallRequest("v2-batch", { id: "rgthree-comfy" }, "u").body.id;
  const o = classifyInstallOutcome({
    target,
    dialect: "v2-batch",
    status: DRAINED, // no error_count on status — the ONLY evidence is batchFailed
    installed: {},
    batchFailed: [target],
  });
  assert.equal(o.state, "failed");
});

test("v2-batch: batch failed[] but NOT drained ⇒ unverified (evidence still gated)", () => {
  const target = buildInstallRequest("v2-batch", { id: "rgthree-comfy" }, "u").body.id;
  const o = classifyInstallOutcome({
    target,
    dialect: "v2-batch",
    status: { is_processing: true }, // not drained
    installed: {},
    batchFailed: [target],
  });
  assert.equal(o.state, "unverified");
});

test("v2-batch: batch failed[] but the pack IS present ⇒ installed (evidence ≠ absence)", () => {
  const target = buildInstallRequest("v2-batch", { id: "rgthree-comfy" }, "u").body.id;
  const o = classifyInstallOutcome({
    target,
    dialect: "v2-batch",
    status: DRAINED,
    installed: { "rgthree-comfy": { cnr_id: "rgthree-comfy" } },
    batchFailed: [target], // stale/ignored — presence wins
  });
  assert.equal(o.state, "installed");
});
