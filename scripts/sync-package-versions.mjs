#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootFlag = process.argv.indexOf('--root')
const root = rootFlag === -1
  ? scriptRoot
  : resolve(process.argv[rootFlag + 1] ?? fail('Missing value after --root'))

const targets = [
  {
    packageFile: 'packages/loom/package.json',
    sourceFile: 'packages/loom/src/version.ts',
    constant: 'VERSION',
  },
  {
    packageFile: 'packages/cortex/package.json',
    sourceFile: 'packages/cortex/src/version.ts',
    constant: 'CORTEX_VERSION',
  },
]

for (const target of targets) {
  const manifestPath = resolve(root, target.packageFile)
  const sourcePath = resolve(root, target.sourceFile)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version = manifest.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Invalid version in ${target.packageFile}`)
  }

  const source = readFileSync(sourcePath, 'utf8')
  const pattern = new RegExp(`(export const ${target.constant} = )(['"])[^'"]+\\2`)
  const matches = source.match(new RegExp(pattern.source, 'g')) ?? []
  if (matches.length !== 1) {
    fail(`Expected exactly one ${target.constant} declaration in ${target.sourceFile}`)
  }

  const updated = source.replace(pattern, `$1'${version}'`)
  if (updated !== source) writeFileSync(sourcePath, updated)
  console.log(`${target.sourceFile} -> ${version}`)
}

function fail(message) {
  throw new Error(message)
}
