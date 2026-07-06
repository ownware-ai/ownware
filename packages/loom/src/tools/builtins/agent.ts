/**
 * Built-in Agent Spawn Tool
 *
 * Lets the model spawn sub-agents to handle complex tasks.
 * Wraps Loom's AgentSpawner to provide the model with delegation capabilities.
 *
 * This is engine-level — any agent type may need to delegate subtasks.
 * The actual agent definitions (explore, planner, verifier) are configured
 * per-profile in agent.json, not hard-coded here.
 *
 * Subagents spawned via this tool receive an enriched system prompt
 * that combines:
 *   1. A "you are a subagent" preamble telling the child it's not
 *      user-facing and the caller will relay its report.
 *   2. The profile-specific system prompt (the subagent's SOUL).
 *   3. An env footer with cwd, date, and (when available) platform /
 *      git branch so the subagent has the same situational awareness
 *      the parent had.
 *
 * Without that scaffolding a fresh subagent is told only "you are a
 * 'verifier' sub-agent" — and loses the env grounding the parent had.
 *
 * @see AgentSpawner in agents/spawner.ts for the underlying implementation.
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'
import {
  assembleSubagentSystemPrompt,
  defaultSubagentPreamble,
  subagentEnvFooter,
} from './subagent-prompt.js'

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const agentSpawn: Tool = defineTool({
  name: 'agent_spawn',
  description:
    'Launch a subagent (a subprocess with its own loop, tools, and system prompt) to handle a complex, independent, or context-heavy task.\n' +
    '\n' +
    '## When to use\n' +
    '- The work would flood your context with raw output you will not need again (broad searches, multi-file analysis).\n' +
    '- Genuinely independent subtasks that can run in parallel with what you are doing. Launch multiple in one response to parallelize.\n' +
    '- Specialized work where a focused system prompt and a restricted toolset produces better results than doing it in your general context.\n' +
    '- Adversarial verification: after non-trivial implementation work, spawn a verifier subagent (if the profile defines one) before reporting the task done.\n' +
    '\n' +
    '## When NOT to use\n' +
    '- A single-file read or a known-path lookup — call readFile / grep directly, it is faster and cheaper.\n' +
    '- Anything you can finish in 1–2 tool calls. The spawn overhead costs more than it saves.\n' +
    '- Work the user needs to watch happen in real time (edits they are reviewing turn-by-turn).\n' +
    '\n' +
    '## Writing the prompt\n' +
    'The subagent starts with zero context from this conversation. Brief it like a smart colleague who just walked into the room — it has not seen what you have seen, does not know what you already ruled out, and does not know why this task matters.\n' +
    '- State what you are trying to accomplish and why.\n' +
    '- Give the file paths, line numbers, and specifics the subagent needs — do not make it re-discover what you already know.\n' +
    '- Describe what you have already tried or ruled out so the subagent does not repeat it.\n' +
    '- If you need a short response, say so ("report in under 200 words").\n' +
    '- Never delegate understanding. Do not write "based on your findings, fix the bug" — that pushes synthesis onto the subagent instead of doing it yourself. Include the specific changes you want made, or ask a specific question.\n' +
    '\n' +
    'Terse, command-style prompts produce shallow, generic work. A clear briefing produces a useful report.\n' +
    '\n' +
    '## After the subagent returns\n' +
    'The subagent result is NOT visible to the user. Write a concise summary back to the user when relaying findings — do not just say "the subagent is done." If the work was verification, state PASS / FAIL / PARTIAL plus the load-bearing evidence.',
  category: 'agent',
  isReadOnly: true,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'conversational',
    summary: { verb: 'Delegated', primaryField: 'subagent_type' },
  },
  // Opt out of the tool-execution wall-clock timeout. A legitimate
  // sub-agent may chain multiple tools and run for many minutes; the
  // default 120s kill-switch would throw away work mid-flight and
  // return `isError: true` to the parent with no pointer to the (fully
  // streamed) partial transcript. Sub-agent runtime is already bounded
  // by the spec's `maxTurns` + the session's budget + parent abort
  // propagation via `context.signal`.
  disableTimeout: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Short name for this agent (3-5 words). Used for tracking and display.',
      },
      prompt: {
        type: 'string',
        description:
          'Complete, self-contained task description. The subagent cannot see your conversation — include all necessary context, file paths, constraints, and what you expect back.',
      },
      subagent_type: {
        type: 'string',
        description:
          'Which subagent profile to use (e.g., "explore", "planner", "verifier"). Available types depend on the current profile. Omit to use a general-purpose subagent.',
      },
      model: {
        type: 'string',
        description:
          'Model override. Use a faster model (e.g., haiku) for simple searches. Omit to inherit the current model or the subagent profile\'s default.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Tool names this agent can access. Omit to inherit from the subagent profile (or all available tools if no profile). Restrict to read-only tools for search/analysis tasks.',
      },
      background: {
        type: 'boolean',
        description:
          'Run in the background (true) or wait for result (false, default). Background agents return an ID immediately — you keep working while they run and check on them later. Do NOT background work whose result you need before your next action.',
      },
      max_turns: {
        type: 'number',
        description: 'Maximum turns the agent can take. Default: 20.',
      },
    },
    required: ['name', 'prompt'],
  },
  async execute(input, context) {
    const {
      name,
      prompt,
      subagent_type,
      model,
      tools,
      background = false,
      max_turns,
    } = input as {
      name: string
      prompt: string
      subagent_type?: string
      model?: string
      tools?: string[]
      background?: boolean
      max_turns?: number
    }

    // The spawner is injected at runtime via config.agentSpawner
    const configAny = context.config as Record<string, unknown>
    const spawner = configAny.agentSpawner as
      | { spawn: Function; waitForAgent: Function } | undefined

    if (!spawner) {
      return {
        content:
          'Agent spawning is not available in this session. ' +
          'Complete the task yourself or break it into smaller steps.',
        isError: true,
        metadata: { reason: 'no_spawner' },
      }
    }

    // Captured across try/catch so the catch branch can include the
    // sub-agent id in its error metadata — lets the parent (and the UI)
    // point at the streamed partial transcript instead of showing a
    // nameless failure card.
    let handle: { id: string } | null = null
    try {
      // Resolve sub-agent definition from profile config (if subagent_type specified)
      const subagentDefs = configAny.subagentDefs as
        Record<string, { model?: string; tools?: string[]; systemPrompt?: string; maxTurns?: number; persistentReminder?: string }> | undefined
      const def = subagent_type && subagentDefs ? subagentDefs[subagent_type] : undefined

      // Inherit the parent's workspace cwd so the sub-agent's env footer
      // matches the filesystem tool's boundary and the terminal's cwd.
      // `LoomConfig.workspacePath` is set by the gateway at session
      // creation; cast through `unknown` because the field is declared
      // on Loom config but the local cast above is to a generic record.
      const parentWorkspacePath = typeof configAny.workspacePath === 'string'
        ? configAny.workspacePath
        : undefined

      const systemPrompt = assembleSubagentSystemPrompt(
        def?.systemPrompt,
        subagent_type,
        parentWorkspacePath,
      )

      const spec = {
        name,
        systemPrompt,
        profileName: subagent_type,
        model: model ?? def?.model ?? undefined,
        tools: tools ?? def?.tools ?? undefined,
        maxTurns: max_turns ?? def?.maxTurns ?? 20,
        ...(def?.persistentReminder && def.persistentReminder.trim().length > 0
          ? { persistentReminder: def.persistentReminder }
          : {}),
      }

      // Seed the sub-agent's conversation with the task as the first user
      // message. Without this, the sub-agent loop would start with zero
      // messages and the provider would reject the API call ("messages: at
      // least one message is required"). The spec.systemPrompt handles the
      // role/identity; this user message is the actual task to work on.
      const initialMessages = [
        { role: 'user' as const, content: prompt },
      ]

      // No wall-clock timeout on spawn or wait: the sub-agent is bounded
      // by its own `maxTurns` guard + the session budget, and the parent
      // can still cancel via the AbortSignal threaded through context.
      // The previous 300_000ms internal timeouts silently killed
      // legitimate long sub-agents — the parent got a timeout error with
      // no pointer to the (still-running) helper.
      const spawned = await spawner.spawn(spec, 'isolated', initialMessages) as { id: string }
      handle = spawned

      if (background) {
        return {
          content:
            `Agent "${name}" launched in background (ID: ${spawned.id}).\n` +
            `It will work independently. You can continue with other tasks and retrieve the result later.`,
          isError: false,
          metadata: { agentId: spawned.id, status: 'launched', background: true },
        }
      }

      const result = await spawner.waitForAgent(spawned.id)

      return {
        content: result.content,
        isError: false,
        metadata: {
          agentId: spawned.id,
          turnCount: result.turnCount,
          usage: result.usage,
        },
      }
    } catch (e) {
      // Include `agentId` when we managed to spawn before the failure.
      // A client's sub-agent view keys on it to surface the streamed
      // transcript — without it, an error card has no "View thread →"
      // affordance and the user loses all visibility into the helper.
      return {
        content: `Agent "${name}" failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        metadata: {
          name,
          error: String(e),
          ...(handle ? { agentId: handle.id, transcriptAvailable: true } : {}),
        },
      }
    }
  },
})

export const agentTools: Tool[] = [agentSpawn]

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __test__ = {
  assembleSubagentSystemPrompt,
  defaultSubagentPreamble,
  subagentEnvFooter,
}
