/**
 * Calibration test — local chars/4 estimate vs Anthropic's exact tokenizer.
 *
 * Validates that the production hybrid path (`measureContextUsage` with
 * the Anthropic provider as counter) returns numbers grounded in the
 * model's actual tokenizer, AND that the pure-local fallback stays
 * within a documented variance band.
 *
 * Skipped when ANTHROPIC_API_KEY is not set, so CI without the key
 * still passes. Hits Anthropic's free `messages.countTokens` endpoint
 * — no token cost, no charge.
 *
 * Why this exists: the user explicitly asked for "production level,
 * reliable, accurate" — this is the test that proves the produced
 * numbers track real-world counts within a documented band.
 */

import { describe, it, expect } from 'vitest'

import {
  measureContextUsage,
  measureContextUsageWithDiagnostics,
} from '../../context/usage.js'
import { AnthropicProvider } from '../../provider/anthropic.js'

import type { Message } from '../../messages/types.js'
import type { TokenCounter } from '../../context/types.js'

const apiKey = process.env.ANTHROPIC_API_KEY
const HAS_KEY = !!apiKey

const MODEL = 'anthropic:claude-haiku-4-5-20251001'  // cheapest, same tokenizer family

const SYSTEM_PROMPT = [
  'You are a focused, careful general-purpose assistant.',
  'Treat <system-reminder> tags as harness instructions.',
  'Calibrate reasoning depth to the task — simple questions get direct answers; complex tasks get more thought.',
  'Reference code as `file_path:line_number`.',
  'Be brief by default.',
].join('\n')

const MESSAGES: Message[] = [
  {
    role: 'user',
    content: 'Read packages/loom/src/core/loop.ts and summarize the main responsibilities of the agent loop in 3 bullet points.',
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I\'ll read the file and summarize.' },
      { type: 'tool_use', id: 'tool_1', name: 'readFile', input: { file_path: '/work/packages/loom/src/core/loop.ts' } },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        toolUseId: 'tool_1',
        content: 'export async function* loop(params) { ... } // ~760 lines of agent-loop code: streaming, tool execution, retries, compaction, recovery.',
        isError: false,
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '- The loop drives a `while(true)` agent cycle: stream model output, execute tool calls, append results, repeat until terminal stop reason.\n- It owns retry / recovery (max-tokens recovery, rate-limit retry, model fallback) plus compaction triggering when context pressure crosses a threshold.\n- It emits a typed event stream (turn lifecycle, content deltas, tool calls, permissions, security blocks, errors) consumed by every UI / SDK layer.',
      },
    ],
  },
]

describe.skipIf(!HAS_KEY)('Context-usage accuracy — local estimator vs Anthropic exact (Haiku 4.5)', () => {
  let provider: AnthropicProvider

  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  void (async () => {
    if (HAS_KEY) provider = new AnthropicProvider({ apiKey: apiKey! })
  })

  function makeCounter(): TokenCounter {
    return {
      count: async (messages, system) => provider.countTokens(messages, system),
    }
  }

  it('hybrid-path total matches Anthropic\'s exact count to within 1 token (anchored sum)', async () => {
    provider = new AnthropicProvider({ apiKey: apiKey! })

    const { usage, diagnostics } = await measureContextUsageWithDiagnostics({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      messages: MESSAGES,
      tools: [],
      counter: makeCounter(),
    })

    expect(usage.method).toBe('mixed')
    expect(diagnostics.counterTotal).toBeGreaterThan(0)

    // The anchored-categories sum (system + skills + messages) must
    // equal the counter total EXACTLY — that's the sum invariant of
    // the scaling pass.
    const anchoredSum = usage.breakdown.systemPrompt + usage.breakdown.skills + usage.breakdown.messages
    expect(anchoredSum).toBe(diagnostics.counterTotal)
  }, 30_000)

  it('local chars/4 estimate is within 25% of Anthropic\'s exact count for typical session content', async () => {
    provider = new AnthropicProvider({ apiKey: apiKey! })

    const localOnly = await measureContextUsage({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      messages: MESSAGES,
      tools: [],
    })

    const exactCount = await provider.countTokens([...MESSAGES], SYSTEM_PROMPT)

    // Compare the locally-estimated sum of system+messages+skills to
    // the exact reading. Tools aren't included in countTokens output,
    // so we don't add them to the local figure here.
    const localAnchored = localOnly.breakdown.systemPrompt + localOnly.breakdown.skills + localOnly.breakdown.messages
    const variance = Math.abs(localAnchored - exactCount) / exactCount

    // eslint-disable-next-line no-console
    console.log(
      `[context-accuracy] local=${localAnchored} exact=${exactCount} variance=${(variance * 100).toFixed(1)}%`,
    )

    expect(localOnly.method).toBe('estimate')
    // 25% is the documented upper bound for chars/4 on agent-style
    // content (mix of code + prose + JSON). In practice the band is
    // ~10–15%; the 25% ceiling absorbs corner cases (lots of JSON,
    // lots of identifiers, content that tokenises unusually).
    expect(variance).toBeLessThan(0.25)
  }, 30_000)
})
