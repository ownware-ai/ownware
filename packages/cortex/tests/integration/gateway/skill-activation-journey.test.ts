import { afterEach, describe, expect, it } from 'vitest'
import {
  registerProvider,
  unregisterProvider,
  type Message,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderFeature,
  type ProviderRequest,
  type ToolDefinition,
} from '@ownware/loom'
import {
  createTestGateway,
  type TestGateway,
} from '../../framework/harness/index.js'

const PROVIDER_NAME = 'skillactivationjourney'
const ROOT_PROFILE_ID = 'test-agent'
const PARENT_PROFILE_ID = 'test-agent'
const SKILL_NAME = 'audit-workflow'
const SKILL_BODY_MARKER = 'EXACT_SKILL_BODY_7f0a5f31'
const CALLER_ARG_MARKER = 'CALLER_ARG_PRIVATE_8481c41d'

const SKILL_MD = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: Apply the exact audit workflow.',
  'trigger: /audit/',
  '---',
  '',
  `This is the exact workflow body: ${SKILL_BODY_MARKER}`,
].join('\n')

interface ObservedProviderRequest {
  readonly request: ProviderRequest
  readonly observedAt: number
}

function provider(
  observed: ObservedProviderRequest[],
): ProviderAdapter {
  const completedRootCalls = new Set<string>()
  return {
    name: PROVIDER_NAME,
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      observed.push({ request, observedAt: Date.now() })
      const system = systemText(request)
      const messages = JSON.stringify(request.messages)
      const hasRootSkillTool = request.tools.some(tool => tool.name === 'skill')
      const hasSpawnTool = request.tools.some(tool => tool.name === 'agent_spawn')

      if (
        hasRootSkillTool
        && messages.includes('Apply the audit workflow.')
        && !messages.includes(SKILL_BODY_MARKER)
      ) {
        yield* toolCall('root-skill-call', 'skill', {
          name: SKILL_NAME,
          args: CALLER_ARG_MARKER,
        })
        return
      }

      if (
        hasSpawnTool
        && !system.includes(SKILL_BODY_MARKER)
        && !completedRootCalls.has(PARENT_PROFILE_ID)
      ) {
        completedRootCalls.add(PARENT_PROFILE_ID)
        yield* toolCall('helper-spawn-call', 'agent_spawn', {
          name: 'Evidence helper',
          prompt: 'Apply the granted audit workflow.',
          subagent_type: 'auditor',
        })
        return
      }

      yield { type: 'text_delta', text: 'done' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: usage(),
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      return messages.length
    },
    supportsFeature(_feature: ProviderFeature): boolean {
      return true
    },
    formatTools(tools: ToolDefinition[]): unknown[] {
      return tools
    },
    getModelPricing() {
      return null
    },
  }
}

async function* toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AsyncGenerator<ProviderChunk> {
  yield { type: 'tool_use_start', id, name }
  yield { type: 'tool_use_args_delta', id, delta: JSON.stringify(input) }
  yield { type: 'tool_use_end', id }
  yield {
    type: 'message_complete',
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: usage(),
  }
}

function usage() {
  return {
    inputTokens: 5,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

function systemText(request: ProviderRequest): string {
  return typeof request.system === 'string'
    ? request.system
    : request.system.map(block => block.text).join('\n')
}

async function waitForRunToStop(gateway: TestGateway, threadId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (gateway.runner.isRunning(threadId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(gateway.runner.isRunning(threadId)).toBe(false)
}

function expectKeyedDigest(value: unknown): void {
  expect(typeof value).toBe('string')
  expect((value as string).startsWith('hmac-sha256:')).toBe(true)
  expect((value as string).length).toBe('hmac-sha256:'.length + 64)
}

describe('skill activation evidence through the public Gateway', () => {
  let gateway: TestGateway | undefined

  afterEach(async () => {
    await gateway?.stop()
    gateway = undefined
    unregisterProvider(PROVIDER_NAME)
  })

  it('persists a content-free root receipt before publishing the exact dispatcher event', async () => {
    const observed: ObservedProviderRequest[] = []
    registerProvider(provider(observed))
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{
        name: ROOT_PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
        skills: { [SKILL_NAME]: SKILL_MD },
      }],
    })

    const started = await gateway.client.post('/api/v1/run', {
      profileId: ROOT_PROFILE_ID,
      prompt: 'Apply the audit workflow.',
    })
    expect(started.status).toBe(200)
    const runId = String(started.body['runId'])
    const threadId = String(started.body['threadId'])
    await waitForRunToStop(gateway, threadId)

    expect(observed).toHaveLength(2)
    expect(JSON.stringify(observed[0]!.request.messages)).not.toContain(SKILL_BODY_MARKER)
    expect(JSON.stringify(observed[1]!.request.messages)).toContain(SKILL_BODY_MARKER)
    expect(JSON.stringify(observed[1]!.request.messages)).toContain(CALLER_ARG_MARKER)

    const unauthenticated = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${runId}/skill-activation-receipts`,
    )
    expect(unauthenticated.status).toBe(401)

    const invalidPage = await gateway.client.get(
      `/api/v1/runs/${runId}/skill-activation-receipts?limit=01`,
    )
    expect(invalidPage.status).toBe(400)
    expect(invalidPage.body).toMatchObject({
      error: 'skill_activation_receipt_page_invalid',
    })

    const response = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${runId}/skill-activation-receipts?limit=1`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const page = await response.json() as {
      readonly items: readonly Record<string, unknown>[]
      readonly nextCursor: string | null
    }
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeNull()
    expect(page.items[0]).toMatchObject({
      sequence: 1,
      runId,
      profileId: ROOT_PROFILE_ID,
      skillName: SKILL_NAME,
      agentId: null,
      toolCallId: 'root-skill-call',
      turnIndex: 0,
    })
    expectKeyedDigest(page.items[0]?.['profileDigest'])
    expectKeyedDigest(page.items[0]?.['skillDigest'])
    const publicReceipt = JSON.stringify(page)
    expect(publicReceipt).not.toContain(SKILL_BODY_MARKER)
    expect(publicReceipt).not.toContain(CALLER_ARG_MARKER)

    const events = await gateway.state.listAgentEvents({ threadId, agentId: 'root' })
    const activationIndex = events.findIndex(event => event.type === 'skill.activation')
    const toolEndIndex = events.findIndex(event =>
      event.type === 'tool.call.end' && event.payload['toolCallId'] === 'root-skill-call')
    expect(activationIndex).toBeGreaterThanOrEqual(0)
    expect(toolEndIndex).toBeGreaterThan(activationIndex)
    expect(JSON.stringify(events[activationIndex]?.payload)).not.toContain(SKILL_BODY_MARKER)
    expect(events[activationIndex]?.payload).toMatchObject({
      activationId: page.items[0]?.['receiptId'],
      sourceRef: ROOT_PROFILE_ID,
      skillName: SKILL_NAME,
    })
  })

  it('persists an explicit helper grant before the helper provider request', async () => {
    const observed: ObservedProviderRequest[] = []
    registerProvider(provider(observed))
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [
        {
          name: PARENT_PROFILE_ID,
          model: `${PROVIDER_NAME}:model`,
          tools: { preset: 'none' },
          skills: { [SKILL_NAME]: SKILL_MD },
          subagents: [{
            name: 'auditor',
            description: 'Applies the audit workflow.',
            systemPrompt: '# Helper\n\nUse only explicitly granted context.',
            grant: { skills: [SKILL_NAME] },
          }],
        },
      ],
    })

    const started = await gateway.client.post('/api/v1/run', {
      profileId: PARENT_PROFILE_ID,
      prompt: 'Ask the auditor helper to apply its granted workflow.',
    })
    expect(started.status).toBe(200)
    const runId = String(started.body['runId'])
    const threadId = String(started.body['threadId'])
    await waitForRunToStop(gateway, threadId)

    const helperRequest = observed.find(entry =>
      systemText(entry.request).includes(SKILL_BODY_MARKER))
    expect(helperRequest).toBeDefined()
    const rootRequests = observed.filter(entry =>
      !systemText(entry.request).includes(SKILL_BODY_MARKER))
    expect(rootRequests.length).toBeGreaterThanOrEqual(2)
    expect(rootRequests.every(entry =>
      !systemText(entry.request).includes(SKILL_BODY_MARKER))).toBe(true)

    const response = await gateway.client.get<{
      readonly items: readonly Record<string, unknown>[]
      readonly nextCursor: string | null
    }>(`/api/v1/runs/${runId}/skill-activation-receipts`)
    expect(response.status).toBe(200)
    expect(response.body.items).toHaveLength(1)
    const receipt = response.body.items[0]!
    expect(receipt).toMatchObject({
      sequence: 1,
      runId,
      profileId: PARENT_PROFILE_ID,
      skillName: SKILL_NAME,
      toolCallId: null,
      turnIndex: 0,
    })
    expect(typeof receipt['agentId']).toBe('string')
    expectKeyedDigest(receipt['profileDigest'])
    expectKeyedDigest(receipt['skillDigest'])
    expect(Number(receipt['activatedAt'])).toBeLessThanOrEqual(helperRequest!.observedAt)
    expect(JSON.stringify(response.body)).not.toContain(SKILL_BODY_MARKER)

    const childAgentId = String(receipt['agentId'])
    const childEvents = await gateway.state.listAgentEvents({
      threadId,
      agentId: childAgentId,
    })
    const activationIndex = childEvents.findIndex(event => event.type === 'skill.activation')
    const sessionStartIndex = childEvents.findIndex(event => event.type === 'session.start')
    expect(activationIndex).toBeGreaterThanOrEqual(0)
    expect(sessionStartIndex).toBeGreaterThan(activationIndex)
    expect(childEvents[activationIndex]?.payload).toMatchObject({
      activationId: receipt['receiptId'],
      sourceRef: PARENT_PROFILE_ID,
      skillName: SKILL_NAME,
      agentId: childAgentId,
      toolCallId: null,
    })
    expect(JSON.stringify(childEvents[activationIndex]?.payload)).not.toContain(SKILL_BODY_MARKER)
  })
})
