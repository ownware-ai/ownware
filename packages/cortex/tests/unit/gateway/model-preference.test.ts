import { describe, expect, it, vi } from 'vitest'
import { resolveRunModelPreference } from '../../../src/gateway/catalog/models/preference.js'
import { createRunHandlers } from '../../../src/gateway/handlers/run.js'
import type { GatewayState } from '../../../src/gateway/state.js'
import type { ProfileRegistry } from '../../../src/profile/registry.js'
import type { SessionRunner } from '../../../src/gateway/session-runner.js'

describe('resolveRunModelPreference', () => {
  it.each([
    {
      input: {
        requestModel: ' request:model ',
        threadModel: 'thread:model',
        installDefaultModel: 'install:model',
        profileDefaultModel: 'profile:model',
      },
      expected: { model: 'request:model', source: 'request' },
    },
    {
      input: {
        requestModel: '  ',
        threadModel: ' thread:model ',
        installDefaultModel: 'install:model',
        profileDefaultModel: 'profile:model',
      },
      expected: { model: 'thread:model', source: 'thread' },
    },
    {
      input: {
        requestModel: null,
        threadModel: '',
        installDefaultModel: ' install:model ',
        profileDefaultModel: 'profile:model',
      },
      expected: { model: 'install:model', source: 'install' },
    },
    {
      input: {
        requestModel: undefined,
        threadModel: null,
        installDefaultModel: ' \n ',
        profileDefaultModel: ' profile:model ',
      },
      expected: { model: 'profile:model', source: 'profile' },
    },
  ])('selects $expected.source without blank shadowing', ({ input, expected }) => {
    expect(resolveRunModelPreference(input)).toEqual(expected)
  })

  it('fails honestly when every configured source is blank', () => {
    expect(() => resolveRunModelPreference({
      requestModel: ' ',
      threadModel: null,
      installDefaultModel: '',
      profileDefaultModel: '\n',
    })).toThrow('Profile default model must not be blank')
  })
})

describe('run model runtime authority', () => {
  it.each([
    {
      authority: { runtimeId: 'openai-codex' },
      status: 409,
      code: 'model_runtime_incompatible',
    },
    {
      authority: null,
      status: 422,
      code: 'install_default_model_unknown',
    },
  ])(
    'rejects an install default before mutation when Provider Hub reports $authority',
    async ({ authority, status, code }) => {
      const setThreadModel = vi.fn()
      const start = vi.fn()
      const thread = {
        id: 'thread-one',
        profileId: 'agent',
        workspaceId: null,
        model: null,
      }
      const createThread = vi.fn(async () => thread)
      const state = {
        createThread,
        getThread: vi.fn(async () => thread),
        getSetting: vi.fn(async (key: string) => key === 'defaults.defaultModel'
          ? { value: 'codex:gpt-test' }
          : undefined),
        setThreadModel,
      } as unknown as GatewayState
      const registry = {
        has: vi.fn(() => true),
        get: vi.fn(async () => ({ config: { model: 'openai:profile-model' } })),
      } as unknown as ProfileRegistry
      const runner = { start } as unknown as SessionRunner
      const handlers = createRunHandlers(state, registry, runner, {
        pickRunnableDefaultModel: async () => null,
        resolveModelExecutionAuthority: async () => authority,
      })

      const error = await handlers.startProfileRun({
        profileId: 'agent',
        prompt: 'must not migrate runtime',
      }).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ status, code })
      expect(createThread).not.toHaveBeenCalled()
      expect(setThreadModel).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
    },
  )

  it('rejects before resetting an existing cached session', async () => {
    const resetSession = vi.fn()
    const setThreadModel = vi.fn()
    const start = vi.fn()
    const thread = {
      id: 'thread-one',
      profileId: 'agent',
      workspaceId: null,
      model: 'openai:old-model',
    }
    const state = {
      getThread: vi.fn(async () => thread),
      getSession: vi.fn(() => ({})),
      getSessionCandidateId: vi.fn(() => 'sha256:old'),
      getSetting: vi.fn(async () => undefined),
      resetSession,
      setThreadModel,
    } as unknown as GatewayState
    const registry = {
      has: vi.fn(() => true),
      get: vi.fn(async () => ({ config: { model: 'openai:profile-model' } })),
    } as unknown as ProfileRegistry
    const runner = { start } as unknown as SessionRunner
    const handlers = createRunHandlers(state, registry, runner, {
      pickRunnableDefaultModel: async () => null,
      resolveModelExecutionAuthority: async () => ({ runtimeId: 'codex-app-server' }),
      candidateResolver: {
        resolve: vi.fn(async () => ({
          candidateId: 'sha256:new',
          profile: { config: { model: 'openai:profile-model' } },
        })),
      } as never,
    })

    const error = await handlers.startProfileRun({
      profileId: 'agent',
      threadId: thread.id,
      prompt: 'must fail before cache mutation',
      model: 'codex:gpt-test',
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ status: 409, code: 'model_runtime_incompatible' })
    expect(resetSession).not.toHaveBeenCalled()
    expect(setThreadModel).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('never treats a runtime-incompatible profile default as keyless unavailability', async () => {
    const pickRunnableDefaultModel = vi.fn(async () => 'openai:fallback')
    const createThread = vi.fn()
    const start = vi.fn()
    const state = {
      getSetting: vi.fn(async () => undefined),
      createThread,
    } as unknown as GatewayState
    const registry = {
      has: vi.fn(() => true),
      get: vi.fn(async () => ({ config: { model: 'codex:gpt-test' } })),
    } as unknown as ProfileRegistry
    const handlers = createRunHandlers(
      state,
      registry,
      { start } as unknown as SessionRunner,
      {
        pickRunnableDefaultModel,
        resolveModelExecutionAuthority: async () => ({ runtimeId: 'codex-app-server' }),
      },
    )

    const error = await handlers.startProfileRun({
      profileId: 'agent',
      prompt: 'must not cross runtimes through fallback',
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ status: 409, code: 'model_runtime_incompatible' })
    expect(pickRunnableDefaultModel).not.toHaveBeenCalled()
    expect(createThread).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })
})
