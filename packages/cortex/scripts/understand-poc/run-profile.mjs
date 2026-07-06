#!/usr/bin/env bun
/**
 * run-profile.mjs — headless test harness for any cortex profile.
 *   bun run-profile.mjs <profile-name> "<prompt>" [model]
 * Loads + assembles the profile (incl. its custom tools) and drives the agent
 * loop with a real model, printing each tool call + the final text.
 */

import { loadProfile, assembleAgent } from '@ownware/cortex'
import { Loom } from '@ownware/loom'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const name = process.argv[2] || 'gatherer'
const prompt = process.argv[3] || 'Get to know me, then summarize who I am.'
const modelOverride = process.argv[4]
const dir = join(HERE, '..', '..', 'profiles', name)

const profile = await loadProfile(dir)
const assembled = await assembleAgent(profile)
const tools = Array.isArray(assembled.tools) ? assembled.tools : []
const model = modelOverride || assembled.config?.model || profile.config?.model
console.log(`\n=== ${name} · ${model} ===\ntools: ${tools.map(t => t.name).join(', ')}\n`)

const agent = Loom.create(model)
  .withSystemPrompt(assembled.soulMd ?? assembled.config?.systemPrompt ?? profile.soulMd ?? '')
  .withTools(tools)
  .withPermissionMode('auto')
  .withMaxTurns(30)
  .build()

let finalText = ''
const calls = []
for await (const e of agent.run(prompt)) {
  const t = e.type || ''
  if (t.includes('tool') && (e.tool?.name || e.name || e.toolName)) { const nm = e.tool?.name || e.name || e.toolName; if (t.includes('start') || t.includes('call')) { calls.push(nm); console.log(`  → ${nm}`) } }
  if (t === 'text.delta' || t === 'message.delta') finalText += (e.text ?? e.delta ?? '')
}
console.log(`\n=== tools called: ${calls.join(', ') || '(see trace)'} ===\n=== RESULT ===\n${finalText.trim()}\n`)
