import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGatewayTaskPackDirs } from '../../../src/gateway/server.js'

describe('gateway task-pack process options', () => {
  it('resolves repeatable directories, preserves order and removes exact duplicates', () => {
    expect(parseGatewayTaskPackDirs([
      '--profiles', './profiles',
      '--task-pack', './documents',
      '--task-pack', './research',
      '--task-pack', './documents',
    ])).toEqual([resolve('./documents'), resolve('./research')])
  })

  it('rejects a missing directory value', () => {
    expect(() => parseGatewayTaskPackDirs(['--task-pack']))
      .toThrow('--task-pack requires a directory.')
    expect(() => parseGatewayTaskPackDirs(['--task-pack', '--no-auth']))
      .toThrow('--task-pack requires a directory.')
  })
})
