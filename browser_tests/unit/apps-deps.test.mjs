// Unit tests for the apps dependency side-panel's core-vs-custom node
// classification (regression: hidden-workflow apps listed core nodes like
// EmptyImage / PreviewImage as uninstallable "custom nodes").
import test from 'node:test'
import assert from 'node:assert/strict'

import { isCoreNodeModule } from '../../web/js/cmcp-apps-ui.js'

test('core ComfyUI modules are recognized as core', () => {
  assert.equal(isCoreNodeModule('nodes'), true)
  assert.equal(isCoreNodeModule('comfy_extras'), true)
  assert.equal(isCoreNodeModule('comfy_extras.nodes_mask'), true)
  assert.equal(isCoreNodeModule('comfy_extras.nodes_images'), true)
})

test('custom node pack modules are not core', () => {
  assert.equal(isCoreNodeModule('custom_nodes.comfyui-manager'), false)
  assert.equal(isCoreNodeModule('custom_nodes.was-node-suite'), false)
  // Prefix must match on a module boundary, not a substring.
  assert.equal(isCoreNodeModule('comfy_extrasx.evil'), false)
  assert.equal(isCoreNodeModule('nodes2'), false)
})

test('unknown or missing python_module is NOT treated as core', () => {
  assert.equal(isCoreNodeModule(undefined), false)
  assert.equal(isCoreNodeModule(null), false)
  assert.equal(isCoreNodeModule(''), false)
})
