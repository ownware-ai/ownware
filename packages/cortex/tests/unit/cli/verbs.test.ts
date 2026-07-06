/**
 * `ownware` CLI verbs (F2) — the pure parts.
 *
 *   - `initProfile` scaffolds ./profiles/assistant and NEVER overwrites
 *     user edits (the files are the product; clobbering them is data loss).
 *   - `parseServeFlags` accepts exactly the documented flags and rejects
 *     typos loudly (a silently-ignored --hots would bind the wrong host).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { initProfile } from '../../../src/cli/init.js'
import { parseServeFlags } from '../../../src/cli/serve.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-cli-verbs-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('initProfile', () => {
  it('scaffolds profiles/assistant with agent.json + SOUL.md', async () => {
    const result = initProfile(dir)
    expect(result.created).toEqual(['agent.json', 'SOUL.md'])
    expect(result.skipped).toEqual([])

    const agent = JSON.parse(await readFile(join(dir, 'profiles', 'assistant', 'agent.json'), 'utf8'))
    expect(agent.name).toBe('assistant')
    expect(agent.security.permissionMode).toBe('ask')
    const soul = await readFile(join(dir, 'profiles', 'assistant', 'SOUL.md'), 'utf8')
    expect(soul).toContain('# Assistant')
  })

  it('never overwrites existing files (user edits are the point)', async () => {
    initProfile(dir)
    const soulPath = join(dir, 'profiles', 'assistant', 'SOUL.md')
    await writeFile(soulPath, '# Mine\n')

    const second = initProfile(dir)
    expect(second.created).toEqual([])
    expect(second.skipped).toEqual(['agent.json', 'SOUL.md'])
    expect(await readFile(soulPath, 'utf8')).toBe('# Mine\n')
  })
})

describe('parseServeFlags', () => {
  it('parses the documented flags', () => {
    const flags = parseServeFlags(['--port', '4100', '--host', '0.0.0.0', '--tls'])
    expect(flags.port).toBe(4100)
    expect(flags.host).toBe('0.0.0.0')
    expect(flags.tls).toBe(true)
  })

  it('parses --no-tls', () => {
    expect(parseServeFlags(['--no-tls']).tls).toBe(false)
  })

  it('rejects an unknown flag loudly', () => {
    expect(() => parseServeFlags(['--hots', '0.0.0.0'])).toThrow(/unknown flag/)
  })

  it('rejects a non-numeric port', () => {
    expect(() => parseServeFlags(['--port', 'abc'])).toThrow(/invalid --port/)
  })
})
