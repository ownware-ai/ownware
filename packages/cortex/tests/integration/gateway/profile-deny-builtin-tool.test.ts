/**
 * Repro test for the user-reported bug: "when I delete a filesystem
 * tool in the Abilities tab and save, the tool comes back."
 *
 * Traces the full handoff for the on-disk built-in profile path:
 *   1. Gateway boots with the bundled `ownware-code` profile loaded
 *      from `packages/cortex/profiles/` as `source: 'builtin'`.
 *   2. PUT /api/v1/profiles/ownware-code with
 *      `config.tools.deny: ['writeFile', ...existing]`.
 *      This must trigger `registry.forkBuiltin` (copy-on-write to
 *      user dir), then write the new agent.json.
 *   3. GET /api/v1/profiles/ownware-code/tools — the resolved tool
 *      list must NOT include `writeFile`.
 *   4. GET /api/v1/profiles/ownware-code — the wire `config.tools.deny`
 *      must include `writeFile`.
 *
 * If step 3 fails: the bug is in fork / merge / persistence.
 * If step 4 succeeds but step 3 fails: the bug is in the resolver.
 * If both succeed: the bug is in the client UI layer (hydration /
 * draft restore).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import type { ToolInfo } from '../../../src/gateway/types.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

beforeAll(async () => {
  // Use the REAL bundled profiles dir so ownware-code is registered
  // as source: 'builtin'. The PUT handler must fork it into dataDir
  // before writing.
  const shallow = resolve(import.meta.dirname, '../../../profiles')
  const deep = resolve(import.meta.dirname, '../../../../profiles')
  profilesDir = existsSync(shallow) ? shallow : deep
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-deny-builtin-data-'))

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 15_000)

afterAll(async () => {
  await gateway.stop()
  await rm(dataDir, { recursive: true, force: true })
})

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders() })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('PUT /api/v1/profiles/:id — deny a built-in filesystem tool', () => {
  it('the bundled ownware-code profile is loaded', async () => {
    const { status, body } = await get('/api/v1/profiles/ownware-code')
    expect(status).toBe(200)
    expect(body.id).toBe('ownware-code')
    // Pre-state sanity: the bundled profile uses preset 'full' so
    // every built-in tool is in-base unless denied.
    expect(body.config.tools.preset).toBe('full')
  })

  it('pre-state: GET /profiles/ownware-code/tools includes writeFile', async () => {
    const { status, body } = await get('/api/v1/profiles/ownware-code/tools')
    expect(status).toBe(200)
    const names = (body as ToolInfo[]).map((t) => t.name)
    expect(names).toContain('writeFile')
  })

  it('PUT with deny=[writeFile, ...existing] succeeds (forks the builtin under the hood)', async () => {
    // Mirror what the client's Abilities tab sends — preset/allow/deny
    // all forwarded. The existing ownware-code denies a few non-fs
    // tools; we preserve those and add writeFile to the list.
    const { status, body } = await put('/api/v1/profiles/ownware-code', {
      config: {
        tools: {
          preset: 'full',
          allow: [],
          deny: [
            'browser_*',
            'image_generate',
            'speech_synthesize',
            'speech_transcribe',
            'writeFile',
          ],
        },
      },
    })
    expect(status).toBe(200)
    expect(body.id).toBe('ownware-code')
    expect(body.updated).toBe(true)
  })

  it('the forked user-copy agent.json carries the new deny list', async () => {
    const forkedPath = join(dataDir, 'profiles', 'ownware-code', 'agent.json')
    expect(existsSync(forkedPath)).toBe(true)
    const disk = JSON.parse(await readFile(forkedPath, 'utf-8'))
    expect(disk.tools.deny).toContain('writeFile')
  })

  it('GET /profiles/ownware-code returns deny including writeFile', async () => {
    const { status, body } = await get('/api/v1/profiles/ownware-code')
    expect(status).toBe(200)
    expect(body.config.tools.deny).toContain('writeFile')
  })

  it('GET /profiles/ownware-code/tools NO LONGER includes writeFile', async () => {
    const { status, body } = await get('/api/v1/profiles/ownware-code/tools')
    expect(status).toBe(200)
    const names = (body as ToolInfo[]).map((t) => t.name)
    expect(names).not.toContain('writeFile')
  })
})
