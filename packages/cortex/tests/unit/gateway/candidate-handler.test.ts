import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createValidateCandidateHandler,
  type CandidateValidationDependencies,
} from '../../../src/gateway/handlers/candidates.js'

let server: Server | undefined
const leftovers: string[] = []

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  server = undefined
  await Promise.all(leftovers.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function request(
  overrides: Partial<CandidateValidationDependencies>,
): Promise<Response> {
  const handler = createValidateCandidateHandler(overrides)
  server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal_error' }))
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  return fetch(`http://127.0.0.1:${address.port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: [{
        path: 'agent.json',
        contentBase64: Buffer.from('{"name":"portable"}').toString('base64'),
      }],
    }),
  })
}

describe('candidate validation cleanup', () => {
  it('removes the isolated directory before returning success', async () => {
    let directory = ''
    const response = await request({
      makeTempDirectory: async () => {
        directory = await mkdtemp(join(tmpdir(), 'candidate-cleanup-success-'))
        leftovers.push(directory)
        return directory
      },
    })

    expect(response.status).toBe(200)
    await expect(access(directory)).rejects.toThrow()
  })

  it('removes the isolated directory when validation throws', async () => {
    let directory = ''
    const response = await request({
      makeTempDirectory: async () => {
        directory = await mkdtemp(join(tmpdir(), 'candidate-cleanup-failure-'))
        leftovers.push(directory)
        return directory
      },
      validate: async () => { throw new Error('injected validation failure') },
    })

    expect(response.status).toBe(500)
    await expect(access(directory)).rejects.toThrow()
  })

  it('never returns a candidate identity when cleanup itself fails', async () => {
    let directory = ''
    const response = await request({
      makeTempDirectory: async () => {
        directory = await mkdtemp(join(tmpdir(), 'candidate-cleanup-injected-'))
        leftovers.push(directory)
        return directory
      },
      removeDirectory: async () => { throw new Error('injected cleanup failure') },
    })
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(body)).toMatchObject({ error: 'candidate_cleanup_failed', category: 'unknown' })
    expect(body).not.toContain('sha256:')
    expect(body).not.toContain(directory)
  })
})
