import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ASSETS = ['models-dev.snapshot.json', 'MODELS_DEV_LICENSE.txt'] as const

await Promise.all(ASSETS.map(async (name) => {
  const source = resolve(ROOT, 'src/provider-hub/catalog', name)
  const destination = resolve(ROOT, 'dist/provider-hub/catalog', name)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}))
