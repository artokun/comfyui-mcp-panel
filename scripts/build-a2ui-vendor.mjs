// Rebuild the vendored A2UI Lit renderer bundle (web/js/vendor/a2ui-lit.bundle.js)
// from the pinned packages in vendor-spike/. For deliberate upgrades only.
//
// Usage (from anywhere — the script derives all paths from its own location):
//   1. cd vendor-spike && npm install   (once, to restore the pinned deps + esbuild)
//   2. node scripts/build-a2ui-vendor.mjs
//
// Pinned surface: @a2ui/lit 0.10.1 + @a2ui/web_core 0.10.4 (see vendor-spike/package.json).

import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const spikeDir = join(repoRoot, "vendor-spike");
const entryFile = join(spikeDir, "entry.js");
const outFile = join(repoRoot, "web", "js", "vendor", "a2ui-lit.bundle.js");

if (!existsSync(join(spikeDir, "node_modules"))) {
  console.error(
    "error: vendor-spike/node_modules is missing (deps are gitignored).\n" +
      `Run:  cd "${spikeDir}" && npm install\n` +
      "then re-run this script.",
  );
  process.exit(1);
}

// esbuild and the @a2ui/* packages live only in vendor-spike/node_modules,
// so resolve them from there — not from wherever this script was invoked.
const requireFromSpike = createRequire(join(spikeDir, "package.json"));
const { build } = requireFromSpike("esbuild");

// entry.js is a trivial re-export and intentionally untracked; recreate it if missing.
if (!existsSync(entryFile)) {
  writeFileSync(
    entryFile,
    "// Re-export the surface Task 3 would import: the Lit renderer's custom\n" +
      "// elements/catalog plus the shared MessageProcessor from web_core.\n" +
      'export * from "@a2ui/lit/v0_9";\n' +
      'export { MessageProcessor, Catalog } from "@a2ui/web_core/v0_9";\n',
  );
  console.log("created " + entryFile);
}

await build({
  entryPoints: [entryFile],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: outFile,
  logLevel: "info",
  banner: {
    js:
      "/* @a2ui/lit 0.10.1 + @a2ui/web_core 0.10.4 (Apache-2.0)\n" +
      " * https://github.com/a2ui-project/a2ui\n" +
      " * Vendored ESM bundle. Rebuild with scripts/build-a2ui-vendor.mjs. */",
  },
});
