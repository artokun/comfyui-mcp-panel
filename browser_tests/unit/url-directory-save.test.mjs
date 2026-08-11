/**
 * #1066 — a URL-derived workflow directory made a tab unsaveable under any name.
 *
 * ComfyUI mints a TEMPORARY workflow whose path is the URL an asset was opened from:
 *
 *     workflows/http://127.0.0.1:8188/api/view?filename=x.png&type=output&subfolder=…
 *
 * Renaming that tab replaces only the FILENAME, so the URL survives as the tab's DIRECTORY —
 * WITH the managed `workflows/` prefix still on the front. `directoryOf()` accepted it
 * verbatim, the save built `workflows/http://127.0.0.1:8188/api/Name.json`, and /userdata
 * rejected it with a 500.
 *
 * Every value below is the shape the code actually receives. An earlier version of this file
 * passed a BARE `http://…`, which let an anchored regex look correct while missing the bug:
 * the test agreed with the code and both disagreed with the report.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../web/js/lib/workflow-save.js", import.meta.url), "utf8");

/** Rebuild a file-private predicate from the shipped source, brace-balanced past the
 *  parameter list. */
function rebuild(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const open = SRC.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === "{") depth += 1;
    if (SRC[i] === "}" && --depth === 0) {
      return new Function(`${SRC.slice(start, i + 1)}; return ${name};`)();
    }
  }
  throw new Error(`${name} body not balanced`);
}

const isUrlDerived = rebuild("isUrlDerivedWorkflowPath");
const isExternal = rebuild("isExternalWorkflowPath");

/** The directory the reporter's tab actually carries — managed prefix retained. */
const REPORTED_DIR = "workflows/http://127.0.0.1:8188/api";
const REPORTED_PATH =
  "workflows/http://127.0.0.1:8188/api/view?filename=x.png&type=output&subfolder=anima%5Cpreset%5C10-framing-basic";

test("#1066 THE VERBATIM REPORTED VALUE is recognised", () => {
  // Not anchored: the `workflows/` prefix is still there. Anchoring is exactly how the first
  // attempt missed this while its own test passed.
  assert.equal(isUrlDerived(REPORTED_DIR), true);
  assert.equal(isUrlDerived(REPORTED_PATH), true);
  // A bare URL too, since a caller may have already stripped the prefix.
  assert.equal(isUrlDerived("http://127.0.0.1:8188/api"), true);
});

test("#1066 it is NOT folded into isExternalWorkflowPath — they mean different things", () => {
  // isExternalWorkflowPath gates the low-level root-COPY route, whose premise is that the
  // source is a REAL existing file: it records `save-as-copy` and refuses outright when the
  // copy API is missing, to avoid moving or destroying the original. A URL source is not a
  // file — there is nothing to copy and nothing to destroy — and classifying it as external
  // kept the tab unsaveable by a different route. The reporter's first successful save came
  // only from treating that source as never persisted (codex).
  assert.equal(isExternal(REPORTED_DIR), false, "a URL directory is not an external FILE");
  assert.equal(isExternal("http://127.0.0.1:8188/api"), false);
  // The shapes it does own are untouched.
  for (const p of ["C:/packs/Foo.json", "C:Foo.json", "/packs/Foo.json", "\\packs\\Foo.json"]) {
    assert.equal(isExternal(p), true, p);
  }
});

test("#1066 ordinary managed directories are untouched — the regression to avoid", () => {
  for (const p of ["workflows", "workflows/sub", "workflows/deep/nested", "my folder", ""]) {
    assert.equal(isUrlDerived(p), false, JSON.stringify(p));
  }
});

test("#1066 a bare colon is not a scheme — '//' is what makes it a URL", () => {
  // Without requiring "//", a folder legitimately named "notes:draft" would be redirected.
  assert.equal(isUrlDerived("notes:draft"), false);
  assert.equal(isUrlDerived("workflows/a:b"), false);
  assert.equal(isUrlDerived("C:/packs/Foo.json"), false, "a drive letter is not a scheme");
  // ...while any real hierarchical scheme is caught, not just http.
  for (const u of ["file:///C:/tmp/x.json", "ftp://host/dir", "x-custom+scheme.v2://host/p"]) {
    assert.equal(isUrlDerived(u), true, u);
  }
});

test("#1066 what stays unmatched is narrower than 'opaque schemes'", () => {
  // An earlier comment of mine claimed `blob:` was not matched. It IS — on its embedded
  // hierarchical URL (codex). Only a form carrying no "://" at all stays out.
  assert.equal(isUrlDerived("blob:http://127.0.0.1:8188/abc"), true, "matches on the embedded http://");
  assert.equal(isUrlDerived("data:application/json,{}"), false, "no :// anywhere");
});

test("#1066 THE KNOWN FALSE POSITIVE, tested as behaviour rather than as prose", () => {
  // A previous version of this test asserted that a comment existed, which proves nothing
  // about what the code does (codex). On POSIX a managed directory can syntactically contain
  // "://", and this predicate DOES match it — so such a tab's Save-As is redirected to the
  // workflows root. That is the accepted cost: a redirected save is recoverable and visible,
  // where the 500 it replaces left the tab unsaveable under any name.
  assert.equal(isUrlDerived("workflows/notes://draft"), true, "a legal POSIX folder name matches");
  assert.equal(isUrlDerived("workflows/a/b://c"), true);
  // It cannot arise on Windows, where ":" is illegal in a filename — so the exposure is
  // limited to POSIX deployments that use such a name deliberately.
  assert.equal(isUrlDerived("workflows/notes-draft"), false, "the ordinary spelling is unaffected");
});

test("#1066 the directory redirect consumes it and sends the save to the workflows root", () => {
  assert.match(
    SRC,
    /if \(!dir \|\| isExternalWorkflowPath\(dir\) \|\| isUrlDerivedWorkflowPath\(dir\)\) return `\$\{WORKFLOWS_ROOT\}\/`;/,
  );
});


/** Defect (2): the save was refused for every name because the source could not be
 *  classified. `groundingIsSafe` authorises only on a proven ABSENCE (a 404 from the
 *  /userdata oracle), and a URL path cannot produce one — the probe is not a valid store
 *  path, so the answer is `unknown` and the refusal is permanent. */
import { groundingIsSafe } from "../../web/js/lib/workflow-save.js";

test("#1066b a URL-derived tab is authorised WITHOUT consulting the oracle", async () => {
  // The proof: /userdata stores relative `workflows/…` paths, so nothing can exist at a path
  // carrying `://` — there is no original for grounding to overwrite, which is the whole
  // #226 hazard the refusal guards.
  let probed = false;
  const oracle = async () => {
    probed = true;
    return null; // what the real oracle returns for this path: unknown
  };
  const wf = { path: REPORTED_PATH, isTemporary: true, isPersisted: false };
  assert.equal(await groundingIsSafe(wf, oracle), true);
  assert.equal(probed, false, "no probe needed — absence is established by construction");
});

test("#1066b a PERSISTED workflow is still never auto-grounded, URL or not", async () => {
  // Placed after the isPersisted check on purpose: if the frontend says this is a real saved
  // workflow, that outranks the path shape and the save is not authorised here.
  const oracle = async () => false;
  assert.equal(
    await groundingIsSafe({ path: REPORTED_PATH, isPersisted: true }, oracle),
    false,
  );
});

test("#1066b ordinary paths still require a PROVEN absence", async () => {
  // The refusal this preserves: anything short of a 404 refuses, so an unknown or present
  // file is never blind-saved over.
  const wf = { path: "workflows/Real.json", isPersisted: false };
  assert.equal(await groundingIsSafe(wf, async () => false), true, "404 authorises");
  assert.equal(await groundingIsSafe(wf, async () => true), false, "present refuses");
  assert.equal(await groundingIsSafe(wf, async () => null), false, "unknown refuses");
  assert.equal(await groundingIsSafe(wf, undefined), false, "no oracle refuses");
});
