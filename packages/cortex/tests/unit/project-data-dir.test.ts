/**
 * The project-local `.ownware/` must never be committable: it holds
 * checkpoints, and checkpoints hold whole conversations (FINDINGS F11).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureProjectDataDir } from '../../src/project-data-dir.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ownware-projectdir-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ensureProjectDataDir', () => {
  it('creates .ownware/ with a .gitignore that hides the whole directory', () => {
    const dir = ensureProjectDataDir(root)
    expect(dir).toBe(join(root, '.ownware'))
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf-8')
    // A bare '*' also ignores the .gitignore itself, so git sees nothing
    // at all — the property that makes this independent of whatever the
    // customer has in their own .gitignore.
    expect(ignore.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))).toEqual(['*'])
  })

  it('is idempotent', () => {
    expect(ensureProjectDataDir(root)).toBe(ensureProjectDataDir(root))
    expect(existsSync(join(root, '.ownware', '.gitignore'))).toBe(true)
  })

  it('never overwrites a .gitignore the user has edited', () => {
    const dir = ensureProjectDataDir(root)
    writeFileSync(join(dir, '.gitignore'), 'mine\n')
    ensureProjectDataDir(root)
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('mine\n')
  })
})
