/**
 * Unit Tests — Credential event shapes + type guard.
 *
 * Behavioural tests (loop emits the events, handle round-trips through
 * the HITL callback, resolveCredential caches values) live alongside the
 * `request_credential` tool and the shell integration. This file
 * locks the wire shape and the `isCredentialEvent` guard so the
 * `agent_events` SQLite payload + SSE fan-out stay compatible forever.
 */

import { describe, it, expect } from 'vitest'
import type {
  CredentialRequestEvent,
  CredentialResponseEvent,
  LoomEvent,
  PermissionRequestEvent,
  SecurityBlockEvent,
  TextDeltaEvent,
} from '../../../src/core/events.js'
import { isCredentialEvent } from '../../../src/core/events.js'

describe('CredentialRequestEvent', () => {
  it('carries only metadata — never a value', () => {
    const event: CredentialRequestEvent = {
      type: 'credential.request',
      requestId: 'req-1',
      label: 'Admin JWT',
      hint: 'DevTools > localStorage > token',
      usage: 'Test auth bypass on /api/admin',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
      isRequired: true,
      turnIndex: 0,
    }
    // Discriminant must be the literal so the union narrows.
    expect(event.type).toBe('credential.request')
    // Shape check — no `value`, `token`, `secret`, or `password` field.
    // Guards the security invariant: event payloads flow to SSE + SQLite.
    const forbiddenKeys = ['value', 'token', 'secret', 'password', 'plaintext']
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(event, key)).toBe(false)
    }
  })

  it('supports every placement variant', () => {
    const placements: CredentialRequestEvent['placement'][] = [
      { type: 'env', variableName: 'X' },
      { type: 'bearer' },
      { type: 'header', name: 'X-API-Key' },
      { type: 'cookie', name: 'session' },
      { type: 'body', fieldPath: 'auth.token' },
      { type: 'query', paramName: 'apikey' },
      { type: 'basic', usernameCredentialId: 'cred-user' },
    ]
    for (const placement of placements) {
      const event: CredentialRequestEvent = {
        type: 'credential.request',
        requestId: `req-${placement.type}`,
        label: `cred-${placement.type}`,
        hint: 'hint',
        usage: 'usage',
        placement,
        isRequired: false,
        turnIndex: 0,
      }
      expect(event.placement).toEqual(placement)
    }
  })
})

describe('CredentialResponseEvent', () => {
  it('stored: credentialId present, denied false', () => {
    const event: CredentialResponseEvent = {
      type: 'credential.response',
      requestId: 'req-1',
      credentialId: 'runtime_thread_ADMIN_JWT',
      label: 'Admin JWT',
      denied: false,
      turnIndex: 0,
    }
    expect(event.credentialId).toBe('runtime_thread_ADMIN_JWT')
    expect(event.denied).toBe(false)
  })

  it('denied: credentialId null, denied true', () => {
    const event: CredentialResponseEvent = {
      type: 'credential.response',
      requestId: 'req-1',
      credentialId: null,
      label: 'Admin JWT',
      denied: true,
      turnIndex: 0,
    }
    expect(event.credentialId).toBeNull()
    expect(event.denied).toBe(true)
  })

  it('still carries no value field', () => {
    const event: CredentialResponseEvent = {
      type: 'credential.response',
      requestId: 'req-1',
      credentialId: 'runtime_thread_DB',
      label: 'DB URL',
      denied: false,
      turnIndex: 0,
    }
    const forbiddenKeys = ['value', 'token', 'secret', 'password', 'plaintext']
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(event, key)).toBe(false)
    }
  })
})

describe('isCredentialEvent', () => {
  it('returns true for credential.request', () => {
    const event: LoomEvent = {
      type: 'credential.request',
      requestId: 'req-1',
      label: 'X',
      hint: 'h',
      usage: 'u',
      placement: { type: 'env', variableName: 'X' },
      isRequired: false,
      turnIndex: 0,
    }
    expect(isCredentialEvent(event)).toBe(true)
  })

  it('returns true for credential.response', () => {
    const event: LoomEvent = {
      type: 'credential.response',
      requestId: 'req-1',
      credentialId: null,
      label: 'X',
      denied: true,
      turnIndex: 0,
    }
    expect(isCredentialEvent(event)).toBe(true)
  })

  it('returns false for permission events (disjoint from credential events)', () => {
    const event: PermissionRequestEvent = {
      type: 'permission.request',
      requestId: 'req-1',
      toolName: 'shell_execute',
      input: {},
      reason: 'r',
      turnIndex: 0,
    }
    expect(isCredentialEvent(event)).toBe(false)
  })

  it('returns false for unrelated event types', () => {
    const text: TextDeltaEvent = { type: 'text.delta', text: 'hi', turnIndex: 0 }
    const sec: SecurityBlockEvent = {
      type: 'security.block',
      toolName: 'shell_execute',
      level: 'blocked',
      reason: 'r',
      turnIndex: 0,
    }
    expect(isCredentialEvent(text)).toBe(false)
    expect(isCredentialEvent(sec)).toBe(false)
  })

  it('narrows the union on true (type-level contract)', () => {
    const event: LoomEvent = {
      type: 'credential.request',
      requestId: 'req-1',
      label: 'X',
      hint: 'h',
      usage: 'u',
      placement: { type: 'env', variableName: 'X' },
      isRequired: true,
      turnIndex: 0,
    }
    if (isCredentialEvent(event)) {
      // Inside this branch, `event` is CredentialRequest|Response only —
      // `label` is a guaranteed property on both. If the guard didn't
      // narrow, this line would fail type-check.
      expect(typeof event.label).toBe('string')
    } else {
      throw new Error('guard must have narrowed here')
    }
  })
})
