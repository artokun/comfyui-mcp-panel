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
