/**
 * Unit Test — foundation-hardening P-doc: a `document` (PDF) content block
 * must reach the provider, not be silently dropped.
 *
 * Loom's own attachment pipeline (`media/attachments.ts`) emits a base64
 * `document` block for PDF uploads, but the three adapters had no `document`
 * case — Anthropic fell through to an EMPTY text block, OpenAI/Google dropped
 * it entirely. Net effect: the user uploads a PDF, asks Claude to read it, and
 * the model sees nothing.
 *
 * Post-fix: Anthropic + Google (which accept PDF natively) serialize the real
 * block; OpenAI (whose Chat file format varies by model/route) surfaces an
 * HONEST placeholder rather than a silent drop or a 400-risking `file` part.
 */

import { describe, it, expect, vi } from 'vitest'
import type { ProviderRequest } from '../../../src/provider/types.js'
import type { Message } from '../../../src/messages/types.js'

// ── Anthropic SDK mock — capture the params passed to messages.stream() ──────
const anthropicCapture: { lastParams: Record<string, unknown> | null } = { lastParams: null }
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        anthropicCapture.lastParams = params
        async function* iterate() { /* no events */ }
        const it = iterate()
        return {
          [Symbol.asyncIterator]: () => it,
          finalMessage: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          abort: () => {},
        }
      },
    }
  }
  return { default: MockAnthropic }
})

// ── Google SDK mock ──────────────────────────────────────────────────────────
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

// ── OpenAI SDK mock ──────────────────────────────────────────────────────────
vi.mock('openai', () => {
  const create = vi.fn()
  return {
    default: class MockOpenAI {
      chat = { completions: { create } }
    },
    __mockCreate: create,
  }
})

import { AnthropicProvider } from '../../../src/provider/anthropic.js'
import { GoogleProvider } from '../../../src/provider/google.js'
import { OpenAIProvider } from '../../../src/provider/openai.js'

const PDF_DATA = 'JVBERi0xLjQK' // fake base64 — serializers pass it through verbatim

function docRequest(model: string): ProviderRequest {
  const messages: Message[] = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize this PDF.' },
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: PDF_DATA } },
    ],
  }]
  return { model, system: '', messages, tools: [], maxTokens: 100, temperature: null }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('P-doc — document/PDF blocks reach each provider', () => {
  it('Anthropic: serializes a native base64 document block (not empty text)', async () => {
    anthropicCapture.lastParams = null
    const provider = new AnthropicProvider({ apiKey: 'k' })
    await drain(provider.stream(docRequest('claude-sonnet-4-6')))

    const content = (anthropicCapture.lastParams!.messages as any[])[0].content as any[]
    const doc = content.find((b) => b.type === 'document')
    expect(doc).toBeDefined()
    expect(doc.source).toMatchObject({ type: 'base64', media_type: 'application/pdf', data: PDF_DATA })
    // The PDF did NOT become an empty text block (the pre-fix behaviour).
    expect(content.some((b) => b.type === 'text' && b.text === '')).toBe(false)
  })

  it('Google: serializes the PDF via inlineData (same channel as images)', async () => {
    const { __mockGenerateContentStream } = (await import('@google/generative-ai')) as any
    __mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }
      })(),
    })
    const provider = new GoogleProvider({ apiKey: 'k' })
    await drain(provider.stream(docRequest('gemini-2.5-pro')))

    const req = __mockGenerateContentStream.mock.calls[0][0]
    const parts = (req.contents as any[]).flatMap((c) => c.parts as any[])
    const inline = parts.find((p) => p.inlineData)
    expect(inline).toBeDefined()
    expect(inline.inlineData).toMatchObject({ mimeType: 'application/pdf', data: PDF_DATA })
  })

  it('OpenAI: surfaces an honest placeholder instead of silently dropping the PDF', async () => {
    const { __mockCreate } = (await import('openai')) as any
    __mockCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      },
    })
    const provider = new OpenAIProvider({ apiKey: 'k' })
    await drain(provider.stream(docRequest('gpt-4o')))

    const sent = __mockCreate.mock.calls[0][0]
    const userMsg = (sent.messages as any[]).find((m) => m.role === 'user')
    const parts = userMsg.content as any[]
    const placeholder = parts.find((p) => p.type === 'text' && /PDF document was attached/.test(p.text))
    expect(placeholder).toBeDefined()
  })
})
