import { describe, expect, it } from 'vitest'
import type { Tool } from '@ownware/loom'
import {
  canonicalPermissionJson,
  permissionPolicyRevision,
  permissionToolRevision,
  scheduleApprovalOperationHash,
} from '../../../src/gateway/permission-intent.js'

function testTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'send_email',
    description: 'Send one email',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' } },
      required: ['to'],
    },
    execute: async () => ({ content: 'sent' }),
    ...overrides,
  }
}

describe('permission intent identity', () => {
  it('canonicalizes JSON object keys while preserving exact array order', () => {
    expect(canonicalPermissionJson({ z: [2, { b: true, a: null }], a: 'x' })).toBe(
      '{"a":"x","z":[2,{"a":null,"b":true}]}',
    )
    expect(canonicalPermissionJson({ a: 'x', z: [{ a: null, b: true }, 2] })).not.toBe(
      canonicalPermissionJson({ z: [2, { b: true, a: null }], a: 'x' }),
    )
  })

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date(0),
    Object.assign([], { extra: true }),
    Object.assign(Object.create(null), {
      [Symbol('hidden')]: true,
    }),
  ])('rejects non-JSON intent material %#', (value) => {
    expect(() => canonicalPermissionJson(value)).toThrow('Permission intent is invalid')
  })

  it('rejects sparse arrays, accessors, cycles and excessive nesting without normalizing them', () => {
    const sparse = new Array(1)
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'hidden',
    })
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    let deep: unknown = null
    for (let index = 0; index < 258; index += 1) deep = [deep]

    for (const value of [sparse, accessor, cycle, deep]) {
      expect(() => canonicalPermissionJson(value)).toThrow('Permission intent is invalid')
    }
  })

  it('allows repeated non-cyclic references because the resulting JSON remains unambiguous', () => {
    const shared = { exact: true }
    expect(canonicalPermissionJson({ left: shared, right: shared })).toBe(
      '{"left":{"exact":true},"right":{"exact":true}}',
    )
  })

  it('changes the tool revision when an authorization-relevant declaration changes', () => {
    const baseline = testTool()
    expect(permissionToolRevision(testTool())).toBe(permissionToolRevision(baseline))
    expect(permissionToolRevision(testTool({ requiresPermission: true }))).not.toBe(
      permissionToolRevision(baseline),
    )
    expect(permissionToolRevision(testTool({
      egress: {
        contractRevision: 'ownware.tool-egress.v1',
        mediation: 'uncontained',
      },
    }))).not.toBe(permissionToolRevision(baseline))
    expect(permissionToolRevision(testTool({
      conditionalEffect: {
        contractRevision: 'etag-v1',
        captureTargetRevision: async () => 'v1',
        executeIfCurrent: async () => ({ content: 'sent' }),
      },
    }))).not.toBe(permissionToolRevision(baseline))
  })

  it('makes policy identity tool-order independent but workspace sensitive', () => {
    const read = testTool({ name: 'read_email', isReadOnly: true })
    const write = testTool()
    const base = {
      profileId: 'assistant',
      candidateId: 'candidate-1',
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/one',
      safetyLevel: 'draft-approval' as const,
      permissionMode: 'ask',
      egressMode: 'unrestricted' as const,
      zoneConfig: { external: 'ask' },
    }
    expect(permissionPolicyRevision({ ...base, tools: [read, write] })).toBe(
      permissionPolicyRevision({ ...base, tools: [write, read] }),
    )
    expect(permissionPolicyRevision({ ...base, tools: [read, write] })).not.toBe(
      permissionPolicyRevision({ ...base, workspacePath: '/tmp/two', tools: [read, write] }),
    )
  })

  it('changes a held approval identity for every bound action dimension', () => {
    const base = {
      approvalId: 'approval-1',
      scheduleId: 'schedule-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'send_email',
      toolInput: { to: 'a@example.test' },
      policyRevision: 'a'.repeat(64),
      toolRevision: 'b'.repeat(64),
      targetRevision: 'etag-1',
    }
    const identity = scheduleApprovalOperationHash(base)
    const variants = [
      { ...base, runId: 'run-2' },
      { ...base, threadId: 'thread-2' },
      { ...base, toolInput: { to: 'b@example.test' } },
      { ...base, policyRevision: 'c'.repeat(64) },
      { ...base, toolRevision: 'd'.repeat(64) },
      { ...base, targetRevision: 'etag-2' },
    ]
    for (const variant of variants) {
      expect(scheduleApprovalOperationHash(variant)).not.toBe(identity)
    }
  })
})
