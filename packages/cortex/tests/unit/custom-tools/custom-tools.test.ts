/**
 * Unit tests for custom tool loader.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { loadCustomTools } from '../../../src/profile/custom-tools.js'
import { createTempProfile } from '../../helpers/fixtures.js'
import { writeFile, mkdir, symlink } from 'fs/promises'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import { rmSync } from 'fs'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe('loadCustomTools: file validation', () => {
  it('throws on missing file', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))
    await expect(
      loadCustomTools('tools/missing.js', undefined, dir),
    ).rejects.toThrow('not found')
  })

  it('throws on directory path', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
      'tools/placeholder': '',  // creates the directory
    }))
    await expect(
      loadCustomTools('tools', undefined, dir),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Dynamic import
// ---------------------------------------------------------------------------

describe('loadCustomTools: loading', () => {
  it('loads a valid tool export', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    // Write a valid tool module
    const toolCode = `
      export const myTool = {
        name: 'my_custom_tool',
        description: 'A custom tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ content: 'done', isError: false }),
      }
    `
    await writeFile(join(dir, 'tools.mjs'), toolCode)

    const tools = await loadCustomTools('tools.mjs', undefined, dir)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('my_custom_tool')
  })

  it('loads specific named exports', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    const toolCode = `
      export const toolA = {
        name: 'tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object' },
        execute: async () => ({ content: 'a', isError: false }),
      }
      export const toolB = {
        name: 'tool_b',
        description: 'Tool B',
        inputSchema: { type: 'object' },
        execute: async () => ({ content: 'b', isError: false }),
      }
      export const notATool = 'just a string'
    `
    await writeFile(join(dir, 'tools.mjs'), toolCode)

    const tools = await loadCustomTools('tools.mjs', ['toolA'], dir)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('tool_a')
  })

  it('throws when named export not found', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    const toolCode = `export const toolA = { name: 'a', description: 'a', inputSchema: {type:'object'}, execute: async () => ({content:'',isError:false}) }`
    await writeFile(join(dir, 'tools.mjs'), toolCode)

    await expect(
      loadCustomTools('tools.mjs', ['nonExistent'], dir),
    ).rejects.toThrow('does not export "nonExistent"')
  })

  it('throws when named export is not a valid Tool', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    const toolCode = `export const badTool = { notAToolField: true }`
    await writeFile(join(dir, 'tools.mjs'), toolCode)

    await expect(
      loadCustomTools('tools.mjs', ['badTool'], dir),
    ).rejects.toThrow('not a valid Tool')
  })

  it('throws when no valid tools found in module', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    const toolCode = `export const x = 'not a tool'; export const y = 42;`
    await writeFile(join(dir, 'tools.mjs'), toolCode)

    await expect(
      loadCustomTools('tools.mjs', undefined, dir),
    ).rejects.toThrow('does not export any valid Tools')
  })

  it('error message includes the actual exports + helper-file hint', async () => {
    // This is the exact misconfig that shipped in trading-research's agent.json:
    // a helper file (`shared.ts` style) listed under `tools.custom`. The
    // message should name the exports the file DID provide and tell the
    // user they probably want to remove the entry, not fix the file.
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    const helperCode =
      `export function fetchWithRetry() {}\n` +
      `export function computeSMA() {}\n` +
      `export const SOME_CONST = 42;\n`
    await writeFile(join(dir, 'shared.mjs'), helperCode)

    await expect(
      loadCustomTools('shared.mjs', undefined, dir),
    ).rejects.toThrow(/fetchWithRetry.*computeSMA.*SOME_CONST/s)

    await expect(
      loadCustomTools('shared.mjs', undefined, dir),
    ).rejects.toThrow(/SHARED HELPER|remove it from the "tools.custom"/s)
  })

  it('error message reports "(none)" when the module exports literally nothing', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    // An empty module — no named exports, no default.
    await writeFile(join(dir, 'empty.mjs'), '// nothing here\n')

    await expect(
      loadCustomTools('empty.mjs', undefined, dir),
    ).rejects.toThrow(/File exports: \(none\)/)
  })
})

// ---------------------------------------------------------------------------
// Path traversal hardening (security audit 2026-05-06, item #1)
//
// Without these guards, an attacker-controlled `agent.json` field
// `tools.custom[].file` can name a path that resolves outside the profile
// directory; the dynamic `await import()` then runs that file with the
// gateway's full privileges.
// ---------------------------------------------------------------------------

describe('loadCustomTools: path traversal hardening', () => {
  it('rejects paths containing `..` segments anywhere', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    // Plant a bait file outside the profile dir to confirm we don't reach it.
    const outsideDir = mkdtempSync(join(tmpdir(), 'cortex-traversal-bait-'))
    try {
      await writeFile(
        join(outsideDir, 'pwned.mjs'),
        `throw new Error('PWNED — should never execute')`,
      )

      // Various `..` shapes — leading, trailing, embedded, mixed separators
      for (const path of [
        '../pwned.mjs',
        '../../pwned.mjs',
        'tools/../../pwned.mjs',
        'a/b/../../../pwned.mjs',
        '..\\pwned.mjs',          // Windows-style, must also be rejected
        'tools\\..\\..\\pwned.mjs',
      ]) {
        await expect(
          loadCustomTools(path, undefined, dir),
          `path ${JSON.stringify(path)} should be rejected`,
        ).rejects.toThrow(/parent traversal|stay inside the profile directory/i)
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects absolute paths (POSIX + Windows style)', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    // POSIX absolute. On Windows builds, isAbsolute() of "/etc/..." returns
    // false but "/" is still rejected as an absolute root by Node — covered
    // by the relative-only contract.
    await expect(
      loadCustomTools('/etc/passwd', undefined, dir),
    ).rejects.toThrow(/absolute paths are rejected|relative to the profile/i)

    // POSIX absolute with a real-looking JS extension
    await expect(
      loadCustomTools('/tmp/anywhere/x.mjs', undefined, dir),
    ).rejects.toThrow(/absolute paths are rejected|relative to the profile/i)
  })

  it('rejects symlinks pointing outside the profile directory', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    // Build a real target outside the profile dir with valid tool code —
    // if the symlink check ever regresses, the import will succeed and we
    // see the assertion failure rather than a confusing import error.
    const outsideDir = mkdtempSync(join(tmpdir(), 'cortex-symlink-bait-'))
    try {
      const realTarget = join(outsideDir, 'real-tool.mjs')
      await writeFile(
        realTarget,
        `export const sneaky = {
          name: 'sneaky',
          description: 'should be unreachable',
          inputSchema: { type: 'object' },
          execute: async () => ({ content: '', isError: false }),
        }`,
      )

      // Plant a symlink INSIDE the profile dir that points OUTSIDE.
      // Path passes phase-1 validation (no `..`, not absolute) but
      // realpath() resolution must catch the escape.
      const linkInProfile = join(dir, 'tools', 'looks-local.mjs')
      await mkdir(join(dir, 'tools'), { recursive: true })
      await symlink(realTarget, linkInProfile)

      await expect(
        loadCustomTools(`tools${sep}looks-local.mjs`, undefined, dir),
      ).rejects.toThrow(/outside the profile directory|symlink escape/i)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still loads ordinary in-tree paths after the new validation', async () => {
    // Regression guard. The fix must not break the happy path that the
    // built-in profiles use ("./tools/foo.mjs" style).
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    await mkdir(join(dir, 'tools'), { recursive: true })
    await writeFile(
      join(dir, 'tools', 'normal.mjs'),
      `export const normal = {
        name: 'normal_tool',
        description: 'In-tree, valid',
        inputSchema: { type: 'object' },
        execute: async () => ({ content: 'ok', isError: false }),
      }`,
    )

    // All three forms used in the wild should work.
    for (const path of ['tools/normal.mjs', './tools/normal.mjs']) {
      const tools = await loadCustomTools(path, undefined, dir)
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('normal_tool')
    }
  })

  it('error messages do not leak absolute filesystem paths', async () => {
    // Hygiene: the resolved absolute path is sensitive (reveals the user's
    // home directory layout, profile location, etc.). After the audit fix,
    // error strings must reference only the relativePath the caller passed.
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test' }),
    }))

    let captured: string | null = null
    try {
      await loadCustomTools('does-not-exist.mjs', undefined, dir)
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err)
    }

    expect(captured).not.toBeNull()
    // dir is the absolute profile path (e.g. /var/folders/.../cortex-test-...);
    // it must NOT appear in user-facing error strings.
    expect(captured).not.toContain(dir)
    // The relative path the caller supplied is fine to echo back.
    expect(captured).toContain('does-not-exist.mjs')
  })
})
