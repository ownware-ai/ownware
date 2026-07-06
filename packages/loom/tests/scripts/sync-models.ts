/**
 * sync-models.ts — Pull the latest model catalog from models.dev and bake it
 * into a committed JSON file shipped with Loom.
 *
 * Why a sync script (not a runtime fetch):
 *   1. Zero runtime network dependency. Loom must work offline.
 *   2. Reproducible builds — the same source tree always uses the same data.
 *   3. The committed JSON is human-reviewable in code review when prices move.
 *
 * Usage:
 *   bun run scripts/sync-models.ts
 *
 * Output:
 *   src/provider/models.dev.json — filtered to the providers Loom adapters
 *   actually call (anthropic, openai, google). Other providers in the upstream
 *   catalog are dropped to keep the bundle small (~90 KB instead of ~1.7 MB).
 *
 * The fetched data is validated against a Zod schema before write. If the
 * upstream schema drifts, the script fails loudly rather than corrupting the
 * shipped table.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schema — what we expect from models.dev/api.json
// ---------------------------------------------------------------------------
//
// Verified by inspection (Apr 2026). Only the fields Loom actually uses for
// pricing/capabilities are required; everything else is `passthrough()` so we
// keep extra fields (release_date, modalities, etc.) without breaking on
// schema additions upstream.

const ModalitySchema = z.object({
  input: z.array(z.string()),
  output: z.array(z.string()),
})

const CostSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    reasoning: z.number().optional(),
    input_audio: z.number().optional(),
    output_audio: z.number().optional(),
    // GPT-5.4-style tiered pricing (e.g. >200K input). Captured as `unknown`
    // because Loom's per-turn calc currently uses the base tier; future work
    // can branch on context size.
    context_over_200k: z.unknown().optional(),
  })
  .passthrough()

const LimitSchema = z
  .object({
    context: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
  })
  .passthrough()

const ModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    temperature: z.boolean().optional(),
    knowledge: z.string().optional(),
    release_date: z.string().optional(),
    last_updated: z.string().optional(),
    modalities: ModalitySchema.optional(),
    open_weights: z.boolean().optional(),
    cost: CostSchema.optional(),
    limit: LimitSchema.optional(),
  })
  .passthrough()

const ProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    doc: z.string().optional(),
    env: z.array(z.string()).optional(),
    npm: z.string().optional(),
    models: z.record(z.string(), ModelSchema),
  })
  .passthrough()

const CatalogSchema = z.record(z.string(), ProviderSchema)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_URL = 'https://models.dev/api.json'
const PROVIDERS_TO_KEEP = ['anthropic', 'openai', 'google'] as const
const OUTPUT_PATH = resolve(
  fileURLToPath(new URL('../src/provider/models.dev.json', import.meta.url)),
)

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Fetching ${SOURCE_URL}...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    throw new Error(`models.dev returned ${res.status} ${res.statusText}`)
  }
  const raw = await res.json()

  // Validate against schema — fails loudly if upstream drifted.
  const parsed = CatalogSchema.parse(raw)

  // Filter to providers Loom actually uses, then strip models with no cost data
  // (embeddings, image-generation, etc. that don't apply to text generation).
  const filtered: Record<string, unknown> = {}
  let totalModels = 0
  for (const providerId of PROVIDERS_TO_KEEP) {
    const provider = parsed[providerId]
    if (!provider) {
      throw new Error(`Provider "${providerId}" missing from upstream catalog`)
    }
    const usableModels: Record<string, unknown> = {}
    for (const [id, model] of Object.entries(provider.models)) {
      if (model.cost?.input != null && model.cost?.output != null) {
        usableModels[id] = model
      }
    }
    filtered[providerId] = {
      ...provider,
      models: usableModels,
    }
    totalModels += Object.keys(usableModels).length
    console.log(
      `  ${providerId}: ${Object.keys(usableModels).length} models with pricing ` +
      `(${Object.keys(provider.models).length} total in upstream)`,
    )
  }

  const output = {
    _generated_at: new Date().toISOString(),
    _source: SOURCE_URL,
    _license: 'MIT (see https://github.com/sst/models.dev)',
    providers: filtered,
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  console.log(`\nWrote ${totalModels} models to ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error('sync-models failed:', err)
  process.exit(1)
})
