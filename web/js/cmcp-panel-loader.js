// Cache-stable extension entry point.
//
// ComfyUI discovers every `*.js` below WEB_DIRECTORY and imports each path as
// given. A page reload therefore cannot change the URL of the old entry module:
// a browser or intermediary holding that response can run stale panel code even
// after ComfyUI restarts with a new pack on disk. Keep this tiny discovery entry
// stable, and load the runtime through a URL keyed to the pack version instead.
// Updating the pack then necessarily selects a fresh module URL.
//
// Do not rename this file to the old `comfyui-mcp-panel.js`: an upgrade must
// remove that legacy `*.js` path from ComfyUI's extension listing, otherwise a
// stale cached copy can still be imported alongside this loader.
const PANEL_BUNDLE_VERSION = "0.11.38";

const runtimeUrl = new URL("./comfyui-mcp-panel.mjs", import.meta.url);
runtimeUrl.searchParams.set("v", PANEL_BUNDLE_VERSION);
await import(runtimeUrl.href);
