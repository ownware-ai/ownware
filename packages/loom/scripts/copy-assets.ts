/**
 * copy-assets.ts — Copy non-TS assets from src/ to dist/ after tsc build.
 *
 * The model fact snapshots: models.dev.json (anthropic/openai/google) and
 * openrouter-models.json (every OpenRouter model). tsc doesn't copy .json
 * files because `include` is restricted to *.ts; without this step the
 * compiled bundle would crash on first pricing lookup ("ENOENT: …json").
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
  {
    src: 'src/provider/openrouter-models.json',
    dest: 'dist/provider/openrouter-models.json',
  },
]

for (const { src, dest } of ASSETS) {
  const absSrc = resolve(ROOT, src)
  const absDest = resolve(ROOT, dest)
  mkdirSync(dirname(absDest), { recursive: true })
  copyFileSync(absSrc, absDest)
  console.log(`copied ${src} → ${dest}`)
}
