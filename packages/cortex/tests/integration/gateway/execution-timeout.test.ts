/**
 * Integration tests for F-09 — `execution.timeout` wiring.
 *
 * Before the fix the field was parsed by zod, displayed on the wire,
 * and never used. Now the run handler derives `timeoutMs` from the
 * profile's `execution.timeout` string via `parseTimeout()` and hands
 * it to `SessionRunner.start()`, which sets a wall-clock timer that
 * calls `session.abort('timeout')` on fire.
 *
 * Where parseTimeout runs: the loader calls it at load time (loader.ts
 * step 8), storing the result on `LoadedProfile.timeoutMs`. A malformed
 * string therefore fails at LOAD, and the run handler surfaces that as
 * a 500 via `registry.get()` throwing. The run handler then just reads
 * the pre-computed `timeoutMs` from the loaded profile and hands it to
 * SessionRunner.
 *
 * What these tests prove against a REAL gateway:
 *
 *   1. A profile with a malformed `execution.timeout` string cannot be
 *      used to run — the load-time parser message surfaces in the 500
 *      body so an operator knows exactly why.
 *
 *   2. A valid timeout string accepts the run without error. The run
 *      itself fails later because the dummy API key can't reach a real
 *      provider — we only care that the timeout path did not reject it.
 *
 * The "timer actually fires and aborts" behavior requires a live
 * model call to observe meaningfully; it is covered by journey
 * tests when `ANTHROPIC_API_KEY` is present in CI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

beforeAll(async () => {
  // Dummy provider keys — SDK constructors throw without them. Real
  // calls will fail; that's fine, we're not testing the model path.
  if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
  if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'

  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-timeout-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-timeout-data-'))
  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })

  async function seed(name: string, config: Record<string, unknown>): Promise<void> {
    const dir = join(userProfiles, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent.json'), JSON.stringify(config, null, 2))
    await writeFile(join(dir, 'SOUL.md'), '# Timeout fixture\n')
    await mkdir(join(dir, 'skills'), { recursive: true })
  }

  // Profile with a valid timeout — should accept the run request.
  await seed('timeout-valid', {
    name: 'timeout-valid',
    model: 'anthropic:claude-haiku-4-5-20251001',
    execution: { timeout: '10s' },
  })

  // Profile with a malformed timeout — should reject with 500 on /run.
  // The schema does not validate timeout-string format (F-09 note),
  // so "chicken" passes zod and surfaces at run time via parseTimeout.
  await seed('timeout-bad', {
    name: 'timeout-bad',
    model: 'anthropic:claude-haiku-4-5-20251001',
    execution: { timeout: 'chicken' },
  })

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 20_000)

afterAll(async () => {
  await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

async function postRun(profileId: string, prompt: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/v1/run`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ profileId, prompt }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

describe('POST /run — execution.timeout parsing (F-09)', () => {
  it('rejects a run whose profile has a malformed execution.timeout string', async () => {
    const { status, body } = await postRun('timeout-bad', 'hello')
    expect(status).toBe(500)
    expect(typeof body.message).toBe('string')
    // The loader's parseTimeout raised; the raw message names the
    // offending value and the expected format — actionable for the
    // operator without reaching for source.
    expect(body.message).toContain('Invalid timeout')
    expect(body.message).toContain('chicken')
    expect(body.message).toContain('number><unit')
  })

  it('accepts a run whose profile has a valid execution.timeout string', async () => {
    const { status, body } = await postRun('timeout-valid', 'hello')
    // 200 — the handler validated the timeout and scheduled the run.
    // The background loop will fail at the provider (dummy key), but
    // that is a separate concern from the timeout-wiring path we care
    // about here.
    expect(status).toBe(200)
    expect(body.threadId).toBeTruthy()
    expect(body.profileId).toBe('timeout-valid')
  })
})
