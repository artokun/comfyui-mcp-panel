#!/usr/bin/env node
/**
 * Quick smoke check for per-workflow agent sessions (Task 6 subset).
 * Requires ComfyUI at PLAYWRIGHT_BASE_URL (default http://127.0.0.1:8188).
 */
import { chromium } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8188";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Panel script should be loaded with workflowTabId helpers.
    const hasWorkflowFns = await page.evaluate(() => {
      const src = [...document.scripts].map((s) => s.src).join("\n");
      return src.includes("comfyui-mcp-panel.js");
    });
    results.push({ check: "panel script loaded", pass: hasWorkflowFns });

    const wf = await page.evaluate(() => {
      const w =
        window.comfyAPI?.app?.app?.extensionManager?.workflow?.activeWorkflow ||
        (typeof app !== "undefined" && app?.extensionManager?.workflow?.activeWorkflow) ||
        null;
      return w
        ? {
            path: w.path,
            key: w.key,
            persisted: w.isPersisted,
            temporary: w.isTemporary,
          }
        : null;
    });
    results.push({ check: "active workflow readable", pass: !!wf, detail: wf });

    const threads = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("comfyui-mcp.panel.threads") || "[]").map((t) => ({
          workflowKey: t.workflowKey,
          msgs: t.msgs?.length ?? 0,
        }));
      } catch {
        return [];
      }
    });
    const tagged = threads.filter((t) => typeof t.workflowKey === "string");
    results.push({
      check: "threads carry workflowKey (if any exist)",
      pass: threads.length === 0 || tagged.length === threads.length,
      detail: { total: threads.length, tagged: tagged.length, sample: tagged.slice(0, 3) },
    });

    const surface = await page.evaluate(() => {
      const r = document.querySelector(".cmcp-root");
      if (!r) return { found: false };
      return {
        found: true,
        width: getComputedStyle(r).getPropertyValue("--cmcp-surface-width").trim(),
        surface: r.dataset.surface,
      };
    });
    results.push({
      check: "A2UI surface seam (--cmcp-surface-width on .cmcp-root)",
      pass: !surface.found || surface.width === "100%" || surface.width === "",
      detail: surface,
    });

    const failed = results.filter((r) => !r.pass);
    console.log(JSON.stringify({ base: BASE, results, pass: failed.length === 0 }, null, 2));
    process.exit(failed.length ? 1 : 0);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});