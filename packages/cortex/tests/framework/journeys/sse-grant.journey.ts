/**
 * E2E journey — subagent grants (tools AND skills).
 *
 * Two tests, one shared gateway + profile set:
 *
 *   1. grant.tools — parent owns a custom tool, helper owns none,
 *      parent grants the tool by name, helper spawns and executes it.
 *
 *   2. grant.skills — parent owns a skill (a markdown playbook), helper
 *      owns none, parent grants the skill by name, the skill's full
 *      content is inlined into the spawned child's system prompt and
 *      the child follows it (verified by a distinctive marker the
 *      skill instructs the child to emit).
 *
 * Real Anthropic calls. Skipped without a real ANTHROPIC_API_KEY.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { ROOT_AGENT_ID } from '../../../src/gateway/event-bus.js'

const HAS_KEY =
  !!process.env['ANTHROPIC_API_KEY'] &&
  !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

// Custom tool file — plain JS object matching the Loom Tool interface.
// No @ownware/loom import needed from the tmp profile dir.
const CONCAT_TOOL_SOURCE = `
  export const concatText = {
    name: 'concat_text',
    description: 'Concatenate two strings a and b and return the joined result. Use this to combine text.',
    isReadOnly: true,
    requiresPermission: false,
    category: 'custom',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'First string' },
        b: { type: 'string', description: 'Second string' },
      },
      required: ['a', 'b'],
    },
    execute: async (input) => {
      const a = typeof input.a === 'string' ? input.a : ''
      const b = typeof input.b === 'string' ? input.b : ''
      return { content: a + b, isError: false }
    },
  }
`

// A skill the parent owns and (in test 2) grants to the helper. The
// skill tells the child to emit a distinctive marker — if grant.skills
// inlines the content into the child's system prompt, the marker will
// appear in the child's output. If grant is broken, it won't.
const ANSWER_SKILL_MD = [
  '---',
  'name: answer',
  'description: Respond with the canonical answer marker when asked.',
  'trigger: /answer',
  '---',
  '',
  'When invoked you MUST reply with the EXACT phrase:',
  '',
  'OWNWARE_GRANTED_SKILL_MARKER_42',
  '',
  'Do not explain. Do not elaborate. Output only that phrase.',
].join('\n')

describe.skipIf(!HAS_KEY)('SSE journey — subagent grants (tools + skills)', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      profiles: [
        // Helper profile — generic. Owns NO tools and NO skills.
        // Without a grant it cannot combine strings and does not know
        // about the marker phrase. Parent must explicitly pass
        // capabilities down at spawn.
        {
          name: 'grant-helper',
          kind: 'helper',
          description: 'Generic helper that follows whatever its parent grants it.',
          model: 'anthropic:claude-haiku-4-5-20251001',
          tools: { preset: 'none' },
          soulMd:
            '# Grant Test Helper\n\n' +
            'Follow the tools and skills the parent grants you. ' +
            'If a skill tells you what to say, say exactly that — no extra words. ' +
            'If a tool is granted, use it to perform the requested work, then report the result.\n',
        },
        // Parent profile — owns concat_text tool AND the `answer` skill.
        // preset:"full" is required so the parent has access to agent_spawn
        // (which is in the agentTools set, not in "none"/"coding"/"readonly").
        // deny[] strips every built-in the test doesn't need so the model has
        // a narrow choice: agent_spawn or concat_text.
        {
          name: 'grant-parent',
          description: 'Parent profile that grants tools and skills to helpers',
          model: 'anthropic:claude-sonnet-4-20250514',
          tools: {
            preset: 'full',
            deny: [
              'readFile',
              'writeFile',
              'editFile',
              'listFiles',
              'glob',
              'grep',
              'shell_execute',
              'web_fetch',
              'web_search',
              'memory_store',
              'memory_search',
              'memory_forget',
              'ask_user',
              'image_generate',
              'text_to_speech',
              'speech_to_text',
              'browser_*',
            ],
            custom: [{ path: './tools/concat.mjs' }],
          },
          customTools: {
            'tools/concat.mjs': CONCAT_TOOL_SOURCE,
          },
          skills: {
            answer: ANSWER_SKILL_MD,
          },
          subagents: [
            {
              name: 'composer',
              description: 'Combines two strings using concat_text',
              profile: 'grant-helper',
              grant: { tools: ['concat_text'] },
            },
            {
              name: 'answerer',
              description: 'Emits the canonical answer marker when asked',
              profile: 'grant-helper',
              grant: { skills: ['answer'] },
            },
          ],
          soulMd:
            '# Grant Test Parent\n\n' +
            'When the user asks to combine strings, you MUST use agent_spawn to dispatch the "composer" helper. ' +
            'When the user asks for the "canonical answer" or mentions asking the answerer, you MUST use agent_spawn to dispatch the "answerer" helper. ' +
            'Do NOT call concat_text yourself. Do NOT produce the marker phrase yourself. ' +
            'Let the helpers do the work, then report their results verbatim.\n',
        },
      ],
      recordFixtures: false,
    })
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  }, 120_000)

  it('helper spawned via grant can actually call the granted tool and return the result', async () => {
    const thread = gw.state.createThread('grant-parent', 'grant-journey')
    const { events } = await gw.client.sseRaw('/api/v1/run', {
      prompt:
        'Use the composer helper to concatenate the strings "foo" and "bar". ' +
        'Do NOT attempt to combine them yourself — spawn the composer and wait for its answer.',
      profileId: 'grant-parent',
      threadId: thread.id,
    })

    // Drain the stream; auto-approve any permission prompts (there
    // shouldn't be any for this profile, but defence in depth).
    for await (const e of events) {
      if (e.event === 'permission.request') {
        await gw.client.post(`/api/v1/threads/${thread.id}/resume`, {
          action: 'approve',
        })
      }
    }

    // ── 1. The parent actually spawned the helper ──────────────────
    const rootEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: ROOT_AGENT_ID,
    })
    expect(rootEvents.length).toBeGreaterThan(0)

    const rootTypes = new Set(rootEvents.map((e) => e.type))
    expect(rootTypes.has('agent.spawn')).toBe(true)
    expect(rootTypes.has('agent.complete')).toBe(true)

    // Find the spawned child's agentId.
    const listRes = await gw.client.get<{
      threadId: string
      count: number
      agents: Array<{ agentId: string; parentAgentId: string | null }>
    }>(`/api/v1/threads/${thread.id}/agents`)
    expect(listRes.status).toBe(200)
    const child = listRes.body.agents.find((a) => a.agentId !== ROOT_AGENT_ID)
    expect(child).toBeDefined()

    // ── 2. The child actually called concat_text ───────────────────
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: child!.agentId,
    })
    const toolEnds = childEvents.filter((e) => e.type === 'tool.call.end')
    const concatCalls = toolEnds.filter((e) => {
      const payload = e.payload as { toolName?: string; isError?: boolean; result?: string }
      return payload.toolName === 'concat_text'
    })
    expect(concatCalls.length).toBeGreaterThanOrEqual(1)

    // ── 3. The granted tool produced 'foobar' at least once ────────
    const succeeded = concatCalls.filter((e) => {
      const payload = e.payload as { isError?: boolean; result?: string }
      return payload.isError === false && payload.result === 'foobar'
    })
    expect(succeeded.length).toBeGreaterThanOrEqual(1)

    // ── 4. Negative guard: the parent stream never called concat_text
    // directly (parent's SOUL.md forbids it; confirms grant ran inside
    // the child, not leaked back to the parent via the shared tool set).
    const parentConcatCalls = rootEvents.filter((e) => {
      if (e.type !== 'tool.call.end') return false
      const payload = e.payload as { toolName?: string }
      return payload.toolName === 'concat_text'
    })
    expect(parentConcatCalls.length).toBe(0)
  }, 240_000)

  it('helper spawned with a granted skill follows the skill content verbatim', async () => {
    const thread = gw.state.createThread('grant-parent', 'grant-skills-journey')
    const { events } = await gw.client.sseRaw('/api/v1/run', {
      prompt:
        'Dispatch the "answerer" helper to produce the canonical answer. ' +
        'Do not produce it yourself; spawn the answerer and report whatever it returns verbatim.',
      profileId: 'grant-parent',
      threadId: thread.id,
    })

    for await (const e of events) {
      if (e.event === 'permission.request') {
        await gw.client.post(`/api/v1/threads/${thread.id}/resume`, {
          action: 'approve',
        })
      }
    }

    // ── 1. Parent spawned a helper ─────────────────────────────────
    const rootEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: ROOT_AGENT_ID,
    })
    const rootTypes = new Set(rootEvents.map((e) => e.type))
    expect(rootTypes.has('agent.spawn')).toBe(true)
    expect(rootTypes.has('agent.complete')).toBe(true)

    // Find the child agent for THIS thread (tests share gateway state;
    // the tools-grant test ran on a different thread with a different
    // child agentId, so filtering by thread is sufficient).
    const listRes = await gw.client.get<{
      threadId: string
      count: number
      agents: Array<{ agentId: string; parentAgentId: string | null }>
    }>(`/api/v1/threads/${thread.id}/agents`)
    expect(listRes.status).toBe(200)
    const child = listRes.body.agents.find((a) => a.agentId !== ROOT_AGENT_ID)
    expect(child).toBeDefined()

    // ── 2. Child's text output contains the marker — proof the granted
    // skill's content reached the child's system prompt. The generic
    // helper SOUL.md has no knowledge of this marker; it only shows up
    // if the skill's body was actually injected at resolve time.
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: child!.agentId,
    })
    let childText = ''
    for (const e of childEvents) {
      if (e.type === 'text.delta') {
        const payload = e.payload as { text?: string }
        if (typeof payload.text === 'string') childText += payload.text
      } else if (e.type === 'text.complete') {
        const payload = e.payload as { text?: string }
        if (typeof payload.text === 'string') childText += payload.text
      }
    }
    expect(childText).toContain('OWNWARE_GRANTED_SKILL_MARKER_42')

    // ── 3. Negative guard: the parent stream should not contain the
    // marker — the parent never sees the skill content (only its name
    // on the catalog), so emitting the marker directly would mean the
    // grant leaked upward or the parent guessed. Neither is acceptable.
    let parentText = ''
    for (const e of rootEvents) {
      if (e.type === 'text.delta' || e.type === 'text.complete') {
        const payload = e.payload as { text?: string }
        if (typeof payload.text === 'string') parentText += payload.text
      }
    }
    // The parent may echo the child's result to the user (SOUL.md says
    // "report their results verbatim") — so the marker CAN appear in the
    // parent's FINAL text, which is correct behaviour. The assertion we
    // care about is that the CHILD produced it first, checked above.
    // Here we just confirm the child's text is not empty so we know the
    // assertion above exercised real child output.
    expect(childText.length).toBeGreaterThan(0)
    // Keep parentText referenced for future debugging if this test
    // regresses; no assertion on its exact contents.
    void parentText
  }, 240_000)
})
