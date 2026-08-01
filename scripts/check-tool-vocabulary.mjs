/**
 * Fail the build when this panel names an MCP tool that does not exist.
 *
 *   node scripts/check-tool-vocabulary.mjs
 *
 * WHY THE PANEL NEEDS THIS MORE THAN THE SERVER DOES. The panel depends on TWO
 * vocabularies it does not own, both as bare strings in browser JS that nothing
 * type-checks:
 *
 *   1. CORE MCP tools, invoked by literal — `callTool("download_model")`. There
 *      are 17 such names today and the 0.49.0 consolidation renames every one of
 *      them.
 *   2. PANEL agent tools, named inside hint and error strings the model reads and
 *      acts on.
 *
 * When a name goes stale the failure is silent here and loud for the user: the
 * model follows the hint, gets tool-not-found, cannot diagnose it, and the panel
 * reads as broken. `panel_get_graph` did exactly that — removed upstream, yet
 * still named in five live error paths and documented in the README as real.
 *
 * This is a POSITIVE allowlist, not a list of banned names, which is the whole
 * point: it catches every invalid name including ones nobody thought to enumerate,
 * and it fails at the moment of the rename instead of when a user clicks.
 *
 * The allowlist is vendor/tool-vocabulary.json, generated in the comfyui-mcp repo
 * by `npm run vocab:export` and re-vendored here. That repo's CI fails if the
 * artefact drifts from its ledger, so the only remaining staleness is the vendoring
 * step itself — which is why the vocabulary hash is printed on every run.
 *
 * The artefact deliberately carries no VERSION. Embedding one made it stale on every
 * upstream release even when the vocabulary was untouched, which failed CI with a diff
 * whose only line was the version number. A hash of the names changes exactly when the
 * names change, and is the primitive the Phase 7 runtime handshake needs.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vocab = JSON.parse(readFileSync(join(root, "vendor", "tool-vocabulary.json"), "utf8"));

/**
 * The vendored artefact must match its OWN hash.
 *
 * It was parsed and trusted immediately, with the hash printed at the end as though it
 * were authoritative — so appending `definitely_missing` to `vendor.core` while leaving
 * `vocabularyHash` untouched made the gate approve `callTool("definitely_missing")`,
 * with both repos green and the stale hash still printed. A hash nobody recomputes is
 * decoration, and it would have made the Phase 7 handshake lie in exactly the same way.
 *
 * Must mirror scripts/export-vocabulary.mts exactly.
 */
{
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        core: vocab.core,
        panel: vocab.panel,
        dead: vocab.dead.map((d) => d.name),
      }),
    )
    .digest("hex");
  if (expected !== vocab.vocabularyHash) {
    console.error(
      `\n[check-tool-vocabulary] FAIL\n\n` +
        `vendor/tool-vocabulary.json does not match its own vocabularyHash.\n\n` +
        `  declared  ${vocab.vocabularyHash}\n  actual    ${expected}\n\n` +
        `The artefact is GENERATED — hand-editing it (or editing it and leaving the hash)\n` +
        `defeats every check below, since they all read these arrays. Re-vendor:\n` +
        `  (in comfyui-mcp) npm run vocab:export\n` +
        `  cp comfyui-mcp/docs/design/tool-vocabulary.json vendor/tool-vocabulary.json\n`,
    );
    process.exit(1);
  }
}
const CORE = new Set(vocab.core);
const PANEL = new Set(vocab.panel);
const DEAD = new Map(vocab.dead.map((d) => [d.name, d]));

/**
 * Files whose purpose is to record the past, where a removed name is correct.
 * Narrow on purpose: README is NOT here, because a tool table is a claim about
 * what exists now, and that is precisely where panel_get_graph was a lie.
 */
const HISTORICAL = [/^CHANGELOG\.md$/, /^docs\/changelog\//];

/**
 * Specific OCCURRENCES where naming a removed tool is correct.
 *
 * Path plus a context substring on the same line, and exactly ONE occurrence per line —
 * the same shape as the server-side allowedIn, for the same reason: a whole-file or
 * whole-line exemption pre-approves whatever lands next to it.
 *
 * The entries below are a test that PROVES a retired name is not recommended. Asserting
 * its absence requires writing it, so the gate would otherwise force the deletion of the
 * very test that guards the thing this gate exists to guard.
 */
const ALLOWED_DEAD = [
  {
    path: "browser_tests/unit/node-resolve.test.mjs",
    context: "not the retired panel_get_graph",
    why: "test name stating what it proves",
  },
  {
    path: "browser_tests/unit/node-resolve.test.mjs",
    context: "The retired panel_get_graph must never be recommended",
    why: "comment explaining the assertion below it",
  },
  {
    path: "browser_tests/unit/node-resolve.test.mjs",
    context: "assert.doesNotMatch(e.message, /panel_get_graph/)",
    why: "the negative assertion itself — it cannot assert absence without naming it",
  },
];

const isAllowedDead = (name, path, line) =>
  line.split(name).length - 1 === 1 &&
  // Same binding rule: the exempted context must itself name the tool.
  ALLOWED_DEAD.some((a) => a.path === path && line.includes(a.context) && a.context.includes(name));

/**
 * `panel_*` identifiers that are NOT tool references. Only property keys and
 * variable names belong here — never "this tool doesn't exist but the string is
 * fine", which is the rot this gate exists to catch.
 */
const NOT_TOOL_NAMES = [
  {
    name: "panel_version",
    file: "web/js/comfyui-mcp-panel.js",
    context: "panel_version: PANEL_VERSION",
    why: "payload property key in the diagnostics blob, not a tool reference",
  },
  {
    name: "panel_version",
    file: "web/js/lib/session-rebind.js",
    context: "panel_version: panelVersion",
    why: "same payload property key in the session-rebind frame, not a tool reference",
  },
];

/**
 * Exempt only the intended OCCURRENCE.
 *
 * A bare name-keyed Set was a global permanent pass: with `panel_version` exempted
 * by name, the live model hint `"Call panel_version to inspect the panel."` sailed
 * through. That is the same whole-file preapproval defect the server-side gate's
 * path+context fix removed, reintroduced here by a different route.
 */
const isNotAToolName = (name, path, line) => {
  // ONE occurrence, not the whole line — the same laundering the server-side gate
  // closed in round 5 and this one still allowed:
  //   panel_version: PANEL_VERSION, hint: "Call panel_version now"
  // Both satisfied the line context, so both were exempted.
  const occurrences = line.split(name).length - 1;
  if (occurrences !== 1) return false;
  // The context must CONTAIN the name, so the exemption covers that occurrence rather
  // than merely sharing a line with it — the fix repo A got in round 10 and this file
  // did not. Without it, `panel_version: PANEL_VERSION` on a line that also says
  // "call panel_version" would exempt whichever one appeared.
  return NOT_TOOL_NAMES.some(
    (e) => e.name === name && e.file === path && line.includes(e.context) && e.context.includes(name),
  );
};

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|mp4|webm|wav|mp3|zip)$/i;
const SELF = new Set(["scripts/check-tool-vocabulary.mjs", "vendor/tool-vocabulary.json"]);

const tracked = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((p) => p && !BINARY.test(p) && !SELF.has(p));

/**
 * Tool-call sites, and how to read the tool name out of each.
 *
 * `callTool("x")` is not the only shape. The training UI routes everything through
 * a `callJson(ctx, tool, args)` envelope wrapper, which hid NINE core tool names
 * from an earlier version of this gate — it saw 22 sites / 17 names when the real
 * figure is 34 / 26. Any new wrapper must be added here.
 */
/**
 * How the callee may be written before the argument list. All of these are valid
 * JavaScript and every one of them produced ZERO matches against a bare
 * `\bcallTool\(` pattern, so `await callTool?.("downlaod_model")` was green:
 *
 *     callTool("x")            callTool?.("x")
 *     callTool /* c *\/ ("x")   ctx["callTool"]("x")
 */
const WS = `(?:\\s|\\/\\*[\\s\\S]*?\\*\\/)*`;
const CALLEE = (fn) =>
  `(?:\\b${fn}\\b|\\[${WS}["'\`]${fn}["'\`]${WS}\\])${WS}` +
  // `.call(` and `.apply(` take a thisArg first, so the NAME moves one argument right —
  // handled by CALL_SITES below. `(callTool)(…)` wraps the callee in parens. Each of
  // these is executable and each produced ZERO matches before.
  `(?:\\?\\.)?${WS}`;

const CALL_SITES = [
  // name is argument 1
  { re: new RegExp(`${CALLEE("callTool")}\\(${WS}([^,)]*)`, "g"), what: "callTool" },
  // (callTool)("x") — parenthesised callee
  { re: new RegExp(`\\(${WS}callTool${WS}\\)${WS}\\(${WS}([^,)]*)`, "g"), what: "(callTool)" },
  // callTool.call(thisArg, "x") / .apply — the name is the SECOND argument
  {
    re: new RegExp(`\\bcallTool${WS}\\.${WS}(?:call|apply)${WS}\\(${WS}[^,]*,${WS}([^,)]*)`, "g"),
    what: "callTool.call",
  },
  // .bind() produces a NEW callee whose own call sites this scanner cannot follow, so
  // the bind itself is flagged as unverifiable rather than silently accepted.
  { re: new RegExp(`\\bcallTool${WS}\\.${WS}bind${WS}\\(${WS}([^,)]*)`, "g"), what: "callTool.bind" },
  // name is argument 2, after ctx
  { re: new RegExp(`${CALLEE("callJson")}\\(${WS}[^,]*,${WS}([^,)]*)`, "g"), what: "callJson" },
];

/** A bare string literal holding nothing but a tool name. */
const PLAIN_LITERAL = /^(["'`])([A-Za-z0-9_]+)\1$/;

/**
 * Lines where a tool name reaches `callTool` as something other than a literal.
 *
 * These are function DEFINITIONS and bridge plumbing, not sources of names, so
 * they are listed rather than flagged. Matched on line CONTENT, not line number,
 * so ordinary edits do not invalidate them.
 *
 * The point of listing them is that anything NOT listed fails. A new wrapper, or a
 * name built at runtime, cannot quietly become invisible the way callJson did —
 * which is the only durable defence, since no text scan can resolve
 * `callTool(nameFromConfig)`.
 */
const KNOWN_INDIRECTIONS = [
  {
    file: "web/js/cmcp-training-ui.js",
    match: "const res = await ctx.callTool(tool, args, opts);",
    why: "inside callJson() — its own call sites are scanned via the callJson pattern above",
  },
  {
    file: "web/js/comfyui-mcp-panel.js",
    match: "callTool: (t, a, o) => liveBridgeClient?.callTool(t, a, o),",
    why: "bridge plumbing: forwards an already-supplied name, never originates one",
  },
  {
    file: "web/js/comfyui-mcp-panel.js",
    match: "callTool(tool, args, opts) {",
    why: "the bridge method definition itself",
  },
  {
    file: "web/js/cmcp-training-ui.js",
    match: "//  - ctx.callTool(tool, args, {timeout}) — cid-correlated call_tool over the",
    why: "documentation comment describing the bridge",
  },
  {
    file: "web/js/cmcp-runpod-ui.js",
    match: "// runpod_* tools over the bridge's callTool (no agent turn needed):",
    why: "prose. The callee pattern allows whitespace before '(' so that `callTool /* c */ (\"x\")` and `callTool?.(\"x\")` are matched; that also matches English after the word. Registering the line beats teaching the scanner to skip comments, which would lose real findings inside them.",
  },
  {
    file: "web/js/comfyui-mcp-panel.js",
    match: "// Reply to a direct callTool() request (cid-correlated).",
    why: "prose. Empty-argument callTool() is not a call site, but it IS invocation-shaped, so the coverage check below sees it.",
  },
  {
    file: "web/js/cmcp-training-ui.js",
    match: "async function callJson(ctx, tool, args, opts) {",
    why: "the callJson() definition — its call sites are scanned by the callJson CALL_SITES pattern",
  },
];

/** Same lookaround rule as the server-side gate: `_` is a word char, so `\b` is wrong. */
const nameRe = (n) =>
  new RegExp(`(?<![A-Za-z0-9_])(?:mcp__[A-Za-z0-9_]+__)?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);

/**
 * Every `panel_*` identifier on a line, wherever it appears.
 *
 * An earlier version scoped this to STRING LITERAL contents, on the reasoning
 * that a name a model reads is always inside a string while a bare `panel_foo:`
 * is a property key. That reasoning is sound but the implementation cannot be:
 * matching JS string literals with a regex desynchronises on the first quote
 * character that is not a string delimiter — a regex literal like `/"/`, an
 * apostrophe in a comment, a `${}` containing a quote, or a template literal
 * spanning multiple lines (this extractor is line-based). Once desynced, later
 * names on the line are silently INVISIBLE.
 *
 * For a gate, under-matching is the unacceptable direction: a miss ships the
 * exact bug this exists to catch, while an over-match costs one reviewed line in
 * NOT_TOOL_NAMES. So scan everything and name the exceptions explicitly. There is
 * currently one.
 */
/**
 * Namespace prefixes derived from the vendored panel names, e.g. `panel_`.
 *
 * Hardcoding `panel_` meant the positive check would validate NOTHING after Phase 6
 * renames the surface to `canvas_*` — a hint containing `canvas_edti` would get no
 * validation at all, while the gate went on reporting success. Deriving them means the
 * new namespace is covered the moment it appears in the vendored artefact.
 */
const NAMESPACES = [...new Set(vocab.panel.map((n) => n.split("_")[0] + "_"))];

function panelTokens(line) {
  // Two boundary details, both learned from counterexamples:
  //  - the class includes A-Z even though real tool names are lowercase. With
  //    [a-z0-9_]+ alone, greedy matching on `panel_query_graphX` yields the VALID
  //    prefix `panel_query_graph` and APPROVES a name that cannot resolve. Adding
  //    the trailing lookahead alone only downgrades that to matching nothing, which
  //    is still a miss. Capturing the capital makes the token `panel_query_graphX`,
  //    which is simply not in the ledger — so it is reported, which is correct.
  //  - the trailing lookahead then stops one name being read as a prefix of another.
  // The FIRST letter may vary in case, the rest may not. Real tool names are all
  // lowercase, so `Panel_query_graph` is invalid — yet a fully case-sensitive prefix
  // produced no token for it, making it invisible rather than reported. Going fully
  // case-insensitive over the whole prefix overshot and flagged 26 SCREAMING_CASE
  // constants (PANEL_VERSION and friends), which are plainly identifiers, not tool
  // references. `[Pp]anel_` catches the plausible typo and leaves constants alone.
  const out = [];
  for (const ns of NAMESPACES) {
    // Case-insensitive prefix, `$` inside the identifier, and SCREAMING_CASE excluded:
    //  - `PANEL_query_graph` produced no token when the prefix had to be lowercase, so
    //    it was invisible rather than reported. Matching case-insensitively catches it;
    //    skipping all-uppercase tokens keeps PANEL_VERSION and friends out (26 of them).
    //  - `panel_query_graph$` matched only the VALID prefix and was approved, because
    //    `$` is a legal identifier character that the class omitted.
    const re = new RegExp(`(?<![A-Za-z0-9_$])${ns}[A-Za-z0-9_$]+(?![A-Za-z0-9_$])`, "gi");
    for (const m of line.matchAll(re)) {
      const tok = m[0];
      // SCREAMING_CASE is skipped only when its lowercase form is NOT a tool. Skipping
      // every uppercase token also exempted `PANEL_QUERY_GRAPH` in a hint — a real tool
      // named in a case that cannot resolve. PANEL_VERSION lowercases to a non-tool, so
      // it is a constant; PANEL_QUERY_GRAPH lowercases to a live tool, so it is a broken
      // reference and is reported.
      if (tok === tok.toUpperCase() && !PANEL.has(tok.toLowerCase())) continue;
      out.push(tok);
    }
  }
  return out;
}

const errors = [];
const files = tracked();
const jsFiles = files.filter((p) => p.startsWith("web/js/") && p.endsWith(".js"));

/**
 * Everywhere a tool name can be written in code, not just the shipped panel.
 *
 * Scoping the call-site and obfuscation scans to web/js left three live holes:
 * `bridge.callTool("definitely_missing")` in browser_tests/ (which ships nothing but
 * is also absent from CI's e2e run, so it could stay wrong indefinitely), and escaped
 * or homoglyph names in shipped Python. Historical files are still skipped.
 */
const codeFiles = files.filter(
  (p) =>
    !HISTORICAL.some((re) => re.test(p)) &&
    // .html/.jsx included: __init__.py serves the whole web/ directory and .comfyignore
    // does not exclude it, so `<script>callTool("x")</script>` in a shipped page is as
    // live as anything in web/js — and was outside every call-site scan.
    /\.(js|mjs|cjs|ts|tsx|jsx|mts|cts|py|html|htm)$/.test(p),
);

// ---------------------------------------------------------------------------
// 1. Every callTool("X") literal must be a real core tool.
// ---------------------------------------------------------------------------
const coreHits = [];
const unverifiable = [];
/** 0-based char offset → 1-based line number. */
const lineAt = (content, index) => content.slice(0, index).split("\n").length;

for (const path of codeFiles) {
  const content = readFileSync(join(root, path), "utf8");
  const lines = content.split("\n");
  // Matched against the WHOLE FILE, not line by line. A line-based scan reported
  // ZERO sites for a perfectly ordinary formatting choice:
  //     await callTool(
  //       "does_not_exist",
  //       {},
  //     );
  // The first line's argument is empty (skipped as prose) and the name sits on a
  // line no pattern ever sees. `[^,)]*` already spans newlines, so scanning content
  // needs no other change.
  {
    for (const { re, what } of CALL_SITES) {
      re.lastIndex = 0;
      for (const m of content.matchAll(re)) {
        const arg = (m[1] ?? "").trim();
        // `callTool()` with no argument is prose, not a call site.
        if (arg === "") continue;
        const i = lineAt(content, m.index ?? 0) - 1;
        const line = lines[i] ?? "";
        const lit = PLAIN_LITERAL.exec(arg);
        if (lit) {
          coreHits.push({ path, line: i + 1, name: lit[2], what });
          continue;
        }
        // Not a plain literal: a template with ${}, a concatenation, or an
        // identifier. Unverifiable by any text scan, so it must be a registered
        // indirection or it fails. This is what catches the runtime-assembly
        // evasions (`download_${"model"}`, ["a","b"].join("_"), nameFromConfig)
        // without trying to enumerate their infinite shapes.
        const trimmed = line.trim();
        if (KNOWN_INDIRECTIONS.some((k) => k.file === path && k.match === trimmed)) continue;
        unverifiable.push({ path, line: i + 1, what, arg: arg.slice(0, 60), text: trimmed.slice(0, 140) });
      }
    }
  }
}
// No non-ASCII filter here: PLAIN_LITERAL admits ASCII only, so a non-ASCII name
// never reaches coreHits — it is classified `unverifiable` instead, and the
// identifier-shaped scan below reports the codepoints. An earlier version filtered
// coreHits for non-ASCII, which was dead code that read like coverage.
const badCore = coreHits.filter((h) => !CORE.has(h.name));
if (badCore.length > 0) {
  errors.push(
    [
      `${badCore.length} callTool() literal(s) name a tool the MCP server does not expose:`,
      "",
      ...badCore.map((h) => {
        const dead = DEAD.get(h.name);
        return (
          `  ${h.path}:${h.line}  ${h.name}` +
          (dead ? `\n    → removed (${dead.since}); use ${dead.replacement}` : "")
        );
      }),
      "",
      `Checked against vendor/tool-vocabulary.json, vocabulary ${vocab.vocabularyHash.slice(0, 12)}…`,
      `(${vocab.counts.core} core tools). If the server renamed it, re-vendor the artefact:`,
      `  (in comfyui-mcp) npm run vocab:export`,
      `  cp comfyui-mcp/docs/design/tool-vocabulary.json vendor/tool-vocabulary.json`,
    ].join("\n"),
  );
}

if (unverifiable.length > 0) {
  errors.push(
    [
      `${unverifiable.length} tool-call site(s) pass a name this gate cannot verify:`,
      "",
      ...unverifiable.flatMap((h) => [
        `  ${h.path}:${h.line}  ${h.what}(${h.arg}…)`,
        `    ${h.text}`,
      ]),
      "",
      `A name built at runtime — a template with \${}, a concatenation, or a variable —`,
      `is invisible to every text scan, so it survives every rename. Either write the`,
      `full literal, or (if this is a wrapper or plumbing that does not originate names)`,
      `register the line in KNOWN_INDIRECTIONS with a reason.`,
      `Registering is not a rubber stamp: a wrapper's OWN call sites must then be`,
      `scanned by a CALL_SITES pattern, or its names go unchecked — which is exactly`,
      `how callJson() hid nine core tool names.`,
    ].join("\n"),
  );
}


// ---------------------------------------------------------------------------
// 2. Every panel_* identifier must be a real panel tool (or a named exception).
// ---------------------------------------------------------------------------
const badPanel = [];
// Every tracked text file, not just web/js. The README's tool table is SHIPPED and
// model-visible, and a typo there (`panel_qurey_graph`) is in neither PANEL nor
// DEAD, so a web/js-only scan reported success on it. Python route handlers return
// model-facing strings too. Historical files are skipped, as for dead names.
for (const path of files) {
  if (HISTORICAL.some((re) => re.test(path))) continue;
  let fileText;
  try {
    fileText = readFileSync(join(root, path), "utf8");
  } catch {
    continue;
  }
  const lines = fileText.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const name of panelTokens(line)) {
      if (PANEL.has(name) || isNotAToolName(name, path, line)) continue;
      if (isAllowedDead(name, path, line)) continue;
      badPanel.push({ path, line: i + 1, name, text: line.trim().slice(0, 140) });
    }
  }
}
if (badPanel.length > 0) {
  errors.push(
    [
      `${badPanel.length} reference(s) to a panel tool that does not exist:`,
      "",
      ...badPanel.flatMap((h) => {
        const dead = DEAD.get(h.name);
        return [
          `  ${h.path}:${h.line}  ${h.name}`,
          `    ${h.text}`,
          dead ? `    → removed (${dead.since}); use ${dead.replacement}` : "",
        ].filter(Boolean);
      }),
      "",
      `Hint and error strings are read by the MODEL, so a wrong name becomes a`,
      `tool-not-found it cannot diagnose. Every panel_* identifier is scanned, not only`,
      `ones inside string literals — matching JS strings by regex desyncs on a stray`,
      `quote and would MISS names, the one failure direction a gate cannot afford.`,
      `If an identifier is not a tool reference (a property key or variable), add it`,
      `to NOT_TOOL_NAMES with a comment saying what it is.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 2a. No tool name assembled so that no contiguous token exists.
//
// `["panel","get","graph"].join("_")` and `"panel\\x5fget_graph"` both evaluate to a
// real tool name at runtime while leaving NOTHING for a text scan to match — not the
// name, not a panel_* token, not a `"prefix" +` concatenation.
//
// Be clear about what this is: a heuristic for the shapes that have been
// demonstrated, not a proof. No static scan can resolve a name computed at runtime;
// the durable answer is validating the name inside the callTool bridge itself
// (comfyui-mcp-nx3). Both patterns currently appear ZERO times in web/js, so this
// costs nothing and closes the demonstrated bypasses.
// ---------------------------------------------------------------------------
const obfuscated = [];
// Third-party bundles are excluded: they are minified, not ours to fix, and cannot
// contain a reference to one of OUR tools. Without this the widened concatenation
// pattern matches minified output by chance.
const ourCode = codeFiles.filter((p) => !p.startsWith("web/js/vendor/"));
for (const path of ourCode) {
  const content = readFileSync(join(root, path), "utf8");
  const lines = content.split("\n");
  const at = (index) => content.slice(0, index).split("\n").length;

  // `.join("_")` is matched over whole CONTENT, because the argument is routinely put
  // on its own line by a formatter:
  //     ["panel", "query", "graph"].join(
  //       "_"
  //     )
  // which a line-based test never saw.
  // Concatenation split ACROSS lines — a literal ending in "_" whose "+" or continuation
  // lands on the next line. Matched over content for the same reason .join is.
  for (const m of content.matchAll(/["'`][^"'`\n]*[A-Za-z0-9]_["'`]\s*\n\s*(?:\+|\.concat\b)|\+\s*\n\s*["'`]_[A-Za-z0-9_]/g)) {
    const i = at(m.index ?? 0);
    obfuscated.push({
      path,
      line: i,
      why: "assembles a name from fragments across lines",
      text: (lines[i - 1] ?? "").trim().slice(0, 140),
    });
  }
  for (const m of content.matchAll(/\.join\(\s*["'`]_["'`]\s*\)/g)) {
    const i = at(m.index ?? 0);
    obfuscated.push({ path, line: i, why: 'joins fragments with "_"', text: (lines[i - 1] ?? "").trim().slice(0, 140) });
  }
  // Escapes are single-token, so per line is exact and gives a better line number.
  for (const [i, line] of lines.entries()) {
    if (/\\x5[fF]|\\u005[fF]/.test(line)) {
      obfuscated.push({ path, line: i + 1, why: "escape-encodes an underscore", text: line.trim().slice(0, 140) });
    }
    // Ordinary concatenation — the simplest assembly of all, and the one this gate
    // somehow did not check. `"Call " + "panel_" + "get_graph"` produced exit 0 while the
    // model received a retired tool name. The server-side gate has had this since round
    // 5; only the panel was missing it, which is what happens when two implementations of
    // the same idea drift.
    //   "panel_" +        a fragment ENDING in an underscore, concatenated
    //   + "_get_graph"    a fragment BEGINNING with one
    // Same-line forms only; the multiline case is handled over whole content below,
    // because a formatter routinely breaks a concatenation across lines:
    //     const hint = "Call panel_"
    //       + "get_graph";
    if (
      /["'`][^"'`\n]*[A-Za-z0-9]_["'`][ \t]*(?:\+|\.concat\b)/.test(line) ||
      /(?:\+|\.concat\()[ \t]*["'`]_[A-Za-z0-9_]/.test(line) ||
      /\+\s*["'`]_["'`]\s*\+/.test(line) ||
      /\$\{\s*["'`][A-Za-z0-9_]+["'`]\s*\}/.test(line)
    ) {
      obfuscated.push({
        path,
        line: i + 1,
        why: "assembles a name from fragments",
        text: line.trim().slice(0, 140),
      });
    }
  }
}
if (obfuscated.length > 0) {
  errors.push(
    [
      `${obfuscated.length} line(s) may assemble a tool name so no literal is visible:`,
      "",
      ...obfuscated.flatMap((h) => [`  ${h.path}:${h.line}  ${h.why}`, `    ${h.text}`]),
      "",
      `Write tool names as plain contiguous literals. A name no text scan can see`,
      `survives every rename, which is precisely what this gate exists to prevent.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 2d. COVERAGE, not enumeration.
//
// Nine call syntaxes were added to CALL_SITES one at a time as each was found — bare,
// ctx-prefixed, optional chaining, bracket access, parenthesised callee, .call, .apply,
// .bind, interposed comments — and reviews kept finding a tenth. Enumerating syntax
// cannot converge; JavaScript has more ways to invoke a function than a regex list will
// ever hold.
//
// So this inverts the question. Rather than "does this line match a known call shape?",
// it asks "does this line look like an INVOCATION of the bridge that I failed to extract
// a name from?" Anything invocation-shaped that produced no classified site and is not a
// registered indirection is reported as unverifiable — which is the honest answer, since
// the gate genuinely cannot tell which tool it calls.
//
// The limit, stated plainly rather than papered over: aliasing
// (`const f = ctx.callTool; f("x")`) and reflective invocation
// (`Reflect.apply(callTool, …)`) still escape, because resolving them needs a parser,
// not a scanner. That is the argument for a runtime check inside the bridge
// (comfyui-mcp-nx3) — not for a tenth regex.
// ---------------------------------------------------------------------------
// `(?:\?\.|\.)?\s*\w*` covers callTool(, callTool?.(, callTool.call( and
// callTool?.call( — the optional-chained MEMBER form escaped an earlier version that
// required a literal dot where `?.` sits.
const INVOCATION_SHAPED = /\b(?:callTool|callJson)\b\s*(?:\?\.|\.)?\s*\w*\s*[)\]]?\s*\(/;
const classifiedAt = new Set([
  ...coreHits.map((h) => `${h.path}:${h.line}`),
  ...unverifiable.map((h) => `${h.path}:${h.line}`),
]);
const unclassified = [];
for (const path of ourCode) {
  const lines = readFileSync(join(root, path), "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    if (!INVOCATION_SHAPED.test(line)) continue;
    if (classifiedAt.has(`${path}:${i + 1}`)) continue;
    if (KNOWN_INDIRECTIONS.some((k) => k.file === path && k.match === line.trim())) continue;
    unclassified.push({ path, line: i + 1, text: line.trim().slice(0, 140) });
  }
}
if (unclassified.length > 0) {
  errors.push(
    [
      `${unclassified.length} line(s) invoke the tool bridge in a form this gate cannot read:`,
      "",
      ...unclassified.flatMap((h) => [`  ${h.path}:${h.line}`, `    ${h.text}`]),
      "",
      `The line looks like a call but no tool name could be extracted, so the name goes`,
      `unchecked. Either write it in a form CALL_SITES recognises, or register the line in`,
      `KNOWN_INDIRECTIONS with a reason if it does not originate a tool name.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 2e. No INTERNAL bridge command name recommended to the model.
//
// GRAPH_TOOL_EXECUTORS keys (graph_*, comfy_*, nodes_*, workflow_*) are browser bridge
// commands, NOT MCP tools. The model cannot call them, and the vocabulary gate could not
// see them either — the positive scan derives its namespaces from the vendored PANEL
// names, which are all `panel_*`, so an internal name in a hint matched nothing and
// passed.
//
// Nine live model-facing strings recommended them: panel_connect's error pointed at
// graph_enter_subgraph and graph_expose_subgraph_*, panel_add_subgraph at
// graph_list_subgraphs, install/update success at comfy_reboot and nodes_queue_status.
// Every one 404s when followed. The public equivalents are panel_enter_subgraph,
// panel_expose_subgraph_*, panel_list_subgraphs, panel_restart_comfyui and
// panel_node_queue_status.
//
// The names are read from the executors object itself rather than hardcoded, so the list
// cannot drift. The DISCRIMINATOR is prose: `case "graph_serialize":` and
// `GRAPH_TOOL_EXECUTORS.graph_x(` are the name standing alone, which is correct usage,
// while a name embedded in a sentence inside a string is an instruction to the model.
// Comments and console.* are excluded — neither reaches a model.
// ---------------------------------------------------------------------------
const internalNames = (() => {
  try {
    const src = readFileSync(join(root, "web/js/comfyui-mcp-panel.js"), "utf8");
    const m = src.match(/const GRAPH_TOOL_EXECUTORS\s*=\s*\{([\s\S]*?)\n\};/);
    return [...(m ? m[1] : "").matchAll(/^\s{2}(?:async\s+)?([a-z][a-z0-9_]*)\s*\(/gm)].map((x) => x[1]);
  } catch {
    return [];
  }
})();

const internalLeaks = [];
for (const path of jsFiles) {
  const lines = readFileSync(join(root, path), "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (/\bconsole\.(?:log|warn|error|debug|info)\s*\(/.test(line)) continue;
    for (const k of internalNames) {
      if (new RegExp(`["'\`]${k}["'\`]`).test(line)) continue; // the whole literal = dispatch
      if (new RegExp(`[\`"'][^\`"']*[ (]${k}[ ).,][^\`"']*[\`"']`).test(line)) {
        internalLeaks.push({ path, line: i + 1, name: k, text: t.slice(0, 140) });
      }
    }
  }
}
if (internalLeaks.length > 0) {
  errors.push(
    [
      `${internalLeaks.length} model-facing string(s) recommend an INTERNAL bridge command:`,
      "",
      ...internalLeaks.flatMap((h) => [`  ${h.path}:${h.line}  ${h.name}`, `    ${h.text}`]),
      "",
      `GRAPH_TOOL_EXECUTORS keys are browser bridge commands, not MCP tools — the model`,
      `cannot call them, so following the advice 404s. Name the public panel_* equivalent.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 2b. No non-ASCII character inside an identifier-shaped word.
//
// A tool name is ASCII. `pаnel_get_graph` with a Cyrillic 'а' is visually identical
// to the real thing, matches no ledger entry, produces no panel_* token (the regex
// needs a literal "panel_"), and cannot resolve — so without this it is invisible in
// every direction. Scoped to words containing an underscore so ordinary prose with
// accented characters is unaffected.
// ---------------------------------------------------------------------------
const nonAscii = [];
// Every tracked non-historical file, not just code: README ships and is model-visible,
// and a Cyrillic 'а' or a zero-width joiner in a tool name there is exactly as
// unresolvable — and exactly as invisible to a reviewer — as one in a hint string.
const textFiles = files.filter((p) => !HISTORICAL.some((re) => re.test(p)));
for (const path of textFiles) {
  const lines = readFileSync(join(root, path), "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/[A-Za-z0-9_\u0080-\uFFFF]*_[A-Za-z0-9_\u0080-\uFFFF]*/g)) {
      const word = m[0];
      // Only non-ASCII LETTERS are homoglyph risks. Non-ASCII punctuation and
      // symbols are ordinary prose: `class_type→pack` uses U+2192 to join two
      // identifiers and is perfectly clear, whereas a Cyrillic 'а' is a trap.
      // Letters, marks AND format characters. A zero-width joiner (U+200D) inside
      // `panel_‍query_graph` is invisible on screen, splits the identifier so no
      // panel_* token matches, and resolves to nothing — but it is \p{Cf}, not
      // \p{L}, so a letters-only filter missed it. Punctuation and symbols stay
      // allowed, which is what keeps `class_type→pack` (U+2192) clean.
      const offenders = [...word].filter(
        (c) => c.codePointAt(0) > 0x7f && /[\p{L}\p{M}\p{Cf}]/u.test(c),
      );
      if (offenders.length === 0) continue;
      nonAscii.push({ path, line: i + 1, word, offenders, text: line.trim().slice(0, 140) });
    }
  }
}
if (nonAscii.length > 0) {
  errors.push(
    [
      `${nonAscii.length} identifier-shaped word(s) contain non-ASCII characters:`,
      "",
      ...nonAscii.flatMap((h) => [
        `  ${h.path}:${h.line}  ${JSON.stringify(h.word)}`,
        `    non-ASCII letter(s): ${h.offenders.map((c) => JSON.stringify(c) + " U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(", ")}`,
      ]),
      "",
      `A homoglyph in a tool name is invisible to review and resolves to nothing.`,
      `If this is genuinely prose rather than an identifier, reword it so the`,
      `non-ASCII character is not inside an underscored word.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 2c. No NEAR-MISS of a real tool name.
//
// Closes the one hole a positive allowlist structurally cannot: a core tool named in
// PROSE rather than in a call expression. This panel already does that — "poll
// get_queue / panel_node_queue_status" at comfyui-mcp-panel.js:7203 — and after Phase 5
// renames get_queue to comfy_queue, a typo like `comfy_quue` in that sentence would be
// seen by nothing: not the call scan (it is not a call), not the namespace scan (core
// names have no single namespace), not the dead-name scan (it is not a known dead name).
//
// Requiring every snake_case token to be a tool is unworkable — there are ~480 of them
// in shipped JS, nearly all ordinary identifiers. But a token ONE EDIT away from a real
// tool name, which is not itself a tool name, is a typo with almost no other
// explanation. Measured on the current tree: zero such tokens, so this costs nothing
// today and starts paying the moment someone fat-fingers a rename.
// ---------------------------------------------------------------------------
const ALL_NAMES = new Set([...vocab.core, ...vocab.panel]);

/** Levenshtein, bailing out as soon as the answer cannot be 1. */
function editDistance1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] === 1;
}

const nearMiss = [];
for (const path of textFiles) {
  let text;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4}\b/g)) {
      const tok = m[0];
      if (ALL_NAMES.has(tok)) continue;
      const hit = [...ALL_NAMES].find((n) => editDistance1(tok, n));
      if (hit) {
        nearMiss.push({ path, line: i + 1, tok, hit, text: line.trim().slice(0, 140) });
      }
    }
  }
}
if (nearMiss.length > 0) {
  errors.push(
    [
      `${nearMiss.length} token(s) are one edit away from a real tool name:`,
      "",
      ...nearMiss.flatMap((h) => [
        `  ${h.path}:${h.line}  ${h.tok}  — did you mean ${h.hit}?`,
        `    ${h.text}`,
      ]),
      "",
      `A tool named in PROSE is invisible to the call-site scan, so a typo there reaches`,
      `the model as an instruction to call something that does not exist. If the token is`,
      `genuinely unrelated to the tool it resembles, rename it or add it to`,
      `NEAR_MISS_ALLOWED with a reason.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 3. No removed name anywhere outside genuinely historical files.
// ---------------------------------------------------------------------------
const deadHits = [];
for (const path of files) {
  if (HISTORICAL.some((re) => re.test(path))) continue;
  let content;
  try {
    content = readFileSync(join(root, path), "utf8");
  } catch {
    continue;
  }
  for (const [name, dead] of DEAD) {
    if (!content.includes(name)) continue;
    const re = nameRe(name);
    for (const [i, line] of content.split("\n").entries()) {
      if (!re.test(line)) continue;
      if (isAllowedDead(name, path, line)) continue;
      deadHits.push({ path, line: i + 1, name, dead, text: line.trim().slice(0, 140) });
    }
  }
}
if (deadHits.length > 0) {
  errors.push(
    [
      `${deadHits.length} reference(s) to a removed tool name:`,
      "",
      ...deadHits.flatMap((h) => [
        `  ${h.path}:${h.line}  ${h.name}`,
        `    ${h.text}`,
        `    → use ${h.dead.replacement}  (${h.name}: ${h.dead.since})`,
      ]),
    ].join("\n"),
  );
}

const staleIndirections = KNOWN_INDIRECTIONS.filter((k) => {
  try {
    return !readFileSync(join(root, k.file), "utf8")
      .split("\n")
      .some((l) => l.trim() === k.match);
  } catch {
    return true;
  }
});
if (staleIndirections.length > 0) {
  errors.push(
    [
      `${staleIndirections.length} stale KNOWN_INDIRECTIONS entr(ies) — the line is gone:`,
      "",
      ...staleIndirections.map((k) => `  ${k.file}  ${JSON.stringify(k.match)}`),
      "",
      `Delete them. A registered indirection that no longer exists is a standing`,
      `pre-approval nobody will re-review.`,
    ].join("\n"),
  );
}

if (errors.length > 0) {
  console.error(`\n[check-tool-vocabulary] FAIL\n\n${errors.join("\n\n")}\n`);
  process.exit(1);
}

console.error(
  `[check-tool-vocabulary] OK — ${coreHits.length} tool-call literal(s) ` +
    `(${new Set(coreHits.map((h) => h.name)).size} distinct) across `.replace("across ", "across ") +
    `${jsFiles.length} shipped JS + ${codeFiles.length} code file(s), all valid against vocabulary ${vocab.vocabularyHash.slice(0, 12)}… ` +
    `(${vocab.counts.core} core / ${vocab.counts.panel} panel tools).`,
);
