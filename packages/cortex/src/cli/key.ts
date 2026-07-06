/**
 * `ownware key` — provider API keys into the credential vault from the
 * terminal.
 *
 *   ownware key add anthropic          # prompts (input hidden)
 *   ownware key add openai sk-…        # value inline (visible in shell history — prompted is better)
 *   ownware key list
 *   ownware key remove anthropic
 *
 * Writes go through the SAME store the gateway uses (`ownware.db`,
 * encrypted at rest, plaintext never logged) — a key added here is what
 * `ownware serve` boots with. A gateway that is ALREADY running re-reads
 * the vault on its next boot; keys saved through the HTTP API instead
 * re-register live.
 */

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { CortexDatabase } from '../gateway/db/database.js'
import { createCredentialStore } from '../credential/store/index.js'
import { LLM_PROVIDERS, llmProviderById } from '../gateway/llm-providers.js'

const PROVIDER_IDS = LLM_PROVIDERS.map((d) => d.providerId).join(' | ')

function usage(): never {
  throw new Error(
    `usage:\n  ownware key add <${PROVIDER_IDS}> [value]\n  ownware key list\n  ownware key remove <provider>`,
  )
}

/** Prompt on the tty with echo suppressed (the value never renders). */
async function promptSecret(question: string): Promise<string> {
  const muted = new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
  process.stdout.write(question)
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question('', (a) => resolvePromise(a))
  })
  rl.close()
  process.stdout.write('\n')
  return answer.trim()
}

export async function keyCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (sub !== 'add' && sub !== 'list' && sub !== 'remove') usage()

  const db = new CortexDatabase()
  try {
    const store = createCredentialStore(db.rawMainHandle)

    if (sub === 'list') {
      const rows = await store.list({ category: 'llm' })
      if (rows.length === 0) {
        console.log('(no provider keys saved — `ownware key add <provider>`)')
        return
      }
      for (const row of rows) {
        const provider =
          LLM_PROVIDERS.find((d) => d.variableName === row.variableName)?.providerId ??
          row.variableName ??
          '(unknown)'
        console.log(`  ${provider.padEnd(12)} ${String(row.hint ?? '').padEnd(14)} ${row.status}`)
      }
      return
    }

    const providerId = rest[0]
    const descriptor = providerId ? llmProviderById(providerId) : undefined
    if (!descriptor) {
      throw new Error(`unknown provider "${providerId ?? '(none)'}" — expected one of: ${PROVIDER_IDS}`)
    }

    const existingRows = await store.list({ category: 'llm' })
    const existing = existingRows.find((c) => c.variableName === descriptor.variableName)

    if (sub === 'remove') {
      if (!existing) {
        console.log(`no ${descriptor.providerId} key saved`)
        return
      }
      await store.delete(existing.id)
      console.log(`✓ removed ${descriptor.providerId} key`)
      return
    }

    // add — value from argv or hidden prompt.
    let value = rest[1]
    if (!value) {
      value = await promptSecret(`Paste your ${descriptor.name} (input hidden): `)
    }
    if (!value) throw new Error('add: empty value')

    if (existing) {
      // Rotate in place. A second `save` row would be invisible: the
      // store→loom bootstrap resolves by variableName in creation order,
      // so the OLD key would keep winning forever.
      await store.update(existing.id, { value })
      console.log(`✓ rotated ${descriptor.providerId} key`)
    } else {
      await store.save({
        name: descriptor.name,
        value,
        category: 'llm',
        authType: 'api-key',
        variableName: descriptor.variableName,
        source: 'manual',
      })
      console.log(`✓ saved ${descriptor.providerId} key (encrypted in ~/.ownware)`)
    }
    console.log('  A running `ownware serve` picks it up on its next start.')
  } finally {
    db.close()
  }
}
