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
  looksLikeOwnerRepoShorthand,
  gitRepoName,
  installGitUrl,
  buildInstallRequest,
  parseInstalled,
  nodeInstalledMatches,
  resolveInstalledUpdateId,
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
  parseObjectInfoSearch,
  objectInfoSearchFallback,
  SEARCH_LIMIT_CAP,
} = ManagerInstall;

test("looksLikeGitUrl recognizes every git protocol, plus author/repo shorthand (#301)", () => {
  for (const u of [
    "https://github.com/foo/bar",
    "http://example.com/foo/bar.git",
    "ssh://git@github.com/foo/bar",
    "git://github.com/foo/bar",
    "git+https://github.com/foo/bar.git",
    "git@github.com:foo/bar.git",
    "git@github.com:foo/bar",
    "something.git",
    "kijai/ComfyUI-Hunyuan3DWrapper", // #301 — bare author/repo shorthand
    "ltdrdata/ComfyUI-Manager",
  ]) {
    assert.equal(looksLikeGitUrl(u), true, `expected git URL: ${u}`);
  }
  for (const id of ["rgthree-comfy", "comfyui-manager", ""]) {
    assert.equal(looksLikeGitUrl(id), false, `expected registry id: ${id}`);
  }
  assert.equal(looksLikeGitUrl(undefined), false);
});

test("looksLikeOwnerRepoShorthand matches only a bare, single-slash owner/repo (#301)", () => {
  for (const s of ["kijai/ComfyUI-Hunyuan3DWrapper", "a/b", "foo-bar/baz_qux.thing"]) {
    assert.equal(looksLikeOwnerRepoShorthand(s), true, `expected shorthand: ${s}`);
  }
  for (const s of [
    "rgthree-comfy", // no slash — plain registry id
    "https://github.com/foo/bar", // already a full URL
    "git@github.com:foo/bar", // scp-form, has a colon
    "foo/bar/baz", // more than one slash
    "", undefined, null,
  ]) {
    assert.equal(looksLikeOwnerRepoShorthand(s), false, `expected non-shorthand: ${s}`);
  }
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

// #301 — regression: panel_install_node({id:"author/repo"}) used to fall through
// to the plain registry-id branch (sent verbatim to Manager → 502 on v4, silent
// failure on 3.x) because looksLikeGitUrl didn't recognize the shorthand. It must
// now be expanded to a real, clonable GitHub URL via id OR repository.
test("installGitUrl expands a bare author/repo shorthand to a clonable GitHub URL (#301)", () => {
  assert.equal(
    installGitUrl({ id: "kijai/ComfyUI-Hunyuan3DWrapper" }),
    "https://github.com/kijai/ComfyUI-Hunyuan3DWrapper",
  );
  assert.equal(
    installGitUrl({ repository: "ltdrdata/ComfyUI-Manager" }),
    "https://github.com/ltdrdata/ComfyUI-Manager",
  );
  // A real registry id (no slash) must NOT be reinterpreted as a shorthand.
  assert.equal(installGitUrl({ id: "rgthree-comfy" }), null);
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

// #301 — author/repo shorthand must route exactly like an equivalent full git
// URL would: v4 by repo name only (no files), v2-batch/legacy via a real
// clonable files[] URL derived from the shorthand.
test("v2 author/repo shorthand → id is repo name, no files, channel dev (#301)", () => {
  const req = buildInstallRequest("v2", { id: "kijai/ComfyUI-Hunyuan3DWrapper" }, "uid-1");
  assert.equal(req.envelope, "task");
  assert.equal(req.params.id, "ComfyUI-Hunyuan3DWrapper");
  assert.equal(req.params.selected_version, "nightly");
  assert.equal(req.params.channel, "dev");
  assert.ok(!("files" in req.params), "v4 must NOT send files");
  assert.ok(!looksLikeGitUrl(req.params.id), "id must not be a full URL or shorthand");
});

for (const dialect of ["v2-batch", "legacy"]) {
  test(`${dialect} author/repo shorthand → native files install with a real clonable URL (#301)`, () => {
    const req = buildInstallRequest(dialect, { id: "kijai/ComfyUI-Hunyuan3DWrapper" }, "uid-1");
    assert.equal(req.body.id, "ComfyUI-Hunyuan3DWrapper");
    assert.deepEqual(req.body.files, ["https://github.com/kijai/ComfyUI-Hunyuan3DWrapper"]);
    assert.equal(req.body.version, "unknown");
    assert.equal(req.body.ui_id, "uid-1");
  });
}

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

test("#1600 resolves an installed directory to Manager's active_nodes identity", () => {
  const installed = {
    "comfyui-minimax-h3-prompt-enhancer-T8": {
      ver: "nightly",
      cnr_id: "comfyui-minimax-h3-prompt-enhancer",
      aux_id: "example/comfyui-minimax-h3-prompt-enhancer",
      enabled: true,
    },
  };
  assert.equal(
    resolveInstalledUpdateId("comfyui-minimax-h3-prompt-enhancer-T8", installed),
    "comfyui-minimax-h3-prompt-enhancer",
  );
  assert.equal(
    resolveInstalledUpdateId("comfyui-minimax-h3-prompt-enhancer", installed),
    "comfyui-minimax-h3-prompt-enhancer",
  );
  assert.equal(resolveInstalledUpdateId("not-installed", installed), null);
});

test("#1600 uses the aux repository basename for an installed unknown git pack", () => {
  const installed = {
    "local-renamed-folder": {
      ver: "unknown",
      aux_id: "owner/original-repo",
      enabled: true,
    },
  };
  assert.equal(resolveInstalledUpdateId("local-renamed-folder", installed), "original-repo");
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
  // The injected delay resolves IMMEDIATELY, and that is the point of injecting it.
  // What this test pins is the drain loop's identifier bindings and its use of
  // queueDrained — a missing binding throws a ReferenceError right here. It is not
  // a timing test, so it must not depend on a real timer winning a race.
  //
  // A sleeping stub made it FLAKY: waitForQueueDrain opens with a fixed
  // boundedDelay(1000, deadline) warm-up, and under load (a loaded machine, the
  // suite's own parallelism) that timer plus scheduling can consume the whole
  // 5000ms budget before two polls complete. The loop then exits on its deadline
  // with status still null, queueDrained(null) is false, and the assertion fails
  // for a reason that has nothing to do with the code under test. Observed at
  // 3.4s / 10.4s / 10.5s across consecutive runs on the same commit.
  //
  // Resolving instantly keeps every assertion meaningful: Date.now() barely moves,
  // so the deadline is still in the future, both polls still run in order, and the
  // drained status is still reached through the real loop.
  const delays = [];
  const boundedDelay = (ms, deadline) => {
    delays.push({ ms, remaining: deadline - Date.now() });
    return Promise.resolve();
  };
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
    // #1539 — the per-task read closes over these two. This call passes no ui_id
    // so they are never evaluated, but binding them keeps the extraction honest:
    // without them a future ui_id case here would fail as a harness gap rather
    // than as the product behaviour under test.
    "taskFailureReason",
    "parseTaskHistoryItem",
    `${fnMatch[0]}\nreturn waitForQueueDrain;`,
  );
  const realWait = factory(
    queueDrained,
    managerGet,
    MANAGER_FETCH_TIMEOUT_MS,
    boundedDelay,
    AbortSignal,
    ManagerInstall.taskFailureReason,
    ManagerInstall.parseTaskHistoryItem,
  );

  // #1539 — the drain wait now reports { status, taskFailure } rather than a bare
  // status: the aggregate status cannot express "this task errored", so the
  // per-task verdict rides alongside it.
  const { status, taskFailure } = await realWait({ timeoutMs: 5000, intervalMs: 10 });
  assert.equal(queueDrained(status), true, "should return a positively-drained status");
  assert.equal(
    taskFailure,
    null,
    "no ui_id was passed, so no per-task record was read — and none may be invented",
  );
  assert.ok(polls >= 2, "should have polled until drained");
  // The delays are now observable rather than merely endured, so the loop's own
  // pacing is asserted instead of being taken on trust: a warm-up before the first
  // poll, then the caller's interval between polls. Each is bounded by the budget
  // that remains, which is what stops a long interval from overrunning the deadline.
  assert.deepEqual(
    delays.map((d) => d.ms),
    [1000, 10],
    "one warm-up before the first poll, then the caller's intervalMs between polls",
  );
  assert.ok(
    delays.every((d) => d.remaining > 0),
    "every delay is handed the remaining budget, so it can be capped by the deadline",
  );
});

// ---------------------------------------------------------------------------
// #671 — the install verification must fit inside the orchestrator's reply
// window. panel_install_node relays nodes_install with a 30s timeout, but
// verifyInstalled waited on waitForQueueDrain's 120s default: any install whose
// Manager queue had not drained within ~30s (a real clone + pip-deps install
// routinely takes longer) never replied, and the orchestrator reported
// `did not reply to "nodes_install" within 30000 ms` on a LIVE canvas while the
// install was proceeding. The fix bounds the whole verification (drain wait +
// installed-list read) by INSTALL_VERIFY_BUDGET_MS and lets the honest
// "unverified/pending" result (with ui_id, pollable via panel_node_queue_status)
// reach the caller in time.
// ---------------------------------------------------------------------------

// Compose the REAL boundedDelay + waitForQueueDrain + verifyInstalled sources
// with injected Manager clients, mirroring the extraction style above. The
// injected budget keeps the test fast WITHOUT touching the timing assertions:
// verifyInstalled closes over INSTALL_VERIFY_BUDGET_MS, so the factory passes a
// small stand-in — the drain-loop arithmetic under test is the panel's own.
//
// `fakeTime` ({ now, boundedDelay, abortSignal }) swaps the clock the composed
// sources read for an injected one (#1246): Date, AbortSignal and boundedDelay
// arrive as factory parameters, so a test can advance time instead of enduring
// it and assert on the deadline arithmetic rather than on the wall clock.
// Without it the real globals are bound and nothing changes.
function loadVerifyInstalled({ budgetMs, get, fakeTime }) {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  );
  const delayMatch = src.match(/function boundedDelay\([\s\S]*?\n\}/);
  const waitMatch = src.match(/async function waitForQueueDrain\([\s\S]*?\n\}/);
  const verifyMatch = src.match(/async function verifyInstalled\([\s\S]*?\n\}/);
  assert.ok(delayMatch && waitMatch && verifyMatch,
    "could not locate boundedDelay / waitForQueueDrain / verifyInstalled in panel source");
  const managerGet = async () => { throw new Error("managerGet must not be called (get is always passed)"); };
  const realBoundedDelay = new Function(`${delayMatch[0]}\nreturn boundedDelay;`)();
  const factory = new Function(
    "queueDrained",
    "classifyInstallOutcome",
    "managerGet",
    "managerV2",
    "managerCall",
    "MANAGER_FETCH_TIMEOUT_MS",
    "INSTALL_VERIFY_BUDGET_MS",
    "AbortSignal",
    "Date",
    "boundedDelay",
    `${waitMatch[0]}\n${verifyMatch[0]}\nreturn verifyInstalled;`,
  );
  return factory(
    queueDrained,
    classifyInstallOutcome,
    managerGet,
    get, // dialect "v2" routes through managerV2
    async () => { throw new Error("managerCall must not be called on the v2 dialect"); },
    15000,
    budgetMs,
    fakeTime?.abortSignal ?? AbortSignal,
    fakeTime ? { now: fakeTime.now } : Date,
    fakeTime?.boundedDelay ?? realBoundedDelay,
  );
}

test("#671 verifyInstalled (real panel source) answers 'unverified' inside the reply window when the queue never drains", async () => {
  // A Manager that is alive but whose queue stays busy — the issue's exact
  // scenario: the canvas is responsive, the install is genuinely still running.
  // The installed-list read HANGS (signal-aware): the ONE shared deadline must
  // cap it at whatever budget the drain wait left, not at a fresh 15s.
  let statusPolls = 0;
  const get = (route, opts) => {
    if (route === "manager/queue/status") {
      statusPolls += 1;
      return Promise.resolve({ is_processing: true, done_count: 0, total_count: 1 });
    }
    if (route === "customnode/installed") {
      return hangUntilAbort(opts);
    }
    return Promise.reject(new Error(`unexpected route ${route}`));
  };

  // #1246 — this test used to bound the run on the WALL clock (elapsed < 10s
  // around a 2.5s injected budget). That measured the machine, not the code:
  // alone it passed in ~3.5s, but inside the loaded full suite the same run
  // took 18-40s and failed — on branches whose entire diff was markdown. It
  // now runs on an injected clock, in the style of the drain-wait test above:
  // boundedDelay's OWN arithmetic advances the fake clock instead of sleeping,
  // and the fake AbortSignal aborts on the microtask queue — what
  // classifyInstallOutcome reads is the abort VERDICT, not how long the hang
  // was endured. What is asserted is the deadline the code computed: the polls
  // that fit the budget, the delays it was paced with, and the signal cap the
  // hanging read was handed — the properties the wall-clock bound was a lossy
  // (and under load, false) proxy for.
  let now = 0;
  const delays = [];
  const timeouts = [];
  const fakeTime = {
    now: () => now,
    // The real boundedDelay's own budget arithmetic (the request capped by
    // what the deadline leaves), applied to the fake clock rather than slept.
    boundedDelay: (ms, deadline) => {
      const wait = Math.max(0, Math.min(ms, deadline - now));
      delays.push({ ms, wait, remaining: deadline - now });
      now += wait;
      return Promise.resolve();
    },
    // An abort that fires as soon as it is observed: the hang rejects, the
    // read classifies as listError — the same verdict the real 1s-capped abort
    // produces, without the wait. The requested ms is recorded so the shared
    // deadline's cap on the read is asserted directly.
    abortSignal: {
      timeout: (ms) => {
        timeouts.push(ms);
        return {
          addEventListener: (type, cb) => {
            if (type === "abort") queueMicrotask(cb);
          },
        };
      },
    },
  };
  const verifyInstalled = loadVerifyInstalled({ budgetMs: 2500, get, fakeTime });
  const outcome = await verifyInstalled("ComfyUI-MelBandRoFormer", "v2", { budgetMs: 2500 });

  // The deadline arithmetic under test: a 2500ms budget is a 1000ms warm-up,
  // one poll, one 1500ms interval — the loop stops AT the deadline, never past
  // it. A missing drain budget (the #671 mutant) falls back to the 120s
  // default: the poll count and the consumed budget both blow up, and this
  // fails in milliseconds instead of after a 120s stall.
  assert.equal(statusPolls, 1, "exactly one poll fits a 2500ms budget after the warm-up");
  assert.deepEqual(
    delays.map((d) => [d.ms, d.wait]),
    [[1000, 1000], [1500, 1500]],
    "one warm-up before the first poll, then the default interval between polls",
  );
  assert.ok(
    delays.every((d) => d.wait <= d.remaining),
    "every delay is capped by the budget that remains, so it cannot overrun the deadline",
  );
  assert.equal(now, 2500, "the drain wait consumed exactly the injected budget and stopped at the deadline");
  // The hanging list read inherited what the drain wait LEFT of the shared
  // deadline — nothing — so its signal was the 1000ms floor, not a fresh 15s
  // (the second #671 mutant: a list read on its own MANAGER_FETCH_TIMEOUT_MS).
  assert.deepEqual(
    timeouts,
    [1500, 1000],
    "the poll was capped by the remaining budget, the list read by the floor past the shared deadline",
  );
  // Assert the REASON, not just the state: not-drained is an honest
  // "still in progress", never a fabricated success or failure.
  assert.equal(outcome.state, "unverified");
  assert.match(outcome.message, /still in progress/);
  assert.match(outcome.message, /panel_node_queue_status/);
});

test("#671 verifyInstalled (real panel source) still verifies a fast-draining install", async () => {
  // Positive control: a queue that drains immediately and a list that contains
  // the pack must still reach "installed" — the budget only converts SLOW
  // verifications to "pending", it must not degrade the fast path.
  const get = async (route) => {
    if (route === "manager/queue/status") {
      return { is_processing: false, done_count: 1, total_count: 1 };
    }
    if (route === "customnode/installed") {
      return { "ComfyUI-MelBandRoFormer": { ver: "1.0.0", cnr_id: "ComfyUI-MelBandRoFormer" } };
    }
    throw new Error(`unexpected route ${route}`);
  };
  const verifyInstalled = loadVerifyInstalled({ budgetMs: 3000, get });
  const outcome = await verifyInstalled("ComfyUI-MelBandRoFormer", "v2", { budgetMs: 3000 });
  assert.equal(outcome.state, "installed");
});

// Fast wiring guard: the behavioral tests catch a reverted budget only after
// waiting out the mutant's stall. Pin the budget threading at source level too,
// so a regression fails in milliseconds — the same style as the #486/#485
// wiring guards below.
test("#671 nodes_install threads ONE sub-30s command budget through every phase (wiring)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  );
  const constMatch = src.match(/const NODES_INSTALL_COMMAND_BUDGET_MS = (\d+);/);
  assert.ok(constMatch, "NODES_INSTALL_COMMAND_BUDGET_MS must be defined");
  assert.ok(
    Number(constMatch[1]) < 30000,
    `command budget (${constMatch[1]} ms) must fit inside the orchestrator's 30s reply window`,
  );
  const fnMatch = src.match(/async nodes_install\(args\)\s*\{[\s\S]*?\n {2}\},/);
  assert.ok(fnMatch, "could not locate nodes_install in panel source");
  const body = fnMatch[0];
  // The verify phase draws on what the command budget has LEFT — not a fresh
  // fixed budget that could stack past the relay window on top of slow calls.
  assert.match(
    body,
    /verifyInstalled\(target, dialect, \{\s*batchFailed, renameProne, budgetMs: remaining\(\), ui_id,\s*\}\)/,
    // #1539 added ui_id to this call. Pinned in the SAME assertion rather than a
    // looser regex: budgetMs threading (#671) and ui_id threading (#1539) are
    // both one-line properties of this one call, and both die silently if
    // dropped — the budget by stacking past the relay window, the ui_id by
    // reporting a rejected install as queued/pending.
    "verifyInstalled must receive the remaining command budget AND the task ui_id",
  );
  // A budget-exhausted stall is reworded per phase, never reported raw.
  assert.match(body, /translateStall\(err, phase\)/, "stalls past the budget must be translated");
  // EVERY phase draws on the SAME remaining budget (codex r2 P2 — a phase
  // without the cap can stack past the relay window ahead of verification).
  assert.match(
    body,
    /detectManagerDialect\(\{\s*signal: AbortSignal\.timeout\(bounded\(/,
    "dialect detection must be budget-bounded",
  );
  assert.match(
    body,
    /reProbeManagerDialect\(\{ signal: AbortSignal\.timeout\(bounded\(/,
    "the #605 re-probe must be budget-bounded",
  );
  assert.match(
    body,
    /"manager\/queue\/start",\s*\{ signal: AbortSignal\.timeout\(bounded\(/,
    "queue/start must be budget-bounded",
  );
  // The re-probe is its own phase: it only runs after a PROVEN 404, so a stall
  // there can honestly claim NOTHING was queued (codex r2 P2).
  assert.match(body, /phase = "reprobe";/, "the re-probe must be its own phase");
  // The verify wait is bounded by the threaded budget.
  const verifyMatch = src.match(/async function verifyInstalled\([\s\S]*?\n\}/);
  assert.ok(verifyMatch, "could not locate verifyInstalled in panel source");
  assert.match(
    verifyMatch[0],
    /waitForQueueDrain\(\{\s*timeoutMs: budget/,
    "verifyInstalled must bound the drain wait by its budget",
  );
});

// The codex-round-1 P1/P2: bounding ONLY the verify phase still let the reply
// miss the 30s window when pre-verify Manager calls each ate their 15s cap.
// Drive the REAL extracted nodes_install end-to-end against a Manager that
// accepts the dialect probe but HANGS the install POST: the command must throw
// an honest, phase-truthful budget error inside the window — never sit silent
// until the relay reports a wedged tab.
function loadNodesInstall({ budgetMs, detect, reProbe, managerV2, managerCall, managerQueueControl, verifyInstalled }) {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  );
  const fnMatch = src.match(/async nodes_install\(args\)\s*\{[\s\S]*?\n {2}\},/);
  // The REAL isStallError is compiled in with the handler (codex r2 P2 — a shim
  // would let the production classifier regress unnoticed).
  const stallMatch = src.match(/function isStallError\([\s\S]*?\n\}/);
  assert.ok(fnMatch && stallMatch, "could not locate nodes_install / isStallError in panel source");
  const body = fnMatch[0].replace(/,\s*$/, "");
  const factory = new Function(
    "detectManagerDialect",
    "crypto",
    "api",
    "installGitUrl",
    "buildInstallRequest",
    "isManagerRouteMissing",
    "dialectRetryTarget",
    "reProbeManagerDialect",
    "managerV2",
    "managerCall",
    "managerQueueControl",
    "verifyInstalled",
    "MANAGER_FETCH_TIMEOUT_MS",
    "NODES_INSTALL_COMMAND_BUDGET_MS",
    "AbortSignal",
    // comfyui-mcp#1606 — the handler correlates its ui_id with the pack, so the
    // Manager's completion broadcast can name what failed. A real log, not a
    // stub: an injected no-op would let the correlation regress unnoticed here.
    "managerTaskResults",
    `${stallMatch[0]}\nconst handler = { ${body} };\nreturn handler.nodes_install;`,
  );
  return factory(
    detect ?? (async () => "v2"), // dialect probe answers instantly — the Manager is ALIVE
    { randomUUID: () => "ui-test-1" },
    { clientId: "test-client" },
    installGitUrl,
    buildInstallRequest,
    ManagerInstall.isManagerRouteMissing,
    ManagerInstall.dialectRetryTarget,
    reProbe ?? (async () => { throw new Error("reProbeManagerDialect must not run (no 404 here)"); }),
    managerV2,
    managerCall,
    managerQueueControl,
    verifyInstalled,
    15000,
    budgetMs,
    AbortSignal,
    ManagerInstall.createManagerTaskResultLog(),
  );
}

// #681: the budget tests straddle TWO clocks — AbortSignal.timeout rides the
// MONOTONIC clock (libuv timers) while translateStall's deadline check reads
// the WALL clock (Date.now()). On a loaded runner the abort can fire while
// Date.now() still reads a beat BEFORE commandDeadline; translateStall then
// sees "budget remains" and passes the raw stall through, and the test gets
// "The operation timed out" instead of the translated budget claim (the CI
// flake). Gate the rejection on the WALL clock: after the abort fires,
// re-check Date.now() until it has passed the budget the mock was invoked
// under. Every mock below runs synchronously AFTER nodes_install fixes
// commandDeadline = Date.now() + budgetMs, so invocation-time + budgetMs is
// never EARLIER than the deadline — once the wall clock passes it, the
// translation MUST fire, whatever the monotonic/wall skew. The re-check loop
// (not a bare setTimeout) is what makes this immune to skew in EITHER
// direction: the wait timer is monotonic too, so only the Date.now() gate
// decides.
function stallError() {
  return Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
}

function rejectOnceWallClockPast(reject, notBefore) {
  const wait = notBefore - Date.now();
  if (wait <= 0) {
    reject(stallError());
  } else {
    setTimeout(() => rejectOnceWallClockPast(reject, notBefore), wait + 1);
  }
}

// A stall that surfaces only once the wall clock has passed now + budgetMs —
// the deterministic shape of "the phase ran the command budget out" (#681),
// for mocks whose stall is SCHEDULED rather than abort-driven.
function stallPastBudget(budgetMs) {
  return new Promise((_, reject) => rejectOnceWallClockPast(reject, Date.now() + budgetMs));
}

// A request that never answers, failing ONLY when its abort signal fires — the
// shape of a stalled Manager call under api.fetchApi. The ref'd fallback timer
// is load-bearing TWICE: (1) a mutant that DROPS the budget signal fails the
// test's elapsed bound instead of hanging the suite; (2) AbortSignal.timeout's
// timer is UNREF'D in Node, so a promise that waits only on "abort" can leave
// the event loop EMPTY — the runner then cancels the test with "Promise
// resolution is still pending but the event loop has already resolved" (CI run
// 31050277380). The fallback keeps the loop alive and is cleared when the abort
// fires, so it never delays a passing suite. `budgetMs` (the command budget the
// test injected) arms the #681 wall-clock gate above; omit it for hangs whose
// classification does not depend on a deadline.
function hangUntilAbort(opts, { fallbackMs = 30000, budgetMs = 0 } = {}) {
  return new Promise((_, reject) => {
    const notBefore = Date.now() + budgetMs;
    const fail = () => rejectOnceWallClockPast(reject, notBefore);
    const fallback = setTimeout(fail, fallbackMs);
    if (opts?.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(fallback);
          fail();
        },
        { once: true },
      );
    }
  });
}

test("#671 isStallError (real panel source) classifies aborts as stalls and real verdicts as NOT stalls", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  );
  const m = src.match(/function isStallError\([\s\S]*?\n\}/);
  assert.ok(m, "could not locate isStallError in panel source");
  const isStallError = new Function(`${m[0]}\nreturn isStallError;`)();
  assert.equal(isStallError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isStallError(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" })), true);
  assert.equal(
    isStallError(new Error("ComfyUI-Manager dialect detection was aborted mid-probe (the caller's budget ran out)")),
    true,
    "detectManagerDialect's own budget abort is a plain Error — matched by its exact prefix",
  );
  // codex r2 P1: a REAL Manager verdict whose message happens to contain
  // "timed out" is EVIDENCE, not a stall — it must surface verbatim.
  assert.equal(isStallError(new Error("Manager manager/queue/task: install timed out")), false);
  // codex r3 P2: a verdict that merely QUOTES the detect-abort phrase is not
  // the detect abort — the match is anchored at the message start.
  assert.equal(
    isStallError(new Error("Manager manager/queue/task: server aborted mid-probe recovery")),
    false,
  );
  assert.equal(isStallError(new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)")), false);
  assert.equal(isStallError(new Error("Manager manager/queue/task: HTTP 500")), false);
});

test("#671 nodes_install (real panel source) answers inside the reply window when the Manager stalls the install POST", async () => {
  // The install POST hangs forever (signal-aware); every other call answers.
  const managerV2 = (route, opts) => {
    if (route === "manager/queue/task") {
      return hangUntilAbort(opts, { budgetMs: 2500 });
    }
    return Promise.reject(new Error(`unexpected route ${route}`));
  };
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    managerV2,
    managerCall: async () => { throw new Error("managerCall must not run on the v2 dialect"); },
    managerQueueControl: async () => { throw new Error("start must not run — the submit never landed"); },
    verifyInstalled: async () => { throw new Error("verify must not run — the submit never landed"); },
  });
  const started = Date.now();
  const err = await nodes_install({ id: "ComfyUI-MelBandRoFormer" }).then(
    () => null,
    (e) => e,
  );
  const elapsed = Date.now() - started;

  assert.ok(err, "a stalled submit must surface an error, never a silent success");
  // The reply leaves the tab WELL inside the 30s relay window. A missing
  // command budget waits out the 15s per-fetch cap — caught by this bound.
  assert.ok(elapsed < 10000, `the command outlived its budget (${elapsed} ms)`);
  // Assert the REASON and the honest state claim: queued-state UNKNOWN, never
  // a fabricated failure — and an actionable next step (a blind retry can
  // double-queue the install).
  assert.match(err.message, /command budget/);
  assert.match(err.message, /UNKNOWN/);
  assert.match(err.message, /panel_node_queue_status/);
});

test("#671 nodes_install (real panel source) happy path still verifies inside the window", async () => {
  // Positive control: a fast Manager must still reach the verified reply.
  const calls = [];
  const managerV2 = async (route) => {
    calls.push(route);
    return null;
  };
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    managerV2,
    managerCall: async () => { throw new Error("managerCall must not run on the v2 dialect"); },
    managerQueueControl: async () => {},
    verifyInstalled: async () => ({ state: "installed", status: null }),
  });
  const started = Date.now();
  const result = await nodes_install({ id: "ComfyUI-MelBandRoFormer" });
  const elapsed = Date.now() - started;
  assert.equal(result.installed, true);
  assert.equal(result.verified, true);
  assert.equal(result.ui_id, "ui-test-1");
  assert.ok(elapsed < 2500, `the happy path must not wait out the budget (${elapsed} ms)`);
  assert.deepEqual(calls, ["manager/queue/task"], "exactly one submit, on the v2 task route");
});

test("#1539 v4 refuses a Git-routed target before any Manager mutation", async () => {
  const calls = [];
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    detect: async () => "v2",
    managerV2: async (...args) => { calls.push(["v2", ...args]); },
    managerCall: async (...args) => { calls.push(["legacy", ...args]); },
    managerQueueControl: async (...args) => { calls.push(["start", ...args]); },
    verifyInstalled: async (...args) => { calls.push(["verify", ...args]); },
  });
  const err = await nodes_install({
    repository: "https://github.com/example/arbitrary-node.git",
  }).then(() => null, (e) => e);

  assert.ok(err, "an arbitrary Git URL must be refused on real v4");
  assert.match(err.message, /Manager v4 does not clone the supplied arbitrary URL/);
  assert.match(err.message, /no install was queued/i);
  assert.match(err.message, /Manager registry id/);
  assert.match(err.message, /ComfyUI host/);
  assert.match(err.message, /local verified path/);
  assert.deepEqual(calls, [], "v4 Git rejection must send no submit, start, or verification mutation");
});

for (const dialect of ["v2-batch", "legacy"]) {
  test(`#1539 ${dialect} keeps the direct-URL files path`, async () => {
    const url = "https://github.com/example/arbitrary-node.git";
    const calls = [];
    const managerV2 = async (route, opts) => {
      calls.push(["v2", route, opts]);
      return { failed: [] };
    };
    const managerCall = async (route, opts) => {
      calls.push(["legacy", route, opts]);
      return null;
    };
    const nodes_install = loadNodesInstall({
      budgetMs: 2500,
      detect: async () => dialect,
      managerV2,
      managerCall,
      managerQueueControl: async (_call, route) => {
        calls.push(["start", route]);
      },
      verifyInstalled: async (target, actualDialect) => {
        assert.equal(actualDialect, dialect);
        return { state: "installed" };
      },
    });
    const result = await nodes_install({ repository: url });

    assert.equal(result.installed, true);
    const submit = calls.find(([kind, route]) =>
      kind === (dialect === "v2-batch" ? "v2" : "legacy") &&
      route === (dialect === "v2-batch" ? "manager/queue/batch" : "manager/queue/install"),
    );
    assert.ok(submit, `${dialect} must still submit the install`);
    const body = dialect === "v2-batch" ? submit[2].body.install[0] : submit[2].body;
    assert.deepEqual(body.files, [url], `${dialect} must preserve files:[url] direct-URL routing`);
    assert.ok(calls.some(([kind, route]) => kind === "start" && route === "manager/queue/start"));
  });
}

test("#671 nodes_install a stalled dialect detection reports NOTHING queued (a retry is safe)", async () => {
  // Detection hangs (signal-aware); NO mutation may run. The budget error must
  // say so — this phase can vouch for it (codex r2 P2).
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    detect: (opts) => hangUntilAbort(opts, { budgetMs: 2500 }),
    managerV2: async () => { throw new Error("no mutation may run — detection never answered"); },
    managerCall: async () => { throw new Error("no mutation may run — detection never answered"); },
    managerQueueControl: async () => { throw new Error("start must not run"); },
    verifyInstalled: async () => { throw new Error("verify must not run"); },
  });
  const started = Date.now();
  const err = await nodes_install({ id: "ComfyUI-MelBandRoFormer" }).then(() => null, (e) => e);
  const elapsed = Date.now() - started;
  assert.ok(err, "a stalled detection must surface an error, never hang the reply");
  assert.ok(elapsed < 10000, `the command outlived its budget (${elapsed} ms)`);
  assert.match(err.message, /command budget/);
  assert.match(err.message, /NOTHING was queued/);
});

test("#671 nodes_install a stalled queue/start after a LANDED submit says QUEUED, never failed", async () => {
  // The submit answers (the install IS queued); the start hangs. The budget
  // error must claim exactly that — not failure, not "nothing happened".
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    managerV2: async () => null, // the submit lands
    managerCall: async () => { throw new Error("managerCall must not run on the v2 dialect"); },
    managerQueueControl: (_call, _route, opts) => hangUntilAbort(opts, { budgetMs: 2500 }),
    verifyInstalled: async () => { throw new Error("verify must not run — the start never answered"); },
  });
  const started = Date.now();
  const err = await nodes_install({ id: "ComfyUI-MelBandRoFormer" }).then(() => null, (e) => e);
  const elapsed = Date.now() - started;
  assert.ok(err, "a stalled start must surface an error, never hang the reply");
  assert.ok(elapsed < 10000, `the command outlived its budget (${elapsed} ms)`);
  assert.match(err.message, /was QUEUED/);
  assert.match(err.message, /panel_node_queue_status/);
  assert.ok(!/FAILED/.test(err.message), "a landed install must never be reported as failed");
});

test("#671 a REAL Manager verdict is never reworded as a budget stall (codex r2 P1)", async () => {
  // The submit answers LATE — past the command budget — with a real HTTP
  // verdict whose message happens to contain "timed out". That is EVIDENCE,
  // not a transport stall: it must surface verbatim, not be reworded into a
  // phase claim.
  const verdict = new Error("Manager manager/queue/task: install timed out");
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    managerV2: (route) =>
      new Promise((_, reject) => setTimeout(() => reject(verdict), 2700)),
    managerCall: async () => { throw new Error("managerCall must not run on the v2 dialect"); },
    managerQueueControl: async () => { throw new Error("start must not run — the submit failed"); },
    verifyInstalled: async () => { throw new Error("verify must not run — the submit failed"); },
  });
  const err = await nodes_install({ id: "ComfyUI-MelBandRoFormer" }).then(() => null, (e) => e);
  assert.ok(err, "a failed submit must surface an error");
  assert.equal(err.message, "Manager manager/queue/task: install timed out", "the real verdict survives verbatim");
});

test("#671 nodes_install a stall in the VERIFY phase claims queued+started, never an unconfirmed start (codex r3 P1)", async () => {
  // Submit and start BOTH returned; the verify step is where the budget runs
  // out. (Production verifyInstalled is internally bounded and never throws a
  // stall — this drives the translateStall branch that guards the claim if
  // that ever changes.) The message must NOT downgrade the acknowledged start.
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    managerV2: async () => null, // submit lands
    managerCall: async () => { throw new Error("managerCall must not run on the v2 dialect"); },
    managerQueueControl: async () => {}, // start acknowledged
    // The stall surfaces only once the WALL clock has passed the command
    // budget — the #681 gate, so the translateStall branch below is driven
    // deterministically regardless of monotonic/wall skew.
    verifyInstalled: () => stallPastBudget(2500),
  });
  const err = await nodes_install({ id: "ComfyUI-MelBandRoFormer" }).then(() => null, (e) => e);
  assert.ok(err, "a verify-phase stall must surface an error");
  assert.match(err.message, /was QUEUED and the queue start was acknowledged/);
  assert.match(err.message, /could not be VERIFIED/);
  assert.match(err.message, /panel_node_queue_status/);
  assert.ok(!/did not answer queue\/start/.test(err.message), "must not claim the start went unanswered");
  assert.ok(!/FAILED/.test(err.message), "must never claim failure");
});

test("#671 nodes_install a stall BEFORE the deadline is NOT claimed as budget exhaustion (codex r3 P2)", async () => {
  // The per-call cap fires while command budget remains: the error is real but
  // it is NOT the command budget — it must pass through untranslated. (The raw
  // surfacing of a per-call stall is pre-existing behavior; only the false
  // budget attribution is the bug guarded here.)
  const stall = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
  const nodes_install = loadNodesInstall({
    budgetMs: 2500,
    managerV2: () => new Promise((_, reject) => setTimeout(() => reject(stall), 500)),
    managerCall: async () => { throw new Error("managerCall must not run on the v2 dialect"); },
    managerQueueControl: async () => { throw new Error("start must not run — the submit failed"); },
    verifyInstalled: async () => { throw new Error("verify must not run — the submit failed"); },
  });
  const err = await nodes_install({ id: "ComfyUI-MelBandRoFormer" }).then(() => null, (e) => e);
  assert.ok(err, "a stalled submit must surface an error");
  assert.equal(err, stall, "a pre-deadline stall surfaces as itself, not reworded as budget exhaustion");
});

// ---------------------------------------------------------------------------
// #486 / #485 — legacy Manager 3.x install dialect. The install runtime lives in
// comfyui-mcp-panel.js (managerQueueControl + nodes_install); we extract the real
// source and assert its wiring so the fixes can't silently regress.
// ---------------------------------------------------------------------------

function readPanelSource() {
  const panelPath = fileURLToPath(
    new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  );
  return readFileSync(panelPath, "utf8");
}

// #486 — queue/start is POST on pip v4 and the released 3.41 build, but GET-only
// on some older released 3.x builds (ComfyUI 0.27.0 → HTTP 405 on POST). Drive
// the REAL managerQueueControl source against mock `call`s to prove: POST first;
// a 405 negotiates a single GET retry on the SAME route; any non-405 propagates
// with NO GET retry.
test("#486 managerQueueControl (real panel source): POST, then GET-retry ONLY on 405", async () => {
  const src = readPanelSource();
  const fnMatch = src.match(/async function managerQueueControl\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "could not locate managerQueueControl in panel source");

  const isMethodNotAllowed = (err) => /HTTP\s*405\b/.test(String(err?.message ?? err ?? ""));
  const MANAGER_FETCH_TIMEOUT_MS = 15000;
  // The real source composes the per-fetch cap with an optional caller budget
  // signal (#671) via anyAbortSignal; inject a faithful stand-in (the helper is
  // not the unit under test here).
  const anyAbortSignal = (signals) => AbortSignal.any(signals.filter(Boolean));
  const factory = new Function(
    "isMethodNotAllowed",
    "MANAGER_FETCH_TIMEOUT_MS",
    "anyAbortSignal",
    "AbortSignal",
    `${fnMatch[0]}\nreturn managerQueueControl;`,
  );
  const managerQueueControl = factory(isMethodNotAllowed, MANAGER_FETCH_TIMEOUT_MS, anyAbortSignal, AbortSignal);

  // (a) POST succeeds ⇒ exactly one POST, no GET retry.
  {
    const calls = [];
    const call = async (route, opts) => {
      calls.push(opts?.method ?? "GET");
    };
    await managerQueueControl(call, "manager/queue/start");
    assert.deepEqual(calls, ["POST"], "a working POST must NOT trigger a GET retry");
  }

  // (b) POST 405s (GET-only build) ⇒ negotiate a single GET retry on the SAME route.
  {
    const calls = [];
    const call = async (route, opts) => {
      const method = opts?.method ?? "GET";
      calls.push({ route, method });
      if (method === "POST") throw new Error("Manager manager/queue/start: HTTP 405");
    };
    await managerQueueControl(call, "manager/queue/start");
    assert.deepEqual(
      calls,
      [
        { route: "manager/queue/start", method: "POST" },
        { route: "manager/queue/start", method: "GET" },
      ],
      "a 405 must negotiate POST→GET on the same route",
    );
  }

  // (c) A non-405 error (e.g. 404 'not reachable') propagates with NO GET retry —
  // a 405 is the ONLY method signal we negotiate.
  {
    let posts = 0;
    let gets = 0;
    const call = async (route, opts) => {
      if ((opts?.method ?? "GET") === "POST") {
        posts += 1;
        throw new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)");
      }
      gets += 1;
    };
    await assert.rejects(() => managerQueueControl(call, "manager/queue/start"), /not reachable/);
    assert.equal(posts, 1);
    assert.equal(gets, 0, "a 404/unreachable must NOT be retried as GET");
  }
});

// #486 — nodes_install must start the queue through managerQueueControl (which
// negotiates POST→GET on 405), never a raw POST (the exact HTTP-405 bug). Guard
// the install block's source.
test("#486 nodes_install starts the queue via managerQueueControl, never a raw POST", () => {
  const src = readPanelSource();
  const fnMatch = src.match(/async nodes_install\(args\)\s*\{[\s\S]*?\n {2}\},/);
  assert.ok(fnMatch, "could not locate nodes_install in panel source");
  const body = fnMatch[0];
  // The start goes through the negotiator, routed to the effective dialect's caller.
  assert.match(
    body,
    /managerQueueControl\(\s*dialect === "legacy" \? managerCall : managerV2,\s*"manager\/queue\/start"/,
  );
  // No raw start POST survives in the install path (the #486 regression).
  assert.ok(
    !/manager(V2|Call)\(\s*"manager\/queue\/start"\s*,\s*post\(\)\s*\)/.test(body),
    "install must not send a raw POST to manager/queue/start",
  );
  // Exactly ONE start is issued (not one per dialect branch) — the submit is
  // separated from start so the #485 fallback can't double-fire (codex P0).
  const starts = body.match(/"manager\/queue\/start"/g) ?? [];
  assert.equal(starts.length, 1, "install must start the queue exactly once");
});

// #485 — a non-legacy dialect whose /v2 mutation reports the Manager unreachable
// (404) must fall back to the ABSOLUTE legacy install SUBMIT, exactly as
// nodes_list already degrades — never surface a false 'not reachable'. The
// fallback must wrap ONLY the enqueue (submit), never the start, so an already-
// landed submission can't be re-fired (codex P0). Guard the wiring in source.
test("#485 nodes_install falls back to the legacy dialect on an unreachable signal", () => {
  const src = readPanelSource();
  const fnMatch = src.match(/async nodes_install\(args\)\s*\{[\s\S]*?\n {2}\},/);
  assert.ok(fnMatch, "could not locate nodes_install in panel source");
  const body = fnMatch[0];
  // The submit is attempted, and on an unreachable error the dialect is re-probed
  // (#605) and the retry picked by the dialectRetryTarget ladder — which still
  // lands on the absolute legacy routes when the re-probe agrees or the Manager
  // is silent (the #485 fallback), and gives up (null → original error) when a
  // legacy submit itself was rejected.
  assert.match(body, /let dialect = detected;/);
  assert.match(body, /submitInstall\(dialect\)/);
  assert.match(
    body,
    /if \(!isManagerRouteMissing\(err\)\) throw err;/,
    "only a PROVEN route-level rejection (the 404 marker) triggers the re-probe/retry — an ambiguous no-response failure must never re-send a mutation (codex P0)",
  );
  assert.match(
    body,
    /dialectRetryTarget\(\s*dialect,\s*await reProbeManagerDialect\(/,
    "the retry dialect comes from a live re-probe via the ladder",
  );
  assert.match(body, /if \(!retry\) throw err;/, "legacy-on-legacy gives up with the original error");
  assert.match(body, /submitted = await submitInstall\(retry\)/);
  // The single queue/start MUST live OUTSIDE the submit try/catch (after it) so
  // a start failure never re-runs the submit (codex P0 — no double-fire). The
  // call is multiline (it takes a budget signal, #671) — anchor on its name,
  // which occurs only at that one call site in this body.
  const catchIdx = body.indexOf("catch (err)");
  const startIdx = body.indexOf("managerQueueControl(");
  assert.ok(catchIdx >= 0 && startIdx > catchIdx, "queue/start must run after the submit try/catch");
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

test("#1287 a limit above the cap is DISCLOSED as limit_cap, not silently honored", () => {
  // The tool's published description documented no maximum while the schema rejected
  // limit>40 (MCP -32602) and the panel silently returned fewer rows than asked. The
  // cap stays — but whenever it bites, the result must NAME it, so a truncated list
  // can no longer read as the whole answer.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `p/${i}`, title: `t${i}` }));

  const clamped = parseNodeMappings(many, "", SEARCH_LIMIT_CAP + 10);
  assert.equal(clamped.results.length, SEARCH_LIMIT_CAP);
  assert.equal(clamped.limit_cap, SEARCH_LIMIT_CAP, "a clamped request must say what bound was applied");

  // At or under the cap — and the default path — there is nothing to disclose, and
  // the payload must not grow a field that claims a clamp that never happened.
  for (const lim of [SEARCH_LIMIT_CAP, 5, undefined]) {
    const r = parseNodeMappings(many, "", lim);
    assert.equal("limit_cap" in r, false, `limit ${String(lim)} was not clamped and must not say it was`);
  }

  // The /object_info fallback search enforces the same bound and discloses it the
  // same way.
  const bigInfo = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`Node${i}`, { display_name: `Node ${i}` }]),
  );
  const infoClamped = parseObjectInfoSearch(bigInfo, "", SEARCH_LIMIT_CAP + 10);
  assert.equal(infoClamped.results.length, SEARCH_LIMIT_CAP);
  assert.equal(infoClamped.limit_cap, SEARCH_LIMIT_CAP);
  assert.equal("limit_cap" in parseObjectInfoSearch(bigInfo, "", SEARCH_LIMIT_CAP), false);
});

test("#1287 the object_info FALLBACK wrapper keeps the limit_cap disclosure", async () => {
  // objectInfoSearchFallback re-wraps the parsed result; the disclosure must survive
  // the re-wrap or the unreachable-Manager path silently loses it.
  const UNREACHABLE_ERR = new Error("Manager customnode/getmappings: not reachable");
  const bigInfo = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`Node${i}`, { display_name: `Node ${i}` }]),
  );
  const res = await objectInfoSearchFallback(async () => bigInfo, "", SEARCH_LIMIT_CAP + 10, UNREACHABLE_ERR);
  assert.equal(res.supported, true);
  assert.equal(res.results.length, SEARCH_LIMIT_CAP);
  assert.equal(res.limit_cap, SEARCH_LIMIT_CAP, "the fallback path must disclose the same clamp");
});

test("#1287 the README documents the same bound the search enforces", () => {
  // The README tool table is the published description this repo owns — it carried no
  // maximum while the search enforced one, the disagreement the issue reports. Pin
  // the row to the enforced cap so the two cannot drift apart again.
  const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
  const row = readme.split("\n").find((l) => l.includes("`panel_search_nodes`"));
  assert.ok(row, "the tool table must list panel_search_nodes");
  assert.match(
    row,
    new RegExp(`max ${SEARCH_LIMIT_CAP}\\b`),
    "the documented limit bound must match the enforced SEARCH_LIMIT_CAP",
  );
});

test("#394 parseNodeMappings MAP-shape id is INSTALLABLE (repo URL), never the display title", () => {
  const res = parseNodeMappings(GETMAPPINGS_MAP, "", 15);
  // The meta objects carry only { title, description } — no installable id — so
  // the id MUST fall through to the repo-URL KEY, not the human title.
  const byTitle = Object.fromEntries(res.results.map((r) => [r.title, r]));
  const impactish = byTitle["ComfyUI-RMBG"];
  assert.ok(impactish, "expected a result keyed by its display title");
  assert.equal(impactish.id, "https://github.com/1038lab/ComfyUI-RMBG");
  // A title with a space ("ComfyUI Frame Interpolation") is the exact shape that
  // used to leak into `id` and defeat install (no slash/protocol). Assert it does
  // NOT: the id is the repo URL and the title stays separate for display.
  const fi = byTitle["ComfyUI Frame Interpolation"];
  assert.ok(fi);
  assert.equal(fi.id, "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation");
  assert.notEqual(fi.id, fi.title);
  // Every derived id must be consumable by panel_install_node — routed as a git
  // install and matched on disk under the repo name.
  for (const r of res.results) {
    assert.equal(looksLikeGitUrl(r.id), true, `id ${r.id} must be git-routable`);
    assert.equal(installGitUrl({ id: r.id }), r.id, `installGitUrl must resolve ${r.id}`);
    const req = buildInstallRequest("v2", { id: r.id, version: "latest" });
    assert.equal(req.params.id, gitRepoName(r.id), "v2 install routes by the repo name");
  }
});

test("#394 parseNodeMappings prefers an explicit cnr/reference id over the title/key", () => {
  // A Manager build that DOES carry a cnr id in meta must keep it (installable),
  // and a `reference` repo URL wins over the human title too.
  const withCnr = {
    "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
      ["ImpactWildcardProcessor"],
      { id: "comfyui-impact-pack", title: "Impact Pack", description: "detailer" },
    ],
  };
  assert.equal(parseNodeMappings(withCnr, "", 15).results[0].id, "comfyui-impact-pack");
  const arrWithRef = [
    { reference: "https://github.com/foo/bar", title: "Foo Bar", description: "x" },
  ];
  assert.equal(parseNodeMappings(arrWithRef, "", 15).results[0].id, "https://github.com/foo/bar");
});

test("managerUnavailableResult is a safe, actionable structured payload", () => {
  const r = managerUnavailableResult(undefined, UNREACHABLE);
  assert.equal(r.supported, false);
  assert.equal(r.query, "");
  assert.equal(r.reason, UNREACHABLE.message);
});

// ---- #426: /object_info installed-node fallback when Manager is unreachable ---
// On a legacy 3.x Manager without the registry search endpoint (or Manager
// disabled), nodes_search used to return a bare "unavailable" message. Now, when
// BOTH Manager routes are unreachable, it searches the connected ComfyUI's core
// /object_info for INSTALLED nodes matching the query so the agent still gets
// usable results.

const OBJECT_INFO = {
  ControlNetApplyAdvanced: {
    display_name: "Apply ControlNet (Advanced)",
    category: "conditioning/controlnet",
    description: "Apply a ControlNet to conditioning.",
  },
  ControlNetLoader: {
    display_name: "Load ControlNet Model",
    category: "loaders",
    description: "",
  },
  KSampler: { display_name: "KSampler", category: "sampling", description: "" },
};

test("#426 parseObjectInfoSearch filters installed nodes by query across name/display/category/desc", () => {
  const r = parseObjectInfoSearch(OBJECT_INFO, "controlnet", 15);
  assert.equal(r.count, 2);
  const ids = r.results.map((x) => x.id).sort();
  assert.deepEqual(ids, ["ControlNetApplyAdvanced", "ControlNetLoader"]);
  assert.equal(r.results[0].installed, true);
  // A query that only appears in the display name still hits.
  assert.equal(parseObjectInfoSearch(OBJECT_INFO, "apply", 15).count, 1);
  // No match → empty.
  assert.equal(parseObjectInfoSearch(OBJECT_INFO, "flux", 15).count, 0);
  // Empty query returns all, capped by limit.
  assert.equal(parseObjectInfoSearch(OBJECT_INFO, "", 2).results.length, 2);
});

test("#426 parseObjectInfoSearch tolerates junk input", () => {
  assert.deepEqual(parseObjectInfoSearch(null, "x", 5), { count: 0, results: [] });
  assert.deepEqual(parseObjectInfoSearch(undefined, "x", 5), { count: 0, results: [] });
});

test("#426 searchNodesVia falls back to /object_info when BOTH Manager routes are unreachable", async () => {
  const throwUnreachable = async () => {
    throw UNREACHABLE;
  };
  const objectInfoGet = async () => OBJECT_INFO;
  const res = await searchNodesVia(throwUnreachable, throwUnreachable, {
    query: "ControlNet",
    objectInfoGet,
  });
  assert.equal(res.supported, true);
  assert.equal(res.managerReachable, false);
  assert.equal(res.installedOnly, true);
  assert.equal(res.source, "object_info");
  assert.equal(res.count, 2);
  assert.match(res.message, /object_info|installed/i);
});

test("#426 falls back to the structured unavailable result when /object_info has NO match", async () => {
  const throwUnreachable = async () => {
    throw UNREACHABLE;
  };
  const res = await searchNodesVia(throwUnreachable, throwUnreachable, {
    query: "no-such-node-xyz",
    objectInfoGet: async () => OBJECT_INFO,
  });
  assert.equal(res.supported, false);
  assert.equal(res.count, 0);
});

test("#426 a failing /object_info fetch degrades to the unavailable result, never throws", async () => {
  const throwUnreachable = async () => {
    throw UNREACHABLE;
  };
  const res = await objectInfoSearchFallback(
    async () => {
      throw new Error("object_info 503");
    },
    "ControlNet",
    15,
    UNREACHABLE,
  );
  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
});

test("#426 with no objectInfoGet injected, behavior is unchanged (structured unavailable)", async () => {
  const throwUnreachable = async () => {
    throw UNREACHABLE;
  };
  const res = await searchNodesVia(throwUnreachable, throwUnreachable, { query: "ControlNet" });
  assert.equal(res.supported, false);
});
