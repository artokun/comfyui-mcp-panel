/**
 * Tier 1 — graph_connect auto-match by type + full-slot failure diagnostics.
 *
 * Exercises the upgraded `graph_connect` executor (web/js/comfyui-mcp-panel.js:
 * autoMatchSlots / slotDiagnostic) against the LIVE LiteGraph graph. The panel
 * receives { rid, cmd:"graph_connect", ... } from the MockBridge exactly as the
 * real orchestrator would, runs the executor, and replies { rid, ok, result }.
 * We drive that round-trip with `mockBridge.command(...)` and assert on the
 * reply — no real agent, no ComfyUI node registry dependency (nodes are built
 * in-page as throwaway LiteGraph node types with precise slot shapes).
 *
 * Covers the spec's six cases (docs/design/connect-auto-match.md §Test plan):
 *   1. omitted to_input auto-matches clip ← CLIP
 *   2. CONDITIONING ambiguity errors with both slot names + [connected] markers
 *   3. auto_match:false + omitted slots reproduces legacy index-0 behavior
 *   4. explicit wrong name errors with the full slot listing
 *   5. reconnect over a connected input reports replaced_link
 *   6. wildcard ("*") connects but loses to an exact-type match
 *
 * NOTE: like the rest of the Tier 1 suite this needs a real ComfyUI running at
 * PLAYWRIGHT_BASE_URL (see playwright.config.ts). It does not need any specific
 * custom nodes — the graph is synthesized in-page.
 */
import { test, expect } from './fixtures/panelTest'
import type { Page } from '@playwright/test'

interface SlotSpec {
  name: string
  type: string
  widget?: boolean
}
interface NodeSpec {
  title: string
  outputs?: SlotSpec[]
  inputs?: SlotSpec[]
}

/**
 * Reset app.graph and build a set of throwaway LiteGraph nodes with the exact
 * slot shapes a test wants. Returns the assigned node ids, one per spec (order
 * preserved). Runs entirely in the page against window.LiteGraph / app.graph.
 */
async function buildGraph(page: Page, specs: NodeSpec[]): Promise<number[]> {
  return page.evaluate((nodeSpecs: NodeSpec[]) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LiteGraph = w.LiteGraph
    const graph = app?.canvas?.graph ?? app?.graph
    if (!app || !LiteGraph || !graph) throw new Error('graph unavailable')

    const TYPE = 'cmcp_test/matcher_node'
    if (!LiteGraph.registered_node_types?.[TYPE]) {
      class CmcpMatcherNode extends LiteGraph.LGraphNode {}
      LiteGraph.registerNodeType(TYPE, CmcpMatcherNode)
    }

    graph.clear()
    const ids: number[] = []
    for (const spec of nodeSpecs) {
      const node = LiteGraph.createNode(TYPE)
      // Label used by slotDiagnostic (origin.type / target.type).
      node.title = spec.title
      node.type = spec.title
      for (const o of spec.outputs ?? []) node.addOutput(o.name, o.type)
      for (const i of spec.inputs ?? []) {
        node.addInput(i.name, i.type)
        const slot = node.inputs[node.inputs.length - 1]
        // Mark widget-converted inputs the way ComfyUI does — ranked last for
        // auto-match and tagged (TYPE/widget) in diagnostics.
        if (i.widget) slot.widget = { name: i.name }
      }
      graph.add(node)
      ids.push(node.id)
    }
    return ids
  }, specs)
}

/** Bring the panel up and connected to the MockBridge. */
async function connectPanel(panel: any, mockBridge: any): Promise<void> {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
}

const CHECKPOINT: NodeSpec = {
  title: 'CheckpointLoaderSimple',
  outputs: [
    { name: 'MODEL', type: 'MODEL' },
    { name: 'CLIP', type: 'CLIP' },
    { name: 'VAE', type: 'VAE' }
  ]
}

test('1. omitted to_input auto-matches clip ← CLIP', async ({ panel, mockBridge }) => {
  await connectPanel(panel, mockBridge)
  const [ckpt, enc] = await buildGraph(panel.page, [
    CHECKPOINT,
    {
      title: 'CLIPTextEncode',
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
      inputs: [
        { name: 'clip', type: 'CLIP' },
        { name: 'text', type: 'STRING', widget: true }
      ]
    }
  ])

  const reply = await mockBridge.command('graph_connect', {
    from_node_id: ckpt,
    from_output: 'CLIP',
    to_node_id: enc
    // to_input omitted → auto-match by type
  })

  expect(reply.ok).toBe(true)
  expect(reply.result.connected.to.input).toBe('clip')
  expect(reply.result.connected.from.output).toBe('CLIP')
  expect(reply.result.connected.type).toBe('CLIP')
  expect(reply.result.connected.auto_matched).toContain('to_input')
})

test('2. CONDITIONING ambiguity errors with both slot names + [connected] marker', async ({
  panel,
  mockBridge
}) => {
  await connectPanel(panel, mockBridge)
  const [ckpt, enc, ksampler] = await buildGraph(panel.page, [
    CHECKPOINT,
    {
      title: 'CLIPTextEncode',
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
      inputs: [{ name: 'clip', type: 'CLIP' }]
    },
    {
      title: 'KSampler',
      inputs: [
        { name: 'model', type: 'MODEL' },
        { name: 'positive', type: 'CONDITIONING' },
        { name: 'negative', type: 'CONDITIONING' },
        { name: 'latent_image', type: 'LATENT' },
        { name: 'seed', type: 'INT', widget: true }
      ]
    }
  ])

  // Wire model first so the diagnostic shows a [connected] marker.
  const pre = await mockBridge.command('graph_connect', {
    from_node_id: ckpt,
    from_output: 'MODEL',
    to_node_id: ksampler,
    to_input: 'model'
  })
  expect(pre.ok).toBe(true)

  const reply = await mockBridge.command('graph_connect', {
    from_node_id: enc,
    from_output: 'CONDITIONING',
    to_node_id: ksampler
    // to_input omitted → two CONDITIONING inputs → ambiguous
  })

  expect(reply.ok).toBe(false)
  expect(reply.error).toContain('ambiguous')
  expect(reply.error).toContain('positive')
  expect(reply.error).toContain('negative')
  expect(reply.error).toContain('[connected]')
  // widget-converted input is tagged
  expect(reply.error).toContain('INT/widget')
})

test('3. auto_match:false + omitted slots reproduces legacy index-0 behavior', async ({
  panel,
  mockBridge
}) => {
  await connectPanel(panel, mockBridge)
  const [ckpt, ksampler] = await buildGraph(panel.page, [
    CHECKPOINT,
    {
      title: 'KSampler',
      inputs: [
        { name: 'model', type: 'MODEL' },
        { name: 'positive', type: 'CONDITIONING' }
      ]
    }
  ])

  const reply = await mockBridge.command('graph_connect', {
    from_node_id: ckpt,
    to_node_id: ksampler,
    auto_match: false
    // both slots omitted → legacy index 0 → MODEL(out 0) → model(in 0)
  })

  expect(reply.ok).toBe(true)
  expect(reply.result.connected.from.output_index).toBe(0)
  expect(reply.result.connected.to.input_index).toBe(0)
  expect(reply.result.connected.from.output).toBe('MODEL')
  expect(reply.result.connected.to.input).toBe('model')
  expect(reply.result.connected.auto_matched).toBeUndefined()
})

test('4. explicit wrong name errors with the full slot listing', async ({
  panel,
  mockBridge
}) => {
  await connectPanel(panel, mockBridge)
  const [ckpt, ksampler] = await buildGraph(panel.page, [
    CHECKPOINT,
    {
      title: 'KSampler',
      inputs: [{ name: 'model', type: 'MODEL' }]
    }
  ])

  const reply = await mockBridge.command('graph_connect', {
    from_node_id: ckpt,
    from_output: 'NONEXISTENT',
    to_node_id: ksampler,
    to_input: 'model'
  })

  expect(reply.ok).toBe(false)
  // Full slot listing: every output named, plus the echoed request.
  expect(reply.error).toContain('from_output="NONEXISTENT"')
  expect(reply.error).toContain('outputs:')
  expect(reply.error).toContain('MODEL')
  expect(reply.error).toContain('CLIP')
  expect(reply.error).toContain('VAE')
  expect(reply.error).toContain('inputs:')
})

test('5. reconnect over a connected input reports replaced_link', async ({
  panel,
  mockBridge
}) => {
  await connectPanel(panel, mockBridge)
  const [ckptA, ckptB, ksampler] = await buildGraph(panel.page, [
    CHECKPOINT,
    CHECKPOINT,
    {
      title: 'KSampler',
      inputs: [{ name: 'model', type: 'MODEL' }]
    }
  ])

  const first = await mockBridge.command('graph_connect', {
    from_node_id: ckptA,
    from_output: 'MODEL',
    to_node_id: ksampler,
    to_input: 'model'
  })
  expect(first.ok).toBe(true)

  const second = await mockBridge.command('graph_connect', {
    from_node_id: ckptB,
    from_output: 'MODEL',
    to_node_id: ksampler,
    to_input: 'model'
  })
  expect(second.ok).toBe(true)
  expect(second.result.connected.replaced_link).toBeTruthy()
  expect(second.result.connected.replaced_link.node_id).toBe(ckptA)
  expect(second.result.connected.replaced_link.output).toBe('MODEL')
})

test('6. wildcard ("*") connects but loses to an exact-type match', async ({
  panel,
  mockBridge
}) => {
  await connectPanel(panel, mockBridge)
  // A reroute-style origin with BOTH a "*" wildcard output and an exact MODEL
  // output. Auto-match to a MODEL input must prefer the exact output (index 1),
  // proving wildcard is ranked below exact.
  const [reroute, ksampler] = await buildGraph(panel.page, [
    {
      title: 'Reroute',
      outputs: [
        { name: 'wild', type: '*' },
        { name: 'MODEL', type: 'MODEL' }
      ]
    },
    {
      title: 'KSampler',
      inputs: [{ name: 'model', type: 'MODEL' }]
    }
  ])

  const reply = await mockBridge.command('graph_connect', {
    from_node_id: reroute,
    to_node_id: ksampler
    // both omitted → exact MODEL→model must beat "*"→model
  })

  expect(reply.ok).toBe(true)
  expect(reply.result.connected.from.output_index).toBe(1)
  expect(reply.result.connected.from.output).toBe('MODEL')
  expect(reply.result.connected.type).toBe('MODEL')

  // And a pure wildcard source still connects (wildcard is compatible, just
  // lower-ranked): a lone "*" output auto-matches the MODEL input.
  const [rerouteOnly, ks2] = await buildGraph(panel.page, [
    { title: 'Reroute', outputs: [{ name: 'wild', type: '*' }] },
    { title: 'KSampler', inputs: [{ name: 'model', type: 'MODEL' }] }
  ])
  const wildReply = await mockBridge.command('graph_connect', {
    from_node_id: rerouteOnly,
    to_node_id: ks2
  })
  expect(wildReply.ok).toBe(true)
  expect(wildReply.result.connected.to.input).toBe('model')
})
