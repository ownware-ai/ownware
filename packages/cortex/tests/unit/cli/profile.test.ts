/**
 * `ownware profile` lifecycle — the pure helpers behind the noun group.
 *
 *   - scaffoldProfile creates ./profiles/<name>, honours overrides, refuses
 *     unsafe names (a name becomes a directory — traversal would escape it),
 *     and NEVER overwrites user edits.
 *   - setProfileFields mutates only the targeted keys, validates against the
 *     schema, and keeps the file minimal (no defaulted bloat).
 *   - removeProfile deletes only local profiles and refuses the unknown.
 *
 * All I/O is in per-test temp dirs — nothing touches the real ~/.ownware.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  scaffoldProfile,
  setProfileFields,
  removeProfile,
  profileInfo,
  assertValidName,
} from '../../../src/cli/profile.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-profile-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('scaffoldProfile', () => {
  it('creates ./profiles/<name> with agent.json + SOUL.md named after it', async () => {
    const r = scaffoldProfile(dir, 'sales')
    expect(r.name).toBe('sales')
    expect(r.created).toEqual(['agent.json', 'SOUL.md'])

    const agent = JSON.parse(await readFile(join(dir, 'profiles', 'sales', 'agent.json'), 'utf8'))
    expect(agent.name).toBe('sales')
    expect(agent.security.permissionMode).toBe('ask')

    const soul = await readFile(join(dir, 'profiles', 'sales', 'SOUL.md'), 'utf8')
    expect(soul).toContain('# Sales') // slug → title-cased heading
  })

  it('title-cases multi-word slugs in the SOUL heading', async () => {
    scaffoldProfile(dir, 'sales-bot')
    const soul = await readFile(join(dir, 'profiles', 'sales-bot', 'SOUL.md'), 'utf8')
    expect(soul).toContain('# Sales Bot')
  })

  it('honours --model / --description overrides', () => {
    scaffoldProfile(dir, 'ops', { model: 'openrouter:haiku-4.5', description: 'the ops bot' })
    const agent = readFileSync(join(dir, 'profiles', 'ops', 'agent.json'), 'utf8')
    expect(agent).toContain('openrouter:haiku-4.5')
    expect(agent).toContain('the ops bot')
  })

  it('refuses unsafe names (path traversal, separators, empty)', () => {
    expect(() => scaffoldProfile(dir, '../evil')).toThrow(/invalid profile name/)
    expect(() => scaffoldProfile(dir, 'a/b')).toThrow(/invalid profile name/)
    expect(() => scaffoldProfile(dir, '')).toThrow(/invalid profile name/)
  })

  it('never overwrites existing files (user edits are the point)', async () => {
    scaffoldProfile(dir, 'sales')
    const soulPath = join(dir, 'profiles', 'sales', 'SOUL.md')
    await writeFile(soulPath, '# Mine\n')

    const second = scaffoldProfile(dir, 'sales')
    expect(second.created).toEqual([])
    expect(second.skipped).toEqual(['agent.json', 'SOUL.md'])
    expect(await readFile(soulPath, 'utf8')).toBe('# Mine\n')
  })
})

describe('setProfileFields', () => {
  it('updates model + description and keeps the file minimal', async () => {
    scaffoldProfile(dir, 'sales')
    const changed = setProfileFields(dir, 'sales', {
      model: 'openai:gpt-4o',
      description: 'new desc',
    })
    expect(changed.sort()).toEqual(['description', 'model'])

    const agent = JSON.parse(await readFile(join(dir, 'profiles', 'sales', 'agent.json'), 'utf8'))
    expect(agent.model).toBe('openai:gpt-4o')
    expect(agent.description).toBe('new desc')
    // The scaffold never sets `execution`; validation must not have injected
    // schema defaults into the persisted file.
    expect(agent.execution).toBeUndefined()
  })

  it('throws for a profile that does not exist', () => {
    expect(() => setProfileFields(dir, 'ghost', { model: 'x' })).toThrow(/no editable profile/)
  })

  it('throws when there is nothing to set', () => {
    scaffoldProfile(dir, 'sales')
    expect(() => setProfileFields(dir, 'sales', {})).toThrow(/nothing to set/)
  })
})

describe('removeProfile', () => {
  it('deletes a local profile directory', () => {
    scaffoldProfile(dir, 'sales')
    const removed = removeProfile(dir, 'sales')
    expect(removed).toContain('sales')
    expect(existsSync(join(dir, 'profiles', 'sales'))).toBe(false)
  })

  it('throws for a profile that does not exist', () => {
    expect(() => removeProfile(dir, 'ghost')).toThrow(/no profile/)
  })
})

describe('profileInfo', () => {
  it('summarizes config highlights + which files exist', () => {
    scaffoldProfile(dir, 'sales')
    const info = profileInfo(join(dir, 'profiles', 'sales'))
    expect(info.name).toBe('sales')
    expect(info.model).toBeDefined()
    expect(info.files).toContain('agent.json')
    expect(info.files).toContain('SOUL.md')
  })
})

describe('assertValidName', () => {
  it('accepts simple names and rejects traversal/whitespace', () => {
    expect(() => assertValidName('sales-bot')).not.toThrow()
    expect(() => assertValidName('agent_2')).not.toThrow()
    expect(() => assertValidName('../x')).toThrow()
    expect(() => assertValidName('a b')).toThrow()
  })
})
