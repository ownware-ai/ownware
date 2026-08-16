import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchChrome, type RunningChrome } from '../../src/browser-launcher/index.js'
import {
  assertBrowserOutputAllowed,
  captureBrowserSensitiveInputBinding,
  connectBrowser,
  disconnectBrowser,
  getPage,
  injectBrowserSensitiveInput,
  resetBrowserCaptureBarrierForFreshContext,
} from '../../src/tools/builtins/browser-session.js'

let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><body>
      <label>Password <input id="password" type="password" autocomplete="current-password"></label>
      <input id="ordinary" type="text" autocomplete="email">
    </body></html>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('real managed-browser sensitive injection', () => {
  it('binds a live password field, injects once, then blocks Ownware capture', async () => {
    let chrome: RunningChrome | null = null
    try {
      chrome = await launchChrome({ headless: true, readyTimeoutMs: 20_000 })
      resetBrowserCaptureBarrierForFreshContext(chrome.cdpUrl)
      const connection = await connectBrowser(chrome.cdpUrl)
      const page = await getPage(connection)
      await page.goto(origin, { waitUntil: 'domcontentloaded' })

      const binding = await captureBrowserSensitiveInputBinding(connection, page, {
        selector: '#password',
        submit: false,
      })
      await expect(injectBrowserSensitiveInput(binding, 'real-browser-canary-秘密'))
        .resolves.toEqual({ disposition: 'applied' })

      // Test-only observation through the retained Playwright page proves the
      // DOM effect. Production Ownware browser output is already blocked.
      await expect(page.locator('#password').inputValue())
        .resolves.toBe('real-browser-canary-秘密')
      expect(() => assertBrowserOutputAllowed(chrome!.cdpUrl))
        .toThrow('Browser output is unavailable after sensitive input')
      await expect(injectBrowserSensitiveInput(binding, 'replay'))
        .resolves.toEqual({ disposition: 'not-applied', reason: 'binding-mismatch' })
    } finally {
      if (chrome !== null) {
        await disconnectBrowser(chrome.cdpUrl)
        await chrome.stop(10_000)
      }
    }
  }, 30_000)
})
