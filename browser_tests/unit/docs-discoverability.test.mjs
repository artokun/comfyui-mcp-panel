// #111 — the panel must point somewhere other than Discord.
//
// The community feature requests in #111 include items that had ALREADY SHIPPED and
// were already documented (the eval ladder at /docs/arena; compact tool mode; the
// panel/npx version-skew sync flow). Users asked for them because a panel user's
// entire discovery path was: an empty-state sentence, four prompt chips, a nine-item
// slash list, and a Discord invite. No surface in this file linked to the docs site
// at all — so "ask a human" was the only exit, and the community carried questions
// the docs already answered.
//
// This does not make the panel self-documenting and does not pretend to. It asserts
// only that the signpost exists and stays wired, in both places a stuck user looks:
// Settings → About, and /help.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");

test("#111 the docs URL is a single named constant, not a literal copied around", () => {
  const decl = SRC.match(/const DOCS_URL = "([^"]+)";/);
  assert.ok(decl, "DOCS_URL must be declared");
  // Verified reachable at the time of the change: /docs and /docs/arena both serve.
  assert.equal(decl[1], "https://comfyui-mcp.artokun.io/docs");
  // One declaration only — this file loads as an ES MODULE, where a second
  // top-level `const DOCS_URL` is a SyntaxError that takes down the entire panel
  // (and `node --check` in CJS mode does not catch it).
  assert.equal(SRC.match(/const DOCS_URL\b/g).length, 1, "exactly one top-level declaration");
  // Every use goes through the constant, so the link can never be half-updated.
  assert.doesNotMatch(
    SRC.replace(/const DOCS_URL = "[^"]+";/, ""),
    /"https:\/\/comfyui-mcp\.artokun\.io\/docs/,
    "no second hard-coded docs literal",
  );
});

test("#111 Settings → About has a docs row that opens the docs site", () => {
  const at = SRC.indexOf('id: "comfyui-mcp.readDocs"');
  assert.notEqual(at, -1, "the About section must have a docs row");
  const row = SRC.slice(at, at + 1200);
  assert.match(row, /category: cat\("About"/, "it belongs to About, beside Star/Discord/Need-help");
  // The tooltip names the DESTINATION, never the mechanism. This row renders into
  // ComfyUI's own Settings dialog, outside the sidebar root that wireExternalLinks
  // delegates on, so the anchor's native target=_blank is the whole mechanism —
  // and where it lands (a tab, the desktop build's system browser, or nowhere if a
  // popup blocker eats it) is neither chosen nor observed here.
  const tooltip = row.match(/tooltip:\s*\n?\s*"([^"]+)"/)[1];
  assert.match(tooltip, /comfyui-mcp\.artokun\.io\/docs/, "the tooltip says where the link goes");
  assert.doesNotMatch(tooltip, /new tab|opens\b/i, "no claim about how or whether it opens");
  assert.match(row, /a\.href = DOCS_URL/, "the anchor points at the docs constant");
  // Opening in-frame hijacks the whole window in the ComfyUI desktop app.
  assert.match(row, /a\.target = "_blank"/);
  assert.match(row, /a\.rel = "noopener noreferrer"/);

  // THE VISIBLE LABEL. Everything above this verifies the link exists and where it
  // points — none of it notices if the control renders BLANK. Deleting the
  // textContent line left every other assertion in this file green while shipping an
  // unlabeled link, which is functionally the same absence this whole change set out
  // to remove: a signpost nobody can read is not a signpost.
  const label = row.match(/a\.textContent = "([^"]*)"/);
  assert.ok(label, "the docs link must set a visible label");
  const text = label[1].trim();
  assert.notEqual(text, "", "an empty label renders a blank control");
  // Words, not just an emoji: a bare 📖 is unreadable to a screen reader and
  // ambiguous to everyone else.
  assert.match(text, /[A-Za-z]{2,}/, `the label needs words, not only an icon (got ${JSON.stringify(text)})`);
  // And it must name what it points at — "Click here" would pass every check above
  // while telling a lost user nothing, which is the exact failure mode of #111.
  assert.match(text, /docs|documentation/i, `the label must say it leads to the docs (got ${JSON.stringify(text)})`);
  // It must sort ABOVE the Discord row: asking a human was previously the only exit.
  const docsOrder = Number(row.match(/sortOrder: ([\d.]+)/)[1]);
  const discord = SRC.slice(SRC.indexOf('id: "comfyui-mcp.joinDiscord"'), SRC.indexOf('id: "comfyui-mcp.joinDiscord"') + 400);
  const discordOrder = Number(discord.match(/sortOrder: ([\d.]+)/)[1]);
  assert.ok(docsOrder > discordOrder, `docs (${docsOrder}) must render above Discord (${discordOrder})`);
});

test("#111 /docs is a LOCAL command — it opens externally, never in-frame", () => {
  const at = SRC.indexOf('cmd: "/docs"');
  assert.notEqual(at, -1, "a /docs slash command must exist");
  // Only THIS entry, and only its executable part: a `//` comment naming the
  // forbidden call (this one does) must not satisfy — or fail — the assertion.
  const entry = SRC.slice(at, SRC.indexOf('cmd: "', at + 10));
  const code = entry.replace(/\/\/[^\n]*/g, "");
  assert.match(code, /openExternalUrl\(DOCS_URL\)/, "must route through openExternalUrl");
  // window.location/window.open would navigate the ComfyUI app itself in the
  // desktop build — no back button, hard-reload to escape.
  assert.doesNotMatch(code, /window\.location|window\.open/, "must not navigate the app frame");
  // …and it must claim NOTHING about what happened. Neither destination reports
  // back — the desktop bridge hands off to the system browser, the web build opens
  // a popup — so an assertion that the docs "opened", or that they opened "in a new
  // tab", is a state never observed (and the tab wording is simply wrong on
  // desktop). What survives is the URL plus a conditional remedy.
  assert.match(code, /Docs: \$\{DOCS_URL\} — if nothing opened, copy that address\./);
  // ORDER MATTERS. The note is the remedy for the open having failed, so emitting it
  // after the attempt made it conditional on that attempt not throwing — backwards.
  // openExternalUrl is guarded and should not throw, but a remedy that relies on its
  // own failure path staying healthy is not a remedy.
  assert.ok(
    code.indexOf("appendSystem(") < code.indexOf("openExternalUrl("),
    "the URL must reach the transcript BEFORE the open is attempted",
  );
  assert.doesNotMatch(code, /appendSystem\(`Opening\b/, "must not report an outcome it cannot see");
  assert.doesNotMatch(code, /appendSystem\([^)]*new tab/, "must not name a mechanism it does not control");
});

test("#111 /help says its list is only panel shortcuts, and names where the rest is", () => {
  const at = SRC.indexOf('cmd: "/help"');
  assert.notEqual(at, -1);
  const entry = SRC.slice(at, at + 1400);
  assert.match(entry, /DOCS_URL/, "/help must carry the docs pointer");
  // The framing is the point: a bare list of nine shortcuts reads as the full
  // extent of what the panel can do, which is how #111 happened.
  assert.match(entry, /panel shortcuts/, "/help must not let its list read as everything");
  // No tool names or counts: mcp RFC #726 is consolidating the tool surface, and a
  // number baked in here would be wrong on the day it lands.
  assert.doesNotMatch(entry, /\b\d+\s+tools\b/, "no tool count to go stale");
  // Newlines would silently collapse — .cmcp-sys has no white-space:pre-wrap.
  const helpString = entry.slice(entry.indexOf("appendSystem"));
  assert.doesNotMatch(helpString.slice(0, helpString.indexOf("},")), /\\n/, "no newline that cannot render");
});
