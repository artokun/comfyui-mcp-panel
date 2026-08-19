import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { pickLocale } from '../../web/js/lib/i18n.js'
import { voiceRecognitionLang } from '../../web/js/lib/voice-language.js'

// #1289 — dictation set recognition.lang from navigator.language alone, so a user
// who picked a panel (or ComfyUI) language different from their browser's dictated
// into a recognizer listening for the WRONG language.
//
// #1329 — after #1289, currentLocale() (the shipped "en" UI-catalog floor) overrode
// a German speaker's de-DE. Dictation does not need a translation catalog.

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

test('#1329 the en panel floor does not override a non-English spoken language', () => {
  // German (and any other language the panel does not ship) flattens to "en" via
  // pickLocale. Dictation still has to listen for the spoken language.
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'de-DE' }), 'de-DE')
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'it-IT' }), 'it-IT')
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'nl-NL' }), 'nl-NL')
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'pl-PL' }), 'pl-PL')
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'sv-SE' }), 'sv-SE')
})

test('#1329 an English browser keeps the en panel locale (or en-US when both are empty)', () => {
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'en-US' }), 'en')
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'en-GB' }), 'en')
  assert.equal(voiceRecognitionLang({ panelLocale: 'en', browserLang: 'en' }), 'en')
})

test('#1329 shipped path: pickLocale floors de-DE to en, then dictation still listens for de-DE', () => {
  // This is the exact shipped composer path: currentLocale() is pickLocale's result,
  // handed to voiceRecognitionLang with navigator.language. Detect + no Comfy.Locale
  // + a German browser is the reporter's setup.
  const panelLocale = pickLocale({ ourSetting: '', comfyLocale: '', navigatorLangs: ['de-DE'] })
  assert.equal(panelLocale, 'en', 'German is not a shipped UI locale — pickLocale floors to en')
  assert.equal(
    voiceRecognitionLang({ panelLocale, browserLang: 'de-DE' }),
    'de-DE',
    'dictation still uses the spoken language, not the UI-catalog floor',
  )
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
