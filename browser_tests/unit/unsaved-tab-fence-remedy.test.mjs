/**
 * #1019 — `panel_new_workflow` created the tab, the session stayed fenced to the previous
 * workflow, and the reporter recorded the part that makes it a dead end:
 *
 *   "Since the new workflow is unsaved, panel_open_workflow cannot recover it."
 *
 * The reported version (0.11.43) is behind the two halves that answer the rest, and both
 * were verified on 0.12.0 while working this issue:
 *
 *   - the reply publishes `workflow_uuid` and `routing_key` for the tab it created (#755),
 *     so a caller has something to re-fence to;
 *   - the created tab's canvas carries a fresh panel identity. MEASURED live on ComfyUI
 *     0.31.1 / frontend 1.48.7 by running `Comfy.NewBlankWorkflow` — the same command the
 *     handler runs — and reading the root before and after:
 *
 *       before   krea2_identity_edit   tag e66e531b   24 nodes   provenEmpty false
 *       after    Unsaved Workflow      tag 2d7fa288    0 nodes   provenEmpty true
 *
 *     A changed tag on a proven-empty canvas is the creation stamp, so the graph fence has
 *     a consistent identity to compare against rather than the previous tab's.
 *
 * What remained, and is what this ships: the refusal's own remedy names
 * `panel_open_workflow`, which resolves a workflow BY PATH — so it cannot re-select an
 * unsaved ACTIVE tab, exactly the canvas a `panel_new_workflow` just made. The claim is
 * kept that narrow (codex): a mismatch means the command's intended workflow is not the
 * active one, and if that intended workflow is a SAVED one, open remains the right
 * recovery. What is ruled out is re-selecting THIS tab, nothing more.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/**
 * Extract a named function's source.
 *
 * The BODY's brace, not the first one: both functions here take a DESTRUCTURED parameter,
 * so a scanner that starts at `indexOf("{")` closes on the parameter pattern and returns
 * a signature with no body. That produced a `SyntaxError: Unexpected token ';'` from
 * `new Function`, which reads like a bug in the source under test rather than in the
 * harness reading it.
 */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const bodyOpen = src.indexOf(") {", start);
  if (bodyOpen === -1) return null;
  let depth = 0;
  for (let i = bodyOpen + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** The shipped message builder, run directly. */
const build = (() => {
  const src = readFileSync(PANEL_JS, "utf8");
  const fn = namedFunctionSource(src, "workflowInstanceMismatchMessage");
  assert.ok(fn, "workflowInstanceMismatchMessage not found");
  return new Function(`${fn}; return workflowInstanceMismatchMessage;`)();
})();

const ARGS = { commandUuid: "11111111-2222-4333-8444-555555555555", activeUuid: "99999999-8888-4777-8666-555555555555" };

test("#1019 an UNSAVED active tab is told open cannot re-select THAT tab", () => {
  const msg = build({ ...ARGS, activeIsUnsaved: true });
  assert.match(msg, /the ACTIVE tab is unsaved, so panel_open_workflow cannot re-select THAT one/);
  assert.match(msg, /resolves a workflow by path and this tab has none/, "and why");
  assert.match(msg, /If the canvas you want is this active tab, re-target instead/, "what to do instead");
  assert.match(msg, /panel_list_workflows is exempt from this fence/, "and the fence-exempt probe");
});

test("#1019 (codex) it does NOT tell a caller that open is useless", () => {
  // A mismatch means the command's intended workflow is not the active one, and that
  // intended workflow may be a SAVED one — for which panel_open_workflow is exactly the
  // right recovery. The unsaved state rules out re-selecting THIS tab, nothing more.
  const msg = build({ ...ARGS, activeIsUnsaved: true });
  assert.match(msg, /opening a different, saved workflow still works normally/);
  assert.doesNotMatch(msg, /Re-targeting is the route here/, "an overclaim that contradicts the remedy above it");
  assert.match(msg, /re-select the intended workflow with panel_open_workflow/, "the original remedy still stands");
});

test("#1019 a SAVED active tab keeps the existing advice, unchanged", () => {
  const msg = build({ ...ARGS, activeIsUnsaved: false });
  assert.doesNotMatch(msg, /ACTIVE tab is unsaved/, "no clause about a tab that can be opened");
  assert.match(msg, /re-select the intended workflow with panel_open_workflow, then retry\./);
});

test("#1019 an UNREADABLE tab says nothing about it — an unproven fact adds nothing to a refusal", () => {
  for (const unknown of [null, undefined]) {
    const msg = build({ ...ARGS, activeIsUnsaved: unknown });
    assert.doesNotMatch(msg, /ACTIVE tab is unsaved/, `activeIsUnsaved=${String(unknown)}`);
  }
  // The default is the same silence.
  assert.doesNotMatch(build(ARGS), /ACTIVE tab is unsaved/);
  // And a non-boolean is not truthy evidence.
  for (const junk of ["yes", 1, {}])
    assert.doesNotMatch(build({ ...ARGS, activeIsUnsaved: junk }), /ACTIVE tab is unsaved/);
});

test("#1019 everything the refusal already said is still said", () => {
  const msg = build({ ...ARGS, activeIsUnsaved: true });
  assert.match(msg, /^workflow instance mismatch: /, "the token readers recognise it by");
  assert.match(msg, /this command was issued for workflow instance 11111111/, "what was compared");
  assert.match(msg, /the active canvas reports 99999999/);
  assert.match(msg, /That is the comparison, not the cause/, "#750's refusal to infer a cause");
  assert.match(msg, /Re-target with panel_set_workflow_target\(\{mode:"current"\}\)/);
  assert.match(msg, /If NO panel tab is connected/, "the connectivity case still lands at the end");
});

test("#1019 an UNSTAMPED command still reports that, whatever the tab", () => {
  const msg = build({ activeUuid: ARGS.activeUuid, activeIsUnsaved: true });
  assert.match(msg, /this command carries no workflow-instance stamp/);
  assert.match(msg, /the ACTIVE tab is unsaved/, "and the unsaved note is independent of that");
});

test("#1019 source guard: the fact is READ, not assumed, and an unreadable read stays null", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const fn = namedFunctionSource(src, "assertActiveWorkflowCommandTarget");
  assert.match(fn, /let activeIsUnsaved = null;/, "unknown by default");
  assert.match(fn, /if \(active\) activeIsUnsaved = !savedWorkflowPath\(active\);/, "positively read");
  assert.match(fn, /} catch \{\r?\n\s*activeIsUnsaved = null;/, "an unreadable tab proves nothing");
  assert.match(fn, /workflowInstanceMismatchMessage\(\{ commandUuid, activeUuid, activeIsUnsaved \}\)/);
});
