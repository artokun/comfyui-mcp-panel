#!/usr/bin/env node
// #907 — remove e2e litter that accumulated BEFORE the suite started cleaning up
// after itself.
//
// Separate from the teardown on purpose. The teardown deletes only what the run
// it is part of created, and knows that because it took a baseline first. This
// script has no baseline: it is looking at files whose origin nobody recorded,
// months of them, in a directory that also holds the developer's real work.
//
// So it DOES NOT DELETE unless told to, twice: it prints what it would remove and
// exits, and only `--apply` acts. Anything it is not sure about, it leaves.
//
//   node scripts/clean-e2e-litter.mjs              # report only (default)
//   node scripts/clean-e2e-litter.mjs --apply      # actually delete
//   node scripts/clean-e2e-litter.mjs --url http://localhost:8189
import { isTestLitter } from "../browser_tests/fixtures/workflow-litter.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const urlIdx = args.indexOf("--url");
const base = urlIdx !== -1 ? args[urlIdx + 1] : process.env.PLAYWRIGHT_BASE_URL || "http://localhost:8188";

const res = await fetch(`${base}/api/userdata?dir=workflows`).catch((err) => {
  console.error(`could not reach ComfyUI at ${base}: ${err?.message ?? err}`);
  process.exit(2);
});
if (!res.ok) {
  console.error(`ComfyUI answered ${res.status} listing workflows`);
  process.exit(2);
}
const all = (await res.json()).filter((n) => typeof n === "string");
const litter = all.filter(isTestLitter).sort();
const keep = all.length - litter.length;

console.log(`${all.length} workflow(s) in ${base}`);
console.log(`  ${keep} kept`);
console.log(`  ${litter.length} match the e2e litter patterns`);
if (!litter.length) process.exit(0);

console.log("\nfirst 20 matches:");
for (const name of litter.slice(0, 20)) console.log(`  ${name}`);
if (litter.length > 20) console.log(`  … and ${litter.length - 20} more`);

if (!apply) {
  console.log(
    `\nNothing was deleted. These are files in YOUR workflows directory — read the list above, ` +
      `then re-run with --apply if it is all test output.`,
  );
  process.exit(0);
}

let removed = 0;
const failed = [];
for (const name of litter) {
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
