/**
 * Unit tests — CredentialResolver interface + error types.
 *
 * The interface itself has no behaviour — it's a contract. These
 * tests pin the discriminated error types so a future change to the
 * `kind` field or the `reason` enum trips them. Real resolver
 * behaviour is exercised in the gateway resolver test file.
 */

import { describe, it, expect } from 'vitest'
import {
  ALWAYS_MISSING_RESOLVER,
  CredentialDeniedError,
  MissingCredentialError,
  type CredentialResolver,
  type ResolveContext,
} from '../../../credentials/resolver.js'

describe('MissingCredentialError', () => {
  it('carries kind: "missing" and the variableName', () => {
    const err = new MissingCredentialError('VERCEL_TOKEN')
    expect(err.kind).toBe('missing')
    expect(err.variableName).toBe('VERCEL_TOKEN')
    expect(err.name).toBe('MissingCredentialError')
    expect(err).toBeInstanceOf(Error)
  })

  it('renders a meaningful message', () => {
    const err = new MissingCredentialError('VERCEL_TOKEN')
    expect(err.message).toContain('VERCEL_TOKEN')
  })
})

describe('CredentialDeniedError', () => {
  const reasons = [
    'SPEND_CAP_EXCEEDED',
    'APPROVAL_DENIED',
    'EXPIRED',
    'REVOKED',
    'ERROR',
  ] as const

  for (const reason of reasons) {
    it(`carries kind: "denied" and reason: "${reason}"`, () => {
      const err = new CredentialDeniedError('VAR', reason)
      expect(err.kind).toBe('denied')
      expect(err.reason).toBe(reason)
      expect(err.variableName).toBe('VAR')
      expect(err).toBeInstanceOf(Error)
    })
  }

  it('renders the reason in the message', () => {
    const err = new CredentialDeniedError('VAR', 'SPEND_CAP_EXCEEDED')
    expect(err.message).toContain('SPEND_CAP_EXCEEDED')
  })

  it('appends optional detail to the message', () => {
    const err = new CredentialDeniedError(
      'VAR',
      'SPEND_CAP_EXCEEDED',
      'cap=$5/day, used=$5.01',
    )
    expect(err.message).toContain('cap=$5/day, used=$5.01')
  })
})

describe('ALWAYS_MISSING_RESOLVER', () => {
  it('rejects every resolve with MissingCredentialError', async () => {
    const ctx: ResolveContext = {
      agentId: 'agent_x',
      sessionId: 'sess_x',
      threadId: 'thread_x',
    }
    await expect(ALWAYS_MISSING_RESOLVER.resolve('FOO', ctx)).rejects.toBeInstanceOf(
      MissingCredentialError,
    )
  })
})

describe('CredentialResolver — discriminated unions', () => {
  it('lets a caller switch on err.kind without a type cast', async () => {
    const resolver: CredentialResolver = {
      resolve: () =>
        Promise.reject(new CredentialDeniedError('FOO', 'EXPIRED')),
    }
    try {
      await resolver.resolve('FOO', {
        agentId: 'a', sessionId: 'b', threadId: 'c',
      })
      expect.fail('should have thrown')
    } catch (err) {
      if (err instanceof MissingCredentialError) {
        expect.fail('should be CredentialDeniedError')
      } else if (err instanceof CredentialDeniedError) {
        expect(err.kind).toBe('denied')
      } else {
        expect.fail('unknown error')
      }
    }
  })
})
