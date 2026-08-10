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
const BASELINE_FILE = join(tmpdir(), 'cmcp-e2e-workflow-baseline.json')

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
    const req = send(target, { method, agent: false }, (res) => {
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
    rmSync(BASELINE_FILE, { force: true })
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
  mkdirSync(dirname(BASELINE_FILE), { recursive: true })
  writeFileSync(BASELINE_FILE, JSON.stringify(before), 'utf-8')
}

function readBaseline(): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'))
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

  const remaining = (await listWorkflows()) ?? after
  const { undeleted, unrecognised } = leakReport(before, remaining, planned)
  rmSync(BASELINE_FILE, { force: true })

  if (planned.length) {
    console.log(`[e2e] removed ${planned.length - undeleted.length} saved workflow(s) this run (#907).`)
  }
  if (undeleted.length || unrecognised.length) {
    const lines = [
      `[e2e] SAVED-WORKFLOW LEAK (#907) — the suite left files in the user's workflow library.`,
    ]
    if (undeleted.length) {
      lines.push(
        `  ${undeleted.length} recognised file(s) could NOT be deleted, so the cleanup itself is broken: ` +
          undeleted.slice(0, 10).join(', '),
      )
    }
    if (unrecognised.length) {
      lines.push(
        `  ${unrecognised.length} new file(s) match no pattern the suite knows: ` +
          unrecognised.slice(0, 10).join(', ') +
          `. If a spec started saving under a new name, add it to LITTER_PATTERNS; if this was ` +
          `saved by hand while the suite ran, it is safe to ignore.`,
      )
    }
    throw new Error(lines.join('\n'))
  }
}
