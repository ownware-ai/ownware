/**
 * Unit Tests — Session constructor accepts credential callbacks.
 *
 * Behavioural tests (callbacks propagate into ToolContext, events stream
 * from the loop, shell injection works) live in Phase B/C once the
 * request_credential tool + shell hardening are in place. This file is
 * a type-plus-construction smoke test that locks down:
 *
 *   1. The Session ctor accepts a `credentials` option without type error.
 *   2. All four callback fields are optional independently.
 *   3. Omitting `credentials` entirely keeps today's behaviour (no throw).
 *   4. The callbacks are held by reference — swapping one out across
 *      runs would require a new Session (documented constraint).
 */

import { describe, it, expect, vi } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import type { ProviderAdapter } from '../../../src/provider/types.js'
import type { CredentialCallbacks } from '../../../src/core/loop.js'
import type {
  CredentialHandle,
  CredentialRequest,
  CredentialValue,
  EnvCredentialEntry,
} from '../../../src/credentials/types.js'

function makeProvider(): ProviderAdapter {
  return {
    name: 'mock',
    stream: vi.fn() as unknown as ProviderAdapter['stream'],
    countTokens: vi.fn().mockResolvedValue(100),
    supportsFeature: vi.fn().mockReturnValue(false),
    formatTools: vi.fn().mockReturnValue([]),
  }
}

describe('Session constructor — credential callbacks', () => {
  it('constructs without credentials option (back-compat)', () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
    })
    expect(session).toBeInstanceOf(Session)
    expect(session.messageCount).toBe(0)
  })

  it('accepts an empty credentials object', () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      credentials: {},
    })
    expect(session).toBeInstanceOf(Session)
  })

  it('accepts each callback independently (subset wiring)', () => {
    const only: CredentialCallbacks = {
      resolveCredential: () => null,
    }
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      credentials: only,
    })
    expect(session).toBeInstanceOf(Session)
  })

  it('accepts all four callbacks together', () => {
    const handle: CredentialHandle = {
      credentialId: 'cred-1',
      label: 'X',
      placement: { type: 'env', variableName: 'X' },
      storedAt: Date.now(),
    }
    const values: readonly CredentialValue[] = [
      { credentialId: 'cred-1', value: 'secret', label: 'X' },
    ]
    const envs: readonly EnvCredentialEntry[] = [
      { credentialId: 'cred-1', variableName: 'X' },
    ]

    const requestCredential = vi.fn(
      async (_req: CredentialRequest & { readonly requestId: string }) => handle,
    )
    const resolveCredential = vi.fn(() => 'secret')
    const listEnvCredentials = vi.fn(() => envs)
    const listAllCredentialValues = vi.fn(() => values)

    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      credentials: {
        requestCredential,
        resolveCredential,
        listEnvCredentials,
        listAllCredentialValues,
      },
    })
    expect(session).toBeInstanceOf(Session)
    // Callbacks are stashed and wired into the loop on submitMessage;
    // they should not be invoked at construction time — that would
    // leak credential material into startup side-effects.
    expect(requestCredential).not.toHaveBeenCalled()
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(listEnvCredentials).not.toHaveBeenCalled()
    expect(listAllCredentialValues).not.toHaveBeenCalled()
  })
})
