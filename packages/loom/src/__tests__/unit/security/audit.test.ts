/**
 * Unit Tests — Audit Log
 *
 * Tests recording, querying, export, and eviction.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { AuditLog } from '../../../security/audit.js'

describe('AuditLog', () => {
  let log: AuditLog

  beforeEach(() => {
    log = new AuditLog()
  })

  describe('record()', () => {
    it('records an entry', () => {
      log.log('shell.execute', { command: 'ls' }, 'allow')
      expect(log.count).toBe(1)
    })

    it('records multiple entries', () => {
      log.log('shell.execute', { command: 'ls' }, 'allow')
      log.log('readFile', { path: 'a.txt' }, 'allow')
      log.log('shell.execute', { command: 'rm -rf /' }, 'deny')
      expect(log.count).toBe(3)
    })

    it('includes timestamp', () => {
      log.log('shell.execute', { command: 'ls' }, 'allow')
      const entries = log.getLog()
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('eviction', () => {
    it('evicts oldest when over maxEntries', () => {
      const small = new AuditLog(3)
      small.log('t1', {}, 'allow')
      small.log('t2', {}, 'allow')
      small.log('t3', {}, 'allow')
      small.log('t4', {}, 'deny')
      expect(small.count).toBe(3)
      expect(small.getLog()[0].toolName).toBe('t2')
    })
  })

  describe('queries', () => {
    beforeEach(() => {
      log.log('shell.execute', { command: 'ls' }, 'allow')
      log.log('readFile', { path: 'a.txt' }, 'allow')
      log.log('shell.execute', { command: 'rm -rf /' }, 'deny', {
        validation: { level: 'blocked', reason: 'Fork bomb' },
      })
    })

    it('getByTool filters by tool name', () => {
      const shell = log.getByTool('shell.execute')
      expect(shell).toHaveLength(2)
    })

    it('getByDecision filters by decision', () => {
      const denied = log.getByDecision('deny')
      expect(denied).toHaveLength(1)
      expect(denied[0].toolName).toBe('shell.execute')
    })

    it('deniedCount returns correct count', () => {
      expect(log.deniedCount).toBe(1)
    })
  })

  describe('export', () => {
    it('exportLog returns valid JSON', () => {
      log.log('shell.execute', { command: 'ls' }, 'allow')
      const json = log.exportLog()
      const parsed = JSON.parse(json)
      expect(parsed.entryCount).toBe(1)
      expect(parsed.entries).toHaveLength(1)
      expect(parsed.exportedAt).toBeDefined()
    })

    it('exportSummary returns statistics', () => {
      log.log('shell.execute', {}, 'allow')
      log.log('shell.execute', {}, 'deny')
      log.log('readFile', {}, 'ask')

      const summary = log.exportSummary()
      expect(summary.total).toBe(3)
      expect(summary.allowed).toBe(1)
      expect(summary.denied).toBe(1)
      expect(summary.asked).toBe(1)
      expect(summary.byTool['shell.execute']).toBe(2)
      expect(summary.byTool['readFile']).toBe(1)
    })
  })

  describe('clear()', () => {
    it('removes all entries', () => {
      log.log('t1', {}, 'allow')
      log.log('t2', {}, 'deny')
      log.clear()
      expect(log.count).toBe(0)
      expect(log.getLog()).toEqual([])
    })
  })
})
