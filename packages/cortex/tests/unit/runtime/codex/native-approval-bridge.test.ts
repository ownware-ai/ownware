import { describe, expect, it, vi } from 'vitest'
import type { LoomEvent, ToolCall } from '@ownware/loom'
import {
  CodexNativeApprovalBridge,
  type CodexNativeApprovalReview,
} from '../../../../src/runtime/codex/native-approval-bridge.js'

function commandRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      approvalId: null,
      command: 'printf safe',
      commandActions: null,
      cwd: '/tmp/workspace',
      networkApprovalContext: null,
      proposedExecpolicyAmendment: ['printf'],
      proposedNetworkPolicyAmendments: null,
      reason: 'provider-controlled prose',
      startedAtMs: 100,
      ...overrides,
    },
  }
}

function fileRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'file-item-1',
      grantRoot: null,
      reason: 'provider-controlled prose',
      startedAtMs: 101,
      ...overrides,
    },
  }
}

function permissionRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 43,
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'permissions-item-1',
      cwd: '/tmp/workspace',
      permissions: {
        fileSystem: {
          entries: [{
            access: 'write',
            path: { type: 'path', path: '/outside' },
          }],
        },
        network: { enabled: true },
      },
      reason: 'provider-controlled prose',
      startedAtMs: 102,
      ...overrides,
    },
  }
}

function bridge(options: {
  readonly review?: (review: CodexNativeApprovalReview) => Promise<'allow' | 'ask'>
  readonly requestApproval?: (tool: ToolCall, reason: string) => Promise<boolean>
  readonly authorizeToolExecution?: () => boolean | Promise<boolean>
  readonly onEvent?: (event: LoomEvent) => void | Promise<void>
  readonly resolveFileChange?: () => Promise<{
    readonly input: Record<string, unknown>
    readonly authority: string
  } | null>
} = {}): CodexNativeApprovalBridge {
  return new CodexNativeApprovalBridge({
    threadId: 'thread-1',
    review: options.review ?? (async () => 'ask'),
    requestApproval: options.requestApproval ?? (async () => false),
    authorizeToolExecution: options.authorizeToolExecution ?? (async () => true),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.resolveFileChange
      ? { resolveFileChange: options.resolveFileChange }
      : {}),
  })
}

describe('CodexNativeApprovalBridge', () => {
  it('maps an allowed command to one-turn accept without applying amendments', async () => {
    const events: LoomEvent[] = []
    const review = vi.fn(async () => 'allow' as const)
    const authorizeToolExecution = vi.fn(async () => true)
    const result = await bridge({
      review,
      authorizeToolExecution,
      onEvent: (event) => { events.push(event) },
    }).handle(commandRequest())

    expect(result).toMatchObject({
      handled: true,
      response: { decision: 'accept' },
      granted: true,
    })
    expect(JSON.stringify(result)).not.toContain('acceptForSession')
    expect(JSON.stringify(result)).not.toContain('printf safe')
    expect(events).toEqual([])
    expect(authorizeToolExecution.mock.calls[0]?.[0]).toMatchObject({
      name: 'codex_native_command',
      input: {
        command: 'printf safe',
        cwd: '/tmp/workspace',
      },
    })
    expect(JSON.stringify(events)).not.toContain('provider-controlled prose')
    expect(review).toHaveBeenCalledOnce()
  })

  it('asks through the existing channel and makes denial visible', async () => {
    const events: LoomEvent[] = []
    const requestApproval = vi.fn(async () => false)
    const result = await bridge({
      requestApproval,
      onEvent: (event) => { events.push(event) },
    }).handle(commandRequest({
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    }))

    expect(result).toMatchObject({
      handled: true,
      response: { decision: 'decline' },
      granted: false,
      code: 'approval_not_granted',
    })
    expect(requestApproval).toHaveBeenCalledOnce()
    expect(events[0]).toMatchObject({
      type: 'permission.request',
      input: {
        network: { host: 'example.com', protocol: 'https' },
      },
    })
    expect(events[1]).toMatchObject({
      type: 'permission.response',
      granted: false,
    })
  })

  it('fails closed when approval times out, throws, or the event channel disconnects', async () => {
    for (const failure of ['timeout', 'throw', 'observer'] as const) {
      const result = await bridge({
        requestApproval: async () => {
          if (failure === 'throw') throw new Error('private approval detail')
          return failure !== 'timeout'
        },
        onEvent: (event) => {
          if (failure === 'observer' && event.type === 'permission.request') {
            throw new Error('private observer detail')
          }
        },
      }).handle(commandRequest({ itemId: `item-${failure}` }))

      expect(result).toMatchObject({
        handled: true,
        response: { decision: 'decline' },
        granted: false,
        code: failure === 'timeout'
          ? 'approval_not_granted'
          : 'approval_channel_failed',
      })
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })

  it('requires item/effect context before accepting a file change', async () => {
    const unresolved = await bridge({
      review: async () => 'allow',
      resolveFileChange: async () => null,
    }).handle(fileRequest())
    expect(unresolved).toMatchObject({
      handled: true,
      response: { decision: 'decline' },
      granted: false,
    })

    const events: LoomEvent[] = []
    const authorizeToolExecution = vi.fn(async () => true)
    const resolved = await bridge({
      review: async () => 'allow',
      authorizeToolExecution,
      resolveFileChange: async () => ({
        input: {
          paths: ['/tmp/workspace/report.txt'],
          summary: 'Create one text file',
        },
        authority: 'item/fileChange/started',
      }),
      onEvent: (event) => { events.push(event) },
    }).handle(fileRequest({ itemId: 'file-item-2' }))
    expect(resolved).toMatchObject({
      handled: true,
      response: { decision: 'accept' },
      granted: true,
    })
    expect(events).toEqual([])
    expect(authorizeToolExecution.mock.calls[0]?.[0]).toMatchObject({
      name: 'codex_native_file_change',
      input: { paths: ['/tmp/workspace/report.txt'] },
    })
  })

  it('denies direct permission expansion with an empty turn-scoped grant', async () => {
    const events: LoomEvent[] = []
    const result = await bridge({
      requestApproval: async () => true,
      onEvent: (event) => { events.push(event) },
    }).handle(permissionRequest())

    expect(result).toMatchObject({
      handled: true,
      response: {
        permissions: {},
        scope: 'turn',
        strictAutoReview: true,
      },
      granted: false,
    })
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'permission.request',
      toolName: 'codex_native_permission_request',
      input: {
        requestedFilesystem: true,
        requestedNetwork: true,
      },
    })
  })

  it('deduplicates the exact callback identity and rejects conflicting reuse', async () => {
    const requestApproval = vi.fn(async () => true)
    const instance = bridge({ requestApproval })
    const request = commandRequest()

    const [first, duplicate] = await Promise.all([
      instance.handle(request),
      instance.handle(request),
    ])
    expect(first).toEqual(duplicate)
    expect(requestApproval).toHaveBeenCalledTimes(1)

    const conflict = await instance.handle(commandRequest({
      command: 'different command',
    }))
    expect(conflict).toMatchObject({
      handled: true,
      response: { decision: 'decline' },
      granted: false,
      code: 'approval_identity_conflict',
    })
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('declines malformed or cross-thread requests and leaves unknown methods unmapped', async () => {
    const requestApproval = vi.fn(async () => true)
    const instance = bridge({ requestApproval })

    expect(await instance.handle(commandRequest({
      threadId: 'other-thread',
    }))).toMatchObject({
      handled: true,
      response: { decision: 'decline' },
      granted: false,
      code: 'approval_scope_mismatch',
    })
    expect(await instance.handle(commandRequest({
      startedAtMs: 'invalid',
    }))).toMatchObject({
      handled: true,
      response: { decision: 'decline' },
      granted: false,
      code: 'approval_request_invalid',
    })
    expect(await instance.handle({
      id: 99,
      method: 'future/approval',
      params: {},
    })).toEqual({ handled: false })
    expect(requestApproval).not.toHaveBeenCalled()
  })
})
