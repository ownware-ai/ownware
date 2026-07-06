/**
 * Unit Test — foundation-hardening I1: editFile must write atomically so a
 * crash / power loss / ENOSPC mid-write can't corrupt the user's file.
 *
 * Before (`filesystem.ts:893`): `await fs.writeFile(resolved, updated)` —
 * truncate-then-write in place. A failure between truncate and full write
 * leaves the file truncated or half-written, silently destroying the user's
 * source. After: write to a temp file in the same dir, fsync, then atomic
 * rename over the target (a NEW inode), preserving the original's mode.
 *
 * The crash itself can't be simulated in a unit test, but the atomic path has
 * an observable signature: a successful edit SWAPS THE INODE (rename), whereas
 * an in-place write keeps it. That distinguishes the fix from the old code.
 */

import { describe, it, expect, afterAll } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, readdirSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editFile } from '../../../src/tools/builtins/filesystem.js'
import type { ToolContext } from '../../../src/tools/types.js'
import type { LoomConfig } from '../../../src/core/config.js'

const DIR = mkdtempSync(join(tmpdir(), 'loom-editfile-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

function ctx(): ToolContext {
  return {
    cwd: DIR,
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: DIR,
    config: {} as LoomConfig,
    requestPermission: async () => true,
  } as unknown as ToolContext
}

describe('I1 — editFile writes atomically (temp + rename)', () => {
  it('updates content, swaps the inode, preserves mode, and leaves no temp residue', async () => {
    const file = join(DIR, 'script.sh')
    writeFileSync(file, '#!/bin/sh\necho OLD\n')
    chmodSync(file, 0o755)
    const inoBefore = statSync(file).ino

    const res = await editFile.execute(
      { file_path: 'script.sh', old_string: 'OLD', new_string: 'NEW' },
      ctx(),
    )
    expect((res as { isError?: boolean }).isError).toBeFalsy()

    // Content updated correctly (no regression).
    expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho NEW\n')

    // Inode CHANGED → the write went through a fresh temp file + rename, not an
    // in-place truncate. This is what isolates the atomic path: the old direct
    // fs.writeFile kept the same inode.
    expect(statSync(file).ino).not.toBe(inoBefore)

    // The executable bit survived the new-inode swap (mode preservation).
    expect(statSync(file).mode & 0o777).toBe(0o755)

    // No leftover `.script.sh.<id>.tmp` files.
    expect(readdirSync(DIR).some(n => n.includes('.tmp'))).toBe(false)
  })

  it('replace_all edits still land atomically with a fresh inode', async () => {
    const file = join(DIR, 'multi.txt')
    writeFileSync(file, 'x\nx\nx\n')
    const inoBefore = statSync(file).ino

    const res = await editFile.execute(
      { file_path: 'multi.txt', old_string: 'x', new_string: 'y', replace_all: true },
      ctx(),
    )
    expect((res as { isError?: boolean }).isError).toBeFalsy()
    expect(readFileSync(file, 'utf8')).toBe('y\ny\ny\n')
    expect(statSync(file).ino).not.toBe(inoBefore)
  })
})
