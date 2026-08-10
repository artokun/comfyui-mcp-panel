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

import {
  collectRecentTaskFailures,
  isRegistryLookupMiss,
  unlistedGitUrlAdvice,
} from "../../web/js/lib/manager-install.js";

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
    // The reason the pattern requires Manager's literal `Node '<id>@<ver>'` prefix
    // rather than just "not found in [...]": a custom node's own post-install code
    // can raise this shape, and it lands in status.messages the same way. Without
    // the prefix, a pack whose installer throws a plain ValueError would be told
    // its GIT URL is the problem.
    "ValueError: 'chroma' not found in ['red', 'green', 'blue']",
    "KeyError: 'sampler' not found in [euler, dpmpp_2m]",
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
  assert.match(a, /custom_nodes\//, "the manual clone");
  assert.match(a, /publish to the registry/, "the durable fix");
});

test("#920 the advice names the tool that CAN clone, and says the usual preference is off", () => {
  // The workaround, found after the honest error shipped: install_custom_node
  // runs on the MACHINE, and its install path clones directly when the Manager
  // accepts a task but the pack never appears installed — exactly this case
  // (node-management.ts, cloneCustomNodeFallback). panel_install_node's own
  // description says "Prefer this over the headless install_custom_node tool",
  // which is precisely backwards here, so the advice has to say so explicitly or
  // a reader follows the description and stays stuck.
  const a = unlistedGitUrlAdvice(MISS);
  // The RECOMMENDATION, not just the name: the tool is mentioned twice (once to
  // cancel the standing preference), so /install_custom_node/ alone passed even
  // when the recommendation itself was deleted. Caught by mutation.
  assert.match(a, /USE install_custom_node INSTEAD/, "recommends it, not merely mentions it");
  assert.match(a, /clones the repository into custom_nodes/, "and why it can");
  assert.match(a, /does NOT hold/, "cancels the standing preference for this case");
  // A remote target genuinely cannot: there is no local tree to clone into, and
  // the orchestrator keeps the Manager's error for that reason. Saying so stops
  // this reading as a promise that always works.
  assert.match(a, /REMOTE target has no local tree/, "the case where it does not apply");
});

test("#920 the legacy-route advice names BOTH steps, or it sends people to a 404", () => {
  // The first cut said "start ComfyUI with --enable-manager-legacy-ui" and stopped.
  // That is not sufficient for the only case this advice is shown for: an UNLISTED
  // pack is rated "high+" by get_risky_level, and the legacy route then requires
  // config allow_git_url_install (default FALSE) or it answers
  // 404 "A security error has occurred". Following the advice as written would have
  // been the THIRD wrong instruction on this issue.
  const a = unlistedGitUrlAdvice(MISS);
  assert.match(a, /--enable-manager-legacy-ui/, "step one");
  assert.match(a, /allow_git_url_install\s*=\s*true/, "step two — without it the route 404s");
  assert.match(a, /answers 404/, "and says what failure to expect if the second step is skipped");
  // It also REPLACES the v2 API rather than adding to it, which the wording must not hide.
  assert.match(a, /REPLACES/, "the mutex, not additive");
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

test("#920 WIRING: a real Manager history reaches the advice END TO END", () => {
  // THE ASSERTION THE FIRST CUT OF THIS FILE WAS MISSING. It matched
  // /unlistedGitUrlAdvice\(recentFailures\.map\(/ and stopped BEFORE the field
  // name — so it passed against `f?.reason` (always undefined, advice always ""),
  // against `f?.result` (correct), and against a garbage field. The suite was
  // green with the defect in place. That is the third inert fix on this issue and
  // the second caused by a wiring assertion that could not fail.
  //
  // This drives the real chain instead: Manager history -> collectRecentTaskFailures
  // -> the exact join the handler performs -> the advice.
  const history = {
    history: [
      {
        ui_id: "ui-1",
        kind: "install",
        params: { id: "ComfyUI-SolAttn_triton" },
        status: { status_str: "error", messages: [MISS] },
      },
    ],
  };
  const failures = collectRecentTaskFailures(history);
  assert.equal(failures.length, 1, "the failure must be collected at all");

  // The handler's own expression. If the field name drifts, this dies.
  const joined = failures.map((f) => f?.result ?? "").join(" ");
  assert.ok(joined.includes("not found in"), `the joined text lost the reason: ${JSON.stringify(joined)}`);
  assert.notEqual(unlistedGitUrlAdvice(joined), "", "the advice must actually be produced");
});

test("#920 WIRING: the handler joins on the field collectRecentTaskFailures emits", () => {
  // Pins the field name specifically, since that is what broke. `reason` is the
  // plausible-sounding wrong one — it is what I wrote.
  const panel = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");
  assert.ok(
    /unlistedGitUrlAdvice\(recentFailures\.map\(\(f\) => f\?\.result \?\? ""\)\.join\(" "\)\)/.test(panel),
    "the queue-status note must join on `result` — `reason` is always undefined here",
  );
  assert.ok(/^\s*unlistedGitUrlAdvice,\s*$/m.test(panel), "and it must be imported");
});
