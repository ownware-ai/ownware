import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLocalHelperDir } from '../../../src/profile/local-helpers.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('local helper containment', () => {
  it('resolves a real helper inside the parent profile', async () => {
    const parent = await temp('ownware-helper-parent-')
    const helper = join(parent, 'helpers', 'researcher')
    await mkdir(helper, { recursive: true })
    await writeFile(join(helper, 'agent.json'), JSON.stringify({ name: 'researcher' }))

    await expect(resolveLocalHelperDir(parent, 'researcher')).resolves.toBe(helper)
  })

  it('rejects a helper directory symlink whose real target is outside the parent profile', async () => {
    const parent = await temp('ownware-helper-parent-')
    const outside = await temp('ownware-helper-outside-')
    await mkdir(join(parent, 'helpers'), { recursive: true })
    await writeFile(join(outside, 'agent.json'), JSON.stringify({ name: 'outside' }))
    await symlink(outside, join(parent, 'helpers', 'researcher'))

    await expect(resolveLocalHelperDir(parent, 'researcher')).rejects.toThrow(
      /inside the profile directory|symlink/i,
    )
  })
})
