/**
 * Unit Tests — ZoneRouter
 *
 * Tests zone-based routing, permission enforcement, and longest prefix match.
 */

import { describe, it, expect, vi } from 'vitest'
import { ZoneRouter } from '../../../backend/zone-router.js'
import { BackendError } from '../../../backend/types.js'
import type { BackendProtocol, Zone } from '../../../backend/types.js'

// ---------------------------------------------------------------------------
// Mock backend factory
// ---------------------------------------------------------------------------

function mockBackend(name: string): BackendProtocol {
  return {
    readFile: vi.fn().mockResolvedValue(`content from ${name}`),
    writeFile: vi.fn().mockResolvedValue(undefined),
    editFile: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn().mockResolvedValue([]),
    glob: vi.fn().mockResolvedValue([]),
    grep: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  }
}

describe('ZoneRouter', () => {
  // -----------------------------------------------------------------------
  // Basic routing
  // -----------------------------------------------------------------------

  describe('basic routing', () => {
    it('routes to root zone for unmatched paths', async () => {
      const root = mockBackend('root')
      const router = new ZoneRouter([{ path: '/', permission: 'rw', backend: root }])

      await router.readFile('/some/file.txt')
      expect(root.readFile).toHaveBeenCalled()
    })

    it('routes to specific zone by prefix', async () => {
      const root = mockBackend('root')
      const memory = mockBackend('memory')
      const router = new ZoneRouter([
        { path: '/', permission: 'rw', backend: root },
        { path: '/memory', permission: 'ro', backend: memory },
      ])

      await router.readFile('/memory/AGENTS.md')
      expect(memory.readFile).toHaveBeenCalled()
      expect(root.readFile).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Longest prefix match
  // -----------------------------------------------------------------------

  describe('longest prefix match', () => {
    it('prefers longer prefix', async () => {
      const root = mockBackend('root')
      const data = mockBackend('data')
      const dataDeep = mockBackend('data-deep')

      const router = new ZoneRouter([
        { path: '/', permission: 'rw', backend: root },
        { path: '/data', permission: 'rw', backend: data },
        { path: '/data/archive', permission: 'ro', backend: dataDeep },
      ])

      await router.readFile('/data/archive/old.txt')
      expect(dataDeep.readFile).toHaveBeenCalled()
      expect(data.readFile).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Permission enforcement
  // -----------------------------------------------------------------------

  describe('permission enforcement', () => {
    it('allows writes to rw zones', async () => {
      const backend = mockBackend('rw')
      const router = new ZoneRouter([{ path: '/', permission: 'rw', backend }])

      await expect(router.writeFile('/file.txt', 'content')).resolves.toBeUndefined()
    })

    it('denies writes to ro zones', async () => {
      const backend = mockBackend('ro')
      const router = new ZoneRouter([{ path: '/', permission: 'ro', backend }])

      await expect(router.writeFile('/file.txt', 'content'))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('denies editFile on ro zones', async () => {
      const backend = mockBackend('ro')
      const router = new ZoneRouter([{ path: '/', permission: 'ro', backend }])

      await expect(router.editFile('/file.txt', 'old', 'new'))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('allows reads from ro zones', async () => {
      const backend = mockBackend('ro')
      const router = new ZoneRouter([{ path: '/', permission: 'ro', backend }])

      await expect(router.readFile('/file.txt')).resolves.toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Path remapping
  // -----------------------------------------------------------------------

  describe('path remapping', () => {
    it('strips zone prefix from delegated path', async () => {
      const memory = mockBackend('memory')
      const router = new ZoneRouter([
        { path: '/', permission: 'rw', backend: mockBackend('root') },
        { path: '/memory', permission: 'ro', backend: memory },
      ])

      await router.readFile('/memory/session/notes.md')
      expect(memory.readFile).toHaveBeenCalledWith('/session/notes.md', undefined)
    })
  })

  // -----------------------------------------------------------------------
  // findZone
  // -----------------------------------------------------------------------

  describe('findZone()', () => {
    it('returns matching zone', () => {
      const root = mockBackend('root')
      const router = new ZoneRouter([{ path: '/', permission: 'rw', backend: root }])

      const zone = router.findZone('/any/path')
      expect(zone).toBeDefined()
      expect(zone!.path).toBe('/')
    })

    it('returns undefined for no match when no root zone', () => {
      const router = new ZoneRouter([{ path: '/specific', permission: 'rw', backend: mockBackend('s') }])

      const zone = router.findZone('/other/path')
      expect(zone).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // getZones
  // -----------------------------------------------------------------------

  describe('getZones()', () => {
    it('returns all configured zones', () => {
      const zones: Zone[] = [
        { path: '/', permission: 'rw', backend: mockBackend('root') },
        { path: '/memory', permission: 'ro', backend: mockBackend('mem') },
      ]
      const router = new ZoneRouter(zones)
      expect(router.getZones()).toHaveLength(2)
    })
  })
})
