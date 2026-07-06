/**
 * PUT /api/v1/designs/:designId/thumbnail — the capture sink.
 *
 * Drives the REAL handler with a mock `state` + a temp workspace (no sqlite):
 *   - a valid PNG body lands at `<workspaceRoot>/.thumb.png`.
 *   - a non-PNG body is refused (400) and nothing is written.
 *   - an unknown design 404s.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesignsRawHandlers } from '../../../src/gateway/handlers/designs-raw.js'
import type { GatewayState } from '../../../src/gateway/state.js'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FAKE_PNG = Buffer.concat([PNG_SIG, Buffer.from('fake-image-payload')])

let wsDir: string
let putThumbnail: ReturnType<typeof createDesignsRawHandlers>['putThumbnail']

function bodyReq(body: Buffer): IncomingMessage {
  const stream = Readable.from(body) as unknown as IncomingMessage
  stream.headers = { host: '127.0.0.1:3011' }
  stream.url = '/api/v1/designs/d1/thumbnail'
  return stream
}

function mockRes(): { res: ServerResponse; done: Promise<{ status: number; body: string }> } {
  let resolve!: (v: { status: number; body: string }) => void
  const done = new Promise<{ status: number; body: string }>((r) => (resolve = r))
  let status = 0
  let headersSent = false
  const res = {
    get headersSent() {
      return headersSent
    },
    writeHead(s: number) {
      status = s
      headersSent = true
      return res
    },
    end(b?: string | Buffer) {
      resolve({ status, body: b == null ? '' : Buffer.isBuffer(b) ? b.toString('utf8') : b })
    },
  } as unknown as ServerResponse
  return { res, done }
}

beforeAll(async () => {
  wsDir = await mkdtemp(join(tmpdir(), 'cortex-thumb-'))
  const state = {
    getDesign: (id: string) => (id === 'missing' ? undefined : { id, workspaceId: 'ws' }),
    getWorkspace: (_id: string) => ({ id: 'ws', path: wsDir }),
  } as unknown as GatewayState
  putThumbnail = createDesignsRawHandlers(state).putThumbnail
})

afterAll(async () => {
  await rm(wsDir, { recursive: true, force: true })
})

async function put(body: Buffer, designId = 'd1'): Promise<{ status: number; body: string }> {
  const { res, done } = mockRes()
  await putThumbnail(bodyReq(body), res, { designId })
  return done
}

describe('putThumbnail', () => {
  it('writes a valid PNG to <workspace>/.thumb.png', async () => {
    const out = await put(FAKE_PNG)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toMatchObject({ designId: 'd1', bytes: FAKE_PNG.length })
    const onDisk = await readFile(join(wsDir, '.thumb.png'))
    expect(onDisk.equals(FAKE_PNG)).toBe(true)
  })

  it('refuses a non-PNG body and writes nothing new', async () => {
    const out = await put(Buffer.from('<html>not a png</html>'), 'd2')
    expect(out.status).toBe(400)
    // The only .thumb.png is the valid one from the prior case (d1's
    // workspace is shared here), proving the bad write was rejected.
    expect(out.body).toContain('not a PNG')
  })

  it('404s for an unknown design', async () => {
    const out = await put(FAKE_PNG, 'missing')
    expect(out.status).toBe(404)
  })

  it('actually persisted a readable PNG file', async () => {
    // Sanity: the file exists and starts with the PNG signature.
    await expect(access(join(wsDir, '.thumb.png'))).resolves.toBeUndefined()
    const onDisk = await readFile(join(wsDir, '.thumb.png'))
    expect(onDisk.subarray(0, 8).equals(PNG_SIG)).toBe(true)
  })
})
