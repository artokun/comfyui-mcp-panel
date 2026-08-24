import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const PANEL = readFileSync(new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url), 'utf8')

function namedFunctionSource(src, name) {
  const start = src.indexOf(`async function ${name}(`)
  assert.notEqual(start, -1, `${name} not found`)
  const open = src.indexOf(') {', start) + 2
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  assert.fail(`${name} was not brace-balanced`)
}

test('#939 reconciliation is bounded when every awaited load loses ownership', async () => {
  const fn = namedFunctionSource(PANEL, 'repaintSaveAsCanvas')
  const repaintSaveAsCanvas = new Function(`
    const MAX_SAVE_AS_CANVAS_RECONCILIATIONS = 3
    const WORKFLOW_META_NAMESPACE = 'comfyui_mcp'
    const WORKFLOW_UUID_FIELD = 'workflow_uuid'
    const WORKFLOW_PATH_FIELD = 'workflow_path'
    const workflowStableUuid = (workflow) => workflow.uuid
    const sameWorkflowObject = (a, b) => a === b
    const normalizedWorkflowPath = (path) => path
    const activeWorkflowRef = () => globalThis.__cmcp939Active
    const liteGraphGlobal = () => null
    const loadGraphDataWithCompletionProof = async ({ load }) => {
      await load()
      return { completed: true }
    }
    ${fn}
    return repaintSaveAsCanvas
  `)()

  const copy = {
    path: 'workflows/copy.json',
    uuid: 'copy',
    changeTracker: { activeState: { nodes: [], extra: {} } }
  }
  const successors = [
    { path: 'workflows/a.json', uuid: 'a', changeTracker: { activeState: { nodes: [], extra: {} } } },
    { path: 'workflows/b.json', uuid: 'b', changeTracker: { activeState: { nodes: [], extra: {} } } },
    { path: 'workflows/c.json', uuid: 'c', changeTracker: { activeState: { nodes: [], extra: {} } } },
    { path: 'workflows/d.json', uuid: 'd', changeTracker: { activeState: { nodes: [], extra: {} } } }
  ]
  let loads = 0
  globalThis.__cmcp939Active = copy
  globalThis.app = {
    graph: { extra: {} },
    canvas: null,
    loadGraphData: async (payload) => {
      await Promise.resolve()
      globalThis.__cmcp939Active = successors[loads]
      loads += 1
      globalThis.app.graph.extra = payload.extra
    }
  }

  try {
    await assert.rejects(
      repaintSaveAsCanvas(copy, copy.path, {
        canvasFence: (workflow) => globalThis.__cmcp939Active === workflow
      }),
      /entered an unsafe state.*bounded loads/
    )
    assert.equal(loads, 4, 'initial repaint plus exactly three bounded reconciliations')
    assert.equal(globalThis.__cmcp939Active, successors[3], 'the newest active record is never overwritten')
  } finally {
    delete globalThis.__cmcp939Active
    delete globalThis.app
  }
})
