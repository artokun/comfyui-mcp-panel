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

// --- queueFailureSignal: only explicit evidence counts ----------------------
test("queueFailureSignal fires only on explicit error/failed evidence", () => {
  assert.equal(queueFailureSignal({ error_count: 1 }), true);
  assert.equal(queueFailureSignal({ failed_count: 2 }), true);
  assert.equal(queueFailureSignal({ failed: ["x"] }), true);
  // A clean/absent status is NOT failure evidence (the #232 trap).
  assert.equal(queueFailureSignal({ is_processing: false, done_count: 1, total_count: 1 }), false);
  assert.equal(queueFailureSignal({ error_count: 0, failed: [] }), false);
  assert.equal(queueFailureSignal(null), false);
});

// --- classifyInstallOutcome: TRI-STATE, no false success / no false failure --
// The handler verifies buildInstallRequest's id (already the repo NAME for a git
// URL). Exercise the full outcome decision per dialect end-to-end.
for (const dialect of ["v2", "v2-batch", "legacy"]) {
  const targetOf = (args) => {
    const req = buildInstallRequest(dialect, args, "uid-1");
    return dialect === "v2" ? req.params.id : req.body.id;
  };

  test(`${dialect}: pack present ⇒ installed (registry)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      drained: true,
      listReadable: true,
      installed: { "rgthree-comfy": { ver: "1.0.0", cnr_id: "rgthree-comfy" } },
      status: { is_processing: false, done_count: 1, total_count: 1 },
    });
    assert.equal(o.state, "installed");
  });

  test(`${dialect}: pack present ⇒ installed (git URL, repo-name dir)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/rgthree/rgthree-comfy.git" }),
      dialect,
      drained: true,
      listReadable: true,
      installed: { "rgthree-comfy": { ver: "nightly", aux_id: "rgthree/rgthree-comfy" } },
      status: {},
    });
    assert.equal(o.state, "installed");
  });

  test(`${dialect}: drained + absent + explicit failure ⇒ failed (no false success)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      dialect,
      drained: true,
      listReadable: true,
      installed: {}, // nothing landed — exactly the #232 report
      status: { is_processing: false, error_count: 1 },
    });
    assert.equal(o.state, "failed");
    assert.match(o.message, /FAILED/);
  });

  test(`${dialect}: drained + absent + NO failure signal ⇒ unverified (no false failure)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      drained: true,
      listReadable: true,
      installed: { "some-other-pack": {} },
      status: { is_processing: false, done_count: 1, total_count: 1 },
    });
    assert.equal(o.state, "unverified");
    assert.notEqual(o.state, "failed");
  });

  test(`${dialect}: still processing at deadline ⇒ unverified, never failed (>120s install)`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/big/slow-pack.git" }),
      dialect,
      drained: false, // deadline hit while the clone was still running
      listReadable: true,
      installed: {},
      status: { is_processing: true },
    });
    assert.equal(o.state, "unverified");
    assert.match(o.message, /still in progress/);
  });

  test(`${dialect}: RENAMED install dir (bare module, ≠ repo name) ⇒ unverified, NOT hard-fail`, () => {
    // The #232 report: TenStrip/10S-Comfy-nodes installs into dir 10S_Nodes.
    // A bare module name with no cnr_id/aux_id can't positively match the repo
    // name — that is INCONCLUSIVE, never proof the genuine install failed.
    const o = classifyInstallOutcome({
      target: targetOf({ repository: "https://github.com/TenStrip/10S-Comfy-nodes.git" }),
      dialect,
      drained: true,
      listReadable: true,
      installed: { "10S_Nodes": { ver: "nightly" } }, // it DID land, under a renamed dir
      status: { is_processing: false, done_count: 1, total_count: 1 }, // no failure signal
    });
    assert.notEqual(o.state, "failed");
    assert.equal(o.state, "unverified");
  });

  test(`${dialect}: installed-list unreadable ⇒ unverified, never failed`, () => {
    const o = classifyInstallOutcome({
      target: targetOf({ id: "rgthree-comfy" }),
      dialect,
      drained: true,
      listReadable: false,
      installed: null,
      status: { error_count: 1 }, // even with a failure signal, unreadable list ⇒ inconclusive
    });
    assert.equal(o.state, "unverified");
  });
}
