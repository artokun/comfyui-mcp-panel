#!/usr/bin/env node
// Bring Calliope up — clone, venv, install, start, and wait for /api/health — in one command.
//
// Calliope ships no Docker image and no single command; its README is six steps across two
// toolchains. That is a demo that dies on stage, so the steps live here, idempotently: every
// run first asks whether Calliope already answers on its port and stops there if it does. A
// second copy on the same port is the one failure this script must never cause.
//
//   node scripts/calliope-up.mjs             clone (pinned) + venv + install + start + wait
//   node scripts/calliope-up.mjs --check     just probe; exit 0 if reachable, 1 if not
//   node scripts/calliope-up.mjs --stop      stop the instance this script started (pidfile)
//   node scripts/calliope-up.mjs --dir D     use an existing checkout at D (default ~/.comfyui-mcp/calliope)
//   node scripts/calliope-up.mjs --update    move an existing checkout to the pinned ref
//
// Prints one JSON line at the end: { reachable, base_url, version, dir, pid, started }.
// Needs: git, Python 3.11+ on PATH (or `py` on Windows). ffmpeg is only needed to export a film.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Our fork. Upstream is benjiyaya/Calliope; the fork carries the fixes this module needs
// before they land upstream (first: PATCH can clear a nullable scene field) and is where
// we are free to deviate. Move the pin deliberately; the client snapshot is 1.2.1's API.
const REPO = process.env.CALLIOPE_REPO || "https://github.com/artokun/Calliope";
const PINNED_REF = process.env.CALLIOPE_REF || "73b0e79";
const HOST = "127.0.0.1";
const PORT = Number(process.env.CALLIOPE_PORT || 8247);
const BASE_URL = process.env.CALLIOPE_BASE_URL || `http://${HOST}:${PORT}`;
const WAIT_MS = 90_000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dir = resolve(opt("dir", process.env.CALLIOPE_DIR || join(homedir(), ".comfyui-mcp", "calliope")));
const backend = join(dir, "calliope-backend");
const venv = join(backend, ".venv");
const isWin = process.platform === "win32";
const venvPython = isWin ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
const pidFile = join(backend, "calliope.pid");
const logFile = join(backend, "calliope.log");

const log = (msg) => process.stderr.write(`[calliope-up] ${msg}\n`);
const done = (obj, code = 0) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
};

async function probe(timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: ctl.signal });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { reachable: true, version: typeof body.version === "string" ? body.version : undefined, dry_run: body.dry_run };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

function run(cmd, args, cwd, quiet = false) {
  const r = spawnSync(cmd, args, { cwd, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", windowsHide: true });
  if (r.error) throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}${quiet ? `\n${r.stderr}` : ""}`);
  return r.stdout ?? "";
}

/** A Python 3.11+ interpreter on PATH — `py -3` first on Windows, then the usual names. */
function findPython() {
  const candidates = isWin ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) {
      const [maj, min] = r.stdout.trim().split(".").map(Number);
      if (maj > 3 || (maj === 3 && min >= 11)) return { cmd, pre, version: r.stdout.trim() };
    }
  }
  return null;
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    const p = await probe(2000);
    if (p.reachable) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { reachable: false, error: `no answer on ${BASE_URL} after ${WAIT_MS / 1000}s — see ${logFile}` };
}

async function main() {
  if (flag("stop")) {
    if (!existsSync(pidFile)) done({ stopped: false, reason: "no pidfile — nothing this script started is running", dir });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      if (isWin) run("taskkill", ["/PID", String(pid), "/T", "/F"], backend, true);
      else process.kill(pid, "SIGTERM");
    } catch (err) {
      done({ stopped: false, pid, error: err instanceof Error ? err.message : String(err), dir }, 1);
    }
    done({ stopped: true, pid, dir });
  }

  const before = await probe();
  if (flag("check")) done({ ...before, base_url: BASE_URL, dir }, before.reachable ? 0 : 1);
  if (before.reachable) {
    log(`already answering on ${BASE_URL} (${before.version ?? "version unknown"}) — not starting a second copy`);
    done({ ...before, base_url: BASE_URL, dir, started: false });
  }

  // 1. checkout
  if (!existsSync(join(dir, ".git"))) {
    log(`cloning ${REPO} → ${dir}`);
    mkdirSync(resolve(dir, ".."), { recursive: true });
    run("git", ["clone", "--quiet", REPO, dir]);
    run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", PINNED_REF], dir);
  } else if (flag("update")) {
    log(`updating ${dir} to ${PINNED_REF}`);
    run("git", ["fetch", "--quiet", "origin"], dir);
    run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", PINNED_REF], dir);
  } else {
    log(`using existing checkout at ${dir} (pass --update to move it to ${PINNED_REF})`);
  }
  if (!existsSync(backend)) throw new Error(`${backend} is missing — not a Calliope checkout?`);

  // 2. venv
  if (!existsSync(venvPython)) {
    const py = findPython();
    if (!py) throw new Error("Python 3.11+ was not found on PATH (Calliope needs it). Install it and run again.");
    log(`creating venv with ${py.cmd} ${py.pre.join(" ")} (${py.version})`);
    run(py.cmd, [...py.pre, "-m", "venv", venv], backend);
  }

  // 3. install — once per checkout revision, so a re-run is quick
  const rev = run("git", ["rev-parse", "HEAD"], dir, true).trim();
  const marker = join(venv, `.installed-${rev}`);
  if (!existsSync(marker)) {
    log("installing calliope-backend into the venv (first run takes a few minutes)");
    run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], backend, true);
    try {
      run(venvPython, ["-m", "pip", "install", "--quiet", "-e", "."], backend, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Seen on Windows: pywin32 unpacks a path deep enough to trip MAX_PATH under a long
      // checkout directory. The default directory is short on purpose; say so.
      if (/WinError 206|filename or extension is too long/i.test(msg)) {
        throw new Error(`pip install failed: a file path inside the venv exceeds Windows' MAX_PATH. Use a shorter --dir (the default ${join(homedir(), ".comfyui-mcp", "calliope")} is fine) or enable long paths in Windows.
${msg}`);
      }
      throw err;
    }
    writeFileSync(marker, new Date().toISOString());
  }

  // 4. start, detached, logging to a file the failure message names
  log(`starting: python -m calliope.main --host ${HOST} --port ${PORT}`);
  const out = openSync(logFile, "a");
  const child = spawn(venvPython, ["-m", "calliope.main", "--host", HOST, "--port", String(PORT)], {
    cwd: backend,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));

  // 5. wait
  const after = await waitForHealth();
  done({ ...after, base_url: BASE_URL, dir, pid: child.pid, started: true }, after.reachable ? 0 : 1);
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  done({ reachable: false, error: err instanceof Error ? err.message : String(err), dir }, 1);
});
