import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { voiceRecognitionLang } from '../../web/js/lib/voice-language.js'

// #1289 — dictation set recognition.lang from navigator.language alone, so a user
// who picked a panel (or ComfyUI) language different from their browser's dictated
// into a recognizer listening for the WRONG language.

test('#1289 the panel locale wins over the browser language', () => {
  assert.equal(voiceRecognitionLang({ panelLocale: 'fr', browserLang: 'en-US' }), 'fr')
  assert.equal(voiceRecognitionLang({ panelLocale: 'pt-BR', browserLang: 'de-DE' }), 'pt-BR')
  // Regional panel codes are valid BCP-47 tags and pass through untouched.
  assert.equal(voiceRecognitionLang({ panelLocale: 'zh-TW', browserLang: 'en-US' }), 'zh-TW')
})

test('#1289 an unresolved panel locale defers to the browser', () => {
  assert.equal(voiceRecognitionLang({ panelLocale: '', browserLang: 'ja-JP' }), 'ja-JP')
  assert.equal(voiceRecognitionLang({ browserLang: 'ko-KR' }), 'ko-KR')
})

test('#1289 lang is never empty — en-US is the floor', () => {
  assert.equal(voiceRecognitionLang({}), 'en-US')
  assert.equal(voiceRecognitionLang({ panelLocale: '', browserLang: '' }), 'en-US')
  assert.equal(voiceRecognitionLang(), 'en-US')
})

test('#1289 WIRED: the composer hands the recognizer the PANEL locale, not raw navigator.language', () => {
  // The helper nothing calls is inert, and the old line is the bug itself — pin both.
  const src = readFileSync(new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ voiceRecognitionLang \} from "\.\/lib\/voice-language\.js";/)

  const assign = src.indexOf('recognition.lang =')
  assert.ok(assign > 0, 'recognition.lang is set')
  const line = src.slice(assign, src.indexOf('\n', assign))
  assert.match(line, /voiceRecognitionLang\(\{ panelLocale: currentLocale\(\), browserLang: navigator\.language \}\)/)
  assert.ok(
    !src.includes('recognition.lang = navigator.language'),
    'the raw navigator.language assignment is retired',
  )
})
