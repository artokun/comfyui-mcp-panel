// panel#920 — the SECOND attempt at this issue, after the first one shipped and
// did nothing.
//
// The reporter passed a GitHub URL and got:
//
//   Node 'ComfyUI-SolAttn_triton@nightly' not found in
//   [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// which names a pack id they never supplied and reads like a registry lookup bug.
// Two rounds of work then went into reshaping the install payload — first by the
// other session (shipped as 0.11.75), then by me (PR #927) — both sending
// `repository`, both justified by ComfyUI-Manager's own generated schema:
//
//   InstallPackParams.repository: "GitHub repository URL (required if
//                                  selected_version is nightly)"
//
// BOTH WERE INERT. Read from Manager's SOURCE rather than its schema:
//
//   async def do_install(params: InstallPackParams):
//       node_id = params.id; node_version = params.selected_version
//       channel = params.channel; mode = params.mode
//       skip_post_install = params.skip_post_install
//
//   params.repository read 0 times — tags 4.2.2, 4.1, branch draft-v4
//
// `install_by_id(node_name, version_spec, channel, mode, …)` takes no repository
// argument, and the nightly path resolves the clone URL from Manager's own
// database. A generated OpenAPI model is the contract of what a server ACCEPTS,
// never of what it DOES — and with Pydantic's default extra='ignore', a
// declared-but-unread field is invisible from the client.
//
// So there is nothing to send. On a stock v4 an unlisted git URL is simply not
// installable: the legacy /manager/queue/install route does support it
// (@unknown + files:[url]), but comfyui_manager/__init__.py registers the legacy
// server only under --enable-manager-legacy-ui.
//
// The remaining panel-side fix is therefore an HONEST ERROR, which is what this
// pins. It cannot make the install work; it stops the failure from misdirecting.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isRegistryLookupMiss, unlistedGitUrlAdvice } from "../../web/js/lib/manager-install.js";

const MISS =
  "Node 'ComfyUI-SolAttn_triton@nightly' not found in [ManagerChannel.dev, ManagerDatabaseSource.cache]";

// ---------------------------------------------------------------------------
// 1. Recognising the miss — narrow on purpose.
// ---------------------------------------------------------------------------

test("#920 the reporter's exact failure is recognised", () => {
  assert.equal(isRegistryLookupMiss(MISS), true);
});

test("#920 recognition does not depend on the enum spellings", () => {
  // channel/mode vary per request, so matching them would make this fire for one
  // configuration and silently stop for another.
  assert.equal(
    isRegistryLookupMiss("Node 'x@1.0' not found in [ManagerChannel.default, ManagerDatabaseSource.remote]"),
    true,
  );
});

test("#920 an unrelated failure is left completely alone", () => {
  for (const other of [
    "pip install failed: No matching distribution found for torch==9.9",
    "git clone failed: repository not found",
    "the Manager reported the task as failed (no detail provided)",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isRegistryLookupMiss(other), false, String(other));
    assert.equal(unlistedGitUrlAdvice(other), "", `advice must stay empty for: ${String(other)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. What the advice says — and, as importantly, what it does not claim.
// ---------------------------------------------------------------------------

test("#920 the advice names the real blocker and the routes that work", () => {
  const a = unlistedGitUrlAdvice(MISS);

  assert.match(a, /NODE REGISTRY lookup/, "names what the lookup actually was");
  assert.match(a, /accepted and then IGNORED/, "says the repository field does nothing");
  assert.match(a, /--enable-manager-legacy-ui/, "the route that does install from a URL");
  assert.match(a, /custom_nodes\//, "the manual clone");
  assert.match(a, /publish it to the registry/, "the durable fix");
});

test("#920 the advice does NOT assert which mistake the caller made", () => {
  // The surface that shows this failure (panel_node_queue_status) does not carry
  // the original request, so claiming "you passed a URL" would be asserting an
  // unobserved fact — the exact defect that produced two wrong fixes here.
  const a = unlistedGitUrlAdvice(MISS);
  assert.match(a, /IF YOU PASSED A GIT URL/, "conditional, not an assertion");
  assert.match(a, /IF YOU MEANT A REGISTRY PACK/, "the other reader is served too");
});

test("#920 the advice never promises the install can be made to work from here", () => {
  const a = unlistedGitUrlAdvice(MISS);
  assert.match(a, /no argument to this tool will make it clone your URL/i);
  // The claim that shipped in 0.11.75 and was false.
  assert.doesNotMatch(a, /now clones|actually clones|is now installed/i);
});

// ---------------------------------------------------------------------------
// 3. WIRING — the advice is worth nothing if the surface never appends it.
// ---------------------------------------------------------------------------

test("#920 WIRING: the queue-status failure note appends the advice", () => {
  // This is the surface the reporter actually polled ("Poll
  // panel_node_queue_status. Observe the task failure below"), so it is the one
  // that has to carry the explanation.
  const panel = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");
  assert.ok(
    /unlistedGitUrlAdvice\(recentFailures\.map\(/.test(panel),
    "the queue-status note must append unlistedGitUrlAdvice over the recent failures",
  );
  assert.ok(/^\s*unlistedGitUrlAdvice,\s*$/m.test(panel), "and it must be imported");
});
