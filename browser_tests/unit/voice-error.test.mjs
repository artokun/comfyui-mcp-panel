import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { describeVoiceError } from '../../web/js/lib/voice-error.js'

// #1288 — a Web Speech error code is an identifier, not an explanation. In a
// Chromium fork "network" is the DEFAULT outcome (no server-side speech service
// ships outside Google Chrome / Microsoft Edge), so the bare code sent users
// debugging a network that was never the problem.

test('#1288 network names the real cause and the browsers that CAN dictate', () => {
  const msg = describeVoiceError('network')
  assert.equal(typeof msg, 'string')
  // The raw code stays in the message — it is what a search for the symptom finds.
  assert.match(msg, /"network"/)
  assert.match(msg, /speech-recognition service/, 'says WHAT actually failed')
  assert.match(msg, /Chrome/, 'names a browser where dictation works')
  assert.match(msg, /Edge/, 'names the other browser where dictation works')
})

test('#1288 a blocked mic points at the permission, keeping its own code', () => {
  for (const code of ['not-allowed', 'service-not-allowed']) {
    const msg = describeVoiceError(code)
    assert.match(msg, new RegExp(`"${code}"`), `${code} keeps its raw code`)
    assert.match(msg, /microphone/i, `${code} says what to allow`)
  }
})

test('#1288 an unexplained code still surfaces — reported, never swallowed', () => {
  assert.equal(describeVoiceError('no-speech'), 'Voice input error: no-speech')
  assert.equal(describeVoiceError('audio-capture'), 'Voice input error: audio-capture')
  // A code this module has never heard of must still reach the user verbatim.
  assert.equal(describeVoiceError('future-code'), 'Voice input error: future-code')
})

test('#1288 "aborted" is the user pressing stop — no error line at all', () => {
  assert.equal(describeVoiceError('aborted'), null)
})

test('#1288 WIRED: the composer routes every recognition error through the describer', () => {
  // A describer nothing calls is inert, so pin the wiring, not just the module.
  const src = readFileSync(new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ describeVoiceError \} from "\.\/lib\/voice-error\.js";/)

  const listener = src.indexOf('recognition.addEventListener("error"')
  assert.ok(listener > 0, 'the error listener exists')
  const body = src.slice(listener, listener + 600)
  assert.match(body, /describeVoiceError\(ev\.error\)/, 'the listener asks for guidance')
  assert.match(body, /if \(msg\) appendSystem\(msg\)/, 'null (aborted) prints nothing')
  // The old shape printed the bare code with no guidance; it must be gone.
  assert.ok(
    !body.includes('if (ev.error !== "aborted")'),
    'the bare-code print is retired',
  )
})
