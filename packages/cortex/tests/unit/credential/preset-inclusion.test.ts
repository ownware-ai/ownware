/**
 * Unit tests — `request_credential` is present in every non-`none` preset.
 *
 * Regression guard. Without this, a profile that uses `preset: 'coding'`
 * (the common case for dev agents) would silently be unable to ask the
 * user for a credential, defeating the whole isolation flow. The bug
 * caught during Phase F review is specifically that the coding + readonly
 * presets originally skipped `credentialTools`.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

async function toolNamesFor(preset: 'full' | 'coding' | 'readonly' | 'none'): Promise<string[]> {
  const { dir, cleanup } = await createMinimalProfile({ tools: { preset } })
  cleanups.push(cleanup)
  const profile = await loadProfile(dir)
  const assembled = await assembleAgent(profile)
  return assembled.tools.map(t => t.name)
}

describe('preset includes request_credential', () => {
  it('`full` preset includes request_credential (via builtinTools)', async () => {
    const names = await toolNamesFor('full')
    expect(names).toContain('request_credential')
  })

  it('`coding` preset includes request_credential', async () => {
    const names = await toolNamesFor('coding')
    expect(names).toContain('request_credential')
    // Sanity: the preset still has its core coding tools.
    expect(names).toContain('readFile')
    expect(names).toContain('shell_execute')
  })

  it('`readonly` preset EXCLUDES request_credential (preset invariant: all read-only)', async () => {
    // readonly's contract is "every tool is isReadOnly:true for safe
    // parallel execution". request_credential is a streaming HITL
    // tool (isReadOnly:false) so it doesn't belong in this preset.
    // Profiles that need credential prompting should use 'coding' or
    // 'full'.
    const names = await toolNamesFor('readonly')
    expect(names).not.toContain('request_credential')
    expect(names).toContain('readFile')
    expect(names).toContain('glob')
    expect(names).not.toContain('writeFile')
    expect(names).not.toContain('editFile')
  })

  it('`none` preset has zero tools (including no request_credential)', async () => {
    const names = await toolNamesFor('none')
    expect(names).toEqual([])
  })
})
