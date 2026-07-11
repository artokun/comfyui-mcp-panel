import { build } from "esbuild";

await build({
  entryPoints: ["entry.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "a2ui-lit.bundle.js",
  logLevel: "info",
  banner: {
    js:
      "/* @a2ui/lit 0.10.1 + @a2ui/web_core 0.10.4 (Apache-2.0)\n" +
      " * https://github.com/a2ui-project/a2ui\n" +
      " * Vendored ESM bundle. Rebuild with scripts/build-a2ui-vendor.mjs. */",
  },
});
