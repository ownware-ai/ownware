/**
 * Unit tests for the understanding store — race-free per-writer slice files
 * merged at read time (chunk 3, slice 3b foundation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeUnderstandingSlice,
  readUnderstanding,
  understandingSlicesDir,
} from '../../../src/profile/understanding-store.js'

let base: string
const ROOT = 'root-session-abc123'

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'understanding-test-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('understanding-store', () => {
  it('returns null before anything is written', () => {
    expect(readUnderstanding(base, ROOT)).toBeNull()
  })

  it('writes a slice and reads it back', () => {
    writeUnderstandingSlice(base, ROOT, 'apps', { usage: [{ app: 'Linear', count: 880 }] })
    const got = readUnderstanding(base, ROOT)
    expect(got?.usage).toEqual([{ app: 'Linear', count: 880 }])
  })

  it('merges multiple writers (each owns its own file — race-free)', () => {
    writeUnderstandingSlice(base, ROOT, 'browser', { usage: [{ app: 'GitHub', count: 4626 }], sources: [{ label: 'browser', detail: '4,626 pages' }] })
    writeUnderstandingSlice(base, ROOT, 'dev', { usage: [{ app: 'VS Code', count: 1200 }], suggestedConnectors: ['github'] })
    writeUnderstandingSlice(base, ROOT, 'judgment', { summary: 'Solo founder.', voice: 'Direct.' })
    const got = readUnderstanding(base, ROOT)
    expect(got?.usage).toEqual([
      { app: 'GitHub', count: 4626 },
      { app: 'VS Code', count: 1200 },
    ])
    expect(got?.summary).toBe('Solo founder.')
    expect(got?.suggestedConnectors).toEqual(['github'])
  })

  it('judgment merges LAST so its scalars win regardless of write order', () => {
    // Write judgment FIRST, a scan SECOND — read order must still apply judgment last.
    writeUnderstandingSlice(base, ROOT, 'judgment', { summary: 'Final judgment.' })
    writeUnderstandingSlice(base, ROOT, 'apps', { usage: [{ app: 'Figma', count: 210 }] })
    const got = readUnderstanding(base, ROOT)
    expect(got?.summary).toBe('Final judgment.')
    expect(got?.usage).toEqual([{ app: 'Figma', count: 210 }])
  })

  it('re-writing the same writer overwrites only its slice', () => {
    writeUnderstandingSlice(base, ROOT, 'apps', { usage: [{ app: 'Linear', count: 1 }] })
    writeUnderstandingSlice(base, ROOT, 'apps', { usage: [{ app: 'Linear', count: 880 }] })
    const got = readUnderstanding(base, ROOT)
    expect(got?.usage).toEqual([{ app: 'Linear', count: 880 }])
  })

  it('isolates sessions by rootSessionId', () => {
    writeUnderstandingSlice(base, 'session-A', 'apps', { usage: [{ app: 'A', count: 1 }] })
    writeUnderstandingSlice(base, 'session-B', 'apps', { usage: [{ app: 'B', count: 2 }] })
    expect(readUnderstanding(base, 'session-A')?.usage).toEqual([{ app: 'A', count: 1 }])
    expect(readUnderstanding(base, 'session-B')?.usage).toEqual([{ app: 'B', count: 2 }])
  })

  it('sanitizes a path-unsafe rootSessionId (no traversal)', () => {
    const evil = '../../etc/passwd'
    writeUnderstandingSlice(base, evil, 'apps', { usage: [{ app: 'X', count: 1 }] })
    expect(understandingSlicesDir(base, evil).startsWith(base)).toBe(true)
    expect(readUnderstanding(base, evil)?.usage).toEqual([{ app: 'X', count: 1 }])
  })

  it('skips a corrupt slice file but still merges the rest', () => {
    writeUnderstandingSlice(base, ROOT, 'good', { usage: [{ app: 'Good', count: 5 }] })
    const dir = understandingSlicesDir(base, ROOT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bad.json'), '{ not valid json ')
    const got = readUnderstanding(base, ROOT)
    expect(got?.usage).toEqual([{ app: 'Good', count: 5 }])
  })
})
