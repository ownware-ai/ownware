import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createModelsDevArtifact,
  modelsDevArtifactText,
  transformModelsDevArtifact,
} from '../src/provider-hub/models-dev.js'

const DEFAULT_SOURCE_URL = 'https://models.dev/api.json'
const MAX_PAYLOAD_BYTES = 32 * 1_024 * 1_024
const DEFAULT_OUTPUT = resolve(
  fileURLToPath(new URL('../src/provider-hub/catalog/models-dev.snapshot.json', import.meta.url)),
)

interface Arguments {
  readonly input?: string
  readonly output: string
  readonly sourceUrl: string
  readonly generatedAt: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const text = args.input == null
    ? await fetchSource(args.sourceUrl)
    : await readFile(args.input, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`Catalog source exceeds the ${MAX_PAYLOAD_BYTES}-byte safety limit`)
  }
  const artifact = createModelsDevArtifact(JSON.parse(text) as unknown, {
    generatedAt: args.generatedAt,
    sourceUrl: args.sourceUrl,
  })
  const snapshot = transformModelsDevArtifact(artifact, { source: 'bundled' })
  await writeAtomically(args.output, modelsDevArtifactText(artifact))
  const routes = Object.values(artifact.providers).reduce(
    (total, provider) => total + Object.keys(provider.models).length,
    0,
  )
  console.log(
    `Wrote ${Object.keys(artifact.providers).length} providers / ${routes} routes to ${args.output}`,
  )
  console.log(`sha256 ${artifact.sha256}`)
  console.log(`${snapshot.routes.length} exact provider routes / ${snapshot.prices.length} price entries`)
}

function parseArgs(argv: readonly string[]): Arguments {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index < 0 ? undefined : argv[index + 1]
  }
  return {
    input: read('--input'),
    output: resolve(read('--output') ?? DEFAULT_OUTPUT),
    sourceUrl: read('--source-url') ?? DEFAULT_SOURCE_URL,
    generatedAt: read('--generated-at') ?? new Date().toISOString(),
  }
}

async function fetchSource(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'Ownware-Provider-Hub/1' },
  })
  if (!response.ok) throw new Error(`Catalog upstream returned ${response.status} ${response.statusText}`)
  const declared = response.headers.get('content-length')
  if (declared != null && Number(declared) > MAX_PAYLOAD_BYTES) {
    throw new Error(`Catalog source exceeds the ${MAX_PAYLOAD_BYTES}-byte safety limit`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`Catalog source exceeds the ${MAX_PAYLOAD_BYTES}-byte safety limit`)
  }
  return text
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
