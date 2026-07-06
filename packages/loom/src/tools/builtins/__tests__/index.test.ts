import { describe, it, expect } from 'vitest'
import { builtinTools, createBuiltinTools, createBuiltinToolMap } from '../index.js'

describe('builtins/index', () => {
  it('exports all built-in tools', () => {
    // filesystem (6) + shell (1) + ask_user (1) + agent_spawn (1) + orchestrate (1)
    // + web_fetch (1) + web_search (1) + browser (17) + memory (3) + tasks (1)
    // + image_generate (1) + speech (2) + credential (1)
    expect(builtinTools.length).toBe(37)
  })

  it('each tool has required properties', () => {
    for (const tool of builtinTools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('has unique tool names', () => {
    const names = builtinTools.map((t) => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  describe('createBuiltinTools', () => {
    it('returns a fresh array each time', () => {
      const a = createBuiltinTools()
      const b = createBuiltinTools()
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })
  })

  describe('createBuiltinToolMap', () => {
    it('creates a Map keyed by tool name', () => {
      const map = createBuiltinToolMap()
      expect(map.size).toBe(37)
      expect(map.get('readFile')).toBeDefined()
      expect(map.get('shell_execute')).toBeDefined()
      expect(map.get('browser_navigate')).toBeDefined()
      expect(map.get('memory_store')).toBeDefined()
      expect(map.get('todo_write')).toBeDefined()
      expect(map.get('image_generate')).toBeDefined()
      expect(map.get('speech_synthesize')).toBeDefined()
      expect(map.get('request_credential')).toBeDefined()
    })
  })
})
