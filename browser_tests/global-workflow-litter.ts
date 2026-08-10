/**
 * #907 — suite-level cleanup for the workflows the e2e specs really persist.
 *
 * Playwright runs `globalSetup` before any worker and `globalTeardown` after the
 * last one, which is the only place that can see the whole run. Per-spec cleanup
 * cannot: it lives at the end of a test body and therefore does not run when the
 * test fails — precisely when it matters.
 *
 * The baseline is passed between the two halves through a file rather than
 * module state, because Playwright may run them in different processes.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { leakReport, plannedDeletions, workflowUserdataPath } from './fixtures/workflow-litter'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8188'
/** #907 — the fixture must delete against the SAME instance it observed a write on. */
export const COMFY_BASE_URL = BASE_URL
/**
 * PER RUN, not per machine (codex). A shared, predictable path let two runs
 * against one ComfyUI overwrite each other's ownership record — and then run A's
 * teardown would delete files run B was still using, judged against a baseline
 * that was never A's. globalSetup and globalTeardown share a process, so the env
 * var carries it; the pid-named file is the fallback.
 */
const BASELINE_ENV = 'CMCP_E2E_WORKFLOW_BASELINE'
function BASELINE_FILE_PATH(): string {
  const named = process.env[BASELINE_ENV]
  if (named) return named
  const path = join(tmpdir(), `cmcp-e2e-workflow-baseline-${process.pid}.json`)
  process.env[BASELINE_ENV] = path
  return path
}

/**
 * NOT `fetch`. Global fetch is undici, whose connection pool outlives these
 * hooks: with it, a PASSING single-spec run exited 127 on Windows with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — a native abort
 * during teardown, after the result was already printed. A green suite that
 * exits non-zero fails CI on every run, which is a worse defect than the litter
 * this file exists to clear.
 *
 * `agent: false` gives each request its own socket and closes it on response, so
 * nothing is left for the process to tear down.
 */
function httpJson(method: 'GET' | 'DELETE', url: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      resolve(null)
      return
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    // BOUNDED (codex). A server that accepts the connection and never ends the
    // response would hang setup or teardown forever — wedging CI rather than
    // failing open, which is the opposite of every other guard here.
    const req = send(target, { method, agent: false, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300
        if (!ok) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch {
          resolve(method === 'DELETE' ? true : null) // a DELETE need not return JSON
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

async function listWorkflows(): Promise<string[] | null> {
  const body = await httpJson('GET', `${BASE_URL}/api/userdata?dir=workflows`)
  return Array.isArray(body) ? body.filter((n): n is string => typeof n === 'string') : null
}

/**
 * Record what the developer's workflow library held BEFORE the run.
 *
 * FAILS OPEN, DELIBERATELY. If ComfyUI cannot be listed we write no baseline,
 * and the teardown then deletes NOTHING. The alternative — treating an
 * unreadable listing as "the directory was empty" — would make every file in it
 * look new, and this code deletes files. An unrunnable cleanup is a bad day; a
 * cleanup that deletes someone's workflows because a fetch failed is
 * unrecoverable.
 */
export async function recordWorkflowBaseline(): Promise<void> {
  const before = await listWorkflows()
  try {
    rmSync(BASELINE_FILE_PATH(), { force: true })
  } catch {
    /* nothing to clear */
  }
  if (!before) {
    console.warn(
      '[e2e] could not list workflows before the run — saved-workflow cleanup is DISABLED for it ' +
        '(#907). Nothing will be deleted.',
    )
    return
  }
  mkdirSync(dirname(BASELINE_FILE_PATH()), { recursive: true })
  writeFileSync(BASELINE_FILE_PATH(), JSON.stringify(before), 'utf-8')
}

function readBaseline(): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_FILE_PATH(), 'utf-8'))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Delete what the run added, then CHECK — and fail the run if the check does not
 * come back clean.
 *
 * The check is the point. #907 is not "the suite saves files", it is that 1269
 * of them accumulated with nobody noticing. A cleanup with no assertion behind
 * it is the same silence one layer down: it would go on reporting success while
 * quietly matching nothing.
 */
export async function cleanWorkflowLitter(): Promise<void> {
  const before = readBaseline()
  if (!before) return // fail-open: no baseline, no deletions
  const after = await listWorkflows()
  if (!after) {
    console.warn('[e2e] could not list workflows after the run — skipping cleanup (#907).')
    return
  }

  const planned = plannedDeletions(before, after)
  for (const name of planned) {
    // A failure here is not swallowed — it shows up as `undeleted` below.
    await httpJson(
      'DELETE',
      `${BASE_URL}/api/userdata/${encodeURIComponent(workflowUserdataPath(name))}`,
    )
  }

  // If the CHECK cannot be taken, say so — do not treat a failed listing as proof
  // that every delete failed (codex). The old `?? after` did exactly that, and
  // would have failed a green run on a transient read error.
  const remaining = await listWorkflows()
  rmSync(BASELINE_FILE_PATH(), { force: true })
  if (!remaining) {
    console.warn(
      `[e2e] removed ${planned.length} saved workflow(s), but the directory could not be re-read, ` +
        `so the cleanup is UNVERIFIED for this run (#907).`,
    )
    return
  }

  const { undeleted, unrecognised } = leakReport(before, remaining, planned)
  if (planned.length) {
    console.log(`[e2e] removed ${planned.length - undeleted.length} saved workflow(s) this run (#907).`)
  }

  // A NEW FILE WE DID NOT MAKE IS NOT A FAILURE (codex). A developer saving
  // something while the suite runs is normal, and failing their run for it — with
  // a message that itself said "safe to ignore" — teaches people to distrust the
  // check. Warn and name it, so a spec that starts saving under a new name still
  // surfaces.
  if (unrecognised.length) {
    console.warn(
      `[e2e] ${unrecognised.length} workflow(s) appeared during this run that the suite does not ` +
        `recognise: ${unrecognised.slice(0, 10).join(', ')}. Left alone. If a spec started saving ` +
        `under a new name, add it to LITTER_PATTERNS (#907).`,
    )
  }

  // THIS is the failure: we recognised the file as ours, tried to delete it, and it
  // is still there — the cleanup itself has stopped working. That is the silence
  // that let 1269 files accumulate, so it has to be loud.
  if (undeleted.length) {
    throw new Error(
      `[e2e] SAVED-WORKFLOW CLEANUP IS BROKEN (#907): ${undeleted.length} file(s) the suite created ` +
        `could not be deleted: ${undeleted.slice(0, 10).join(', ')}`,
    )
  }
}

/**
 * Delete one workflow by its userdata path (#907), straight over HTTP.
 *
 * Exported so the per-test fixture can sweep what a page WROTE even after that page has
 * been closed — a spec that calls `pageB.close()` takes its in-page record with it, and
 * the last leak of a full suite run was exactly that. A 404 is success: the file is gone,
 * which is the objective.
 */
export async function deleteWorkflowByPath(userdataPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/userdata/${encodeURIComponent(userdataPath)}`, {
      method: "DELETE",
    })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}
