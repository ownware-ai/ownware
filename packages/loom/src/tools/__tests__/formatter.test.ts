import { describe, it, expect } from 'vitest'
import {
  formatToolsForProvider,
  formatDefinitionsForProvider,
  type AnthropicToolSchema,
  type OpenAIToolSchema,
  type GoogleToolSchema,
} from '../formatter.js'
import { defineTool } from '../types.js'
import type { ToolDefinition } from '../../provider/types.js'

const testTool = defineTool({
  name: 'readFile',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
      offset: { type: 'number', description: 'Start line' },
    },
    required: ['file_path'],
  },
  async execute() {
    return { content: 'ok', isError: false }
  },
})

const testDefinition: ToolDefinition = {
  name: 'readFile',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
    },
    required: ['file_path'],
  },
}

describe('formatToolsForProvider', () => {
  describe('Anthropic format', () => {
    it('returns { name, description, input_schema }', () => {
      const result = formatToolsForProvider([testTool], 'anthropic') as AnthropicToolSchema[]
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        name: 'readFile',
        description: 'Read a file',
        input_schema: testTool.inputSchema,
      })
    })
  })

  describe('OpenAI format', () => {
    it('returns { type: function, function: { name, description, parameters } }', () => {
      const result = formatToolsForProvider([testTool], 'openai') as OpenAIToolSchema[]
      expect(result).toHaveLength(1)
      expect(result[0]!.type).toBe('function')
      expect(result[0]!.function.name).toBe('readFile')
      expect(result[0]!.function.description).toBe('Read a file')
      expect(result[0]!.function.parameters).toEqual(testTool.inputSchema)
    })
  })

  describe('Google format', () => {
    it('returns { functionDeclarations: [...] }', () => {
      const result = formatToolsForProvider([testTool], 'google') as GoogleToolSchema[]
      expect(result).toHaveLength(1)
      const schema = result[0] as GoogleToolSchema
      expect(schema.functionDeclarations).toHaveLength(1)
      expect(schema.functionDeclarations[0]!.name).toBe('readFile')
      expect(schema.functionDeclarations[0]!.description).toBe('Read a file')
    })

    it('converts JSON Schema to Google format', () => {
      const result = formatToolsForProvider([testTool], 'google') as GoogleToolSchema[]
      const params = result[0]!.functionDeclarations[0]!.parameters
      expect(params.type).toBe('object')
      expect(params.properties!['file_path']).toBeDefined()
      expect(params.required).toEqual(['file_path'])
    })
  })

  it('throws for unknown provider', () => {
    expect(() =>
      formatToolsForProvider([testTool], 'unknown' as never),
    ).toThrow('Unknown provider')
  })

  it('handles multiple tools', () => {
    const tool2 = defineTool({
      name: 'writeFile',
      description: 'Write a file',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { content: 'ok', isError: false }
      },
    })

    const anthropic = formatToolsForProvider([testTool, tool2], 'anthropic') as AnthropicToolSchema[]
    expect(anthropic).toHaveLength(2)

    const openai = formatToolsForProvider([testTool, tool2], 'openai') as OpenAIToolSchema[]
    expect(openai).toHaveLength(2)

    // Google wraps all in one object
    const google = formatToolsForProvider([testTool, tool2], 'google') as GoogleToolSchema[]
    expect(google).toHaveLength(1)
    expect(google[0]!.functionDeclarations).toHaveLength(2)
  })
})

describe('formatDefinitionsForProvider', () => {
  it('formats definitions for Anthropic', () => {
    const result = formatDefinitionsForProvider([testDefinition], 'anthropic')
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveProperty('input_schema')
  })

  it('formats definitions for OpenAI', () => {
    const result = formatDefinitionsForProvider([testDefinition], 'openai')
    expect(result[0]).toHaveProperty('type', 'function')
  })

  it('formats definitions for Google', () => {
    const result = formatDefinitionsForProvider([testDefinition], 'google')
    expect(result[0]).toHaveProperty('functionDeclarations')
  })
})
