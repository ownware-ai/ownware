/**
 * Marketplace HTTP handler tests.
 *
 * Drives the handlers via direct invocation (skipping the live HTTP
 * server) so the test surface is the same Promise-returning function
 * the router calls. We mock IncomingMessage / ServerResponse with
 * minimal in-memory shims — every assertion is on status code, headers,
 * and parsed JSON body.
 *
 * Real `git` is used for the install / update / uninstall paths via the
 * same wrapper-script approach as the install integration suite.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMarketplaceHandlers } from '../../../src/gateway/handlers/marketplace.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { isGitAvailable } from '../../../src/profile/install/clone.js'

let gitOk = false
beforeAll(async () => {
  gitOk = await isGitAvailable('git')
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* */ }
  })
  return dir
}

function runSync(args: string[]): void {
  const [cmd, ...rest] = args
  if (cmd === undefined) throw new Error('runSync called without command')
  const r = spawnSync(cmd, rest, { encoding: 'utf-8' })
  if (r.status !== 0) {
    throw new Error(`${args.join(' ')} → exit ${r.status}\nstderr: ${r.stderr}`)
  }
}

interface FakeRepo {
  cloneUrl: string
  githubUrl: string
  pushFiles: (files: Record<string, string>, opts?: { branch?: string }) => Promise<string>
}

async function makeBareRepo(): Promise<FakeRepo> {
  const root = await makeTempDir('cortex-bare-')
  const bareDir = join(root, 'remote.git')
  const workDir = join(root, 'work')
  await mkdir(bareDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  runSync(['git', 'init', '--bare', '--initial-branch=main', bareDir])
  runSync(['git', 'init', '--initial-branch=main', workDir])
  runSync(['git', '-C', workDir, 'config', 'user.email', 't@e.com'])
  runSync(['git', '-C', workDir, 'config', 'user.name', 'T'])
  runSync(['git', '-C', workDir, 'config', 'commit.gpgsign', 'false'])
  runSync(['git', '-C', workDir, 'remote', 'add', 'origin', bareDir])
  return {
    cloneUrl: `file://${bareDir}`,
    githubUrl: 'https://github.com/acme/finance',
    pushFiles: async (files, opts) => {
      const branch = opts?.branch ?? 'main'
      const exists = spawnSync('git', ['-C', workDir, 'rev-parse', '--verify', branch], { stdio: 'ignore' }).status === 0
      if (exists) runSync(['git', '-C', workDir, 'checkout', branch])
      else runSync(['git', '-C', workDir, 'checkout', '-B', branch])
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(workDir, rel)
        await mkdir(join(abs, '..'), { recursive: true })
        await writeFile(abs, content)
      }
      runSync(['git', '-C', workDir, 'add', '-A'])
      runSync(['git', '-C', workDir, 'commit', '-m', `update ${branch}`])
      runSync(['git', '-C', workDir, 'push', 'origin', branch])
      return spawnSync('git', ['-C', workDir, 'rev-parse', branch], { encoding: 'utf-8' }).stdout.trim()
    },
  }
}

async function makeGitWrapper(bare: FakeRepo): Promise<string> {
  const wrapperDir = await makeTempDir('cortex-git-wrapper-')
  const wrapperPath = join(wrapperDir, 'git-wrapper.sh')
  const wrapperSrc = `#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  if [ "$a" = "https://github.com/acme/finance.git" ]; then
    args+=("${bare.cloneUrl}")
  else
    args+=("$a")
  fi
done
exec git "\${args[@]}"
`
  await writeFile(wrapperPath, wrapperSrc, { mode: 0o755 })
  return wrapperPath
}

// ---------------------------------------------------------------------------
// HTTP shims
// ---------------------------------------------------------------------------

function fakeReq(opts: {
  body?: unknown
  headers?: Record<string, string>
}): IncomingMessage {
  const bodyStr = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const stream = Readable.from([Buffer.from(bodyStr)]) as unknown as IncomingMessage
  Object.defineProperty(stream, 'headers', { value: opts.headers ?? {} })
  Object.defineProperty(stream, 'method', { value: 'POST' })
  return stream
}

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function fakeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: '' }
  const ee = new EventEmitter() as unknown as ServerResponse
  ;(ee as any).statusCode = 200
  ;(ee as any).setHeader = (name: string, value: string) => {
    captured.headers[name.toLowerCase()] = String(value)
  }
  ;(ee as any).getHeader = (name: string) => captured.headers[name.toLowerCase()]
  ;(ee as any).writeHead = (status: number, headers?: Record<string, unknown>) => {
    ;(ee as any).statusCode = status
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        captured.headers[k.toLowerCase()] = String(v)
      }
    }
    return ee
  }
  ;(ee as any).end = (chunk?: string | Buffer) => {
    captured.statusCode = (ee as any).statusCode
    if (chunk !== undefined) captured.body += String(chunk)
  }
  ;(ee as any).write = (chunk: string | Buffer) => {
    captured.body += String(chunk)
    return true
  }
  return { res: ee as ServerResponse, captured }
}

async function dispatchAndCapture(
  fn: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>,
  args: { body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const req = fakeReq({ ...(args.body !== undefined ? { body: args.body } : {}), ...(args.headers !== undefined ? { headers: args.headers } : {}) })
  const { res, captured } = fakeRes()
  await fn(req, res, args.params ?? {})
  let parsed: unknown = null
  try { parsed = JSON.parse(captured.body) } catch { /* leave null */ }
  return { status: captured.statusCode, body: parsed, headers: captured.headers }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const MANIFEST = JSON.stringify({
  schema: 1,
  id: 'acme/finance',
  summary: 'Finance analyst',
  category: 'Finance',
  models: ['anthropic:claude-sonnet-4-6'],
  connectors: [{ id: 'sec-edgar', label: 'SEC EDGAR', auth: 'none' }],
  capabilities: ['filesystem-rw'],
  profiles: [{ name: 'finance', path: 'profiles/finance' }],
})

describe('POST /api/v1/marketplace/install', () => {
  it('installs a profile and returns 201 with the result', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST,
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    const wrapper = await makeGitWrapper(bare)
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry, gitBinary: wrapper })

    const r = await dispatchAndCapture(handlers.install, {
      body: { url: bare.githubUrl },
    })
    expect(r.status).toBe(201)
    expect(r.body.data.repoId).toBe('acme/finance')
    expect(r.body.data.profiles).toHaveLength(1)
  })

  it('rejects malformed body with 400', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.install, { body: { wrong: 'shape' } })
    expect(r.status).toBe(400)
  })

  it('returns 400 on invalid_url', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.install, {
      body: { url: 'http://gitlab.com/x/y' },
    })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_url')
  })

  it('returns 409 on name collision (idempotent retry)', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST,
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    const wrapper = await makeGitWrapper(bare)
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry, gitBinary: wrapper })

    await dispatchAndCapture(handlers.install, { body: { url: bare.githubUrl } })
    const r = await dispatchAndCapture(handlers.install, { body: { url: bare.githubUrl } })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('name_collision')
  })

  it('returns 400 on forbidden_custom_code', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST,
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/tools/evil.ts': 'process.env',
    })
    const dataDir = await makeTempDir('cortex-data-')
    const wrapper = await makeGitWrapper(bare)
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry, gitBinary: wrapper })
    const r = await dispatchAndCapture(handlers.install, { body: { url: bare.githubUrl } })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('forbidden_custom_code')
  })

})

describe('readAuthHeader', () => {
  // Imported via dynamic import below to avoid pulling the whole
  // marketplace module's static deps when this test file runs in isolation.
  it('parses Bearer scheme', async () => {
    const { readAuthHeader } = await import('../../../src/gateway/handlers/marketplace.js')
    expect(readAuthHeader({ headers: { authorization: 'Bearer ghp_xxx' } }))
      .toEqual({ kind: 'pat', token: 'ghp_xxx' })
  })
  it('parses GitHub-Token alias (case-insensitive)', async () => {
    const { readAuthHeader } = await import('../../../src/gateway/handlers/marketplace.js')
    expect(readAuthHeader({ headers: { authorization: 'GitHub-Token abc' } }))
      .toEqual({ kind: 'pat', token: 'abc' })
    expect(readAuthHeader({ headers: { authorization: 'github-token abc' } }))
      .toEqual({ kind: 'pat', token: 'abc' })
  })
  it('parses GitHub historical "token" scheme', async () => {
    const { readAuthHeader } = await import('../../../src/gateway/handlers/marketplace.js')
    expect(readAuthHeader({ headers: { authorization: 'token abc' } }))
      .toEqual({ kind: 'pat', token: 'abc' })
  })
  it('returns null on missing header', async () => {
    const { readAuthHeader } = await import('../../../src/gateway/handlers/marketplace.js')
    expect(readAuthHeader({ headers: {} })).toBeNull()
  })
  it('returns null on unknown scheme', async () => {
    const { readAuthHeader } = await import('../../../src/gateway/handlers/marketplace.js')
    expect(readAuthHeader({ headers: { authorization: 'Basic abc' } })).toBeNull()
  })
  it('returns null when token is empty', async () => {
    const { readAuthHeader } = await import('../../../src/gateway/handlers/marketplace.js')
    expect(readAuthHeader({ headers: { authorization: 'Bearer ' } })).toBeNull()
  })
})

describe('POST /api/v1/marketplace/preview', () => {
  it('returns 400 on malformed body', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.preview, { body: { x: 1 } })
    expect(r.status).toBe(400)
  })

  it('returns 400 on invalid_url', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.preview, {
      body: { url: 'ssh://github.com/x/y' },
    })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_url')
  })
})

describe('GET /api/v1/marketplace/repos/:repoId/update', () => {
  it('returns 404 when repoId has no installed profiles', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.checkUpdate, {
      params: { repoId: 'unknown__repo' },
    })
    expect(r.status).toBe(404)
  })

  it('returns 400 on malformed repoId', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.checkUpdate, {
      params: { repoId: '../escape' },
    })
    expect(r.status).toBe(400)
  })

  it('returns up-to-date status after install', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST,
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    const wrapper = await makeGitWrapper(bare)
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry, gitBinary: wrapper })
    await dispatchAndCapture(handlers.install, { body: { url: bare.githubUrl } })

    // Patch sidecar so check uses file:// (not real github).
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    const sidecarPath = join(dir, '.ownware-origin.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'))
    sidecar.repoUrl = bare.cloneUrl
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const r = await dispatchAndCapture(handlers.checkUpdate, {
      params: { repoId: 'acme__finance' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data.status.state).toBe('up-to-date')
  })
})

describe('DELETE /api/v1/marketplace/repos/:repoId', () => {
  it('removes every installed profile for the repo and returns 200', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST,
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    const wrapper = await makeGitWrapper(bare)
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry, gitBinary: wrapper })
    await dispatchAndCapture(handlers.install, { body: { url: bare.githubUrl } })

    const r = await dispatchAndCapture(handlers.uninstall, {
      params: { repoId: 'acme__finance' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data.removed).toHaveLength(1)
  })

  it('returns 404 for an unknown repo', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.uninstall, {
      params: { repoId: 'no__one' },
    })
    expect(r.status).toBe(404)
  })
})

describe('POST /api/v1/marketplace/repos/:repoId/update', () => {
  it('rejects unknown strategy with 400', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({ dataDir, registry })
    const r = await dispatchAndCapture(handlers.applyUpdate, {
      params: { repoId: 'a__b' },
      body: { strategy: 'magic' },
    })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/v1/marketplace/index', () => {
  it('serves stale cache when index URL fails (with retry-after on cold)', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    const registry = new ProfileRegistry()
    const handlers = createMarketplaceHandlers({
      dataDir,
      registry,
      indexUrl: 'http://127.0.0.1:1/never-listening',
    })
    const r = await dispatchAndCapture(handlers.index)
    // Cold cache + unreachable URL → 503 with Retry-After.
    expect(r.status).toBe(503)
    expect(r.headers['retry-after']).toBe('60')
  })
})
