/**
 * Integration tests — shell_execute × credential isolation.
 *
 * These cover the end-to-end behaviour of `shell_execute` with a wired
 * ToolContext that carries known credentials:
 *
 *   - The child process inherits vault values as env vars.
 *   - `.env`-reading commands are hard-blocked before spawn.
 *   - Commands that inline a known credential value are hard-blocked.
 *   - Output that contains credential values gets redacted.
 *   - Output containing sensitive KEY=VALUE env lines gets redacted.
 *
 * Spawning a real `/bin/sh` is part of the point — we have to verify the
 * env actually reaches the child, not just that we built the env map
 * correctly. Each test uses tiny commands (`printenv`, `echo`) to keep
 * runtime trivial.
 */

import { describe, it, expect } from 'vitest'
import { execute as shellExecute } from '../shell.js'
import type { ToolContext, ToolProgress, ToolResult } from '../../types.js'
import { createDefaultConfig } from '../../../core/config.js'
import type {
  CredentialValue,
  EnvCredentialEntry,
} from '../../../credentials/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ContextOverrides {
  readonly listEnvCredentials?: () => readonly EnvCredentialEntry[]
  readonly resolveCredential?: (id: string) => string | null
  readonly listAllCredentialValues?: () => readonly CredentialValue[]
  readonly requestPermission?: () => Promise<boolean>
}

function buildContext(overrides: ContextOverrides = {}): ToolContext {
  return {
    cwd: process.cwd(),
    workspacePath: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    config: createDefaultConfig('mock:test'),
    requestPermission: overrides.requestPermission ?? (async () => true),
    requestCredential: async () => null,
    resolveCredential: overrides.resolveCredential ?? (() => null),
    listEnvCredentials: overrides.listEnvCredentials ?? (() => []),
    listAllCredentialValues: overrides.listAllCredentialValues ?? (() => []),
  }
}

async function runShell(command: string, ctx: ToolContext): Promise<ToolResult> {
  const result = shellExecute.execute({ command }, ctx)
  if (typeof (result as { next?: unknown }).next === 'function') {
    const gen = result as AsyncGenerator<ToolProgress, ToolResult>
    let step = await gen.next()
    while (!step.done) step = await gen.next()
    return step.value
  }
  return result as Promise<ToolResult>
}

// ---------------------------------------------------------------------------
// Env injection
// ---------------------------------------------------------------------------

describe('shell_execute — env auto-injection', () => {
  it('injects a vault credential as $VAR for the child process', async () => {
    const ctx = buildContext({
      listEnvCredentials: () => [{ credentialId: 'c1', variableName: 'OWNWARE_TEST_VAR' }],
      resolveCredential: id => id === 'c1' ? 'hello-from-vault' : null,
      listAllCredentialValues: () => [
        { credentialId: 'c1', value: 'hello-from-vault', label: 'OWNWARE_TEST_VAR' },
      ],
    })

    const result = await runShell('printenv OWNWARE_TEST_VAR', ctx)
    // printenv prints the value followed by \n. Redaction then replaces
    // the value with ***REDACTED::<label>*** before output reaches us.
    expect(result.isError).toBe(false)
    expect(result.content).toContain('***REDACTED::OWNWARE_TEST_VAR***')
    expect(result.content).not.toContain('hello-from-vault')
  })

  it('injects MULTIPLE credentials independently', async () => {
    const ctx = buildContext({
      listEnvCredentials: () => [
        { credentialId: 'c1', variableName: 'OWNWARE_A' },
        { credentialId: 'c2', variableName: 'OWNWARE_B' },
      ],
      resolveCredential: id => id === 'c1' ? 'alpha-value-xyz' : id === 'c2' ? 'beta-value-xyz' : null,
      listAllCredentialValues: () => [
        { credentialId: 'c1', value: 'alpha-value-xyz', label: 'A' },
        { credentialId: 'c2', value: 'beta-value-xyz', label: 'B' },
      ],
    })

    const result = await runShell(
      'sh -c "echo A=$OWNWARE_A; echo B=$OWNWARE_B"',
      ctx,
    )
    expect(result.isError).toBe(false)
    // Values must not appear; both labels' redaction markers should.
    expect(result.content).not.toContain('alpha-value-xyz')
    expect(result.content).not.toContain('beta-value-xyz')
    expect(result.content).toContain('***REDACTED::A***')
    expect(result.content).toContain('***REDACTED::B***')
  })

  it('does not inject when no env credentials are listed', async () => {
    const ctx = buildContext()
    const result = await runShell('echo NO_CREDS', ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('NO_CREDS')
  })
})

// ---------------------------------------------------------------------------
// Pre-execution blocks
// ---------------------------------------------------------------------------

describe('shell_execute — command pre-execution blocks', () => {
  it('hard-blocks "cat .env"', async () => {
    const ctx = buildContext()
    const result = await runShell('cat .env', ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/credential vault/)
  })

  it('hard-blocks "source .env"', async () => {
    const ctx = buildContext()
    const result = await runShell('source .env', ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/credential vault/)
  })

  it('hard-blocks "grep SECRET .env.local"', async () => {
    const ctx = buildContext()
    const result = await runShell('grep SECRET .env.local', ctx)
    expect(result.isError).toBe(true)
  })

  it('does not block "cat package.json"', async () => {
    const ctx = buildContext()
    const result = await runShell('cat package.json', ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toMatch(/"name"/)
  })

  it('blocks a command containing an inline credential value', async () => {
    const value = 'unique-sekrit-value-xyz-123'
    const ctx = buildContext({
      listAllCredentialValues: () => [
        { credentialId: 'c1', value, label: 'Token' },
      ],
    })
    const result = await runShell(`echo "${value}"`, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/inlined|credential value/i)
    expect(result.content).toContain('Token')
  })

  it('does not block a command that references the credential by $VAR name only', async () => {
    const value = 'unique-sekrit-value-xyz-987'
    const ctx = buildContext({
      listEnvCredentials: () => [{ credentialId: 'c1', variableName: 'MY_TOKEN' }],
      resolveCredential: id => id === 'c1' ? value : null,
      listAllCredentialValues: () => [
        { credentialId: 'c1', value, label: 'MyToken' },
      ],
    })
    const result = await runShell('echo "using $MY_TOKEN"', ctx)
    expect(result.isError).toBe(false)
    // Shell expands $MY_TOKEN to the value, which gets redacted in output.
    expect(result.content).not.toContain(value)
    expect(result.content).toContain('***REDACTED::MyToken***')
  })
})

// ---------------------------------------------------------------------------
// Output redaction
// ---------------------------------------------------------------------------

describe('shell_execute — output redaction', () => {
  it('redacts sensitive KEY=VALUE lines from env output', async () => {
    // No vault-wired credentials — the sensitive-env-line pass catches
    // anything with a KEY that looks secret. We force-set NODE_ENV (safe)
    // alongside a made-up SESSION_SECRET (sensitive) via `sh -c 'VAR=…'`.
    //
    // The exact replacement format is not asserted here: stage (a)
    // replaces the value with `SENSITIVE_ENV` but stage (b) (the
    // generic output-sanitizer) may then collapse the whole
    // `KEY=<marker>` into `[REDACTED:SECRET_ASSIGNMENT]`. Both outcomes
    // are correct — what matters is that the literal value is gone and
    // some redaction marker is present.
    const ctx = buildContext()
    const result = await runShell(
      'sh -c "NODE_ENV=testing SESSION_SECRET=nobody-should-see env | grep -E \'^(NODE_ENV|SESSION_SECRET)=\'"',
      ctx,
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('NODE_ENV=testing')
    expect(result.content).not.toContain('nobody-should-see')
    expect(result.content).toMatch(/REDACTED|SENSITIVE_ENV/)
  })

  it('emits (no output) placeholder when command produces nothing, not an error', async () => {
    const ctx = buildContext()
    const result = await runShell('true', ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toBe('(no output)')
  })
})
