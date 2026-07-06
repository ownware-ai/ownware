import { describe, expect, it } from 'vitest'
import {
  isKimiModel,
  parseKimiTaggedToolCalls,
  wrapKimiToolCallStream,
} from '../../../src/provider/quirks/kimi.js'
import type { ProviderChunk } from '../../../src/provider/types.js'

const TAGGED_SINGLE =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.writeFile:0 <|tool_call_argument_begin|> {"file_path":"/tmp/out.txt","content":"hello"} <|tool_call_end|> <|tool_calls_section_end|>'

const TAGGED_MULTI =
  '<|tool_calls_section_begin|>' +
  '<|tool_call_begin|>functions.readFile:0<|tool_call_argument_begin|>{"file_path":"/x/a"}<|tool_call_end|>' +
  '<|tool_call_begin|>functions.writeFile:1<|tool_call_argument_begin|>{"file_path":"/x/b","content":"done"}<|tool_call_end|>' +
  '<|tool_calls_section_end|>'

const TAGGED_NO_FUNCTIONS_PREFIX =
  '<|tool_calls_section_begin|><|tool_call_begin|>writeFile:7<|tool_call_argument_begin|>{"file_path":"/p","content":"x"}<|tool_call_end|><|tool_calls_section_end|>'

const TAGGED_WITH_PROSE =
  'I will write the file now.\n\n<|tool_calls_section_begin|><|tool_call_begin|>functions.writeFile:0<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>\n\nDone.'

const MALFORMED_TRUNCATED =
  '<|tool_calls_section_begin|><|tool_call_begin|>functions.writeFile:0<|tool_call_argument_begin|>{"file_path":"/x","conte'

const MALFORMED_BAD_JSON =
  '<|tool_calls_section_begin|><|tool_call_begin|>functions.writeFile:0<|tool_call_argument_begin|>not json<|tool_call_end|><|tool_calls_section_end|>'

async function* asyncOf(chunks: ProviderChunk[]): AsyncGenerator<ProviderChunk> {
  for (const c of chunks) yield c
}

async function collect(
  source: AsyncGenerator<ProviderChunk>,
): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = []
  for await (const c of source) out.push(c)
  return out
}

describe('parseKimiTaggedToolCalls', () => {
  it('returns null when no tagged section is present', () => {
    expect(parseKimiTaggedToolCalls('plain prose, no markers')).toBeNull()
  })

  it('parses a single tool call and trims surrounding whitespace from cleanText', () => {
    const result = parseKimiTaggedToolCalls(TAGGED_SINGLE)
    expect(result).not.toBeNull()
    expect(result!.calls).toHaveLength(1)
    expect(result!.calls[0]!.name).toBe('writeFile')
    expect(result!.calls[0]!.args).toEqual({
      file_path: '/tmp/out.txt',
      content: 'hello',
    })
    expect(result!.calls[0]!.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
    expect(result!.cleanText).toBe('')
  })

  it('parses multiple tool calls in order', () => {
    const result = parseKimiTaggedToolCalls(TAGGED_MULTI)
    expect(result).not.toBeNull()
    expect(result!.calls.map((c) => c.name)).toEqual(['readFile', 'writeFile'])
    expect(result!.calls[0]!.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
    expect(result!.calls[1]!.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
    expect(result!.calls[0]!.id).not.toBe(result!.calls[1]!.id)
    expect(result!.calls[1]!.args).toEqual({
      file_path: '/x/b',
      content: 'done',
    })
  })

  it('handles tool names without the functions. prefix', () => {
    const result = parseKimiTaggedToolCalls(TAGGED_NO_FUNCTIONS_PREFIX)
    expect(result).not.toBeNull()
    expect(result!.calls[0]!.name).toBe('writeFile')
    expect(result!.calls[0]!.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
  })

  it('mints a fresh id every parse — the same tagged section twice produces distinct ids', () => {
    const a = parseKimiTaggedToolCalls(TAGGED_SINGLE)
    const b = parseKimiTaggedToolCalls(TAGGED_SINGLE)
    expect(a!.calls[0]!.id).not.toBe(b!.calls[0]!.id)
  })

  it('preserves prose surrounding the tagged section in cleanText', () => {
    const result = parseKimiTaggedToolCalls(TAGGED_WITH_PROSE)
    expect(result).not.toBeNull()
    expect(result!.cleanText).toBe(
      'I will write the file now.\n\n\n\nDone.',
    )
  })

  it('returns null for a truncated section (missing end markers)', () => {
    expect(parseKimiTaggedToolCalls(MALFORMED_TRUNCATED)).toBeNull()
  })

  it('returns null when a tool call has non-JSON arguments', () => {
    expect(parseKimiTaggedToolCalls(MALFORMED_BAD_JSON)).toBeNull()
  })

  it('returns null when JSON arguments parse as a non-object (array)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.x:0<|tool_call_argument_begin|>[1,2,3]<|tool_call_end|><|tool_calls_section_end|>'
    expect(parseKimiTaggedToolCalls(text)).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────
  // Production-grade prefix tolerance (vLLM Kimi-K2-Accuracy blog +
  // Moonshot's tool_call_guidance — capitalized / underscore / dash
  // variants observed in the wild against K2.6).
  // ──────────────────────────────────────────────────────────────────

  it('strips the prefix from a capitalized variant (Functions.WriteFile)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>Functions.WriteFile:0<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>'
    const result = parseKimiTaggedToolCalls(text)
    expect(result).not.toBeNull()
    expect(result!.calls[0]!.name).toBe('WriteFile')
  })

  it('strips the prefix from an underscore variant (Functions_WriteFile)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>Functions_WriteFile:3<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>'
    const result = parseKimiTaggedToolCalls(text)
    expect(result).not.toBeNull()
    expect(result!.calls[0]!.name).toBe('WriteFile')
  })

  it('strips the prefix from a dash variant (functions-writeFile)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions-writeFile:0<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>'
    const result = parseKimiTaggedToolCalls(text)
    expect(result).not.toBeNull()
    expect(result!.calls[0]!.name).toBe('writeFile')
  })

  it('strips an all-caps prefix (FUNCTIONS.write_file)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>FUNCTIONS.write_file:0<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>'
    const result = parseKimiTaggedToolCalls(text)
    expect(result).not.toBeNull()
    expect(result!.calls[0]!.name).toBe('write_file')
  })

  it('preserves the original idx in the minted internal id', () => {
    // Underscores embedded after the prefix should not be touched.
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.writeFile:42<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>'
    const result = parseKimiTaggedToolCalls(text)
    expect(result).not.toBeNull()
    // The id encodes idx=42 so it round-trips back to
    // `functions.writeFile:42` on the wire.
    expect(result!.calls[0]!.id).toMatch(/^call_kimi_writeFile_42_[a-f0-9]{24}$/)
  })

  it('falls back to idx=0 when the trailing :N counter is missing', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.writeFile<|tool_call_argument_begin|>{"file_path":"/x","content":"y"}<|tool_call_end|><|tool_calls_section_end|>'
    const result = parseKimiTaggedToolCalls(text)
    expect(result).not.toBeNull()
    expect(result!.calls[0]!.id).toMatch(/^call_kimi_writeFile_0_[a-f0-9]{24}$/)
  })
})

describe('wrapKimiToolCallStream', () => {
  it('passes non-message_complete chunks through unchanged', async () => {
    const input: ProviderChunk[] = [
      { type: 'text_delta', text: 'partial ' },
      { type: 'text_delta', text: 'output' },
      { type: 'thinking_delta', text: 'reasoning…' },
    ]
    const out = await collect(wrapKimiToolCallStream(asyncOf(input)))
    expect(out).toEqual(input)
  })

  it('rewrites tagged tool calls in message_complete and flips stopReason', async () => {
    const input: ProviderChunk[] = [
      { type: 'text_delta', text: TAGGED_SINGLE },
      {
        type: 'message_complete',
        content: [{ type: 'text', text: TAGGED_SINGLE }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ]
    const out = await collect(wrapKimiToolCallStream(asyncOf(input)))
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(input[0]) // text_delta unchanged
    const final = out[1]
    if (final?.type !== 'message_complete') throw new Error('expected message_complete')
    expect(final.stopReason).toBe('tool_use')
    expect(final.content).toHaveLength(1)
    const block = final.content[0]
    if (block?.type !== 'tool_use') throw new Error('expected tool_use block')
    expect(block.name).toBe('writeFile')
    expect(block.input).toEqual({ file_path: '/tmp/out.txt', content: 'hello' })
    expect(block.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
    expect(final.usage.outputTokens).toBe(50)
  })

  it('preserves prose around the tagged section as a separate text block', async () => {
    const input: ProviderChunk[] = [
      {
        type: 'message_complete',
        content: [{ type: 'text', text: TAGGED_WITH_PROSE }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ]
    const [final] = await collect(wrapKimiToolCallStream(asyncOf(input)))
    if (final?.type !== 'message_complete') throw new Error('expected message_complete')
    expect(final.content).toHaveLength(2)
    expect(final.content[0]).toEqual({
      type: 'text',
      text: 'I will write the file now.\n\n\n\nDone.',
    })
    const tool = final.content[1]
    if (tool?.type !== 'tool_use') throw new Error('expected tool_use block')
    expect(tool.name).toBe('writeFile')
    expect(tool.input).toEqual({ file_path: '/x', content: 'y' })
    expect(tool.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
    expect(final.stopReason).toBe('tool_use')
  })

  it('emits multiple tool_use blocks in section order for a multi-call response', async () => {
    const input: ProviderChunk[] = [
      {
        type: 'message_complete',
        content: [{ type: 'text', text: TAGGED_MULTI }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ]
    const [final] = await collect(wrapKimiToolCallStream(asyncOf(input)))
    if (final?.type !== 'message_complete') throw new Error('expected message_complete')
    const toolUses = final.content.filter((b) => b.type === 'tool_use')
    expect(toolUses.map((b) => (b as { name: string }).name)).toEqual([
      'readFile',
      'writeFile',
    ])
  })

  it('leaves message_complete unchanged when there is no tagged section', async () => {
    const input: ProviderChunk[] = [
      {
        type: 'message_complete',
        content: [{ type: 'text', text: 'just a normal response' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ]
    const [final] = await collect(wrapKimiToolCallStream(asyncOf(input)))
    expect(final).toEqual(input[0])
  })

  it('does not touch existing tool_use blocks (defensive against mixed responses)', async () => {
    const input: ProviderChunk[] = [
      {
        type: 'message_complete',
        content: [
          {
            type: 'tool_use',
            id: 'call_native_1',
            name: 'readFile',
            input: { file_path: '/native' },
          },
          { type: 'text', text: TAGGED_SINGLE },
        ],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ]
    const [final] = await collect(wrapKimiToolCallStream(asyncOf(input)))
    if (final?.type !== 'message_complete') throw new Error('expected message_complete')
    expect(final.content).toHaveLength(2)
    expect(final.content[0]).toEqual(input[0]!.type === 'message_complete' ? input[0]!.content[0] : null)
    const rewritten = final.content[1]
    if (rewritten?.type !== 'tool_use') throw new Error('expected tool_use block')
    expect(rewritten.name).toBe('writeFile')
    expect(rewritten.input).toEqual({ file_path: '/tmp/out.txt', content: 'hello' })
    expect(rewritten.id).toMatch(/^call_kimi_[A-Za-z0-9]+_\d+_[a-f0-9]{24}$/)
  })
})

describe('isKimiModel', () => {
  it.each([
    'kimi-k2',
    'kimi-k2.5',
    'kimi-k2.6',
    'KIMI-K2.6',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2',
    'MoonshotAI/Kimi-K2.6',
  ])('detects %s as Kimi', (id) => {
    expect(isKimiModel(id)).toBe(true)
  })

  it.each(['gpt-4o', 'claude-sonnet-4-6', 'deepseek-v3.2', 'glm-4.6'])(
    'does not flag %s as Kimi',
    (id) => {
      expect(isKimiModel(id)).toBe(false)
    },
  )
})
