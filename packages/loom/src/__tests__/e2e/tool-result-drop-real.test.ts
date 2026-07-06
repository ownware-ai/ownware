/**
 * End-to-end: tool-result drop fires against a real Anthropic session.
 *
 * Builds a session with the drop enabled at a very low trigger fraction
 * so a handful of turns is enough to cross it, and wires a custom tool
 * that always returns a large (deterministic) blob. The agent is
 * nudged into calling the tool on several turns; by the time it does,
 * the message history contains enough tool_result bytes that the drop
 * check fires at the next turn boundary.
 *
 * Asserts:
 *   1. A `tool_result.drop` event is emitted at least once.
 *   2. `droppedCount > 0` and `bytesReclaimed > 0` on that event.
 *   3. The final text response still arrives (the replacement does not
 *      break the conversation).
 *   4. `tool_use` ids remain paired with their (possibly rewritten)
 *      `tool_result` blocks — no orphans.
 *
 * Skips without `ANTHROPIC_API_KEY`. Uses `claude-haiku-4-5` so the
 * test runs fast and cheap — the drop is model-independent; the
 * behaviour we are checking is in Loom, not in the model.
 */

import { describe, it, expect } from 'vitest'
// Deep imports ONLY. Importing from `../../index.js` would eagerly
// register every provider at module load, which constructs the OpenAI
// client and requires `OPENAI_API_KEY` even for a test that only uses
// Anthropic. Matches the pattern used by the other Loom e2e tests.
import { Session, createSession } from '../../core/session.js'
import { createDefaultConfig, mergeConfig } from '../../core/config.js'
import { AnthropicProvider } from '../../provider/anthropic.js'
import { defineTool } from '../../tools/types.js'
import type { LoomEvent, ToolResultDropEvent } from '../../core/events.js'
import type { Message, ToolResultBlock, ToolUseBlock } from '../../messages/types.js'

// Silence the unused warning — `createSession` is imported so the
// test file matches the deep-import pattern established by the other
// e2e tests, but this specific test constructs its Session directly so
// it can inject permission callbacks.
void createSession

const apiKey =
  process.env['ANTHROPIC_API_KEY'] &&
  !process.env['ANTHROPIC_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['ANTHROPIC_API_KEY']
    : undefined

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping tool-result-drop e2e test: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

/** Deterministic, big-ish payload that dwarfs the minBytesToDrop threshold. */
const BIG_BLOB = 'x'.repeat(3000)

const readFakeFile = defineTool({
  name: 'read_fake_file',
  description:
    'Returns the contents of a pretend file. Always returns a large deterministic blob. ' +
    'Use this tool whenever the user asks you to read a file.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'path to pretend to read',
      },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const path = (input as { path: string }).path
    // ToolResult.content is a plain string — not an array of content
    // blocks. Returning anything else silently loses data.
    return {
      content: `FILE ${path}\n\n${BIG_BLOB}`,
      isError: false,
    }
  },
})

describe('e2e: tool-result drop with real API', () => {
  it('fires tool_result.drop event, drops tool_results, preserves pairing', async () => {
    if (skipIfNoKey()) return

    const baseConfig = createDefaultConfig('anthropic:claude-haiku-4-5')
    const config = mergeConfig(baseConfig, {
      maxTokens: 256,
      systemPrompt:
        'You are a file-reading assistant. When the user asks you to read files, call read_fake_file ' +
        'for each path they give. After you have read them all, reply with a one-sentence summary.',
      compaction: {
        ...baseConfig.compaction,
        toolResultDrop: {
          enabled: true,
          // Very low trigger — we want this to fire on a short test.
          // claude-haiku-4-5 context window is ~200K, so 0.005 ≈ 1K tokens
          // of history is enough. A couple of 3KB tool results will blow
          // past that comfortably.
          triggerFraction: 0.005,
          keepRecentTurns: 1,
          minBytesToDrop: 500,
        },
      },
    })

    const provider = new AnthropicProvider()
    const session = new Session({
      config,
      provider,
      tools: [readFakeFile],
      // Auto-allow so the model can actually call the tool. The trigger
      // needs `tool_result` bodies in history; if every call is denied
      // by the default 'ask' → false path, no results accumulate and
      // nothing gets dropped.
      checkPermission: async () => 'allow',
      requestApproval: async () => true,
    })

    // Spread the tool calls across multiple user turns so the
    // "keepRecentTurns" window actually has something older than it to
    // drop. A single user message that triggers many tool calls in a
    // row all counts as the SAME recent turn — the algorithm is
    // turn-based, not call-based, so stale results need an older turn
    // to be eligible.
    const events: LoomEvent[] = []
    async function send(text: string) {
      const gen: AsyncGenerator<LoomEvent, unknown> = session.submitMessage(text)
      let next = await gen.next()
      while (!next.done) {
        events.push(next.value)
        next = await gen.next()
      }
    }

    await send('Read the file at path /a.txt. Reply "OK" when done.')
    await send('Now read /b.txt. Reply "OK" when done.')
    await send('Now read /c.txt. Reply with a one-word summary only.')

    // If the call threw at the provider layer we want the test output
    // to surface that instead of a confusing "expected 0 ≥ 1" later on.
    const errEvents = events.filter(e => e.type === 'error')
    if (errEvents.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[tool-result-drop-e2e] provider errors:', JSON.stringify(errEvents, null, 2))
    }

    // ---------------------------------------------------------------
    // 1. Drop event fired at least once
    // ---------------------------------------------------------------
    const drops = events.filter(
      (e): e is ToolResultDropEvent => e.type === 'tool_result.drop',
    )
    expect(drops.length).toBeGreaterThanOrEqual(1)

    // ---------------------------------------------------------------
    // 2. The event reports real work
    // ---------------------------------------------------------------
    const totalDropped = drops.reduce((n, e) => n + e.droppedCount, 0)
    const totalReclaimed = drops.reduce((n, e) => n + e.bytesReclaimed, 0)
    expect(totalDropped).toBeGreaterThan(0)
    expect(totalReclaimed).toBeGreaterThan(0)

    // ---------------------------------------------------------------
    // 3. The conversation still completes with a final assistant text
    // ---------------------------------------------------------------
    const textDeltas = events.filter(e => e.type === 'text.delta')
    expect(textDeltas.length).toBeGreaterThan(0)

    // ---------------------------------------------------------------
    // 4. tool_use / tool_result pairing invariant holds in the final
    //    message history — no orphans after the rewrites.
    // ---------------------------------------------------------------
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

    /* eslint-disable no-console */
    console.log('\n──────── TOOL-RESULT DROP E2E REPORT ────────')
    console.log(`events:tool_result.drop=${drops.length}  `
      + `droppedCount=${totalDropped}  bytesReclaimed=${totalReclaimed}`)
    console.log(`tool_use / tool_result pairing: ${toolUseIds.length} / ${toolResultIds.length}`)
    console.log(`final message count: ${finalMessages.length}`)
    console.log('──────────────────────────────────────────────\n')
    /* eslint-enable no-console */
  }, 180_000)
})
