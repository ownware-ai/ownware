/**
 * getRaw font proxying (C1b) — the opt-in `?fonts=proxy` render transform
 * for URL-load previews.
 *
 * Drives the REAL handler with a mock `state` + a temp workspace (no sqlite):
 *   - WITH `?fonts=proxy` → Google-Fonts links are rewritten to the local proxy.
 *   - WITHOUT the param → the document is served pristine (this is the path the
 *     file-watcher's `readRaw` takes, so the editable file map is never mutated).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesignsRawHandlers } from '../../../src/gateway/handlers/designs-raw.js'
import type { GatewayState } from '../../../src/gateway/state.js'

const HOST = '127.0.0.1:3011'
const GFONT =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'

let wsDir: string
let getRaw: ReturnType<typeof createDesignsRawHandlers>['getRaw']

function mockReq(path: string): IncomingMessage {
  return { url: path, headers: { host: HOST } } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; done: Promise<{ status: number; body: string }> } {
  let resolve!: (v: { status: number; body: string }) => void
  const done = new Promise<{ status: number; body: string }>((r) => (resolve = r))
  let status = 0
  const res = {
    writeHead(s: number) {
      status = s
      return res
    },
    end(body?: string | Buffer) {
      resolve({ status, body: body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : body })
    },
    destroy() {},
    on() {
      return res
    },
  } as unknown as ServerResponse
  return { res, done }
}

beforeAll(async () => {
  wsDir = await mkdtemp(join(tmpdir(), 'cortex-raw-fonts-'))
  await writeFile(
    join(wsDir, 'index.html'),
    `<!doctype html><html><head><link href="${GFONT}" rel="stylesheet"></head><body>hi</body></html>`,
  )
  const state = {
    getDesign: (id: string) => ({ id, workspaceId: 'ws' }),
    getWorkspace: (_id: string) => ({ id: 'ws', path: wsDir }),
  } as unknown as GatewayState
  getRaw = createDesignsRawHandlers(state).getRaw
})

afterAll(async () => {
  await rm(wsDir, { recursive: true, force: true })
})

async function fetchIndex(query: string): Promise<{ status: number; body: string }> {
  const { res, done } = mockRes()
  await getRaw(mockReq(`/api/v1/designs/d1/raw/index.html${query}`), res, {
    designId: 'd1',
    path: 'index.html',
  })
  return done
}

describe('getRaw — opt-in font proxy', () => {
  it('rewrites Google-Fonts links when ?fonts=proxy is set', async () => {
    const out = await fetchIndex('?v=1&fonts=proxy')
    expect(out.status).toBe(200)
    expect(out.body).not.toContain('fonts.googleapis.com')
    expect(out.body).toContain(`http://${HOST}/api/v1/fonts/css?u=`)
  })

  it('serves the pristine document without the param (watcher path)', async () => {
    const out = await fetchIndex('?v=1')
    expect(out.status).toBe(200)
    expect(out.body).toContain('fonts.googleapis.com')
    expect(out.body).not.toContain('/api/v1/fonts/css')
  })
})
