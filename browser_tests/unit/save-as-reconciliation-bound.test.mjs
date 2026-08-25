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

test('#939 four ownership losses refuse only after repairing the active canvas', async () => {
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
    { path: 'workflows/a.json', uuid: 'a', changeTracker: { activeState: { nodes: [{ id: 'a' }], extra: {} } } },
    { path: 'workflows/b.json', uuid: 'b', changeTracker: { activeState: { nodes: [{ id: 'b' }], extra: {} } } },
    { path: 'workflows/c.json', uuid: 'c', changeTracker: { activeState: { nodes: [{ id: 'c' }], extra: {} } } },
    { path: 'workflows/d.json', uuid: 'd', changeTracker: { activeState: { nodes: [{ id: 'd' }], extra: {} } } }
  ]
  let loads = 0
  let canvasPayload = null
  globalThis.__cmcp939Active = copy
  globalThis.app = {
    graph: { _nodes: [], extra: {} },
    canvas: null,
    loadGraphData: async (payload) => {
      await Promise.resolve()
      // The first four loads lose ownership to A, B, C, and D. The fifth load is
      // the bounded terminal repair and must bind the shared canvas to D rather
      // than leaving C's payload visible under D's active record.
      globalThis.__cmcp939Active = successors[Math.min(loads, successors.length - 1)]
      loads += 1
      globalThis.app.graph.extra = payload.extra
      globalThis.app.graph._nodes = payload.nodes ?? []
      canvasPayload = payload
    }
  }

  try {
    await assert.rejects(
      repaintSaveAsCanvas(copy, copy.path, {
        canvasFence: (workflow) => globalThis.__cmcp939Active === workflow
      }),
      /entered an unsafe state.*safely repaired \(active\)/
    )
    assert.equal(loads, 5, 'four failed loads plus exactly one bounded repair load')
    assert.equal(globalThis.__cmcp939Active, successors[3], 'the newest active record is never overwritten')
    assert.deepEqual(canvasPayload.nodes, successors[3].changeTracker.activeState.nodes, 'canvas payload belongs to active D')
    assert.equal(globalThis.app.graph.extra.comfyui_mcp.workflow_uuid, successors[3].uuid)
    assert.equal(globalThis.app.graph.extra.comfyui_mcp.workflow_path, successors[3].path)
  } finally {
    delete globalThis.__cmcp939Active
    delete globalThis.app
  }
})

test('#939 a continuously changing active tab gets a bounded neutral canvas before refusal', async () => {
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
    path: 'workflows/copy-neutral.json',
    uuid: 'copy-neutral',
    changeTracker: { activeState: { nodes: [{ id: 'copy' }], extra: {} } }
  }
  const successors = Array.from({ length: 8 }, (_, index) => ({
    path: `workflows/${String.fromCharCode(97 + index)}-neutral.json`,
    uuid: String.fromCharCode(97 + index),
    changeTracker: { activeState: { nodes: [{ id: String.fromCharCode(97 + index) }], extra: {} } }
  }))
  let loads = 0
  globalThis.__cmcp939Active = copy
  globalThis.app = {
    graph: { _nodes: [], extra: {} },
    canvas: null,
    loadGraphData: async (payload) => {
      await Promise.resolve()
      if (payload.nodes.length > 0) {
        globalThis.__cmcp939Active = successors[Math.min(loads, successors.length - 1)]
      }
      loads += 1
      globalThis.app.graph.extra = payload.extra
      globalThis.app.graph._nodes = payload.nodes ?? []
    }
  }

  try {
    await assert.rejects(
      () =>
        repaintSaveAsCanvas(copy, copy.path, {
          canvasFence: (workflow) => globalThis.__cmcp939Active === workflow
        }),
      /entered an unsafe state.*safely repaired \(neutral\)/
    )
    assert.equal(loads, 9, 'four repaint loads, four repair loads, and one neutralizing load')
    assert.equal(globalThis.__cmcp939Active, successors[7], 'the last active tab remains selected')
    assert.deepEqual(globalThis.app.graph._nodes, [], 'the neutral canvas has no stale payload nodes')
    assert.equal(globalThis.app.graph.extra.comfyui_mcp?.workflow_path, undefined, 'neutral canvas has no stale path')
  } finally {
    delete globalThis.__cmcp939Active
    delete globalThis.app
  }
})
