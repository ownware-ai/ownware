/**
 * Tests for DocumentBlock and multimodal message support.
 *
 * Verifies that the message type system correctly handles
 * images, documents, and mixed content in user messages.
 */

import { describe, it, expect } from 'vitest'
import type {
  ContentBlock,
  TextBlock,
  ImageBlock,
  DocumentBlock,
  UserMessage,
  ToolResultBlock,
} from '../../../messages/types.js'
import { createUserMessage } from '../../../messages/types.js'

// ---------------------------------------------------------------------------
// DocumentBlock type
// ---------------------------------------------------------------------------

describe('DocumentBlock', () => {
  it('can be created with correct shape', () => {
    const doc: DocumentBlock = {
      type: 'document',
      source: {
        type: 'base64',
        mediaType: 'application/pdf',
        data: 'JVBERi0xLjQ=',
      },
    }

    expect(doc.type).toBe('document')
    expect(doc.source.type).toBe('base64')
    expect(doc.source.mediaType).toBe('application/pdf')
    expect(doc.source.data).toBe('JVBERi0xLjQ=')
  })

  it('is part of ContentBlock union', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'abc' } },
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'def' } },
    ]

    expect(blocks).toHaveLength(3)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[1]!.type).toBe('image')
    expect(blocks[2]!.type).toBe('document')
  })
})

// ---------------------------------------------------------------------------
// Multimodal UserMessage
// ---------------------------------------------------------------------------

describe('multimodal UserMessage', () => {
  it('supports string content (text-only)', () => {
    const msg = createUserMessage('hello world')
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('hello world')
  })

  it('supports ContentBlock[] content (multimodal)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0=' } },
    ]

    const msg = createUserMessage(blocks)
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    expect((msg.content as ContentBlock[])).toHaveLength(2)
    expect((msg.content as ContentBlock[])[0]!.type).toBe('text')
    expect((msg.content as ContentBlock[])[1]!.type).toBe('image')
  })

  it('supports text + PDF document blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Summarize this document' },
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' } },
    ]

    const msg = createUserMessage(blocks)
    expect(Array.isArray(msg.content)).toBe(true)
    const content = msg.content as ContentBlock[]
    expect(content[1]!.type).toBe('document')
  })

  it('supports text + multiple images', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Compare these screenshots' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'img1=' } },
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'img2=' } },
    ]

    const msg = createUserMessage(blocks)
    const content = msg.content as ContentBlock[]
    expect(content).toHaveLength(3)
    const images = content.filter(b => b.type === 'image')
    expect(images).toHaveLength(2)
  })

  it('supports mixed content (text + image + pdf + notebook text)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Analyze all of this' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'img=' } },
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'pdf=' } },
      { type: 'text', text: '<cell id="cell-0">import pandas</cell>' },
    ]

    const msg = createUserMessage(blocks)
    const content = msg.content as ContentBlock[]
    expect(content).toHaveLength(4)

    const types = content.map(b => b.type)
    expect(types).toEqual(['text', 'image', 'document', 'text'])
  })
})

// ---------------------------------------------------------------------------
// ToolResultBlock with multimodal content
// ---------------------------------------------------------------------------

describe('ToolResultBlock multimodal content', () => {
  it('supports string content (text-only tool result)', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'tool_123',
      content: 'File contents here',
      isError: false,
    }
    expect(typeof result.content).toBe('string')
  })

  it('supports ContentBlock[] content (multimodal tool result)', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'tool_123',
      content: [
        { type: 'text', text: 'Image file: screenshot.png' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'base64data' } },
      ],
      isError: false,
    }

    expect(Array.isArray(result.content)).toBe(true)
    const content = result.content as ContentBlock[]
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe('text')
    expect(content[1]!.type).toBe('image')
  })
})

// ---------------------------------------------------------------------------
// ImageBlock variants
// ---------------------------------------------------------------------------

describe('ImageBlock', () => {
  it('supports base64 source', () => {
    const img: ImageBlock = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0=' },
    }
    expect(img.source.type).toBe('base64')
  })

  it('supports URL source', () => {
    const img: ImageBlock = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/image.png' },
    }
    expect(img.source.type).toBe('url')
  })
})
