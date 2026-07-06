/**
 * Unit Tests — Tool Description Renderer + createToolsFragment integration
 */

import { describe, it, expect } from 'vitest'

import { renderToolDoc } from '../../../src/tools/descriptions/render.js'
import { ToolDescriptionRegistry } from '../../../src/tools/descriptions/registry.js'
import { createToolsFragment } from '../../../src/prompt/fragments/tools.js'
import { createBuiltinDescriptionRegistry } from '../../../src/tools/builtins/descriptions/index.js'

import type { Tool } from '../../../src/tools/types.js'
import type { ToolDescription } from '../../../src/tools/descriptions/types.js'

function fakeTool(over: Partial<Tool> = {}): Tool {
  return {
    name: 'example',
    description: 'flat description',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'a path' },
      },
      required: ['path'],
    },
    isReadOnly: true,
    requiresPermission: false,
    async execute() {
      return { content: 'ok', isError: false }
    },
    ...over,
  }
}

function fullDesc(): ToolDescription {
  return {
    name: 'example',
    sections: {
      overview: 'OV',
      usage: 'US',
      safety: 'SA',
      parallel: 'PA',
      alternatives: 'AL',
      examples: 'EX',
    },
  }
}

describe('renderToolDoc — legacy fallback', () => {
  it('emits the flat description + parameter list when no modular description is registered', () => {
    const tool = fakeTool()
    const out = renderToolDoc(tool, undefined, undefined)
    expect(out).toContain('## example')
    expect(out).toContain('flat description')
    expect(out).toContain('Parameters:')
    expect(out).toContain('- path (required): a path')
    expect(out).toContain('(read-only, safe for parallel execution)')
  })
})

describe('renderToolDoc — modular path', () => {
  it('emits every present section in canonical order with sub-headings (except overview)', () => {
    const out = renderToolDoc(fakeTool(), fullDesc(), undefined)
    // Overview lands directly under the tool heading, no `### overview`.
    expect(out).toMatch(/## example\nOV/)
    expect(out).toContain('### usage')
    expect(out.indexOf('### usage')).toBeLessThan(out.indexOf('### safety'))
    expect(out.indexOf('### safety')).toBeLessThan(out.indexOf('### parallel'))
    expect(out.indexOf('### parallel')).toBeLessThan(out.indexOf('### alternatives'))
    expect(out.indexOf('### alternatives')).toBeLessThan(out.indexOf('### examples'))
  })

  it('honors a per-tool selection', () => {
    const out = renderToolDoc(
      fakeTool(),
      fullDesc(),
      { perTool: { example: ['overview', 'safety'] } },
    )
    expect(out).toContain('### safety')
    expect(out).not.toContain('### usage')
    expect(out).not.toContain('### alternatives')
  })

  it('falls back to the default selection when no perTool entry exists', () => {
    const out = renderToolDoc(
      fakeTool(),
      fullDesc(),
      { default: ['overview', 'examples'] },
    )
    expect(out).toContain('### examples')
    expect(out).not.toContain('### usage')
  })

  it('always includes overview even if a profile forgot it', () => {
    const out = renderToolDoc(
      fakeTool(),
      fullDesc(),
      { default: ['safety', 'examples'] },  // no overview
    )
    expect(out).toMatch(/## example\nOV/)
  })

  it('silently ignores selected sections that the description does not define', () => {
    const desc: ToolDescription = {
      name: 'example',
      sections: { overview: 'OV' },
    }
    const out = renderToolDoc(
      fakeTool(),
      desc,
      { perTool: { example: ['overview', 'safety', 'examples'] } },
    )
    expect(out).toContain('OV')
    expect(out).not.toContain('### safety')
    expect(out).not.toContain('### examples')
  })

  it('still emits parameters and capability flags after the modular sections', () => {
    const out = renderToolDoc(fakeTool({ requiresPermission: true }), fullDesc(), undefined)
    expect(out).toContain('Parameters:')
    expect(out).toContain('- path (required): a path')
    expect(out).toContain('(read-only, safe for parallel execution)')
    expect(out).toContain('(requires user permission)')
  })
})

describe('createToolsFragment integration', () => {
  it('produces identical output to pre-Phase-4 when no descriptions registry is supplied', () => {
    const tool = fakeTool()
    const frag = createToolsFragment([tool])
    expect(frag.content).toContain('## example')
    expect(frag.content).toContain('flat description')
    expect(frag.content).toContain('Parameters:')
  })

  it('uses the modular description when the registry has one', () => {
    const tool = fakeTool()
    const registry = new ToolDescriptionRegistry().register(fullDesc())
    const frag = createToolsFragment([tool], { descriptions: registry })
    expect(frag.content).not.toContain('flat description')
    expect(frag.content).toContain('OV')
    expect(frag.content).toContain('### usage')
    expect(frag.content).toContain('### safety')
  })

  it('mixes modular and legacy rendering — only the registered tool gets sub-sections', () => {
    const a = fakeTool({ name: 'a', description: 'A flat' })
    const b = fakeTool({ name: 'b', description: 'B flat' })
    const registry = new ToolDescriptionRegistry().register({
      name: 'a',
      sections: { overview: 'A modular OV', usage: 'A usage' },
    })
    const frag = createToolsFragment([a, b], { descriptions: registry })
    expect(frag.content).toContain('A modular OV')
    expect(frag.content).toContain('### usage')
    // b stays on the legacy path
    expect(frag.content).toContain('B flat')
  })

  it('respects the profile selection across multiple registered tools', () => {
    const skill = fakeTool({ name: 'skill', description: 'flat' })
    const shell = fakeTool({ name: 'shell_execute', description: 'flat' })
    const registry = createBuiltinDescriptionRegistry()

    const frag = createToolsFragment([skill, shell], {
      descriptions: registry,
      selection: {
        default: ['overview', 'usage'],
        perTool: { shell_execute: ['overview', 'usage', 'safety', 'alternatives'] },
      },
    })

    // skill takes default → safety / examples NOT rendered
    expect(frag.content).toMatch(/## skill[\s\S]*?## shell_execute/)
    // shell_execute takes perTool override → safety + alternatives rendered
    expect(frag.content).toContain('### safety')
    expect(frag.content).toContain('### alternatives')
  })
})

describe('createBuiltinDescriptionRegistry', () => {
  it('registers every shipped builtin with overview present', () => {
    const r = createBuiltinDescriptionRegistry()
    const expected = ['skill', 'shell_execute', 'readFile', 'editFile', 'writeFile', 'glob', 'grep']
    for (const name of expected) {
      expect(r.has(name)).toBe(true)
      const desc = r.get(name)
      expect(desc?.sections.overview, `${name} overview`).toBeTruthy()
      expect(desc?.sections.overview.length).toBeGreaterThan(20)
    }
  })

  it('every builtin has at least the safety or alternatives section', () => {
    const r = createBuiltinDescriptionRegistry()
    for (const desc of r.list()) {
      const hasOneOf = desc.sections.safety !== undefined
        || desc.sections.alternatives !== undefined
      expect(hasOneOf, `${desc.name} should ship safety or alternatives`).toBe(true)
    }
  })

  it('every builtin has parallel guidance', () => {
    const r = createBuiltinDescriptionRegistry()
    for (const desc of r.list()) {
      expect(desc.sections.parallel, `${desc.name} parallel`).toBeTruthy()
    }
  })
})
