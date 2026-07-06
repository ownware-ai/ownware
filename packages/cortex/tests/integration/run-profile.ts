#!/usr/bin/env npx tsx
/**
 * Cortex Runner — Load a profile and run it on Loom
 *
 * Usage:
 *   npx tsx packages/cortex/run.ts "Fix the bug in src/index.ts"
 *   npx tsx packages/cortex/run.ts --profile coder "Add tests"
 *   npx tsx packages/cortex/run.ts --profile researcher "Find all TODOs"
 */

import { resolve } from 'node:path'
import { loadProfile } from './src/profile/loader.js'
import { assembleAgent } from './src/profile/assembler.js'

// Parse args
const args = process.argv.slice(2)
let profileName = 'coder'
let prompt = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' || args[i] === '-p') {
    profileName = args[i + 1] ?? 'coder'
    i++
  } else if (!args[i]!.startsWith('-')) {
    prompt = args[i]!
  }
}

if (!prompt) {
  console.error('Usage: npx tsx packages/cortex/run.ts [--profile <name>] "<prompt>"')
  process.exit(1)
}

async function main() {
  // 1. Load profile
  const profileDir = resolve(import.meta.dirname, 'profiles', profileName)
  console.log(`\x1b[2mLoading profile: ${profileName}\x1b[0m`)

  let profile
  try {
    profile = await loadProfile(profileDir)
  } catch (e) {
    console.error(`\x1b[31mFailed to load profile "${profileName}": ${e instanceof Error ? e.message : e}\x1b[0m`)
    process.exit(1)
  }

  // 2. Assemble agent (profile → LoomConfig + tools)
  console.log(`\x1b[2mAssembling agent: ${profile.config.name} (${profile.config.model})\x1b[0m`)

  let assembled
  try {
    assembled = await assembleAgent(profile)
  } catch (e) {
    console.error(`\x1b[31mFailed to assemble agent: ${e instanceof Error ? e.message : e}\x1b[0m`)
    process.exit(1)
  }

  console.log(`\x1b[2mTools: ${assembled.tools.map(t => t.name).join(', ')}\x1b[0m`)
  console.log('')

  // 3. Create Loom session and run
  const { Session } = await import('@ownware/loom')

  const session = new Session({
    config: assembled.config,
    provider: assembled.provider,
    tools: assembled.tools,
  })

  // 4. Stream events
  for await (const event of session.submitMessage(prompt)) {
    switch (event.type) {
      case 'text.delta':
        process.stdout.write(event.text)
        break
      case 'tool.call.start':
        console.log(`\n\x1b[36m[tool]\x1b[0m ${event.toolName}()`)
        break
      case 'tool.call.end':
        console.log(`\x1b[32m[done]\x1b[0m ${event.toolName} \x1b[2m(${event.durationMs}ms)\x1b[0m`)
        break
      case 'permission.request':
        console.log(`\x1b[33m[permission]\x1b[0m ${event.toolName}: ${event.reason}`)
        break
      case 'security.block':
        console.log(`\x1b[31m[blocked]\x1b[0m ${event.reason}`)
        break
      case 'error':
        console.error(`\x1b[31m[error]\x1b[0m ${event.message}`)
        break
      case 'turn.end':
        // Show usage after each turn
        break
    }
  }

  console.log('')
  console.log(`\x1b[2mProfile: ${profileName} | Model: ${profile.config.model}\x1b[0m`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
