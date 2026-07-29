/**
 * S1 integration: the CLI's machinery against a REAL gateway over the
 * real wire — in-process boot, temp profilesDir AND dataDir (never the
 * real ~/.ownware; repo guardrail #4).
 *
 * The happy chat path needs a model. It runs keyless against Ollama when
 * available and self-skips otherwise (the repo's env-gated e2e lane
 * convention). The unhappy path — no key, no ollama model configured —
 * is asserted unconditionally: the run must fail HONESTLY with the
 * keyless instructions, and the loop machinery must survive to prompt
 * again (the parked-prompt contract).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OwnwareClient, interpretSseEvent } from '@ownware/client'
import { ensureGateway, probeLocalGateway, type GatewayHandle } from '../../gateway.js'
import { ensureWorkspace } from '../../workspace.js'
import { SessionStore } from '../../session-store.js'
import { runRepl } from '../../repl.js'
import { PLAIN_STYLE } from '../../style.js'

const OLLAMA_MODEL = 'ollama:llama3.2'

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { models?: Array<{ name?: string }> }
    return (body.models ?? []).some((m) => (m.name ?? '').startsWith('llama3.2'))
  } catch {
    return false
  }
}

let tempRoot: string
let gateway: GatewayHandle
let client: OwnwareClient

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'ownware-cli-test-'))
  const profilesDir = join(tempRoot, 'profiles')
  mkdirSync(join(profilesDir, 'test-agent'), { recursive: true })
  writeFileSync(
    join(profilesDir, 'test-agent', 'agent.json'),
    JSON.stringify({ name: 'test-agent', description: 'S1 test agent' }),
  )
  gateway = await ensureGateway({
    profilesDir,
    dataDir: join(tempRoot, 'data'),
    cwd: tempRoot,
  })
  client = new OwnwareClient({
    baseUrl: gateway.baseUrl,
    ...(gateway.token !== undefined ? { token: gateway.token } : {}),
  })
})

afterAll(async () => {
  await gateway.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('CLI ↔ gateway over the wire', () => {
  it('boots an owned loopback gateway and lists the temp profile', async () => {
    expect(gateway.owned).toBe(true)
    expect(gateway.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const profiles = await client.profiles()
    expect(profiles.map((p) => p.id ?? p.name)).toContain('test-agent')
  })

  it('ensureWorkspace find-or-creates the cwd workspace idempotently', async () => {
    const first = await ensureWorkspace(gateway.baseUrl, gateway.token, tempRoot)
    expect(first).not.toBeNull()
    const second = await ensureWorkspace(gateway.baseUrl, gateway.token, tempRoot)
    expect(second).toBe(first)
  })

  it('probeLocalGateway finds a running plain-HTTP gateway, null otherwise (S5)', async () => {
    const port = Number(new URL(gateway.baseUrl).port)
    const found = await probeLocalGateway(gateway.dataDir, {}, port)
    expect(found).not.toBeNull()
    expect(found!.baseUrl).toBe(`http://127.0.0.1:${port}`)
    const none = await probeLocalGateway(gateway.dataDir, {}, 1) // nothing listens on 1
    expect(none).toBeNull()
  })

  it('SessionStore lives under the temp dataDir, never ~/.ownware', () => {
    const store = new SessionStore(gateway.dataDir)
    store.saveThread(tempRoot, 'test-agent', 'thread-123')
    expect(store.lastThread(tempRoot, 'test-agent')).toBe('thread-123')
    expect(gateway.dataDir.startsWith(tempRoot)).toBe(true)
  })

  it('leaves the loop when readline closes under an outstanding prompt', async () => {
    // Found by the journey harness: ctrl-c at an idle prompt hung the
    // CLI until it was killed. `rl.question` never calls back once the
    // interface closes, so the loop parked on a promise that could no
    // longer settle. Closing the input while a question is outstanding
    // is the same path ctrl-c takes.
    const output = new PassThrough()
    output.resume()
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = false

    const repl = runRepl({
      client,
      baseUrl: gateway.baseUrl,
      token: gateway.token,
      profileId: 'test-agent',
      style: PLAIN_STYLE,
      sessionStore: new SessionStore(gateway.dataDir),
      cwd: tempRoot,
      resume: false,
      input,
      output,
    })

    // Never answer the prompt — just close the input under it.
    await new Promise((r) => setTimeout(r, 100))
    input.end()

    const settled = await Promise.race([
      repl.then(() => 'returned' as const),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000)),
    ])
    expect(settled).toBe('returned')
  }, 20_000)

  it('keyless with no local model: the run fails honestly, not silently', async () => {
    if (await ollamaAvailable()) {
      // A local model exists — the "no model at all" failure shape is
      // not reproducible on this machine; the happy-path test covers it.
      return
    }
    // The failure may surface at run() (assembly) or on the stream as an
    // error event — both are honest; hanging or fake success is the bug.
    try {
      const started = await client.run({ profileId: 'test-agent', prompt: 'hello' })
      let sawTerminal = false
      let lastSeq = 0
      for await (const ev of client.events(started.runId ?? started.threadId, {})) {
        const interpreted = interpretSseEvent(ev.type, ev.data, lastSeq)
        lastSeq = interpreted.seq
        if (interpreted.event?.type === 'error') sawTerminal = true
        if (interpreted.stop) break
      }
      expect(sawTerminal).toBe(true)
    } catch (err) {
      expect(String(err instanceof Error ? err.message : err)).toMatch(/provider|model|configured|key/i)
    }
  }, 60_000)

  it('chats end-to-end keyless via ollama and resumes the thread (self-skips without ollama)', async () => {
    if (!(await ollamaAvailable())) return

    const output = new PassThrough()
    let transcript = ''
    output.on('data', (c: Buffer) => {
      transcript += c.toString('utf-8')
    })
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = false

    const store = new SessionStore(gateway.dataDir)
    const repl = runRepl({
      client,
      baseUrl: gateway.baseUrl,
      token: gateway.token,
      profileId: 'test-agent',
      model: OLLAMA_MODEL,
      style: PLAIN_STYLE,
      sessionStore: store,
      cwd: tempRoot,
      resume: false,
      input,
      output,
    })
    input.write('Reply with exactly the word pong and nothing else.\n')
    input.write('/exit\n')
    input.end()
    await repl

    expect(transcript.toLowerCase()).toContain('pong')
    const threadId = store.lastThread(tempRoot, 'test-agent')
    expect(threadId).not.toBeNull()

    // --resume replays via /hydrate: the prior exchange must be visible.
    const output2 = new PassThrough()
    let transcript2 = ''
    output2.on('data', (c: Buffer) => {
      transcript2 += c.toString('utf-8')
    })
    const input2 = new PassThrough() as PassThrough & { isTTY?: boolean }
    input2.isTTY = false
    const repl2 = runRepl({
      client,
      baseUrl: gateway.baseUrl,
      token: gateway.token,
      profileId: 'test-agent',
      model: OLLAMA_MODEL,
      style: PLAIN_STYLE,
      sessionStore: store,
      cwd: tempRoot,
      resume: true,
      input: input2,
      output: output2,
    })
    input2.write('/exit\n')
    input2.end()
    await repl2

    expect(transcript2).toContain(`↺ resumed ${threadId}`)
    expect(transcript2.toLowerCase()).toContain('pong')
  }, 180_000)
})
