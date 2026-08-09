export type RunModelPreferenceSource = 'request' | 'thread' | 'install' | 'profile'

export interface RunModelPreferenceInput {
  readonly requestModel?: string | null
  readonly threadModel?: string | null
  readonly installDefaultModel?: string | null
  readonly profileDefaultModel: string
}

export interface RunModelPreference {
  readonly model: string
  readonly source: RunModelPreferenceSource
}

/**
 * Resolve the configured model authority for one run.
 *
 * Blank higher-precedence values never hide a lower-precedence choice. This
 * function establishes configuration precedence only; runtime compatibility,
 * adapter presence and provider acceptance are separate dispatch checks.
 */
export function resolveRunModelPreference(
  input: RunModelPreferenceInput,
): RunModelPreference {
  const choices: ReadonlyArray<readonly [
    RunModelPreferenceSource,
    string | null | undefined,
  ]> = [
    ['request', input.requestModel],
    ['thread', input.threadModel],
    ['install', input.installDefaultModel],
    ['profile', input.profileDefaultModel],
  ]

  for (const [source, value] of choices) {
    const model = cleanModel(value)
    if (model != null) return { model, source }
  }

  throw new TypeError('Profile default model must not be blank')
}

function cleanModel(value: string | null | undefined): string | null {
  const cleaned = value?.trim()
  return cleaned == null || cleaned.length === 0 ? null : cleaned
}
