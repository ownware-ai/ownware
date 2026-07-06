/**
 * copy-assets.ts — Copy non-TS assets from src/ to dist/ after tsc build.
 *
 * Currently just the models.dev catalog snapshot. tsc doesn't copy .json
 * files because `include` is restricted to *.ts; without this step the
 * compiled bundle would crash on first pricing lookup ("ENOENT: models.dev.json").
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const ASSETS: ReadonlyArray<{ src: string; dest: string }> = [
  {
    src: 'src/provider/models.dev.json',
    dest: 'dist/provider/models.dev.json',
  },
]

for (const { src, dest } of ASSETS) {
  const absSrc = resolve(ROOT, src)
  const absDest = resolve(ROOT, dest)
  mkdirSync(dirname(absDest), { recursive: true })
  copyFileSync(absSrc, absDest)
  console.log(`copied ${src} → ${dest}`)
}
