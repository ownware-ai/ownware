/**
 * Model Router
 *
 * Parses model strings into provider + model ID pairs.
 * Supports explicit format ("anthropic:claude-sonnet-4-20250514"),
 * auto-detection from prefixes, and short aliases.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed model string result. */
export interface ParsedModel {
  readonly providerName: string
  readonly modelId: string
}

// ---------------------------------------------------------------------------
// Model aliases — short names for common models
// ---------------------------------------------------------------------------

const MODEL_ALIASES: Record<string, string> = {
  // Anthropic
  'sonnet': 'anthropic:claude-sonnet-4-20250514',
  'opus': 'anthropic:claude-opus-4-20250514',
  'haiku': 'anthropic:claude-haiku-4-5-20251001',
  'claude-sonnet': 'anthropic:claude-sonnet-4-20250514',
  'claude-opus': 'anthropic:claude-opus-4-20250514',
  'claude-haiku': 'anthropic:claude-haiku-4-5-20251001',
  // OpenAI
  'gpt4o': 'openai:gpt-4o',
  'gpt-4o': 'openai:gpt-4o',
  'gpt4o-mini': 'openai:gpt-4o-mini',
  'gpt-4o-mini': 'openai:gpt-4o-mini',
  'o3': 'openai:o3',
  'o3-mini': 'openai:o3-mini',
  'o4-mini': 'openai:o4-mini',
  // Google
  'gemini-pro': 'google:gemini-2.5-pro',
  'gemini-flash': 'google:gemini-2.5-flash',
  'gemini-2.5-pro': 'google:gemini-2.5-pro',
  'gemini-2.5-flash': 'google:gemini-2.5-flash',
}

// ---------------------------------------------------------------------------
// Prefix -> provider auto-detection
// ---------------------------------------------------------------------------

const PREFIX_RULES: Array<{ test: (model: string) => boolean; provider: string }> = [
  { test: m => m.startsWith('claude'), provider: 'anthropic' },
  { test: m => m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4'), provider: 'openai' },
  { test: m => m.startsWith('gemini'), provider: 'google' },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a model string into provider name and model ID.
 *
 * Supports three formats:
 * 1. Explicit: "anthropic:claude-sonnet-4-20250514" -> { anthropic, claude-sonnet-4-20250514 }
 * 2. Alias: "sonnet" -> { anthropic, claude-sonnet-4-20250514 }
 * 3. Auto-detect: "gpt-4o" -> { openai, gpt-4o }
 */
export function parseModelString(model: string): ParsedModel {
  // 1. Check aliases first
  const alias = MODEL_ALIASES[model]
  if (alias) {
    return parseExplicit(alias)
  }

  // 2. Explicit "provider:model" format
  const colonIndex = model.indexOf(':')
  if (colonIndex > 0) {
    return parseExplicit(model)
  }

  // 3. Auto-detect from model name prefix
  for (const rule of PREFIX_RULES) {
    if (rule.test(model)) {
      return { providerName: rule.provider, modelId: model }
    }
  }

  throw new Error(
    `Cannot determine provider for model "${model}". ` +
    `Use "provider:model" format (e.g., "anthropic:claude-sonnet-4-20250514") ` +
    `or a known alias: ${Object.keys(MODEL_ALIASES).join(', ')}`,
  )
}

/**
 * Resolve an alias to its full "provider:model" string.
 * Returns the input unchanged if not an alias.
 */
export function resolveAlias(model: string): string {
  return MODEL_ALIASES[model] ?? model
}

/**
 * List all registered model aliases.
 */
export function listAliases(): Record<string, string> {
  return { ...MODEL_ALIASES }
}

/**
 * Register a custom model alias at runtime.
 */
export function registerAlias(alias: string, fullModel: string): void {
  MODEL_ALIASES[alias] = fullModel
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function parseExplicit(model: string): ParsedModel {
  const colonIndex = model.indexOf(':')
  return {
    providerName: model.slice(0, colonIndex),
    modelId: model.slice(colonIndex + 1),
  }
}
