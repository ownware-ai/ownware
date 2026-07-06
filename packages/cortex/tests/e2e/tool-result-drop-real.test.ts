/**
 * End-to-end: profile.compaction.toolResultDrop opt-in fires the drop
 * pass against a real Anthropic session — through Cortex's assembler,
 * not via a direct LoomConfig override.
 *
 * This complements the Loom-level e2e test by proving the full path:
 *
 *   agent.json → ProfileSchema → assembleAgent → LoomConfig →
 *   Session → loop → tool_result.drop event on the wire
 *
 * A failure here would mean the profile schema, the assembler mapping,
 * or the Loom loop is disconnected — each of which the unit tests cover
 * individually but not as a chain.
 *
 * Asserts:
 *   - The assembler produced a LoomConfig.compaction.toolResultDrop that
 *     reflects the profile knobs.
 *   - Running a multi-turn conversation with large tool outputs yields
 *     at least one `tool_result.drop` event.
 *   - `toolUseId` / `tool_use.id` pairing is preserved after the drop.
 *   - The conversation reaches a final assistant response.
 *
 * Skips without `ANTHROPIC_API_KEY`.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  Session,
  defineTool,
  type LoomEvent,
  type Message,
  type ToolResultBlock,
  type ToolResultDropEvent,
  type ToolUseBlock,
} from '@ownware/loom'
import { assembleAgent } from '../../src/profile/assembler.js'
import { loadProfile } from '../../src/profile/loader.js'
import { createTempProfile } from '../helpers/fixtures.js'

const apiKey =
  process.env['ANTHROPIC_API_KEY'] &&
  !process.env['ANTHROPIC_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['ANTHROPIC_API_KEY']
    : undefined

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping Cortex tool-result-drop e2e: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

const BIG_BLOB = 'x'.repeat(3000)

/**
 * A custom tool injected into the session at runtime. The profile
 * cannot contribute arbitrary TS tools without a loader, so we pass
 * this one in alongside the profile-derived tool set. The drop logic
 * does not care how the tool got into the session — it only cares
 * about the `tool_result` bodies it leaves in history.
 */
const readFakeFile = defineTool({
  name: 'read_fake_file',
  description:
    'Returns the contents of a pretend file. Always returns a large deterministic blob.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'path to pretend to read' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const path = (input as { path: string }).path
    return {
      content: `FILE ${path}\n\n${BIG_BLOB}`,
      isError: false,
    }
  },
})

describe('e2e: profile.compaction.toolResultDrop triggers a drop on real API', () => {
  it('assembler → loom → drop event, pairing preserved', async () => {
    if (skipIfNoKey()) return

    // Build a profile that opts in at a very low trigger so the test
    // completes in a few real API round-trips.
    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'e2e-tool-result-drop',
          model: 'anthropic:claude-haiku-4-5',
          // Keep the baseline prompt small and deterministic; we don't
          // want the stable prefix to overshadow the tool results in
          // the pressure calculation.
          tools: { preset: 'none' },
          context: {
            cwd: false, datetime: false, git: false, os: false,
            project: false, modelInfo: false, contextUsage: false,
          },
          memory: { enabled: false },
          compaction: {
            toolResultDrop: {
              enabled: true,
              triggerFraction: 0.005,
              keepRecentTurns: 1,
              minBytesToDrop: 500,
              previewBytes: 80,
            },
          },
          systemPrompt:
            'You are a file-reading assistant. When the user gives you a path, call ' +
            'read_fake_file with it. Reply briefly after each tool call.',
        }),
      }),
    )

    const profile = await loadProfile(dir)

    // Sanity-check: the schema picked up the opt-in with all four knobs.
    expect(profile.config.compaction.toolResultDrop).toEqual({
      enabled: true,
      triggerFraction: 0.005,
      keepRecentTurns: 1,
      minBytesToDrop: 500,
      previewBytes: 80,
    })

    const assembled = await assembleAgent(profile)

    // The assembler must have forwarded the opt-in into LoomConfig.
    expect(
      (assembled.config.compaction as { toolResultDrop?: unknown }).toolResultDrop,
    ).toEqual({
      enabled: true,
      triggerFraction: 0.005,
      keepRecentTurns: 1,
      minBytesToDrop: 500,
      previewBytes: 80,
    })

    const session = new Session({
      config: { ...assembled.config, maxTokens: 128 },
      provider: assembled.provider,
      // Merge the e2e-only `read_fake_file` with whatever the profile
      // contributed (here: nothing, preset: 'none'). In a real profile
      // the tool would come from a custom/TS loader.
      tools: [...assembled.tools, readFakeFile],
      checkPermission: async () => 'allow',
      requestApproval: async () => true,
    })

    const events: LoomEvent[] = []
    async function send(text: string) {
      const gen: AsyncGenerator<LoomEvent, unknown> = session.submitMessage(text)
      let next = await gen.next()
      while (!next.done) {
        events.push(next.value)
        next = await gen.next()
      }
    }

    await send('Read /a.txt. Reply "OK".')
    await send('Now read /b.txt. Reply "OK".')
    await send('Now read /c.txt. Reply with one word only.')

    const errEvents = events.filter(e => e.type === 'error')
    if (errEvents.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[cortex-tool-result-drop-e2e] errors:', JSON.stringify(errEvents, null, 2))
    }

    const drops = events.filter(
      (e): e is ToolResultDropEvent => e.type === 'tool_result.drop',
    )
    expect(drops.length).toBeGreaterThanOrEqual(1)
    const totalDropped = drops.reduce((n, e) => n + e.droppedCount, 0)
    const totalReclaimed = drops.reduce((n, e) => n + e.bytesReclaimed, 0)
    expect(totalDropped).toBeGreaterThan(0)
    expect(totalReclaimed).toBeGreaterThan(0)

    // Conversation still completes.
    expect(events.some(e => e.type === 'text.delta')).toBe(true)

    // Pairing invariant holds on the final history — no orphaned
    // tool_use or tool_result after the rewrites.
    const finalMessages: readonly Message[] = session.getMessages()
    const toolUseIds: string[] = []
    const toolResultIds: string[] = []
    for (const msg of finalMessages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolUseIds.push((block as ToolUseBlock).id)
        if (block.type === 'tool_result')
          toolResultIds.push((block as ToolResultBlock).toolUseId)
      }
    }
    expect(toolResultIds.sort()).toEqual(toolUseIds.sort())

    // Spot-check: at least one rewritten placeholder should contain the
    // new self-descriptive shape (tool name + "dropped"). The assertion
    // stays tolerant on exact text — the public contract is "drop fires
    // and placeholder references the tool call", not the exact wording.
    const rewritten = finalMessages
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is ToolResultBlock => b.type === 'tool_result')
      .map(b => (typeof b.content === 'string' ? b.content : ''))
      .filter(s => /dropped/i.test(s))
    expect(rewritten.length).toBeGreaterThan(0)
    expect(rewritten[0]!).toContain('read_fake_file')

    /* eslint-disable no-console */
    console.log('\n──── CORTEX TOOL-RESULT DROP E2E REPORT ────')
    console.log(`drops=${drops.length}  droppedCount=${totalDropped}  bytesReclaimed=${totalReclaimed}`)
    console.log(`pairing: tool_use=${toolUseIds.length} tool_result=${toolResultIds.length}`)
    console.log(`rewritten placeholders found: ${rewritten.length}`)
    console.log(`final messages: ${finalMessages.length}`)
    console.log(`sample placeholder: ${rewritten[0]!.slice(0, 200)}`)
    console.log('─────────────────────────────────────────────\n')
    /* eslint-enable no-console */
  }, 180_000)
})
