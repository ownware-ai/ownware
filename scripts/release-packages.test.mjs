import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  discoverPublicPackagePaths,
  PUBLISH_ORDER,
  publishTagForVersion,
} from './release-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('publish order contains every public workspace package exactly once', () => {
  assert.deepEqual(
    [...PUBLISH_ORDER].sort(),
    discoverPublicPackagePaths(root),
  )
  assert.equal(new Set(PUBLISH_ORDER).size, PUBLISH_ORDER.length)
})

test('publish order is topological for internal runtime dependencies', () => {
  const manifests = PUBLISH_ORDER.map((relativePath) => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, relativePath, 'package.json'), 'utf8'),
    )
    return { relativePath, manifest }
  })
  const positionByName = new Map(
    manifests.map(({ manifest }, index) => [manifest.name, index]),
  )

  for (const [index, { relativePath, manifest }] of manifests.entries()) {
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]

    for (const dependencyName of dependencyNames) {
      const dependencyPosition = positionByName.get(dependencyName)
      if (dependencyPosition === undefined) continue
      assert.ok(
        dependencyPosition < index,
        `${relativePath} must publish after ${dependencyName}`,
      )
    }
  }
})

test('prereleases use next while stable versions use latest', () => {
  assert.equal(publishTagForVersion('0.4.0'), 'latest')
  assert.equal(publishTagForVersion('0.4.0-beta.0'), 'next')
  assert.equal(publishTagForVersion('1.0.0-rc.2'), 'next')
})
