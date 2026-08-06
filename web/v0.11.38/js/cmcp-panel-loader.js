// Version-addressed extension entry point. The containing WEB_DIRECTORY is
// `web/v<panel-version>`, so this loader, its runtime, and every relative
// dependency all have a new URL on every release. Do not move it out of that
// tree or add a query-only cache bust: either leaves a cached module boundary.
await import(new URL("./comfyui-mcp-panel.mjs", import.meta.url).href);
