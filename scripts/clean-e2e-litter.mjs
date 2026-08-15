#!/usr/bin/env node
// #907 — remove e2e litter that accumulated BEFORE the suite started cleaning up
// after itself.
//
// Separate from the teardown on purpose, and far more cautious. The teardown
// deletes only files that appeared during its own run AND carry the suite's
// `cmcp-e2e-` prefix, so it can never be wrong about ownership. This script has
// neither: it looks at files whose origin nobody recorded, months of them, in a
// directory that also holds the developer's real work.
//
// THE FAMILY YOU ACTUALLY WANT GONE IS THE AMBIGUOUS ONE. The ~1272 files here
// are named `Untitled <date> <time>.json` — exactly what ComfyUI names the user's
// OWN unnamed saves. Nothing in the name distinguishes a test artifact from a
// workflow someone meant to keep, so a script cannot decide it and must not
// pretend to (codex). Hence:
//
//   • `cmcp-e2e-*` is unambiguous and needs only --apply;
//   • the Untitled family needs --include-untitled ON TOP of --apply, and the
//     full list goes to a file first, because a 20-line preview of 1272
//     deletions is not review, it is a formality.
//
//   node scripts/clean-e2e-litter.mjs                              # report only
//   node scripts/clean-e2e-litter.mjs --apply                      # cmcp-e2e-* only
//   node scripts/clean-e2e-litter.mjs --apply --include-untitled   # + Untitled family
import { writeFileSync } from "node:fs";

import { isTestLitter } from "../browser_tests/fixtures/workflow-litter.ts";

/** ComfyUI's default for an unnamed save — AMBIGUOUS by construction. */
const UNTITLED = /^Untitled \d{4}-\d{2}-\d{2}(?: \d{2}-\d{2}-\d{2})?(?: \(\d+\))?\.json$/;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const includeUntitled = args.includes("--include-untitled");
const urlIdx = args.indexOf("--url");
const base =
  urlIdx !== -1 ? args[urlIdx + 1] : process.env.PLAYWRIGHT_BASE_URL || "http://localhost:8188";

const res = await fetch(`${base}/api/userdata?dir=workflows`).catch((err) => {
  console.error(`could not reach ComfyUI at ${base}: ${err?.message ?? err}`);
  process.exit(2);
});
if (!res.ok) {
  console.error(`ComfyUI answered ${res.status} listing workflows`);
  process.exit(2);
}
const all = (await res.json()).filter((n) => typeof n === "string");
const suiteNamed = all.filter(isTestLitter).sort();
const untitled = all.filter((n) => UNTITLED.test(n)).sort();
const targets = includeUntitled ? [...suiteNamed, ...untitled].sort() : suiteNamed;

console.log(`${all.length} workflow(s) in ${base}`);
console.log(`  ${suiteNamed.length} named by the suite (cmcp-e2e-*) — unambiguous`);
console.log(
  `  ${untitled.length} Untitled <date> — ComfyUI's name for ANY unnamed save, including yours`,
);
console.log(`  ${all.length - suiteNamed.length - untitled.length} other`);

if (!targets.length) {
  console.log(`\nNothing to do.`);
  process.exit(0);
}

const listing = "cmcp-e2e-litter-review.txt";
writeFileSync(listing, `${targets.join("\n")}\n`, "utf-8");
console.log(`\nfull list of ${targets.length} candidate(s) written to ${listing}`);

if (!apply) {
  const untitledHint =
    untitled.length && !includeUntitled
      ? ` (add --include-untitled to also remove the ${untitled.length} Untitled files — read the` +
        ` list for anything you saved yourself first; this script cannot tell them apart).`
      : ".";
  console.log(`\nNothing was deleted. Read ${listing}, then re-run with --apply${untitledHint}`);
  process.exit(0);
}

if (untitled.length && !includeUntitled) {
  console.log(
    `\nSkipping the ${untitled.length} Untitled files — pass --include-untitled to remove them too.`,
  );
}

let removed = 0;
const failed = [];
for (const name of targets) {
  const r = await fetch(`${base}/api/userdata/${encodeURIComponent(`workflows/${name}`)}`, {
    method: "DELETE",
  }).catch(() => null);
  if (r && r.ok) removed++;
  else failed.push(name);
}
console.log(`\nremoved ${removed} file(s)`);
if (failed.length) {
  console.log(`FAILED to remove ${failed.length}: ${failed.slice(0, 10).join(", ")}`);
  process.exit(1);
}
