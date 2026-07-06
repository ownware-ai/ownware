/**
 * Drift test: CORTEX_VERSION must match package.json's `version`
 * field. Catches "bumped package.json but forgot to bump version.ts".
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORTEX_VERSION } from '../../src/version.js'

function findPackageJson(): { name: string; version: string } {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    try {
      const raw = readFileSync(resolve(dir, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown }
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        return { name: pkg.name, version: pkg.version }
      }
    } catch {
      // not at the package root yet
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('package.json not found when walking up from version.test.ts')
}

describe('CORTEX_VERSION', () => {
  it('matches the version field in @ownware/cortex package.json', () => {
    const pkg = findPackageJson()
    expect(pkg.name).toBe('@ownware/cortex')
    expect(CORTEX_VERSION).toBe(pkg.version)
  })
})
