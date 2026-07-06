/**
 * `pickRunnableDefaultModel` — the gateway-side keyless pick (F1).
 *
 * Contract under test:
 *   1. A provider registered in Loom's registry (env key OR vault
 *      bootstrap — both land there) wins, via its catalog default.
 *   2. With no cloud provider, a reachable Ollama's first INSTALLED
 *      model wins (the catalog can't know what the user pulled).
 *   3. With nothing available → null (callers fall through to the
 *      provider's actionable error — never a guess).
 *   4. The always-registered `ollama` registry entry does NOT count as
 *      a cloud provider (it's keyless; reachability is what matters).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { listProviders, registerProvider, unregisterProvider } from '@ownware/loom'
import type { ProviderAdapter } from '@ownware/loom'
import { pickRunnableDefaultModel } from '../../../src/gateway/catalog/models/index.js'

function fakeAdapter(name: string): ProviderAdapter {
  return { name } as unknown as ProviderAdapter
}

beforeEach(() => {
  // Loom registers providers at import time from the ambient env (and
  // `ollama` always). Empty the registry so each case is explicit.
  for (const name of listProviders()) unregisterProvider(name)
})

describe('pickRunnableDefaultModel', () => {
  it('returns null when no provider is registered and no Ollama answers', async () => {
    const result = await pickRunnableDefaultModel({ probe: async () => null })
    expect(result).toBeNull()
  })

  it('falls back to the first installed Ollama model when only Ollama is reachable', async () => {
    const result = await pickRunnableDefaultModel({ probe: async () => ['llama3.2:latest', 'qwen3'] })
    expect(result).toBe('ollama:llama3.2:latest')
  })

  it('prefers a registered cloud provider (vault or env key) over Ollama', async () => {
    registerProvider(fakeAdapter('openai'))
    let probed = false
    const result = await pickRunnableDefaultModel({
      probe: async () => {
        probed = true
        return ['llama3.2']
      },
    })
    expect(result).toBe('openai:gpt-5.5') // the openai catalog default
    expect(probed).toBe(false) // no network probe when a key exists
  })

  it('ignores the always-registered ollama registry entry as a cloud provider', async () => {
    registerProvider(fakeAdapter('ollama'))
    const result = await pickRunnableDefaultModel({ probe: async () => null })
    expect(result).toBeNull()
  })

  it('returns the catalog default for whichever provider is registered', async () => {
    registerProvider(fakeAdapter('anthropic'))
    const result = await pickRunnableDefaultModel({ probe: async () => null })
    expect(result).toBe('anthropic:claude-sonnet-4-6')
  })
})
