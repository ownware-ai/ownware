/**
 * S4 contract: the headless stream loop (`streamExec`) emits NDJSON that
 * matches the AsyncAPI channel contract (`@ownware/client/spec/
 * asyncapi.yaml`) — every line one raw gateway event payload carrying
 * `type` + `seq`, with the channel's declared lifecycle types present.
 *
 * Deterministic: a scripted session driven through `runner.start` inside
 * a REAL gateway (the same seam cortex's own permission contracts use);
 * `streamExec` consumes the run purely over the wire. Also proves the
 * headless approval policy: pending requests are DENIED, noted on
 * stderr, and the pipeline never hangs.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OwnwareClient } from '@ownware/client'
import { OwnwareGateway } from '@ownware/cortex'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { parseExecArgs, streamExec } from '../../exec.js'

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: 'test',
  costUsd: 0,
} as const

class ScriptedSession {
  readonly sessionId = 'exec-flow'
  constructor(private readonly hitl: HumanInTheLoop) {}

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() } as LoomEvent
    yield { type: 'text.delta', turnIndex: 0, text: 'Starting.\n' } as LoomEvent
    yield {
      type: 'permission.request',
      turnIndex: 0,
      requestId: 'exec_perm',
      toolName: 'send_email',
      input: { body: 'x' },
      reason: 'needs approval',
    } as LoomEvent
    const granted = await this.hitl.requestApproval({
      id: 'exec_perm',
      name: 'send_email',
      input: { body: 'x' },
    })
    yield {
      type: 'permission.response',
      turnIndex: 0,
      requestId: 'exec_perm',
      granted,
    } as LoomEvent
    yield {
      type: 'text.delta',
      turnIndex: 0,
      text: granted ? 'sent\n' : 'skipped\n',
    } as LoomEvent
    yield {
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: USAGE,
      timestamp: Date.now(),
    } as LoomEvent
    return undefined
  }

  abort(): void {
    this.hitl.denyAll()
  }
}

let tempRoot: string
let gateway: OwnwareGateway
let client: OwnwareClient

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'ownware-exec-'))
  const profilesDir = join(tempRoot, 'profiles')
  mkdirSync(join(profilesDir, 'test-agent'), { recursive: true })
  writeFileSync(
    join(profilesDir, 'test-agent', 'agent.json'),
    JSON.stringify({ name: 'test-agent' }),
  )
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir: join(tempRoot, 'data'),
    tls: false,
  })
  await gateway.start()
  client = new OwnwareClient({
    baseUrl: `http://127.0.0.1:${gateway.port}`,
    token: gateway.token,
  })
})

afterAll(async () => {
  await gateway.stop()
  rmSync(tempRoot, { recursive: true, force: true })
})

async function startScriptedRun(label: string) {
  const wsDir = join(tempRoot, label.replace(/[^a-z0-9]+/gi, '-'))
  mkdirSync(wsDir, { recursive: true })
  const workspace = await gateway.state.createWorkspace(wsDir, label)
  const thread = await gateway.state.createThread('test-agent', label, workspace.id)
  const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
  hitl.onApprovalNeeded(() => {})
  const session = new ScriptedSession(hitl) as unknown as Session
  gateway.state.setSession(thread.id, session)
  gateway.state.setRuntime(thread.id, { session, hitl, zoneManager: null } as never)
  const run = await gateway.runStore.create({
    threadId: thread.id,
    workspaceId: workspace.id,
    profileId: 'test-agent',
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  })
  const handle = gateway.runner.start({
    runId: run.runId,
    threadId: thread.id,
    profileId: 'test-agent',
    model: 'test:model',
    prompt: label,
    permissionPolicyRevision: 'a'.repeat(64),
  })
  return { threadId: thread.id, runId: run.runId, handle }
}

function asyncApiDeclaredTypes(): Set<string> {
  const specPath = fileURLToPath(
    new URL('../../../node_modules/@ownware/client/spec/asyncapi.yaml', import.meta.url),
  )
  const spec = readFileSync(specPath, 'utf-8')
  const types = new Set<string>()
  for (const match of spec.matchAll(/type:\s*\{\s*const:\s*([a-z_.]+)\s*\}/g)) {
    types.add(match[1]!)
  }
  return types
}

describe('exec — headless NDJSON contract (S4)', () => {
  it('stream-json lines conform to the AsyncAPI channel; approvals auto-deny', async () => {
    const { threadId, runId, handle } = await startScriptedRun('stream json flow')
    let stdout = ''
    let stderr = ''
    const code = await streamExec(client, {
      runId,
      threadId,
      format: 'stream-json',
      profileId: 'test-agent',
      model: 'test:model',
      io: { out: (c) => { stdout += c }, err: (c) => { stderr += c } },
    })
    await handle.done

    expect(code, stderr).toBe(0)
    const lines = stdout.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(4)

    const declared = asyncApiDeclaredTypes()
    expect(declared.size).toBeGreaterThanOrEqual(8)
    const seenTypes = new Set<string>()
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(typeof parsed['type']).toBe('string')
      seenTypes.add(parsed['type'] as string)
      // Every event the AsyncAPI declares must ride with its resume cursor.
      if (declared.has(parsed['type'] as string)) {
        expect(typeof parsed['seq']).toBe('number')
      }
    }
    // The channel's core lifecycle appears, exactly as declared.
    expect(seenTypes).toContain('text.delta')
    expect(seenTypes).toContain('permission.request')
    expect(seenTypes).toContain('turn.end')

    // Sanitized wire truth even headless: the raw input never leaks.
    expect(stdout).not.toContain('"body":"x"')

    // Headless approval policy: denied, noted, pipeline completed.
    expect(stderr).toContain('permission.request for send_email — denied (headless)')
    expect(stdout).toContain('skipped')
  }, 20_000)

  it('json format emits one final object; text format streams plain text', async () => {
    const first = await startScriptedRun('json flow')
    let jsonOut = ''
    const jsonCode = await streamExec(client, {
      runId: first.runId,
      threadId: first.threadId,
      format: 'json',
      profileId: 'test-agent',
      model: 'test:model',
      io: { out: (c) => { jsonOut += c }, err: () => {} },
    })
    await first.handle.done
    expect(jsonCode).toBe(0)
    const result = JSON.parse(jsonOut) as Record<string, unknown>
    expect(result['status']).toBe('completed')
    expect(result['threadId']).toBe(first.threadId)
    expect(String(result['text'])).toContain('Starting.')

    const second = await startScriptedRun('text flow')
    let textOut = ''
    const textCode = await streamExec(client, {
      runId: second.runId,
      threadId: second.threadId,
      format: 'text',
      profileId: 'test-agent',
      model: 'test:model',
      io: { out: (c) => { textOut += c }, err: () => {} },
    })
    await second.handle.done
    expect(textCode).toBe(0)
    expect(textOut).toContain('Starting.')
    expect(textOut).not.toContain('{')
  }, 20_000)

  it('parseExecArgs rejects missing prompt and bad formats honestly', () => {
    expect(() => parseExecArgs([])).toThrow(/needs a prompt/)
    expect(() => parseExecArgs(['-p', 'x', '-o', 'xml'])).toThrow(/must be text \| json \| stream-json/)
  })
})
