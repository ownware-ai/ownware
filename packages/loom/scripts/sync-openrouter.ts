/**
 * sync-openrouter.ts — Pull the live OpenRouter model catalog and bake it into
 * a committed JSON file shipped with Loom.
 *
 * Why a separate source from models.dev:
 *   models.dev has NO `openrouter` provider — it only catalogs direct providers
 *   (anthropic / openai / google / etc.). OpenRouter's own API is the only
 *   authoritative, always-fresh source for what OpenRouter actually charges and
 *   the context/output limits it enforces. Third-party aggregators (LiteLLM,
 *   models.dev) lag and go stale; the vendor's own API never does. So OpenRouter
 *   facts come straight from OpenRouter.
 *
 * Why a sync script (not a runtime fetch) — same reasons as sync-models.ts:
 *   1. Zero runtime network dependency. Loom must work offline.
 *   2. Reproducible builds — the same source tree always uses the same data.
 *   3. The committed JSON is human-reviewable in code review when prices move.
 *
 * Usage:
 *   bun run scripts/sync-openrouter.ts
 *
 * Output:
 *   src/provider/openrouter-models.json — every OpenRouter model with pricing,
 *   normalized to the same conventions as models.dev.json: cost in USD per
 *   MILLION tokens (so it plugs into the existing pricing.ts pipeline), context
 *   window and max-output as plain numbers, and a compact capability flag set
 *   derived faithfully from OpenRouter's `supported_parameters` + modalities.
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
// Schema — what we expect from openrouter.ai/api/v1/models
// ---------------------------------------------------------------------------
//
// Verified against the live response (Jun 2026). Pricing values are STRINGS in
// USD-per-token. Only the fields we consume are constrained; everything else is
// `passthrough()` so upstream additions don't break the sync.

const PricingSchema = z
  .object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  })
  .passthrough()

const ArchitectureSchema = z
  .object({
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  })
  .passthrough()

const TopProviderSchema = z
  .object({
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
  })
  .passthrough()

const ModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    created: z.number().optional(),
    context_length: z.number().nullable().optional(),
    architecture: ArchitectureSchema.optional(),
    pricing: PricingSchema,
    top_provider: TopProviderSchema.optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough()

const ResponseSchema = z.object({
  data: z.array(ModelSchema),
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_URL = 'https://openrouter.ai/api/v1/models'
const OUTPUT_PATH = resolve(
  fileURLToPath(new URL('../src/provider/openrouter-models.json', import.meta.url)),
)

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OpenRouter per-token price string to USD per million tokens,
 * matching the models.dev `cost.input` convention so both catalogs feed the
 * same pricing math. Returns null for absent prices. A literal "0" (free
 * models) is preserved as 0 — that's a real price, not "unknown".
 */
function perTokenToPerMillion(price: string | undefined): number | null {
  if (price == null) return null
  const perToken = Number.parseFloat(price)
  if (Number.isNaN(perToken)) return null
  // Round to 8 significant decimals of the per-million value to strip
  // float-multiplication noise (0.000000435 * 1e6 = 0.43499999999…).
  return Number((perToken * 1_000_000).toFixed(8))
}

interface NormalizedCapabilities {
  readonly tools: boolean
  readonly reasoning: boolean
  readonly structured: boolean
  readonly vision: boolean
  readonly pdf: boolean
}

function deriveCapabilities(model: z.infer<typeof ModelSchema>): NormalizedCapabilities {
  const params = new Set(model.supported_parameters ?? [])
  const inputModalities = new Set(model.architecture?.input_modalities ?? [])
  return {
    tools: params.has('tools') || params.has('tool_choice'),
    reasoning: params.has('reasoning') || params.has('include_reasoning'),
    structured: params.has('structured_outputs') || params.has('response_format'),
    vision: inputModalities.has('image'),
    pdf: inputModalities.has('file') || inputModalities.has('pdf'),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Fetching ${SOURCE_URL}...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    throw new Error(`OpenRouter returned ${res.status} ${res.statusText}`)
  }
  const raw = await res.json()

  // Validate against schema — fails loudly if upstream drifted.
  const parsed = ResponseSchema.parse(raw)

  const models: Record<string, unknown> = {}
  let kept = 0
  let skipped = 0

  for (const model of parsed.data) {
    const input = perTokenToPerMillion(model.pricing.prompt)
    const output = perTokenToPerMillion(model.pricing.completion)
    // A text-generation model we can price needs both rates. Skip anything
    // without them (embeddings, moderation, malformed entries) — same policy
    // as sync-models.ts dropping cost-less models.
    if (input == null || output == null) {
      skipped += 1
      continue
    }

    const contextWindow = model.top_provider?.context_length ?? model.context_length ?? null
    const maxOutput = model.top_provider?.max_completion_tokens ?? null

    models[model.id] = {
      id: model.id,
      name: model.name,
      created: model.created ?? null,
      context_length: contextWindow,
      max_output_tokens: maxOutput,
      cost: {
        input,
        output,
        cache_read: perTokenToPerMillion(model.pricing.input_cache_read),
        cache_write: perTokenToPerMillion(model.pricing.input_cache_write),
      },
      capabilities: deriveCapabilities(model),
    }
    kept += 1
  }

  if (kept === 0) {
    throw new Error('OpenRouter sync produced 0 priced models — refusing to write an empty catalog')
  }

  const output = {
    _generated_at: new Date().toISOString(),
    _source: SOURCE_URL,
    _license: 'OpenRouter public model catalog (https://openrouter.ai/docs/api-reference/list-available-models)',
    _note: 'cost is USD per MILLION tokens (models.dev convention); cache_read/write null when not priced',
    _count: kept,
    models,
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  console.log(`\nWrote ${kept} priced models to ${OUTPUT_PATH} (skipped ${skipped} without pricing)`)
}

main().catch((err) => {
  console.error('sync-openrouter failed:', err)
  process.exit(1)
})
