/**
 * Unit tests for `buildHookBinding` — the bridge from agent.json's
 * declarative `hooks` config to the engine's HookRuntime.
 *
 * Covers:
 *   - bucket → event mapping (onStart / onToolCall / onToolEnd)
 *   - each action compiles and behaves (log / webhook / save_json)
 *   - observe actions never block, even when their transport fails
 *   - loud-or-dead validation at build time (bad URL, http-non-localhost,
 *     absolute / escaping save_json paths, missing fields)
 *   - the command-action trust gate (off by default, opt-in flag)
 *   - the OWNWARE_DISABLE_HOOKS kill switch
 *   - credential redaction of webhook payloads
 *   - the model-visible loop-back (command hook output → reminder queue)
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ProfileSchema } from '../../../src/profile/schema.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import {
  buildHookBinding,
  hookBindingOptionsFromEnv,
  HookConfigError,
} from '../../../src/profile/hooks.js'
import type { HookContext } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
  vi.restoreAllMocks()
  delete process.env.OWNWARE_DISABLE_HOOKS
})

function makeProfile(
  hooks: Record<string, unknown>,
  basePath = '/tmp/hooks-test-profile',
): LoadedProfile {
  const config = ProfileSchema.parse({ name: 'hooks-test', hooks })
  return {
    config,
    soulMd: null,
    agentsMd: null,
    skills: [],
    basePath,
    timeoutMs: 1_800_000,
  }
}

const TOOL_PRE_CTX: HookContext = {
  event: 'tool.pre',
  turnIndex: 0,
  toolName: 'readFile',
  toolInput: { file_path: '/tmp/x.txt' },
}

const SESSION_START_CTX: HookContext = {
  event: 'session.start',
  turnIndex: 0,
  sessionId: 'sess_test',
  model: 'anthropic:claude-sonnet-4-20250514',
}

/** Local HTTP sink capturing POSTed hook payloads. */
async function startSink(status = 200): Promise<{
  url: string
  bodies: string[]
}> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(status).end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
  return { url: `http://127.0.0.1:${port}/hook`, bodies }
}

// ---------------------------------------------------------------------------
// Null paths
// ---------------------------------------------------------------------------

describe('buildHookBinding — null paths', () => {
  it('returns null when no hooks are declared', () => {
    expect(buildHookBinding(makeProfile({}))).toBeNull()
  })

  it('returns null under OWNWARE_DISABLE_HOOKS=1 (with a warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.OWNWARE_DISABLE_HOOKS = '1'
    const binding = buildHookBinding(
      makeProfile({ onStart: [{ action: 'log' }] }),
    )
    expect(binding).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OWNWARE_DISABLE_HOOKS'))
  })
})

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('buildHookBinding — bucket → event mapping', () => {
  it('maps all seven buckets to their engine events', () => {
    const binding = buildHookBinding(
      makeProfile({
        onStart: [{ action: 'log' }],
        onToolCall: [{ action: 'log' }],
        onToolEnd: [{ action: 'log' }],
        onModelCall: [{ action: 'log' }],
        onModelEnd: [{ action: 'log' }],
        onComplete: [{ action: 'log' }],
        onError: [{ action: 'log' }],
      }),
    )!
    expect(binding.runtime.has('session.start')).toBe(true)
    expect(binding.runtime.has('tool.pre')).toBe(true)
    expect(binding.runtime.has('tool.post')).toBe(true)
    expect(binding.runtime.has('model.pre')).toBe(true)
    expect(binding.runtime.has('model.post')).toBe(true)
    expect(binding.runtime.has('session.end')).toBe(true)
    expect(binding.runtime.has('error')).toBe(true)
    expect(binding.runtime.has('user.prompt.submit')).toBe(false)
  })

  it('runs onModelEnd actions against the metering context', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const binding = buildHookBinding(
      makeProfile({ onModelEnd: [{ action: 'log' }] }),
    )!
    const result = await binding.runtime.run({
      event: 'model.post',
      turnIndex: 2,
      model: 'ollama:llama3.2',
      stopReason: 'tool_use',
      inputTokens: 500,
      outputTokens: 42,
      costUsd: 0.0123,
      toolCallCount: 1,
    })
    expect(result.continue).toBe(true)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('model.post model=ollama:llama3.2 turn=2 stop=tool_use'),
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cost=$0.0123'))
  })

  it('runs onComplete/onError actions against their contexts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const binding = buildHookBinding(
      makeProfile({
        onComplete: [{ action: 'log' }],
        onError: [{ action: 'log', level: 'error' }],
      }),
    )!
    const endResult = await binding.runtime.run({
      event: 'session.end',
      turnIndex: 3,
      sessionId: 'sess_x',
      reason: 'end_turn',
    })
    expect(endResult.continue).toBe(true)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('session.end reason=end_turn'),
    )
    const errResult = await binding.runtime.run({
      event: 'error',
      turnIndex: 3,
      code: 'UNKNOWN',
      message: 'provider exploded',
    })
    expect(errResult.continue).toBe(true)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('error code=UNKNOWN'),
    )
  })
})

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

describe('log action', () => {
  it('logs a secret-safe summary and allows', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'log' }] }),
    )!
    const result = await binding.runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(true)
    const line = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(line).toContain('tool.pre tool=readFile')
    // Summary only — the tool INPUT must not reach the log line.
    expect(line).not.toContain('/tmp/x.txt')
  })

  it('honors the level field', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const binding = buildHookBinding(
      makeProfile({ onStart: [{ action: 'log', level: 'error' }] }),
    )!
    await binding.runtime.run(SESSION_START_CTX)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('session.start'))
  })
})

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

describe('webhook action', () => {
  it('POSTs the payload and allows', async () => {
    const sink = await startSink()
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'webhook', url: sink.url }] }),
    )!
    const result = await binding.runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(true)
    expect(sink.bodies).toHaveLength(1)
    const payload = JSON.parse(sink.bodies[0]!) as {
      v: number
      profile: string
      event: string
      context: { toolName: string }
    }
    expect(payload.v).toBe(1)
    expect(payload.profile).toBe('hooks-test')
    expect(payload.event).toBe('tool.pre')
    expect(payload.context.toolName).toBe('readFile')
  })

  it('never blocks on HTTP failure (500)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sink = await startSink(500)
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'webhook', url: sink.url }] }),
    )!
    const result = await binding.runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
  })

  it('never blocks when the endpoint is unreachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const binding = buildHookBinding(
      // Port 9 (discard) — nothing listens there.
      makeProfile({ onToolCall: [{ action: 'webhook', url: 'http://127.0.0.1:9/x' }] }),
    )!
    const result = await binding.runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(true)
  })

  it('redacts credential values from the payload', async () => {
    const sink = await startSink()
    const secret = 'sk-live-abcdef123456'
    const bound = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'webhook', url: sink.url }] }),
      { redactValues: () => [secret] },
    )!
    const ctx: HookContext = {
      event: 'tool.pre',
      turnIndex: 0,
      toolName: 'shell_execute',
      toolInput: { command: `curl -H "Authorization: Bearer ${secret}"` },
    }
    await bound.runtime.run(ctx)
    expect(sink.bodies.at(-1)).toContain('[REDACTED]')
    expect(sink.bodies.at(-1)).not.toContain(secret)
  })

  // Loud-or-dead validation
  it('rejects a missing url at build time', () => {
    expect(() =>
      buildHookBinding(makeProfile({ onToolCall: [{ action: 'webhook' }] })),
    ).toThrow(HookConfigError)
  })

  it('rejects an unparseable url at build time', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolCall: [{ action: 'webhook', url: 'not a url' }] }),
      ),
    ).toThrow(/not a valid URL/)
  })

  it('rejects http for non-loopback hosts at build time', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolCall: [{ action: 'webhook', url: 'http://example.com/x' }] }),
      ),
    ).toThrow(/https/)
  })

  it('accepts https for remote hosts (build only)', () => {
    expect(
      buildHookBinding(
        makeProfile({ onStart: [{ action: 'webhook', url: 'https://ops.example.com/audit' }] }),
      ),
    ).not.toBeNull()
  })

  it('enforces the operator allowlist when set', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onStart: [{ action: 'webhook', url: 'https://evil.example.com/x' }] }),
        { webhookAllowlist: ['https://ops.example.com/'] },
      ),
    ).toThrow(/allowlist/)

    expect(
      buildHookBinding(
        makeProfile({ onStart: [{ action: 'webhook', url: 'https://ops.example.com/audit' }] }),
        { webhookAllowlist: ['https://ops.example.com/'] },
      ),
    ).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// save_json
// ---------------------------------------------------------------------------

describe('save_json action', () => {
  it('appends JSONL inside the profile directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ownware-hooks-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const binding = buildHookBinding(
      makeProfile({ onToolEnd: [{ action: 'save_json', path: 'runs/log.jsonl' }] }, dir),
    )!
    const ctx: HookContext = {
      event: 'tool.post',
      turnIndex: 1,
      toolName: 'writeFile',
      toolInput: { file_path: 'a.txt' },
      result: 'ok',
      isError: false,
    }
    await binding.runtime.run(ctx)
    await binding.runtime.run(ctx)
    const raw = await readFile(join(dir, 'runs', 'log.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!) as { event: string; context: { toolName: string } }
    expect(first.event).toBe('tool.post')
    expect(first.context.toolName).toBe('writeFile')
  })

  it('rejects absolute paths at build time', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolEnd: [{ action: 'save_json', path: '/etc/ownware.jsonl' }] }),
      ),
    ).toThrow(/relative/)
  })

  it('rejects escapes from the profile directory at build time', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolEnd: [{ action: 'save_json', path: '../outside.jsonl' }] }),
      ),
    ).toThrow(/escapes/)
  })

  it('rejects a missing path at build time', () => {
    expect(() =>
      buildHookBinding(makeProfile({ onToolEnd: [{ action: 'save_json' }] })),
    ).toThrow(HookConfigError)
  })
})

// ---------------------------------------------------------------------------
// command — the trust gate
// ---------------------------------------------------------------------------

describe('command action — trust gate', () => {
  it('is rejected by default with the opt-in message', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolCall: [{ action: 'command', command: 'echo hi' }] }),
      ),
    ).toThrow(/disabled by default/)
  })

  it('compiles when the operator opts in', () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'command', command: 'echo hi' }] }),
      { allowCommandHooks: true },
    )
    expect(binding).not.toBeNull()
    expect(binding!.runtime.has('tool.pre')).toBe(true)
  })

  it('rejects an empty command even when opted in', () => {
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolCall: [{ action: 'command', command: '  ' }] }),
        { allowCommandHooks: true },
      ),
    ).toThrow(/requires a 'command'/)
  })

  it('routes command stdout into the reminder queue (model-visible)', async () => {
    const binding = buildHookBinding(
      makeProfile({ onStart: [{ action: 'command', command: 'echo hook-note' }] }),
      { allowCommandHooks: true },
    )!
    const result = await binding.runtime.run(SESSION_START_CTX)
    expect(result.continue).toBe(true)
    // The runtime emitted a hook.success reminder into the SAME
    // injector the binding exposes — drain and check the rendering.
    const drained = binding.reminders.drain({ turnIndex: 0 })
    expect(drained.join('\n')).toContain('hook-note')
  })

  it('a blocking command blocks (exit != 0)', async () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'command', command: 'exit 2' }] }),
      { allowCommandHooks: true },
    )!
    const result = await binding.runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(false)
    expect(result.blockedHook).toContain('onToolCall[0]:command')
  })
})

// ---------------------------------------------------------------------------
// Env policy resolution
// ---------------------------------------------------------------------------

describe('hookBindingOptionsFromEnv', () => {
  it('defaults to command-hooks-off and no allowlist', () => {
    const opts = hookBindingOptionsFromEnv({})
    expect(opts.allowCommandHooks).toBe(false)
    expect(opts.webhookAllowlist).toBeUndefined()
  })

  it('honors OWNWARE_ALLOW_COMMAND_HOOKS=1 (and only exactly "1")', () => {
    expect(hookBindingOptionsFromEnv({ OWNWARE_ALLOW_COMMAND_HOOKS: '1' }).allowCommandHooks).toBe(true)
    expect(hookBindingOptionsFromEnv({ OWNWARE_ALLOW_COMMAND_HOOKS: 'true' }).allowCommandHooks).toBe(false)
    expect(hookBindingOptionsFromEnv({ OWNWARE_ALLOW_COMMAND_HOOKS: '0' }).allowCommandHooks).toBe(false)
  })

  it('parses the webhook allowlist as trimmed, comma-separated prefixes', () => {
    const opts = hookBindingOptionsFromEnv({
      OWNWARE_HOOK_WEBHOOK_ALLOWLIST: ' https://ops.example.com/ , https://audit.example.com/hooks ,',
    })
    expect(opts.webhookAllowlist).toEqual([
      'https://ops.example.com/',
      'https://audit.example.com/hooks',
    ])
  })

  it('env-resolved options drive the real gate end-to-end', () => {
    // Command hook + no opt-in env → assembly-level rejection.
    expect(() =>
      buildHookBinding(
        makeProfile({ onToolCall: [{ action: 'command', command: 'echo hi' }] }),
        hookBindingOptionsFromEnv({}),
      ),
    ).toThrow(/disabled by default/)
    // With the env opt-in → compiles.
    expect(
      buildHookBinding(
        makeProfile({ onToolCall: [{ action: 'command', command: 'echo hi' }] }),
        hookBindingOptionsFromEnv({ OWNWARE_ALLOW_COMMAND_HOOKS: '1' }),
      ),
    ).not.toBeNull()
    // Allowlist from env is enforced on webhooks.
    expect(() =>
      buildHookBinding(
        makeProfile({ onStart: [{ action: 'webhook', url: 'https://evil.example.com/x' }] }),
        hookBindingOptionsFromEnv({ OWNWARE_HOOK_WEBHOOK_ALLOWLIST: 'https://ops.example.com/' }),
      ),
    ).toThrow(/allowlist/)
  })
})
