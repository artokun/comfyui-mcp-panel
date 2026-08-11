/**
 * #1066 — a URL-shaped workflow DIRECTORY made a tab unsaveable under any name.
 *
 * ComfyUI mints a temporary workflow whose `path` is the URL an asset was opened from:
 *
 *     workflows/http://127.0.0.1:8188/api/view?filename=x.png&type=output&subfolder=…
 *
 * Renaming that tab replaces only the FILENAME, so the URL survives as the tab's DIRECTORY.
 * `isExternalWorkflowPath()` redirected a Save-As to the workflows root for a drive letter
 * (`^[a-zA-Z]:`) or a leading separator — and a URL is neither: its colon sits at index 4 and
 * it has no leading slash. So the directory was accepted verbatim, the save built
 * `workflows/http://127.0.0.1:8188/api/Name.json`, and /userdata rejected it with a 500.
 *
 * These exercise the classifier through the module's own source, since it is file-private.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../web/js/lib/workflow-save.js", import.meta.url), "utf8");

/** The classifier, rebuilt from the shipped source so a drift in either is caught. */
const isExternal = (() => {
  const start = SRC.indexOf("function isExternalWorkflowPath(");
  assert.ok(start > 0, "isExternalWorkflowPath not found");
  const open = SRC.indexOf(") {", start) + 2;
  let depth = 0;
  let end = -1;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === "{") depth += 1;
    if (SRC[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  return new Function(`${SRC.slice(start, end)}; return isExternalWorkflowPath;`)();
})();

test("#1066 THE REPORTED SHAPE: a URL directory is external", () => {
  assert.equal(isExternal("http://127.0.0.1:8188/api/view?filename=x.png&type=output"), true);
  assert.equal(isExternal("https://example.com/things"), true);
  // A scheme, not the literal "http", so file: and any custom scheme are covered too.
  for (const url of ["file:///C:/tmp/x.json", "ftp://host/dir", "x-custom+scheme.v2://host/path"]) {
    assert.equal(isExternal(url), true, url);
  }
  // DELIBERATELY NOT COVERED: opaque schemes with no "//" — `blob:http://…`, `data:…`.
  // Catching those means accepting a bare `scheme:`, which would also classify an ordinary
  // folder named "notes:draft" as external and silently redirect its saves. ComfyUI mints
  // these tabs from an asset URL, which is hierarchical, so the reported shape is covered;
  // an opaque-scheme directory is unobserved and left failing the way it does today rather
  // than traded for a false positive on a real folder name.
  assert.equal(isExternal("blob:http://127.0.0.1:8188/abc"), false);
  assert.equal(isExternal("data:application/json,{}"), false);
});

test("#1066 the everyday managed path is untouched — that is the regression to avoid", () => {
  // A managed store path is relative "workflows/…": no drive letter, no leading separator,
  // no scheme. Redirecting one of these would break every ordinary Save-As.
  for (const p of ["workflows", "workflows/sub", "workflows/deep/nested", "my folder", ""]) {
    assert.equal(isExternal(p), false, JSON.stringify(p));
  }
});

test("#1066 the two shapes this already caught still classify as external", () => {
  for (const p of ["C:/packs/Foo.json", "C:Foo.json", "/packs/Foo.json", "\\packs\\Foo.json", "//server/share"]) {
    assert.equal(isExternal(p), true, p);
  }
});

test("#1066 a bare colon is NOT a scheme — the '//' is what makes it a URL", () => {
  // Without requiring "//", a Windows drive letter would match the new test as well as the
  // old one (harmless), but so would an ordinary name containing a colon — and a folder
  // called "notes:draft" is a managed directory, not somewhere unwritable.
  assert.equal(isExternal("notes:draft"), false);
  assert.equal(isExternal("workflows/a:b"), false);
  // ...while a real scheme still resolves as external.
  assert.equal(isExternal("x-custom+scheme.v2://host/path"), true);
});

test("#1066 the directory redirect is what consumes this, and it sends the copy to the root", () => {
  // directoryOf() is the caller: an external directory becomes `${WORKFLOWS_ROOT}/`, so the
  // Save-As copy lands somewhere writable instead of building an unwritable target path.
  assert.match(SRC, /if \(!dir \|\| isExternalWorkflowPath\(dir\)\) return `\$\{WORKFLOWS_ROOT\}\/`;/);
});

test("#1066 the comment records the shape and why both old tests missed it", () => {
  const at = SRC.indexOf("function isExternalWorkflowPath(");
  const body = SRC.slice(at - 1400, at + 1400);
  assert.match(body, /#1066/);
  assert.match(body, /colon sits at index 4/, "why the drive-letter test does not fire");
  assert.match(body, /renaming that tab replaces\s*\r?\n?\s*\/\/ only the FILENAME/i, "how the URL survives as a directory");
});
