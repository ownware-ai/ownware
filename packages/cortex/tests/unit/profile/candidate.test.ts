import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProfileCandidate } from '../../../src/profile/candidate.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ownware-candidate-'))
  dirs.push(dir)
  return dir
}

describe('profile candidate validation', () => {
  it('gives identical bytes the same opaque identity regardless of creation order', async () => {
    const a = await temp()
    const b = await temp()
    await mkdir(join(a, 'skills'), { recursive: true })
    await writeFile(join(a, 'agent.json'), JSON.stringify({ name: 'portable' }))
    await writeFile(join(a, 'skills', 'one.md'), '---\nname: one\n---\nOne')

    await mkdir(join(b, 'skills'), { recursive: true })
    await writeFile(join(b, 'skills', 'one.md'), '---\nname: one\n---\nOne')
    await writeFile(join(b, 'agent.json'), JSON.stringify({ name: 'portable' }))

    const first = await validateProfileCandidate({ profileDir: a, allowCustomCode: true })
    const second = await validateProfileCandidate({ profileDir: b, allowCustomCode: true })
    expect(first).toMatchObject({ valid: true, findings: [], profileName: 'portable' })
    expect(first.candidateId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(second.candidateId).toBe(first.candidateId)
  })

  it('changes identity when one candidate byte changes', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'agent.json'), JSON.stringify({ name: 'portable' }))
    const before = await validateProfileCandidate({ profileDir: dir, allowCustomCode: true })
    await writeFile(join(dir, 'SOUL.md'), 'Changed')
    const after = await validateProfileCandidate({ profileDir: dir, allowCustomCode: true })
    expect(after.candidateId).not.toBe(before.candidateId)
  })

  it('returns safe findings and no identity for an escaping symlink', async () => {
    const dir = await temp()
    const outside = await temp()
    await writeFile(join(dir, 'agent.json'), JSON.stringify({ name: 'portable' }))
    await writeFile(join(outside, 'secret'), 'PRIVATE_CANDIDATE_CANARY')
    await symlink(join(outside, 'secret'), join(dir, 'escape'))

    const result = await validateProfileCandidate({ profileDir: dir, allowCustomCode: true })
    expect(result).toMatchObject({
      valid: false,
      candidateId: null,
      findings: [{ code: 'path_escape', severity: 'error' }],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(dir)
    expect(serialized).not.toContain(outside)
    expect(serialized).not.toContain('PRIVATE_CANDIDATE_CANARY')
  })

  it('does not expose host paths when profile parsing fails', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'agent.json'), '{ not json }')

    const result = await validateProfileCandidate({ profileDir: dir, allowCustomCode: true })
    expect(result).toMatchObject({
      valid: false,
      candidateId: null,
      findings: [{ code: 'profile_invalid', severity: 'error' }],
    })
    expect(JSON.stringify(result)).not.toContain(dir)
  })
})
