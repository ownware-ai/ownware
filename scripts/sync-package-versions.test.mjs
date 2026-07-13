import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const syncScript = join(repoRoot, 'scripts', 'sync-package-versions.mjs')

test('release versioning synchronizes bundle-safe constants with package manifests', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ownware-release-version-'))

  try {
    for (const packageName of ['loom', 'cortex']) {
      const packageRoot = join(fixtureRoot, 'packages', packageName)
      mkdirSync(join(packageRoot, 'src'), { recursive: true })
      writeFileSync(
        join(packageRoot, 'package.json'),
        `${JSON.stringify({ name: `@ownware/${packageName}`, version: '0.2.0' }, null, 2)}\n`,
      )
    }
    writeFileSync(join(fixtureRoot, 'packages/loom/src/version.ts'), "export const VERSION = '0.1.0'\n")
    writeFileSync(
      join(fixtureRoot, 'packages/cortex/src/version.ts'),
      "export const CORTEX_VERSION = '0.1.0'\n",
    )

    execFileSync(process.execPath, [syncScript, '--root', fixtureRoot], { stdio: 'pipe' })

    assert.equal(
      readFileSync(join(fixtureRoot, 'packages/loom/src/version.ts'), 'utf8'),
      "export const VERSION = '0.2.0'\n",
    )
    assert.equal(
      readFileSync(join(fixtureRoot, 'packages/cortex/src/version.ts'), 'utf8'),
      "export const CORTEX_VERSION = '0.2.0'\n",
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
