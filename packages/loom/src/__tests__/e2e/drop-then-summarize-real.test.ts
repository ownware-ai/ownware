/**
 * End-to-end integration: tool-result drop AND full summarising
 * compaction fire cleanly in the same session.
 *
 * The two compaction tiers are independent primitives. Drop runs at a
 * lower pressure threshold and rewrites `tool_result` bodies in place;
 * full compaction runs at a higher threshold and summarises the entire
 * history. The unit + e2e tests shipped with each lever prove each
 * tier works in isolation — this test proves they COMPOSE:
 *
 *   1. A session crosses the drop threshold first. `tool_result.drop`
 *      fires. Old tool outputs become placeholders. Pairing invariant
 *      holds.
 *   2. The session keeps going. More turns pile up. Pressure keeps
 *      climbing even after the drop (assistant text, new tool calls).
 *   3. Eventually pressure crosses the full-compaction threshold.
 *      `compaction.start` / `compaction.end` fire. The summariser sees
 *      a history that already contains drop placeholders and must
 *      produce a working summary from that mixed input.
 *   4. The session still completes without the provider rejecting the
 *      request.
 *
 * Why this test matters even though the units pass: a summariser that
 * cannot cope with dropped-content placeholders would either produce a
 * garbage summary or throw. A loop that stops firing drops after full
 * compaction has run (intentional — we don't want to keep stripping
 * after the full pass already shortened everything) needs to be
 * verified in the live path, not just asserted in code.
 *
 * Skips without `ANTHROPIC_API_KEY`. Uses `claude-haiku-4-5` to keep
 * cost + latency low.
 */

import { describe, it, expect } from 'vitest'
// Deep imports so we do not eagerly construct every provider. See the
// matching comment in tool-result-drop-real.test.ts.
import { Session } from '../../core/session.js'
import { createDefaultConfig, mergeConfig } from '../../core/config.js'
import { AnthropicProvider } from '../../provider/anthropic.js'
import { createCompactionManager } from '../../compaction/manager.js'
import { getModelContextWindow } from '../../messages/tokens.js'
import { defineTool } from '../../tools/types.js'
import type { LoomEvent, ToolResultDropEvent } from '../../core/events.js'
import type { Message, ToolResultBlock, ToolUseBlock } from '../../messages/types.js'

const apiKey =
  process.env['ANTHROPIC_API_KEY'] &&
  !process.env['ANTHROPIC_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['ANTHROPIC_API_KEY']
    : undefined

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping drop-then-summarize e2e: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

/** Big deterministic payload so every tool call floods context fast. */
const BLOB = 'x'.repeat(4000)

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
      path: { type: 'string', description: 'pretend path' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const path = (input as { path: string }).path
    return { content: `FILE ${path}\n\n${BLOB}`, isError: false }
  },
})

describe('e2e: tool-result drop AND full compaction compose cleanly', () => {
  it('drop fires first, summarize fires later, session completes, pairing holds', async () => {
    if (skipIfNoKey()) return

    const base = createDefaultConfig('anthropic:claude-haiku-4-5')
    const config = mergeConfig(base, {
      maxTokens: 256,
      systemPrompt:
        'You are a file-reading assistant. When the user asks you to read a file, ' +
        'call read_fake_file once for the path they name. Keep replies brief.',
      compaction: {
        ...base.compaction,
        // Full compaction on MESSAGE COUNT, not fraction. Using a
        // fraction trigger here would create a paradox with the drop:
        // drop fires first and relieves pressure, so the fraction
        // threshold never gets crossed and we could not observe
        // composition. Message-count is orthogonal — it fires after N
        // messages regardless of how much pressure drop has relieved,
        // which is exactly what this test needs.
        trigger: { type: 'messages', threshold: 6 },
        // A small retain count so the summariser has real work to do.
        retain: { type: 'messages', count: 4 },
        strategy: 'summarize',
        // Drop fires early on pressure so it runs BEFORE the
        // message-count threshold is crossed.
        toolResultDrop: {
          enabled: true,
          triggerFraction: 0.007,
          keepRecentTurns: 1,
          minBytesToDrop: 500,
          previewBytes: 80,
        },
      },
    })

    // Session does not auto-construct a CompactionManager — callers
    // wire one up explicitly. Without this the compaction config in
    // LoomConfig is ignored by the loop and full compaction never
    // fires, no matter how we set the trigger.
    const provider = new AnthropicProvider()
    const compaction = createCompactionManager({
      config: config.compaction,
      provider,
      contextWindowTokens: getModelContextWindow(config.model),
    })

    const session = new Session({
      config,
      provider,
      tools: [readFakeFile],
      compaction,
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

    // Enough distinct user turns to cross both thresholds in sequence.
    // Each turn calls the tool once and adds ~4KB of tool_result plus
    // short model replies.
    await send('Read /a.txt. Reply "OK".')
    await send('Now /b.txt. Reply "OK".')
    await send('Now /c.txt. Reply "OK".')
    await send('Now /d.txt. Reply "OK".')
    await send('Now /e.txt. Reply "OK".')
    await send('Summarise what you read in ONE word.')

    // If the live path failed, we want a diagnostic log instead of a
    // confusing assertion mismatch.
    const errs = events.filter(e => e.type === 'error')
    if (errs.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[drop-then-summarize] provider errors:', JSON.stringify(errs, null, 2))
    }

    // --------------------------------------------------------------
    // 1. Drop fired at least once (tier 1 engaged)
    // --------------------------------------------------------------
    const drops = events.filter(
      (e): e is ToolResultDropEvent => e.type === 'tool_result.drop',
    )
    expect(drops.length).toBeGreaterThanOrEqual(1)
    const totalDropped = drops.reduce((n, e) => n + e.droppedCount, 0)
    expect(totalDropped).toBeGreaterThan(0)

    // --------------------------------------------------------------
    // 2. Full compaction fired at least once (tier 2 engaged)
    // --------------------------------------------------------------
    const compactStarts = events.filter(e => e.type === 'compaction.start')
    const compactEnds = events.filter(e => e.type === 'compaction.end')
    expect(compactStarts.length).toBeGreaterThanOrEqual(1)
    expect(compactEnds.length).toBe(compactStarts.length) // paired
    for (const end of compactEnds) {
      // The summary must actually reduce tokens. If this fails, the
      // summariser got confused by the placeholders.
      const e = end as { postTokenCount: number; preTokenCount: number }
      expect(e.postTokenCount).toBeLessThan(e.preTokenCount)
    }

    // --------------------------------------------------------------
    // 3. Drop fires BEFORE full compaction in the event timeline —
    //    the graduated response order the design promises.
    // --------------------------------------------------------------
    const firstDropIdx = events.findIndex(e => e.type === 'tool_result.drop')
    const firstCompactIdx = events.findIndex(e => e.type === 'compaction.start')
    expect(firstDropIdx).toBeLessThan(firstCompactIdx)

    // --------------------------------------------------------------
    // 4. Session completes — at least one assistant text delta arrived.
    // --------------------------------------------------------------
    expect(events.some(e => e.type === 'text.delta')).toBe(true)

    // --------------------------------------------------------------
    // 5. Pairing invariant on the FINAL history. After BOTH drop and
    //    full compaction have run, every remaining `tool_result` still
    //    has a matching `tool_use`. No orphans.
    // --------------------------------------------------------------
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
    console.log('\n──── DROP + SUMMARIZE COMPOSITION REPORT ────')
    console.log(`drops=${drops.length}  droppedCount=${totalDropped}`)
    console.log(`full compactions=${compactStarts.length}`)
    console.log(`pairing: tool_use=${toolUseIds.length} tool_result=${toolResultIds.length}`)
    console.log(`final messages: ${finalMessages.length}`)
    console.log('──────────────────────────────────────────────\n')
    /* eslint-enable no-console */
  }, 300_000)
})
