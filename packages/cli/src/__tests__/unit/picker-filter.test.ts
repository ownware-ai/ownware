import { describe, expect, it } from 'vitest'
import { filterItems, fuzzyScore } from '../../tui/picker.js'

const MODELS = [
  { id: 'anthropic:claude-sonnet-4-6', label: 'anthropic:claude-sonnet-4-6' },
  { id: 'anthropic:claude-haiku-4-5', label: 'anthropic:claude-haiku-4-5' },
  { id: 'openai:gpt-5.5', label: 'openai:gpt-5.5' },
  { id: 'ollama:llama3.2', label: 'ollama:llama3.2', muted: true },
]

describe('fuzzyScore', () => {
  it('matches subsequences, rejects non-matches, empty matches all', () => {
    expect(fuzzyScore('snt', 'sonnet')).not.toBeNull()
    expect(fuzzyScore('xyz', 'sonnet')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('prefers contiguous and prefix matches', () => {
    const contiguous = fuzzyScore('son', 'sonnet')!
    const scattered = fuzzyScore('son', 'silicon-moon')!
    expect(contiguous).toBeGreaterThan(scattered)
  })
})

describe('filterItems', () => {
  it('filters and ranks, muted items last', () => {
    const all = filterItems(MODELS, '')
    expect(all).toHaveLength(4)
    expect(all[all.length - 1]!.id).toBe('ollama:llama3.2') // muted sinks

    const sonnets = filterItems(MODELS, 'sonnet')
    expect(sonnets[0]!.id).toBe('anthropic:claude-sonnet-4-6')

    expect(filterItems(MODELS, 'gpt')[0]!.id).toBe('openai:gpt-5.5')
    expect(filterItems(MODELS, 'zzz')).toHaveLength(0)
  })
})
