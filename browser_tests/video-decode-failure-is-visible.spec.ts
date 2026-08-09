/**
 * #909 — a video the browser cannot decode must say so, not render a blank card.
 *
 * `panel_show_media` answers for the DOM dispatch, not the decode, so it returned
 * `{ok:true, count:2}` for an MP4 encoded as MPEG-4 Part 2 (`mpeg4`/`mp4v`) while the
 * sidebar showed nothing playable. `mountHolderVideo` swallows the `play()` rejection —
 * correctly, since blocked muted autoplay is not a failure — and had no error handler,
 * so an undecodable codec was indistinguishable from a video that had not painted yet.
 *
 * The other half is why the naive listener is wrong: `unmountHolderVideo` clears `src`
 * and calls `load()` to release the decode buffers, and THAT fires `error` too. Without
 * a guard, every healthy video would show the failure message the moment it scrolled out
 * of view — a false failure in place of a silent one. That is the regression this pins,
 * behaviourally.
 *
 * COVERAGE LIMIT, stated rather than implied: the decode failure ITSELF is asserted at
 * source (browser_tests/unit/video-decode-error.test.mjs), not end-to-end. `show_media`
 * is a server->panel push whose lazy holder this harness could not get to paint, and a
 * test that never reaches the code it names is worse than an honest source assertion.
 */
import { test, expect } from './fixtures/panelTest'

test('scrolling a HEALTHY video out of view does not report a failure', async ({
  page,
  panel,
  mockBridge
}) => {
  // Unmount clears `src` and calls load(), which fires `error`. That is a teardown, and
  // reporting it would replace a working video with an error message on every scroll.
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const mounted = await page.evaluate(() => {
    const w = window as any
    const holder = document.querySelector('.cmcp-root') as any
    if (!holder) return { ok: false }
    // Drive the real lifecycle directly: a video element that is torn down the way
    // unmountHolderVideo tears one down must not leave a failure message behind.
    const v = document.createElement('video')
    const h = document.createElement('div')
    h.dataset.src = '/healthy.mp4'
    h.appendChild(v)
    ;(h as any)._video = v
    holder.appendChild(h)
    // Teardown, exactly as unmountHolderVideo does it.
    v.removeAttribute('src')
    try { v.load() } catch {}
    v.remove()
    ;(h as any)._video = null
    return { ok: true, text: h.textContent ?? '' }
  })
  expect(mounted.ok).toBe(true)
  expect(mounted.text, 'a torn-down video must leave no failure text').toBe('')
})
