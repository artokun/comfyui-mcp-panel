// panel#920 — `panel_install_node({repository:"https://github.com/kijai/ComfyUI-SolAttn_triton.git",
// version:"nightly"})` queued a REGISTRY LOOKUP instead of a source install:
//
//   Node 'ComfyUI-SolAttn_triton@nightly' not found in
//   [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// `buildInstallRequest`'s v2 branch reduced the URL to its basename via
// gitRepoName() and never sent it. Manager got id:"ComfyUI-SolAttn_triton",
// channel:"dev", mode:"cache" — which is exactly the pair the error names.
//
// WHY IT WAS WRITTEN THAT WAY, and why that reasoning does not extend here: a
// full URL sent as `id` made Manager v4 silently mark the install "done" while
// doing nothing, and made 3.x fail late. So the panel derives a name instead.
// That is right for `id`. It is wrong when the caller supplied `repository`,
// because then the URL IS the request and no registry entry exists to find.
//
// THE CONTRACT (not a guess — this is why the fix waited). Generated from the
// Manager v4 API in Comfy-Org/ComfyUI_frontend,
// src/workbench/extensions/manager/types/generatedManagerTypes.ts:
//
//   InstallPackParams: ManagerPackInfo & {
//     selected_version: string | 'latest' | 'nightly'
//     /** GitHub repository URL (required if selected_version is nightly) */
//     repository?: string
//     mode: ManagerDatabaseSource
//     channel: ManagerChannel
//     ...
//   }
//   ManagerPackInfo: {
//     /** Either github-author/github-repo or name of pack from the registry */
//     id: string
//     version: string
//   }
//
// The consequence this fixes: `repository` is REQUIRED for a nightly install and
// was being dropped. `id` is left alone — see the note in the source.
//
// `params` is an UNTAGGED Pydantic union with InstallPackParams first, so a
// guessed field would be dropped SILENTLY and the wrong model could win — that
// is #809. Adding `repository` makes this payload match InstallPackParams more
// specifically, which is the safe direction across that union.
import test from "node:test";
import assert from "node:assert/strict";

import { buildInstallRequest } from "../../web/js/lib/manager-install.js";

const URL_GIT = "https://github.com/kijai/ComfyUI-SolAttn_triton.git";

// ---------------------------------------------------------------------------
// 1. The report, end to end.
// ---------------------------------------------------------------------------

test("#920 a repository-only nightly install SENDS the url", () => {
  const req = buildInstallRequest("v2", { repository: URL_GIT, version: "nightly" });

  assert.equal(req.dialect, "v2");
  assert.equal(req.params.repository, URL_GIT, "the URL must reach Manager — this is the fix");
  assert.equal(req.params.selected_version, "nightly");
  // `id` is UNCHANGED — still the repo name. Sending owner/repo instead looked
  // right from ManagerPackInfo's description and broke #301's assertion that a
  // bare shorthand must never be sent as `id`, which exists because of a real
  // failure. The dropped URL is the proven bug; the id form is not, and is filed
  // separately rather than bundled in here.
  assert.equal(req.params.id, "ComfyUI-SolAttn_triton");
});

test("#920 the url is sent whether it arrives as `repository` or as `id`", () => {
  // The tool documents both spellings, and the reporter's workaround was to move
  // the URL into `id`. Both must now produce a source install.
  for (const args of [{ repository: URL_GIT }, { id: URL_GIT }]) {
    const req = buildInstallRequest("v2", { ...args, version: "nightly" });
    assert.equal(req.params.repository, URL_GIT, JSON.stringify(args));
    assert.equal(req.params.id, "ComfyUI-SolAttn_triton", JSON.stringify(args));
  }
});

// ---------------------------------------------------------------------------
// 2. The registry path must be untouched.
// ---------------------------------------------------------------------------

test("#920 a plain registry id still installs from the registry, with no repository", () => {
  const req = buildInstallRequest("v2", { id: "comfyui-impact-pack", version: "1.2.3" });

  assert.equal(req.params.id, "comfyui-impact-pack");
  assert.equal(req.params.repository, undefined, "a registry install must not claim a repository");
  assert.equal(req.params.mode, "remote");
  assert.equal(req.params.channel, "default");
});

test("#920 the non-v2 dialects are unchanged — they install the URL natively", () => {
  // v2-batch and legacy put the URL in `files`, which already worked. This fix
  // must not disturb them.
  for (const dialect of ["v2-batch", "legacy"]) {
    const req = buildInstallRequest(dialect, { repository: URL_GIT }, "ui-1");
    assert.deepEqual(req.body.files, [URL_GIT], dialect);
    assert.equal(req.body.id, "ComfyUI-SolAttn_triton", `${dialect} keeps the repo name`);
  }
});

// The owner/repo derivation that used to live here went with the helper: `id` is
// unchanged by this fix, so a helper only its own tests exercised would be dead
// code inviting someone to wire it without the empirical check that is missing.
// Filed separately.
