import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Public npm packages in dependency order. A package may only depend on
 * entries that occur before it. The dependency-free, first-publish UI package
 * leads the order so a scope-ownership failure happens before an existing
 * package version is changed.
 */
export const PUBLISH_ORDER = [
  'packages/ui',
  'packages/loom',
  'packages/client',
  'packages/react',
  'adapters/shuttle',
  'packages/cortex',
  'packages/ownware',
  'packages/cli',
]

/**
 * Prerelease versions must never become npm's default install accidentally.
 */
export function publishTagForVersion(version) {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version) ? 'next' : 'latest'
}

export function discoverPublicPackagePaths(root) {
  const packagePaths = []

  for (const parent of ['packages', 'adapters']) {
    const parentPath = resolve(root, parent)
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const relativePath = `${parent}/${entry.name}`
      const manifestPath = resolve(root, relativePath, 'package.json')
      if (!existsSync(manifestPath)) continue

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.private !== true) packagePaths.push(relativePath)
    }
  }

  return packagePaths.sort()
}
