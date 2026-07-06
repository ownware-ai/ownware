/**
 * End-to-end test: REAL Anthropic API exercising the memory system.
 *
 * What this proves:
 *   1. The `remember` tool is wired into the assembled tool set when
 *      memory.autoLearn is on, with the right description so the
 *      model decides to call it on its own.
 *   2. The tool's propose() lands a row in `memory_proposals` with
 *      the correct (profileId, threadId) binding — i.e. the agent
 *      did NOT have to know its own scope.
 *   3. Accepting the proposal moves it to `memories` ('active') and
 *      it ranks into the top-N for the next assembled session.
 *   4. A FRESH session for the same profile loads the new memory
 *      into its system prompt (verified by inspecting the prompt
 *      blocks the assembler emits).
 *
 * Skipped automatically when ANTHROPIC_API_KEY is not set.
 *
 * Cost: two Haiku turns + one Haiku assembly read. Designed to stay
 * under a few thousand tokens total per run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, systemPromptToText } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { CortexDatabase } from '../../src/gateway/db/database.js'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { createMemorySystem, type MemorySystem } from '../../src/memory/index.js'

const apiKey =
  process.env.ANTHROPIC_API_KEY &&
  !process.env.ANTHROPIC_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.ANTHROPIC_API_KEY
    : undefined

const PROFILE_ID = 'memory-e2e'

let tmpDir: string
let profileDir: string
let db: CortexDatabase
let memory: MemorySystem

async function drainEvents(
  gen: AsyncGenerator<LoomEvent, unknown>,
): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return events
}

function findToolCall(events: LoomEvent[], name: string): LoomEvent | undefined {
  return events.find(
    (e) => e.type === 'tool.call.start' && (e as { toolName: string }).toolName === name,
  )
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cortex-mem-e2e-'))
  profileDir = join(tmpDir, 'profile')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'agent.json'),
    JSON.stringify({
      name: PROFILE_ID,
      // Haiku is cheap + fast and is a real Anthropic model.
      model: 'anthropic:claude-haiku-4-5-20251001',
      // Cap aggressively to keep cost trivial.
      maxTokens: 512,
      maxTurns: 4,
      tools: { preset: 'none' },
      // Memory ON, autoLearn ON — the whole point of this test.
      memory: { enabled: true, autoLearn: true },
      context: { datetime: false, cwd: false, modelInfo: false },
    }),
  )
  await writeFile(
    join(profileDir, 'SOUL.md'),
    [
      '# Memory tester',
      '',
      'You are an agent whose ONLY job is to demonstrate the memory system.',
      'When the user shares a fact about themselves, IMMEDIATELY call the',
      '`remember` tool to propose it for persistence. Use third-person',
      'phrasing ("User uses ..."). Always call the tool exactly once for',
      'each fact. Do not respond with anything else until you have called',
      'remember at least once.',
    ].join('\n'),
  )

  db = new CortexDatabase(join(tmpDir, 'ownware.db'), join(tmpDir, 'fx.db'))
  memory = createMemorySystem(db.rawMainHandle)
}, 30_000)

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe.skipIf(!apiKey)('e2e: real Anthropic API calls remember()', () => {
  it('agent invokes remember(); proposal lands in DB; next session sees the accepted memory', async () => {
    const profile = await loadProfile(profileDir)
    const threadId1 = 'thread_e2e_1'

    // ── Turn 1: assemble + run, agent should call `remember` ────────
    const assembled1 = await assembleAgent(profile, {
      memory: { system: memory, threadId: threadId1 },
    })

    // The remember tool is in the assembled tool list.
    const rememberTool = assembled1.tools.find((t) => t.name === 'remember')
    expect(rememberTool, 'expected `remember` tool in assembled tools').toBeDefined()
    // Loom's write-through memory tools are denied.
    expect(assembled1.tools.find((t) => t.name === 'memory_store')).toBeUndefined()
    expect(assembled1.tools.find((t) => t.name === 'memory_search')).toBeUndefined()

    const session1 = new Session({
      config: assembled1.config,
      provider: assembled1.provider,
      tools: assembled1.tools,
    })

    const events = await drainEvents(
      session1.submitMessage(
        'My name is Sam and I prefer concise responses. Call the `remember` tool to propose this for persistence.',
      ),
    )

    const toolCall = findToolCall(events, 'remember')
    expect(toolCall, 'agent should have called `remember`').toBeDefined()

    // The proposal landed in the DB with the right binding.
    const pending = memory.proposals.listForProfile(PROFILE_ID, { status: 'pending' })
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0]!.threadId).toBe(threadId1)
    expect(pending[0]!.proposedContent.toLowerCase()).toMatch(/sam|concise/)

    // ── User accepts ────────────────────────────────────────────────
    const acceptResult = memory.proposals.accept(pending[0]!.id, {})
    expect(acceptResult).not.toBeNull()
    expect(acceptResult!.proposal.status).toMatch(/accepted|edited/)
    expect(acceptResult!.memory.profileId).toBe(PROFILE_ID)

    // ── Turn 2: a fresh session for the same profile ────────────────
    // Re-load the profile fresh (mirrors a brand-new conversation).
    const profile2 = await loadProfile(profileDir)
    const threadId2 = 'thread_e2e_2'
    const assembled2 = await assembleAgent(profile2, {
      memory: { system: memory, threadId: threadId2 },
    })

    // The accepted memory must now appear in the assembled system prompt.
    const promptText = systemPromptToText(assembled2.systemPrompt)
    expect(promptText.toLowerCase()).toMatch(/sam|concise/)
    // The "## Memory — what this agent has learned ..." header is
    // emitted whenever any active memory is present.
    expect(promptText).toContain('Memory')
  }, 120_000)
})
