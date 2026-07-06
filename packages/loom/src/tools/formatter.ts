/**
 * Tool Schema Formatter
 *
 * Converts Loom's provider-agnostic tool definitions into
 * the format each LLM provider expects.
 *
 * Supported providers:
 * - Anthropic: { name, description, input_schema }
 * - OpenAI:    { type: 'function', function: { name, description, parameters } }
 * - Google:    { functionDeclarations: [{ name, description, parameters }] }
 */

import type { Tool } from './types.js'
import type { JsonSchema, ToolDefinition } from '../provider/types.js'

// ---------------------------------------------------------------------------
// Provider format types
// ---------------------------------------------------------------------------

export interface AnthropicToolSchema {
  readonly name: string
  readonly description: string
  readonly input_schema: JsonSchema
}

export interface OpenAIToolSchema {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: JsonSchema
  }
}

export interface GoogleFunctionDeclaration {
  readonly name: string
  readonly description: string
  readonly parameters: GoogleSchema
}

export interface GoogleToolSchema {
  readonly functionDeclarations: GoogleFunctionDeclaration[]
}

/**
 * Google's schema format — similar to JSON Schema but uses
 * slightly different conventions (no `additionalProperties` at root,
 * `items` instead of array-level type).
 */
export interface GoogleSchema {
  readonly type: string
  readonly properties?: Record<string, GoogleSchema>
  readonly required?: string[]
  readonly items?: GoogleSchema
  readonly description?: string
  readonly enum?: string[]
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

export type ProviderName = 'anthropic' | 'openai' | 'google'

/**
 * Convert Loom tools to the format expected by a specific provider.
 */
export function formatToolsForProvider(
  tools: Tool[],
  provider: ProviderName,
): unknown[] {
  switch (provider) {
    case 'anthropic':
      return tools.map(formatForAnthropic)
    case 'openai':
      return tools.map(formatForOpenAI)
    case 'google':
      return [formatForGoogle(tools)]
    default:
      throw new Error(`Unknown provider: ${provider as string}`)
  }
}

/**
 * Convert ToolDefinitions (from provider/types.ts) to provider format.
 */
export function formatDefinitionsForProvider(
  defs: ToolDefinition[],
  provider: ProviderName,
): unknown[] {
  switch (provider) {
    case 'anthropic':
      return defs.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.inputSchema,
      }))
    case 'openai':
      return defs.map((d) => ({
        type: 'function' as const,
        function: {
          name: d.name,
          description: d.description,
          parameters: d.inputSchema,
        },
      }))
    case 'google':
      return [
        {
          functionDeclarations: defs.map((d) => ({
            name: d.name,
            description: d.description,
            parameters: jsonSchemaToGoogle(d.inputSchema),
          })),
        },
      ]
    default:
      throw new Error(`Unknown provider: ${provider as string}`)
  }
}

// ---------------------------------------------------------------------------
// Per-provider formatters
// ---------------------------------------------------------------------------

function formatForAnthropic(tool: Tool): AnthropicToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function formatForOpenAI(tool: Tool): OpenAIToolSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function formatForGoogle(tools: Tool[]): GoogleToolSchema {
  return {
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaToGoogle(tool.inputSchema),
    })),
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → Google Schema converter
// ---------------------------------------------------------------------------

function jsonSchemaToGoogle(schema: JsonSchema): GoogleSchema {
  const result: GoogleSchema = {
    type: schema.type,
    required: schema.required,
  }

  if (schema.properties) {
    const props: Record<string, GoogleSchema> = {}
    for (const [key, prop] of Object.entries(schema.properties)) {
      props[key] = jsonSchemaPropertyToGoogle(prop)
    }
    return { ...result, properties: props }
  }

  return result
}

function jsonSchemaPropertyToGoogle(prop: {
  type: string
  description?: string
  enum?: string[]
  items?: { type: string; description?: string; enum?: string[] }
  properties?: Record<string, unknown>
  required?: string[]
}): GoogleSchema {
  const base: GoogleSchema = {
    type: prop.type,
    description: prop.description,
    enum: prop.enum,
  }

  if (prop.type === 'array' && prop.items) {
    return { ...base, items: jsonSchemaPropertyToGoogle(prop.items) }
  }

  if (prop.type === 'object' && prop.properties) {
    const props: Record<string, GoogleSchema> = {}
    for (const [key, val] of Object.entries(prop.properties)) {
      props[key] = jsonSchemaPropertyToGoogle(val as typeof prop)
    }
    return { ...base, properties: props, required: prop.required }
  }

  return base
}
