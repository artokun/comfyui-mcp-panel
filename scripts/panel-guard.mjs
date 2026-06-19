#!/usr/bin/env node
// panel-guard.mjs — dev-time guardian for the live-served panel bundle.
//
// web/js/*.js is served LIVE to ComfyUI through the custom_nodes junction, so a
// single syntactically-broken save (a stray ``` fence, a bad optional-chaining
// assignment, a half-finished edit) doesn't just break this panel — it throws
// in ComfyUI's extension loader and blacks out the ENTIRE frontend (no sidebar).
//
// This watcher keeps a ring of the last-known-good version of every web/js file
// and INSTANTLY restores it whenever a save fails `node --check`, so a fumbled
// edit can never take down ComfyUI. Run it in a spare terminal while editing:
//
//     node scripts/panel-guard.mjs
//
// It only ever writes a file back to a version that previously parsed — it never
// invents content. Snapshots live in .panel-guard/ (gitignored).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Defaults to the repo root; PANEL_GUARD_ROOT overrides it (used by the test).
const ROOT = process.env.PANEL_GUARD_ROOT
  ? path.resolve(process.env.PANEL_GUARD_ROOT)
  : path.resolve(__dirname, "..");
const WATCH_DIR = path.join(ROOT, "web", "js");
const SNAP_DIR = path.join(ROOT, ".panel-guard");
const KEEP = 10; // history depth per file
const DEBOUNCE_MS = 300;

const lastGood = new Map(); // absFile -> { content, hash }
const timers = new Map(); // absFile -> timeout

fs.mkdirSync(SNAP_DIR, { recursive: true });

const rel = (abs) => path.relative(WATCH_DIR, abs).split(path.sep).join("/");
const snapKey = (abs) => rel(abs).replace(/[\\/]/g, "__");
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const log = (...a) => console.log(`[panel-guard ${new Date().toLocaleTimeString()}]`, ...a);

function isValidJs(abs) {
  const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || "").trim() };
}

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function snapshotsFor(abs) {
  const prefix = `${snapKey(abs)}.`;
  return fs
    .readdirSync(SNAP_DIR)
    .filter((f) => f.startsWith(prefix))
    .sort(); // ISO timestamps sort chronologically
}

function saveSnapshot(abs, content) {
  const h = sha(content);
  const prev = lastGood.get(abs);
  if (prev && prev.hash === h) return; // unchanged — skip (also breaks restore loop)
  lastGood.set(abs, { content, hash: h });
  try {
    fs.writeFileSync(path.join(SNAP_DIR, `${snapKey(abs)}.${stamp()}.${h}.js`), content);
    const mine = snapshotsFor(abs);
    for (const f of mine.slice(0, Math.max(0, mine.length - KEEP))) {
      try {
        fs.unlinkSync(path.join(SNAP_DIR, f));
      } catch {}
    }
    log(`✓ snapshot ${rel(abs)} (${h})`);
  } catch (e) {
    log("snapshot write failed:", e.message);
  }
}

function loadLatestSnapshot(abs) {
  const mine = snapshotsFor(abs);
  if (!mine.length) return null;
  try {
    return fs.readFileSync(path.join(SNAP_DIR, mine[mine.length - 1]), "utf8");
  } catch {
    return null;
  }
}

function check(abs) {
  if (!fs.existsSync(abs)) return;
  const { ok, err } = isValidJs(abs);
  if (ok) {
    saveSnapshot(abs, fs.readFileSync(abs, "utf8"));
    return;
  }
  const good = lastGood.get(abs)?.content ?? loadLatestSnapshot(abs);
  log(`✗ BROKEN save: ${rel(abs)}`);
  if (err) log("   " + err.split("\n").find((l) => l.trim()) || err);
  if (good == null) {
    log("   ⚠ no known-good snapshot yet — cannot auto-restore. FIX THIS FILE manually.");
    return;
  }
  try {
    fs.writeFileSync(abs, good);
    log(`   ↩ restored last-good ${rel(abs)} — ComfyUI frontend protected. Re-apply your edit cleanly.`);
  } catch (e) {
    log("   restore failed:", e.message);
  }
}

function schedule(abs) {
  clearTimeout(timers.get(abs));
  timers.set(abs, setTimeout(() => check(abs), DEBOUNCE_MS));
}

if (!fs.existsSync(WATCH_DIR)) {
  console.error(`panel-guard: ${WATCH_DIR} not found — run from the repo root.`);
  process.exit(1);
}

log(`watching web/js (snapshots → .panel-guard/, keep ${KEEP} per file)`);
for (const abs of listJs(WATCH_DIR)) {
  const { ok } = isValidJs(abs);
  if (ok) {
    saveSnapshot(abs, fs.readFileSync(abs, "utf8"));
  } else {
    const good = loadLatestSnapshot(abs);
    if (good != null) {
      fs.writeFileSync(abs, good);
      log(`↩ ${rel(abs)} was broken at startup — restored from snapshot`);
    } else {
      log(`⚠ ${rel(abs)} is broken and has no snapshot — fix it manually`);
    }
  }
}

fs.watch(WATCH_DIR, { recursive: true }, (_evt, name) => {
  if (!name || !String(name).endsWith(".js")) return;
  schedule(path.join(WATCH_DIR, String(name)));
});

log("ready — edit away; broken saves auto-revert.");
