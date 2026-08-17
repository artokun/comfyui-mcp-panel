import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { isEmbeddedDesktopShell, voiceInputSupport } from '../../web/js/lib/voice-support.js'

// #1290 — the mic button was gated on the SpeechRecognition API object EXISTING.
// The ComfyUI desktop app's Electron shell exposes webkitSpeechRecognition but
// has no speech service behind it, so dictation could never work there and the
// button still looked ready — every click failed instead of saying so.

class FakeSR {}

test('#1290 a desktop shell is detected from the Electron bridge or the UA token', () => {
  assert.equal(isEmbeddedDesktopShell({ electronBridge: {} }), true)
  assert.equal(isEmbeddedDesktopShell({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0.0.0 Electron/31.0.0' }), true)
  assert.equal(isEmbeddedDesktopShell({ electronBridge: {}, userAgent: '' }), true)
  assert.equal(
    isEmbeddedDesktopShell({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' }),
    false,
  )
  assert.equal(isEmbeddedDesktopShell({}), false)
})

test('#1290 no API object at all keeps the plain not-supported reason', () => {
  const v = voiceInputSupport({ SR: undefined, desktopShell: false })
  assert.equal(v.supported, false)
  assert.equal(v.title, 'Voice input is not supported in this browser')
})

test('#1290 an API object in a desktop shell is UNSUPPORTED — and the title names the remedy', () => {
  const v = voiceInputSupport({ SR: FakeSR, desktopShell: true })
  assert.equal(v.supported, false)
  assert.match(v.title, /desktop app/, 'says WHERE dictation is unavailable')
  assert.match(v.title, /speech-recognition service/, 'says WHY')
  assert.match(v.title, /Chrome or Edge/, 'says what to do instead')
})

test('#1290 an API object in a plain browser is supported, with no title to show', () => {
  const v = voiceInputSupport({ SR: FakeSR, desktopShell: false })
  assert.deepEqual(v, { supported: true })
})

test('#1290 WIRED: the mic button and the click handler both consult the support verdict', () => {
  const src = readFileSync(new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ isEmbeddedDesktopShell, voiceInputSupport \} from "\.\/lib\/voice-support\.js";/)

  // The verdict is computed once, from the API object AND the desktop-shell check.
  assert.match(src, /const voiceSupport = voiceInputSupport\(\{/)
  assert.match(src, /desktopShell: isEmbeddedDesktopShell\(\{/)

  // The button is disabled with the verdict's OWN title — no inline string that
  // could drift from the lib's reason.
  assert.match(src, /micBtn\.disabled = true;\s*\n\s*micBtn\.title = voiceSupport\.title;/)

  // The click path refuses on the verdict too, so a stale listener cannot start
  // a backend-less session.
  assert.match(src, /if \(!voiceSupport\.supported\) return;/)
  assert.ok(!src.includes('if (!SR) return;'), 'the API-exists-only guard is retired')
})
