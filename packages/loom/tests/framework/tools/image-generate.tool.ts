/**
 * Image Generation Tool — E2E Test
 *
 * Tests image_generate with a real LLM and a mock image provider.
 * Verifies the model can instruct image generation and handle results.
 */

import { describe, it, afterEach } from 'vitest'
import { createTestSession } from '../harness/index.js'
import {
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertToolFailed,
  assertTextContains,
} from '../harness/assertions.js'
import type { TestSession } from '../harness/session.js'
import { imageGenerateTools } from '../../../src/tools/builtins/image-generate.js'
import type { ImageGenerationProvider, GeneratedImage } from '../../../src/tools/builtins/image-generate.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

// ---------------------------------------------------------------------------
// Mock image provider
// ---------------------------------------------------------------------------

class MockImageProvider implements ImageGenerationProvider {
  lastPrompt: string | null = null
  lastOptions: Record<string, unknown> | null = null
  shouldFail = false
  shouldBlockContent = false

  async generate(
    prompt: string,
    options?: { size?: string; quality?: string; count?: number; style?: string },
  ): Promise<GeneratedImage[]> {
    this.lastPrompt = prompt
    this.lastOptions = options ?? null

    if (this.shouldBlockContent) {
      throw new Error('content_policy_violation: Your request was rejected due to safety filters.')
    }

    if (this.shouldFail) {
      throw new Error('Provider unavailable')
    }

    const count = options?.count ?? 1
    const images: GeneratedImage[] = []
    for (let i = 0; i < count; i++) {
      images.push({
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        format: 'png',
        revisedPrompt: `A beautiful ${prompt}`,
      })
    }
    return images
  }
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Tool: image_generate (E2E)', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('generates an image when the model calls the tool', async () => {
    const provider = new MockImageProvider()

    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: imageGenerateTools,
      systemPrompt:
        'You are a concise assistant. When asked to create an image, ' +
        'you MUST use the image_generate tool with a detailed prompt.',
      maxTurns: 3,
      maxTokens: 512,
      permissionMode: 'allow-all',
      configOverrides: {
        imageGenerationProvider: provider,
      } as Record<string, unknown>,
    })

    const stream = await ts.run('Generate an image of a sunset over the ocean.')
    assertStreamCompleted(stream)
    assertToolCalled(stream, 'image_generate')
    assertToolSucceeded(stream, 'image_generate')

    if (!provider.lastPrompt) throw new Error('Provider was not called')
    if (!provider.lastPrompt.toLowerCase().includes('sunset')) {
      throw new Error(`Expected prompt to mention "sunset", got: ${provider.lastPrompt}`)
    }
  }, 30_000)

  it('handles content policy rejection gracefully', async () => {
    const provider = new MockImageProvider()
    provider.shouldBlockContent = true

    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: imageGenerateTools,
      systemPrompt: 'You MUST use image_generate when asked to create images.',
      maxTurns: 3,
      maxTokens: 512,
      permissionMode: 'allow-all',
      configOverrides: {
        imageGenerationProvider: provider,
      } as Record<string, unknown>,
    })

    const stream = await ts.run('Generate an image of a cat.')
    assertStreamCompleted(stream)
    assertToolCalled(stream, 'image_generate')
    assertToolFailed(stream, 'image_generate')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('Tool: image_generate (unit)', () => {
  it('returns error when no provider configured', async () => {
    const tool = imageGenerateTools[0]!
    const result = await tool.execute(
      { prompt: 'a cat' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: {} as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error')
    if (!res.content.includes('not configured')) throw new Error('Expected "not configured" message')
  })

  it('rejects empty prompt', async () => {
    const provider = new MockImageProvider()
    const tool = imageGenerateTools[0]!
    const result = await tool.execute(
      { prompt: '' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { imageGenerationProvider: provider } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error for empty prompt')
  })

  it('generates multiple images with count param', async () => {
    const provider = new MockImageProvider()
    const tool = imageGenerateTools[0]!
    const result = await tool.execute(
      { prompt: 'a sunset', count: 3 },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { imageGenerationProvider: provider } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean; metadata?: Record<string, unknown> }
    if (res.isError) throw new Error('Should not be an error')
    if (!res.content.includes('3 images')) throw new Error('Expected "3 images" in content')
    const images = (res.metadata?.images as Array<unknown>) ?? []
    if (images.length !== 3) throw new Error(`Expected 3 images in metadata, got ${images.length}`)
  })

  it('handles content policy errors', async () => {
    const provider = new MockImageProvider()
    provider.shouldBlockContent = true
    const tool = imageGenerateTools[0]!
    const result = await tool.execute(
      { prompt: 'bad content' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { imageGenerationProvider: provider } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error')
    if (!res.content.includes('content policy')) throw new Error('Expected content policy message')
  })
})
