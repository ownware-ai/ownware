/**
 * S3 (design-context-tooling) — the ownware-design design-system tools
 * are REGISTERED and EXECUTABLE.
 *
 * Background: `tools/list-design-systems.ts` + `tools/apply-design-system.ts`
 * exported valid Tools but `agent.json` had `tools.custom: []`, so the
 * assembler never loaded them — dead code, no on-demand path for the agent
 * (BUGS CT-4). This test pins that they are now wired AND that they work
 * against the real shipped catalog.
 *
 * Two layers:
 *   1. Config wiring — `loadProfile` reads the real profile dir and
 *      `validateCustomToolPaths` (inside loadProfile) throws if any custom
 *      path is missing. So a successful load + the refs being present proves
 *      the wiring resolves on disk.
 *   2. Execution — import the tool modules and run `execute()` against the
 *      real `design-systems/` catalog (pointed at via OWNWARE_DESIGN_CATALOG_DIR),
 *      proving list → apply round-trips with real data (Principle 18: the
 *      tool actually works, not just "the file exists").
 */

import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { loadProfile } from '../../src/profile/loader.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = join(__dirname, '../../profiles/ownware-design')
const CATALOG_DIR = join(PROFILE_DIR, 'design-systems')

// IMPORTANT: pin the catalog dir at MODULE-TOP scope, before the dynamic
// `import()`s of the tool modules below. The design-systems service is a
// process-global singleton that resolves its catalog dir ONCE on first
// call (getDesignSystemsService → resolveCatalogDir reads this env). A
// `beforeAll` set would be too late if anything initialized the singleton
// first; setting it here — before any tool import — makes it deterministic.
// (Static imports above are hoisted, but they don't touch the service;
// the tool imports are dynamic + run at test time, after this line.)
process.env['OWNWARE_DESIGN_CATALOG_DIR'] = CATALOG_DIR

describe('ownware-design — design-system tools registered (S3 / CT-4)', () => {
  it('agent.json registers both design-system tools in tools.custom', async () => {
    // loadProfile validates every custom tool path exists on disk and
    // throws otherwise — a clean load is itself proof the refs resolve.
    const profile = await loadProfile(PROFILE_DIR)
    const custom = profile.config.tools.custom
    const paths = custom.map((c) => c.path)
    expect(paths).toContain('tools/list-design-systems.ts')
    expect(paths).toContain('tools/apply-design-system.ts')

    const listRef = custom.find((c) => c.path === 'tools/list-design-systems.ts')
    const applyRef = custom.find((c) => c.path === 'tools/apply-design-system.ts')
    expect(listRef?.functions).toEqual(['LIST_DESIGN_SYSTEMS_TOOL'])
    expect(applyRef?.functions).toEqual(['APPLY_DESIGN_SYSTEM_TOOL'])
  })
})

describe('ownware-design — constrained write engine wired (one-Designer collapse)', () => {
  it('agent.json registers the three structured write tools and denies raw file writes', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    const custom = profile.config.tools.custom
    const paths = custom.map((c) => c.path)
    expect(paths).toContain('tools/set-tokens.ts')
    expect(paths).toContain('tools/write-component.ts')
    expect(paths).toContain('tools/write-page.ts')

    expect(
      custom.find((c) => c.path === 'tools/set-tokens.ts')?.functions,
    ).toEqual(['SET_TOKENS_TOOL'])
    expect(
      custom.find((c) => c.path === 'tools/write-component.ts')?.functions,
    ).toEqual(['WRITE_COMPONENT_TOOL'])
    expect(
      custom.find((c) => c.path === 'tools/write-page.ts')?.functions,
    ).toEqual(['WRITE_PAGE_TOOL'])

    // The whole point of the constrained engine: raw writes are off, so the
    // gate can't be bypassed by writeFile/editFile.
    expect(profile.config.tools.deny).toContain('writeFile')
    expect(profile.config.tools.deny).toContain('editFile')
  })

  it('deny removes the cortex-injected open_pane and builtin image_generate', async () => {
    const { applyToolPolicy, resolvePresetTools } = await import(
      '../../src/profile/tool-policy.js'
    )
    const profile = await loadProfile(PROFILE_DIR)
    const { allow, deny } = profile.config.tools

    // Config lists them.
    expect(deny).toContain('open_pane')
    expect(deny).toContain('image_generate')
    // Shell is denied so it can't bypass the anti-hardcode gate (echo > file).
    expect(deny).toContain('shell_*')

    // Mechanism: the assembler injects open_pane into the tool list BEFORE
    // applying allow/deny (assembler.ts a.7 → b), so the deny filter removes
    // it just like a real builtin. Reproduce that here with the real preset +
    // a stub open_pane and assert both are gone.
    const base = resolvePresetTools(profile.config.tools.preset)
    expect(base.some((t) => t.name === 'image_generate')).toBe(true) // present pre-deny
    const withInjected = [
      ...base,
      { name: 'open_pane' } as (typeof base)[number],
    ]
    const resolved = applyToolPolicy(withInjected, allow, deny)
    const names = resolved.map((t) => t.name)
    expect(names).not.toContain('open_pane')
    expect(names).not.toContain('image_generate')
    // And the rest of the deny list still bites — every raw-write path is
    // gone (writeFile / editFile / shell), so the gate is unbypassable.
    expect(names).not.toContain('writeFile')
    expect(names).not.toContain('editFile')
    expect(names).not.toContain('shell_execute')
  })

  it('the write gate rejects hardcoded values and accepts tokens', async () => {
    const { validateHtml, validateCss } = await import(
      '../../profiles/ownware-design/helpers/gate.js'
    )

    // Raw hex below :root → rejected with an actionable hint.
    const rawHex = validateCss('.btn { color: #635bff; }')
    expect(rawHex.length).toBeGreaterThan(0)
    expect(rawHex[0]!.rule).toBe('no-raw-color')

    // The same hex INSIDE :root (a token definition) → allowed.
    expect(validateCss(':root { --accent: #635bff; }')).toEqual([])

    // Referencing the token via var(--…) → allowed.
    expect(validateCss('.btn { color: var(--accent); }')).toEqual([])

    // Inline style on an element → rejected.
    const inline = validateHtml('<div style="color:#fff">x</div>')
    expect(inline.some((v) => v.rule === 'no-inline-style')).toBe(true)
  })
})

describe('ownware-design — design-system tools execute against the real catalog', () => {
  it('list_design_systems returns real catalog summaries', async () => {
    const mod = await import(
      '../../profiles/ownware-design/tools/list-design-systems.js'
    )
    const tool = mod.LIST_DESIGN_SYSTEMS_TOOL
    expect(tool.name).toBe('list_design_systems')

    const res = await tool.execute({})
    expect(res.isError).toBe(false)
    const data = JSON.parse(res.content as string) as {
      total: number
      results: { id: string; name: string; swatches: string[] }[]
    }
    // S4.5 (CT-9 fixed): all 16 shipped design systems load with zero
    // category warnings now that the category enum was opened to a free
    // lowercase-kebab string. Before the fix only 3 of 16 survived
    // validation. Lock the full catalog so it can't silently regress.
    expect(data.total).toBeGreaterThanOrEqual(16)
    expect(data.results.length).toBe(data.total)
    const ids = data.results.map((r) => r.id)
    expect(ids).toContain('modern-minimal')
    // Entries that USED to be dropped by the narrow enum (CT-9) now load.
    expect(ids).toContain('gradient-vivid') // was category "marketing"
    expect(ids).toContain('neon-arcade') // was category "futuristic"
    expect(ids).toContain('luxury-serif') // was category "premium"
    // Summaries carry swatches (the lightweight shape — NO heavy file bodies).
    const mm = data.results.find((r) => r.id === 'modern-minimal')!
    expect(mm.swatches.length).toBeGreaterThanOrEqual(3)
    expect(res.content).not.toContain('tokens.css') // summaries only
  })

  it('list_design_systems search narrows by free text', async () => {
    const mod = await import(
      '../../profiles/ownware-design/tools/list-design-systems.js'
    )
    const res = await mod.LIST_DESIGN_SYSTEMS_TOOL.execute({ search: 'minimal' })
    const data = JSON.parse(res.content as string) as { results: { id: string }[] }
    expect(data.results.some((r) => r.id.includes('minimal'))).toBe(true)
  })

  it('apply_design_system returns full DESIGN.md + tokens + :root for a real id', async () => {
    const mod = await import(
      '../../profiles/ownware-design/tools/apply-design-system.js'
    )
    const tool = mod.APPLY_DESIGN_SYSTEM_TOOL
    expect(tool.name).toBe('apply_design_system')

    const res = await tool.execute({ id: 'modern-minimal' })
    expect(res.isError).toBe(false)
    const data = JSON.parse(res.content as string) as {
      id: string
      designMd: string
      tokensCss: string
      rootBlock: string
    }
    expect(data.id).toBe('modern-minimal')
    expect(data.designMd.length).toBeGreaterThan(100)
    expect(data.tokensCss).toContain(':root')
    expect(data.rootBlock.startsWith(':root')).toBe(true)
  })

  it('apply_design_system errors actionably on an unknown id', async () => {
    const mod = await import(
      '../../profiles/ownware-design/tools/apply-design-system.js'
    )
    const res = await mod.APPLY_DESIGN_SYSTEM_TOOL.execute({ id: 'does-not-exist' })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('Unknown design system')
    expect(res.content).toContain('list_design_systems')
  })
})
