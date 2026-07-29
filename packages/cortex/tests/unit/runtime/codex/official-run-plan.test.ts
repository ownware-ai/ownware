import { describe, expect, it } from 'vitest'
import {
  CodexOfficialRunPlanError,
  composeCodexOfficialRunPlan,
} from '../../../../src/runtime/codex/official-run-plan.js'
import type { CodexScopedToolAuthority } from '../../../../src/runtime/codex/profile-mapping.js'

function readyProfile(toolNames: readonly string[] = []) {
  return {
    report: {
      id: 'profile-report',
      state: 'ready' as const,
      observedAt: '2026-07-26T00:00:00.000Z',
      validUntil: null,
      authority: 'codex-app-server/0.145.0-generated-schema' as const,
      entries: [],
      limitations: [],
    },
    mapping: {
      reportId: 'profile-report',
      requestDigest: 'request-digest',
      scopedToolNames: toolNames,
      threadStart: {
        cwd: '/tmp/workspace',
        model: 'gpt-5.4',
        developerInstructions: 'Use verified evidence.',
        approvalPolicy: 'never' as const,
        sandbox: 'read-only' as const,
      },
      turnStart: {
        input: [{ type: 'text' as const, text: 'Inspect the workspace.' }],
      },
    },
  }
}

function readySandbox() {
  return {
    report: {
      id: 'sandbox-report',
      state: 'requires_acceptance' as const,
      observedAt: '2026-07-26T00:00:00.000Z',
      validUntil: null,
      authority: 'codex-app-server/0.145.0-generated-schema' as const,
      limitations: [],
    },
    plan: {
      threadStart: {
        sandbox: 'workspace-write' as const,
        approvalPolicy: {
          granular: {
            mcp_elicitations: false as const,
            request_permissions: false as const,
            rules: false as const,
            sandbox_approval: true as const,
            skill_approval: false as const,
          },
        },
      },
      turnStart: {
        sandboxPolicy: {
          type: 'workspaceWrite' as const,
          writableRoots: ['/tmp/workspace'],
          networkAccess: false as const,
          excludeSlashTmp: true as const,
          excludeTmpdirEnvVar: true as const,
        },
      },
      readScope: 'host_readable' as const,
      networkScope: 'denied' as const,
    },
  }
}

describe('composeCodexOfficialRunPlan', () => {
  it('replaces the preview fence only after both accepted plans are present', () => {
    const plan = composeCodexOfficialRunPlan({
      profile: readyProfile(),
      sandbox: readySandbox(),
    })

    expect(plan.threadStart).toMatchObject({
      cwd: '/tmp/workspace',
      sandbox: 'workspace-write',
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          request_permissions: false,
        },
      },
    })
    expect(plan.requestDigest).toBe('request-digest')
    expect(plan.turnStart.sandboxPolicy).toMatchObject({
      type: 'workspaceWrite',
      networkAccess: false,
    })
    expect(plan.readScope).toBe('host_readable')
    expect(plan.networkScope).toBe('denied')
  })

  it('rejects unaccepted profile/sandbox plans and stale tool authority', () => {
    expect(() => composeCodexOfficialRunPlan({
      profile: { ...readyProfile(), mapping: null },
      sandbox: readySandbox(),
    })).toThrowError(expect.objectContaining({ code: 'profile_not_ready' }))

    expect(() => composeCodexOfficialRunPlan({
      profile: readyProfile(),
      sandbox: { ...readySandbox(), plan: null },
    })).toThrowError(expect.objectContaining({ code: 'sandbox_not_ready' }))

    expect(() => composeCodexOfficialRunPlan({
      profile: readyProfile(['filesystem_read']),
      sandbox: readySandbox(),
    })).toThrowError(expect.objectContaining({ code: 'tool_authority_stale' }))
    expect(() => composeCodexOfficialRunPlan({
      profile: readyProfile(['filesystem_read']),
      sandbox: readySandbox(),
      scopedTools: {
        toolNames: ['filesystem_read'],
        isActive: () => false,
      } as CodexScopedToolAuthority,
    })).toThrowError(expect.objectContaining({ code: 'tool_authority_stale' }))
    expect(new CodexOfficialRunPlanError('sandbox_not_ready').message).toBe(
      'Codex official run plan failed (sandbox_not_ready).',
    )
  })
})
