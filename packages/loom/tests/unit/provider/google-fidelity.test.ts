/**
 * Unit Test — foundation-hardening P-gem-pair + P-gem-finish.
 *
 * P-gem-pair: Gemini pairs a functionResponse to its functionCall BY NAME, but
 *   the adapter set `functionResponse.name = block.toolUseId` (the call id),
 *   which never matched any functionCall — multi-turn tool calls silently
 *   broke on Gemini. Fixed by resolving the tool NAME from the call id.
 *
 * P-gem-finish: the adapter computed stopReason solely from whether tool calls
 *   were present, ignoring `candidate.finishReason` — so Gemini's MAX_TOKENS /
 *   SAFETY / RECITATION all collapsed to a clean `end_turn`, hiding truncation
 *   and blocks (and disabling the loop's max-tokens continuation recovery).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'
import type { Message } from '../../../src/messages/types.js'

vi.mock('@google/generative-ai', () => {
  const mockGenerateContentStream = vi.fn()
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return { generateContentStream: mockGenerateContentStream, countTokens: vi.fn() }
      }
    },
    __mockGenerateContentStream: mockGenerateContentStream,
  }
})

import { GoogleProvider } from '../../../src/provider/google.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeRequest(messages: Message[]): ProviderRequest {
  return { model: 'gemini-2.5-pro', system: '', messages, tools: [], maxTokens: 100, temperature: null }
}

function textStream(text: string, finishReason?: string) {
  return {
    stream: (async function* () {
      yield {
        candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }
    })(),
  }
}

async function run(mockReturn: any, req: ProviderRequest) {
  const { __mockGenerateContentStream } = (await import('@google/generative-ai')) as any
  __mockGenerateContentStream.mockResolvedValue(mockReturn)
  const provider = new GoogleProvider({ apiKey: 'k' })
  const chunks: ProviderChunk[] = []
  for await (const c of provider.stream(req)) chunks.push(c)
  const sentContents = __mockGenerateContentStream.mock.calls[0][0].contents as any[]
  return { chunks, sentContents }
}

describe('Google adapter fidelity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('P-gem-pair: pairs a tool_result to its functionCall by NAME, not call id', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'data', isError: false }] },
    ]
    const { sentContents } = await run(textStream('ok'), makeRequest(messages))
    const fnResp = sentContents.flatMap((c) => c.parts).find((p: any) => p.functionResponse)
    expect(fnResp).toBeDefined()
    // The functionResponse name is the tool NAME (matches the functionCall),
    // not the raw call id 'call_1' that never paired.
    expect(fnResp.functionResponse.name).toBe('read_file')
  })

  it('P-gem-finish: MAX_TOKENS → max_tokens stop reason', async () => {
    const { chunks } = await run(textStream('partial', 'MAX_TOKENS'), makeRequest([{ role: 'user', content: 'hi' }]))
    const complete = chunks.find((c) => c.type === 'message_complete') as any
    expect(complete.stopReason).toBe('max_tokens')
  })

  it('P-gem-finish: SAFETY block → refusal stop reason', async () => {
    const { chunks } = await run(textStream('', 'SAFETY'), makeRequest([{ role: 'user', content: 'hi' }]))
    const complete = chunks.find((c) => c.type === 'message_complete') as any
    expect(complete.stopReason).toBe('refusal')
  })

  it('P-gem-finish: a normal STOP still reports end_turn', async () => {
    const { chunks } = await run(textStream('done', 'STOP'), makeRequest([{ role: 'user', content: 'hi' }]))
    const complete = chunks.find((c) => c.type === 'message_complete') as any
    expect(complete.stopReason).toBe('end_turn')
  })
})
