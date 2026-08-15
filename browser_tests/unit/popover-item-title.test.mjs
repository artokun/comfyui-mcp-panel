// The provider/model popover row must expose its truncated secondary line on hover.
//
// `item({label, small})` renders `small` into a <small> whose CSS is
// `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`, and the row deliberately
// truncates THAT line rather than the provider name. For a not-ready provider the same line
// carries the recovery instruction, and the actionable part is terminal in every one of them
// ("… — run: ollama serve", "… or run `pi` once and /login"), so the ellipsis removes exactly
// the part the user needs. Without a title there is no way to read it at all.
//
// This asserts on the SOURCE because `item` is a closure nested inside buildPanel, which
// cannot be constructed without ComfyUI's `app`. That makes the test only as good as its
// anchor, so it is written to fail if the line is deleted — verified by deleting it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = fs.readFileSync(path.join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");

/** The body of the popover `item` factory, bounded by its own arrow-function block. */
function itemBody() {
  const start = SRC.indexOf("const item = ({ label, small, cls }");
  assert.notEqual(start, -1, "the popover item factory was renamed — update this test's anchor");
  let depth = 0;
  let i = SRC.indexOf("{", SRC.indexOf("=>", start));
  const from = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return SRC.slice(from, i + 1);
}

test("a popover row's secondary line is readable on hover after it truncates", () => {
  const body = itemBody();
  // Scoped to the `if (small)` branch so a title set on some other element cannot satisfy it.
  const branch = body.slice(body.indexOf("if (small)"));
  assert.match(
    branch,
    /s\.title\s*=\s*small/,
    "item() renders `small` into an ellipsis-truncated <small> with no title — the recovery " +
      "instruction it carries for a not-ready provider becomes unreadable",
  );
});

test("the truncation this depends on is still in force", () => {
  // If the row ever stops truncating, the title becomes redundant rather than load-bearing,
  // and this test should be revisited rather than silently kept.
  assert.match(SRC, /text-overflow: ellipsis/, "expected the popover row CSS to still truncate");
});
