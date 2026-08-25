import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #851 — the reboot reply named the ROUTE and never the HOST.
//
// When the panel drives a ComfyUI that is NOT the orchestrator's headless
// COMFYUI_URL, a confirmation timeout sends the user to `restart_comfyui`, which
// targets the OTHER machine and answers "No ComfyUI process found on port 8188"
// — while the panel had been operating on the live one all along. Nothing in any
// reply revealed the two were different, so nobody could notice before acting on
// advice aimed at the wrong server.
//
// The panel is the one component that knows this for certain: it runs inside the
// ComfyUI it reboots. These pin that it says so, on EVERY branch, and that the
// value it says it with is the same one the orchestrator was told to target.

const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

const reboot = (() => {
  const at = PANEL.indexOf("  async comfy_reboot({ force } = {}) {");
  assert.ok(at > 0, "comfy_reboot must exist");
  return PANEL.slice(at, PANEL.indexOf("  async free_vram()", at));
})();

test("the target comes from the SAME value handed to the orchestrator in hello", () => {
  // If this used its own notion of the ComfyUI URL, the identity a caller
  // compares against its own target could drift from the one it was told to
  // target — which is the entire failure being fixed.
  const fn = PANEL.slice(
    PANEL.indexOf("function rebootTargetFields() {"),
    PANEL.indexOf("const GRAPH_TOOL_EXECUTORS = {"),
  );
  assert.ok(fn.length > 0, "the helper must precede the executors table");
  assert.ok(fn.includes("comfyuiUrlForAgent()"), "it must reuse the hello identity");
});

test("an unknown target is OMITTED, never guessed", () => {
  // `comfyuiUrlForAgent()` returns "" when it cannot read the location. Emitting
  // `target: ""` would be worse than saying nothing: a caller comparing hosts
  // would read it as a real, different one.
  const fn = PANEL.slice(
    PANEL.indexOf("function rebootTargetFields() {"),
    PANEL.indexOf("const GRAPH_TOOL_EXECUTORS = {"),
  );
  assert.ok(fn.includes("target ? { target } : {}"), "an empty target must be omitted");
});

test("it is a plain function, not a method on the executors table", () => {
  // Dispatch calls `executor(msg)` with no receiver, so `this` is undefined in a
  // module — a method call would throw a TypeError instead of rebooting, turning
  // a reply-shape improvement into a broken reboot.
  assert.ok(PANEL.includes("function rebootTargetFields() {"), "must be a standalone function");
  assert.ok(!reboot.includes("this.rebootTargetFields"), "must not be called as a method");
  assert.ok(PANEL.includes("result = await executor(msg);"), "dispatch really is receiver-less");
});

// ── every branch, including the ones that failed ───────────────────────────

test("all six reply branches name the target", () => {
  // The failures matter most: "which server refused?" is the whole question when
  // the panel and the headless tool disagree about what they are pointing at.
  const spread = (reboot.match(/\.\.\.rebootTargetFields\(\)/g) || []).length;
  assert.equal(spread, 6, `expected 6 branches to carry the target, found ${spread}`);
});

test("the successful reboot says which server is going down", () => {
  assert.ok(
    reboot.includes("return { rebooting: true, endpoint: route, method, ...rebootTargetFields() };"),
    "the ok branch must carry it",
  );
});

test("the Manager 403 refusal says which server refused", () => {
  const at = reboot.indexOf("ComfyUI-Manager refused the reboot (HTTP 403)");
  assert.ok(at > 0);
  const branch = reboot.slice(reboot.lastIndexOf("return {", at), at);
  assert.ok(branch.includes("rebootTargetFields()"), "a refusal must name the server that refused");
});

test("the exhausted-endpoints failure says which server could not be reached", () => {
  const at = reboot.indexOf("Could not reach any ComfyUI-Manager reboot endpoint");
  assert.ok(at > 0);
  const branch = reboot.slice(reboot.lastIndexOf("return {", at), at);
  assert.ok(branch.includes("rebootTargetFields()"));
});

test("the busy refusal names the server it declined to restart", () => {
  const at = reboot.indexOf("blocked_busy: true");
  assert.ok(at > 0);
  const branch = reboot.slice(at, at + 200);
  assert.ok(branch.includes("rebootTargetFields()"));
});

// ── it has to be safe where it is called ───────────────────────────────────

test("resolving the target cannot throw — one branch runs inside a catch", () => {
  // The dropped-connection branch is a `catch`. If reading the identity could
  // throw there, a reboot that FIRED would be reported as a failure — the exact
  // inversion those branches exist to prevent. The whole chain swallows:
  // getSetting catches, remoteUrlSetting type-guards, comfyuiUrlForAgent catches.
  const url = PANEL.slice(
    PANEL.indexOf("function comfyuiUrlForAgent() {"),
    PANEL.indexOf("// #296/#291 — Local ComfyUI workspace path"),
  );
  assert.ok(url.includes("} catch {"), "the origin read must be guarded");
  assert.ok(url.includes('return "";'), "…and fall back to an empty string");
  const setting = PANEL.slice(
    PANEL.indexOf("function remoteUrlSetting() {"),
    PANEL.indexOf("function externalOrchestratorMode() {"),
  );
  assert.ok(setting.includes('typeof v === "string" ? v.trim() : ""'), "a non-string setting must not blow up");
  const get = PANEL.slice(PANEL.indexOf("\nfunction getSetting(id) {"), PANEL.indexOf("function chatScopeMode(backend) {"));
  assert.ok(get.includes("} catch {"), "the settings read must be guarded");
});

test("a remote-URL override IS the target — not window.location.origin", () => {
  // This is the reported case: the panel driving a ComfyUI that is not the one
  // the headless tool targets. If the reply named the browser's own origin while
  // the panel was actually operating on the override, the field would be a
  // confident wrong answer — worse than the missing one it replaces.
  const url = PANEL.slice(
    PANEL.indexOf("function comfyuiUrlForAgent() {"),
    PANEL.indexOf("// #296/#291 — Local ComfyUI workspace path"),
  );
  const overrideAt = url.indexOf("if (override) return override;");
  const originAt = url.indexOf("window.location.origin");
  assert.ok(overrideAt > 0 && originAt > 0, "both sources must be present");
  assert.ok(overrideAt < originAt, "the override must win over the page origin");
});

// ── the prose a human actually reads ───────────────────────────────────────

test("the failure messages name the server, not only the structured field", () => {
  // `target` is for a caller comparing hosts. These strings are what gets shown,
  // and "could not reach any reboot endpoint" that cannot say WHICH server it
  // failed to reach is the reported failure in miniature.
  assert.ok(
    reboot.includes('rebootTargetLabel("Could not reach any ComfyUI-Manager reboot endpoint")'),
    "the unreachable-endpoints error must name the server",
  );
  assert.ok(
    reboot.includes('rebootTargetLabel("ComfyUI-Manager refused the reboot (HTTP 403)")'),
    "the 403 refusal must name the server that refused",
  );
});

test("the label appends nothing when the target is unknown", () => {
  // Same rule as the field: a blank host is worse than no host, because it reads
  // as a real one. `prefix` must come back untouched.
  const fn = PANEL.slice(
    PANEL.indexOf("function rebootTargetLabel(prefix) {"),
    PANEL.indexOf("function rebootTargetFields() {"),
  );
  assert.ok(fn.length > 0, "the label helper must exist");
  assert.ok(fn.includes("comfyuiUrlForAgent()"), "it must reuse the hello identity too");
  assert.ok(fn.includes("target ? prefix"), "an unknown target must yield the bare prefix");
  assert.ok(fn.includes(": prefix;"), "…and nothing appended to it");
});

test("naming the server did not swallow the rest of either message", () => {
  // Both messages carry their remedy — lower the Manager security level; check
  // the Manager is enabled — and a refusal that lost its recovery is worse than
  // one that never named the host.
  assert.ok(reboot.includes("security level to be 'middle' or below"), "the 403 remedy survives");
  assert.ok(reboot.includes("(is the built-in Manager enabled?). Tried: "), "the retry list survives");
  assert.ok(reboot.includes("ComfyUI was NOT restarted"), "both must still say nothing happened");
});

test("the proxy-5xx and dropped-connection branches keep reporting a FIRED reboot", () => {
  // Both are successes (the origin is going down). Adding the target must not
  // have disturbed `rebooting: true` — reporting a fired reboot as a failure is
  // the defect those branches exist to prevent.
  const proxy = reboot.slice(reboot.indexOf("proxy returned") - 260, reboot.indexOf("proxy returned"));
  assert.ok(proxy.includes("rebooting: true") && proxy.includes("rebootTargetFields()"));
  const dropped = reboot.slice(reboot.indexOf("connection dropped") - 260, reboot.indexOf("connection dropped"));
  assert.ok(dropped.includes("rebooting: true") && dropped.includes("rebootTargetFields()"));
});
