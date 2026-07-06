#!/usr/bin/env npx tsx
/**
 * Cortex Integration Example
 *
 * Shows exactly how Cortex uses Loom as its engine:
 *   1. Load profile configuration
 *   2. Assemble tools from multiple sources
 *   3. Set up security with enterprise rules
 *   4. Create session with checkpoint store
 *   5. Run with full event routing
 *   6. Checkpoint and resume
 *
 * This is the REFERENCE IMPLEMENTATION for Cortex → Loom integration.
 *
 * Usage:
 *   npx tsx examples/cortex-integration.ts "Read package.json and explain this project"
 */

import {
  Session,
  createDefaultConfig,
  mergeConfig,
  PermissionEvaluator,
  HumanInTheLoop,
  MemoryCheckpointStore,
  builtinTools,
  defineTool,
  CODING_AGENT_RULES,
  AuditLog,
  type LoomEvent,
  type LoomConfig,
  type Tool,
} from '../src/index.js'
import { resolveProvider } from '../src/provider/registry.js'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  magenta: '\x1b[35m',
}

const prompt = process.argv.slice(2).join(' ')
if (!prompt) {
  console.log(`${C.bold}Cortex Integration Example${C.reset}`)
  console.log(`Usage: npx tsx examples/cortex-integration.ts "your task"`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 1: Simulate profile loading
// ---------------------------------------------------------------------------

console.log(`${C.dim}[ownware]${C.reset} Loading profile: ${C.cyan}default${C.reset}`)

const profileConfig = {
  name: 'cortex-default',
  model: 'anthropic:claude-sonnet-4-20250514',
  systemPrompt:
    'You are Cortex, an AI assistant built on the Loom runtime. ' +
    'You have access to filesystem and shell tools. ' +
    'Be helpful, precise, and safe.',
  maxTurns: 30,
  maxTokens: 16_384,
}

// ---------------------------------------------------------------------------
// Step 2: Assemble tools from multiple sources
// ---------------------------------------------------------------------------

// Built-in tools
const tools: Tool[] = [...builtinTools]

// Custom domain tool (simulating MCP or plugin tools)
const projectInfo: Tool = defineTool({
  name: 'project.info',
  description: 'Get metadata about the current project (name, version, dependencies).',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    return {
      content: JSON.stringify({
        name: '@ownware/loom',
        version: '0.1.0',
        description: 'Agent Operating System Runtime',
        toolCount: tools.length,
      }, null, 2),
      isError: false,
    }
  },
})
tools.push(projectInfo)

console.log(`${C.dim}[ownware]${C.reset} Tools loaded: ${tools.map(t => t.name).join(', ')}`)

// ---------------------------------------------------------------------------
// Step 3: Security — evaluator + HITL
// ---------------------------------------------------------------------------

const evaluator = new PermissionEvaluator({
  safetyRules: CODING_AGENT_RULES,
  rules: [
    { pattern: 'readFile', decision: 'allow' },
    { pattern: 'listFiles', decision: 'allow' },
    { pattern: 'glob', decision: 'allow' },
    { pattern: 'grep', decision: 'allow' },
    { pattern: 'project.*', decision: 'allow' },
    { pattern: 'shell.*', decision: 'ask' },
    { pattern: 'writeFile', decision: 'ask' },
    { pattern: 'editFile', decision: 'ask' },
  ],
})

const hitl = new HumanInTheLoop({ timeoutMs: 30_000 })
// Auto-approve for this demo (in production, this would show a UI prompt)
hitl.onApprovalNeeded((req) => {
  console.log(`${C.magenta}[security]${C.reset} Auto-approving: ${req.toolCall.name}`)
  hitl.respond(req.requestId, true)
})

const auditLog = new AuditLog()

console.log(`${C.dim}[ownware]${C.reset} Security: CODING_AGENT_RULES + custom policy`)

// ---------------------------------------------------------------------------
// Step 4: Create session with checkpoint store
// ---------------------------------------------------------------------------

const checkpointStore = new MemoryCheckpointStore()

const { provider } = resolveProvider(profileConfig.model)
const config = mergeConfig(createDefaultConfig(profileConfig.model), {
  systemPrompt: profileConfig.systemPrompt,
  maxTurns: profileConfig.maxTurns,
  maxTokens: profileConfig.maxTokens,
  checkpointStore,
})

const session = new Session({
  config,
  provider,
  tools,
  checkpoint: checkpointStore,
})

console.log(`${C.dim}[ownware]${C.reset} Session: ${session.sessionId.slice(0, 8)}...`)
console.log(`${C.dim}[ownware]${C.reset} Checkpoint: MemoryCheckpointStore`)
console.log()

// Handle Ctrl+C
process.on('SIGINT', () => {
  session.abort()
  hitl.dispose()
  console.log(`\n${C.dim}Aborted.${C.reset}`)
  process.exit(130)
})

// ---------------------------------------------------------------------------
// Step 5: Run with full event routing
// ---------------------------------------------------------------------------

console.log(`${C.bold}Running:${C.reset} ${prompt}\n`)

const gen = session.submitMessage(prompt)
let result = await gen.next()

while (!result.done) {
  const event: LoomEvent = result.value
  routeEvent(event)
  result = await gen.next()
}

const loopResult = result.value

// ---------------------------------------------------------------------------
// Step 6: Show checkpoint info
// ---------------------------------------------------------------------------

const checkpoints = await checkpointStore.list()
if (checkpoints.length > 0) {
  console.log(`\n${C.dim}[checkpoint]${C.reset} ${checkpoints.length} checkpoint(s) saved`)
  console.log(`${C.dim}[checkpoint]${C.reset} Latest: ${checkpoints[0]!.sessionId.slice(0, 8)}... at ${new Date(checkpoints[0]!.timestamp).toISOString()}`)
}

// Audit summary
console.log(`\n${C.dim}[audit]${C.reset} ${auditLog.entries.length} entries logged`)

// Usage
console.log(`\n${C.dim}─────────────────────────────────────────${C.reset}`)
console.log(`${C.dim}Model: ${profileConfig.model}${C.reset}`)
console.log(`${C.dim}Tokens: ${loopResult.totalUsage.inputTokens.toLocaleString()} in / ${loopResult.totalUsage.outputTokens.toLocaleString()} out${C.reset}`)
console.log(`${C.dim}Turns: ${loopResult.turnCount} | Reason: ${loopResult.reason}${C.reset}`)

hitl.dispose()

// ---------------------------------------------------------------------------
// Event router — how Cortex maps LoomEvents to its UI
// ---------------------------------------------------------------------------

function routeEvent(event: LoomEvent): void {
  switch (event.type) {
    // Text → stream to console
    case 'text.delta':
      process.stdout.write(event.text)
      break

    // Tool calls → formatted log
    case 'tool.call.start':
      console.log(`\n${C.cyan}[${event.toolName}]${C.reset} ${abbreviate(JSON.stringify(event.input), 80)}`)
      auditLog.record({
        toolName: event.toolName,
        decision: 'started',
        timestamp: Date.now(),
      })
      break

    case 'tool.call.end':
      if (event.isError) {
        console.log(`  ${C.red}error:${C.reset} ${abbreviate(event.result, 120)}`)
      } else {
        console.log(`  ${C.green}done${C.reset} ${C.dim}(${event.durationMs}ms)${C.reset}`)
      }
      auditLog.record({
        toolName: event.toolName,
        decision: event.isError ? 'error' : 'completed',
        durationMs: event.durationMs,
        timestamp: Date.now(),
      })
      break

    // Security → warnings
    case 'security.block':
      console.log(`\n${C.red}[BLOCKED]${C.reset} ${event.reason}`)
      break

    // Permissions → log
    case 'permission.request':
      console.log(`${C.magenta}[permission]${C.reset} Requesting approval: ${event.toolName}`)
      break

    // Checkpoint → confirmation
    case 'checkpoint.saved':
      console.log(`${C.dim}[checkpoint] Saved: ${event.checkpointId.slice(0, 8)}...${C.reset}`)
      break

    // Compaction → info
    case 'compaction.start':
      console.log(`${C.yellow}[compaction]${C.reset} ${event.strategy} (${event.preTokenCount} tokens)`)
      break

    case 'compaction.end':
      console.log(`${C.yellow}[compaction]${C.reset} Reduced: ${event.preTokenCount} → ${event.postTokenCount} tokens`)
      break

    // Recovery → warning
    case 'recovery':
      console.log(`${C.yellow}[recovery]${C.reset} ${event.reason}: ${event.detail}`)
      break

    // Errors → stderr
    case 'error':
      console.error(`${C.red}[error]${C.reset} ${event.code}: ${event.message}`)
      break
  }
}

function abbreviate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...'
}
