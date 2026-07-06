/**
 * Built-in Image Generation Tool
 *
 * Generates images from text prompts via a pluggable provider interface.
 * Consumers inject their own implementation (DALL-E, FAL, Midjourney, etc.)
 * via config.imageGenerationProvider.
 *
 * Engine-level — any agent may need to create images for the user.
 *
 * Design:
 *   - Zero external deps (provider implementations live in Cortex)
 *   - ImageGenerationProvider interface is injected via config
 *   - If no provider is configured, the tool returns a clear error
 *   - Image data returned in metadata.images (base64 array)
 *   - Text content describes what was generated (for model context)
 *
 * @security
 *   - Requires explicit permission (generates content visible to users)
 *   - Prompt text is passed to external APIs — no local processing
 *   - Generated images may contain sensitive content (provider responsibility)
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Image generation provider interface.
 * Consumers inject their own implementation via config.imageGenerationProvider.
 *
 * Implementations may wrap:
 *   - OpenAI DALL-E API
 *   - FAL.ai models
 *   - Stability AI
 *   - Custom self-hosted models
 */
export interface ImageGenerationProvider {
  /**
   * Generate images from a text prompt.
   * Returns one or more generated images.
   */
  generate(
    prompt: string,
    options?: {
      /** Image dimensions (e.g., "1024x1024", "1792x1024") */
      size?: string
      /** Quality level */
      quality?: 'standard' | 'hd'
      /** Number of images to generate (1-4) */
      count?: number
      /** Style hint */
      style?: 'natural' | 'vivid'
    },
  ): Promise<GeneratedImage[]>
}

export interface GeneratedImage {
  /** Base64-encoded image data */
  readonly data: string
  /** Image format */
  readonly format: 'png' | 'jpeg' | 'webp'
  /** Provider-returned URL (if available, may expire) */
  readonly url?: string
  /** Revised prompt (some providers modify the prompt) */
  readonly revisedPrompt?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PROMPT_LENGTH = 4_000
const MAX_IMAGE_COUNT = 4

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const imageGenerate: Tool = defineTool({
  name: 'image_generate',
  description:
    'Generate an image from a text description.\n' +
    '- Provide a detailed, descriptive prompt for best results.\n' +
    '- Include style, composition, lighting, and subject details in your prompt.\n' +
    '- Generated images are returned as data (viewable by the user).\n' +
    '- Default size is 1024x1024. Use "size" for other dimensions.\n' +
    '- Use quality="hd" for higher detail (slower, more expensive).\n' +
    '- Maximum 4 images per request.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: true,
  timeoutMs: 120_000,
  uiDescriptor: {
    kind: 'image',
    summary: { verb: 'Generated', primaryField: 'prompt' },
    preview: { contentField: 'imagePath', format: 'image-thumb' },
    openAction: { target: 'image-pane', pathField: 'imagePath' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Detailed description of the image to generate. Include style, subject, ' +
          'composition, colors, lighting, and mood for best results.',
      },
      size: {
        type: 'string',
        description:
          'Image dimensions. Common sizes: "1024x1024" (square), ' +
          '"1792x1024" (landscape), "1024x1792" (portrait). Default: "1024x1024".',
      },
      quality: {
        type: 'string',
        enum: ['standard', 'hd'],
        description: 'Quality level. "hd" produces more detailed images but costs more. Default: "standard".',
      },
      count: {
        type: 'number',
        description: 'Number of images to generate (1-4). Default: 1.',
      },
      style: {
        type: 'string',
        enum: ['natural', 'vivid'],
        description: 'Style preset. "natural" for realistic, "vivid" for artistic/dramatic. Default: "vivid".',
      },
    },
    required: ['prompt'],
  },
  async execute(input, context) {
    const provider = (context.config as Record<string, unknown>).imageGenerationProvider as
      | ImageGenerationProvider | undefined

    if (!provider) {
      return {
        content:
          'Image generation is not configured in this session. ' +
          'No image generation provider is available.',
        isError: true,
        metadata: { reason: 'no_provider' },
      }
    }

    const { prompt, size, quality, count, style } = input as {
      prompt: string
      size?: string
      quality?: 'standard' | 'hd'
      count?: number
      style?: 'natural' | 'vivid'
    }

    if (!prompt || prompt.trim().length === 0) {
      return { content: 'Prompt cannot be empty.', isError: true }
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return {
        content: `Prompt too long (${prompt.length} chars). Maximum is ${MAX_PROMPT_LENGTH} characters.`,
        isError: true,
      }
    }

    const imageCount = Math.min(Math.max(count ?? 1, 1), MAX_IMAGE_COUNT)

    try {
      const images = await provider.generate(prompt.trim(), {
        size: size ?? '1024x1024',
        quality: quality ?? 'standard',
        count: imageCount,
        style: style ?? 'vivid',
      })

      if (images.length === 0) {
        return {
          content: 'Image generation returned no results. Try a different prompt.',
          isError: true,
          metadata: { prompt },
        }
      }

      const descriptions = images.map((img, i) => {
        const parts = [`Image ${i + 1}: ${img.format}`]
        if (img.revisedPrompt) parts.push(`Revised prompt: "${img.revisedPrompt}"`)
        if (img.url) parts.push(`URL: ${img.url}`)
        return parts.join('\n  ')
      }).join('\n')

      return {
        content: `Generated ${images.length} image${images.length > 1 ? 's' : ''}:\n${descriptions}`,
        isError: false,
        metadata: {
          images: images.map(img => ({
            data: img.data,
            format: img.format,
            url: img.url,
            revisedPrompt: img.revisedPrompt,
          })),
          prompt,
          count: images.length,
        },
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)

      // Handle common provider errors
      if (msg.includes('content_policy') || msg.includes('safety')) {
        return {
          content: 'Image generation was blocked by the provider\'s content policy. Try a different prompt.',
          isError: true,
          metadata: { prompt, reason: 'content_policy' },
        }
      }

      return {
        content: `Image generation failed: ${msg}`,
        isError: true,
        metadata: { prompt, error: String(e) },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const imageGenerateTools: Tool[] = [imageGenerate]
