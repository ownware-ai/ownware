/**
 * Built-in Orchestrate Tool
 *
 * One model-facing surface for multi-agent orchestration. The model picks a
 * `shape` and supplies the worker tasks; the tool routes to the right pattern:
 *
 *   • fan-out    — run every task in parallel, return all results.
 *   • pipeline   — run tasks in order, threading each output into the next.
 *   • map-reduce — fan-out the tasks, then a `reducer` merges them into one.
 *
 * One tool, a `shape` parameter — NOT three separate tools (Loom's input-
 * polymorphism idiom + the single-tool-surface principle). It drives the SAME
 * injected `AgentSpawner` that `agent_spawn` uses, so per-worker events stream
 * through the gateway's onEvent hook for free (the fan-out tree's live feed).
 *
 * The coordinator helpers in agents/coordinator.ts remain the SDK-level API
 * (code-facing); this is the tool-level API (model-facing).
 */

import { defineTool } from '../types.js'
import type { Tool, ToolContext } from '../types.js'
import { assembleSubagentSystemPrompt } from './subagent-prompt.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Shape = 'fan-out' | 'pipeline' | 'map-reduce'

interface TaskInput {
  readonly name: string
  readonly prompt: string
  readonly subagent_type?: string
  readonly model?: string
  readonly max_turns?: number
  /**
   * Optional JSON Schema. When set, the worker is instructed to return a
   * single JSON object matching it; the result is parsed + validated (one
   * retry on malformed output) so callers get clean, uniform data instead
   * of free-form prose.
   */
  readonly output_schema?: Record<string, unknown>
}

interface OrchestrateInput {
  readonly shape: Shape
  readonly tasks: readonly TaskInput[]
  readonly reducer?: TaskInput
}

interface SpawnedResult {
  readonly content: string
  readonly turnCount: number
  readonly usage: unknown
}

/** Minimal shape of the injected AgentSpawner the tool relies on. */
interface InjectedSpawner {
  spawn(spec: unknown, mode: string, messages: unknown[]): Promise<{ id: string }>
  waitForAgent(id: string): Promise<SpawnedResult>
}

type SubagentDefs = Record<
  string,
  { model?: string; tools?: string[]; systemPrompt?: string; maxTurns?: number; persistentReminder?: string }
> | undefined

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the AgentSpec for one worker — same shape agent_spawn uses. */
function buildSpec(task: TaskInput, defs: SubagentDefs, workspacePath: string | undefined) {
  const def = task.subagent_type && defs ? defs[task.subagent_type] : undefined
  return {
    name: task.name,
    profileName: task.subagent_type,
    systemPrompt: assembleSubagentSystemPrompt(def?.systemPrompt, task.subagent_type, workspacePath),
    model: task.model ?? def?.model ?? undefined,
    tools: def?.tools ?? undefined,
    maxTurns: task.max_turns ?? def?.maxTurns ?? 10,
    ...(def?.persistentReminder && def.persistentReminder.trim().length > 0
      ? { persistentReminder: def.persistentReminder }
      : {}),
  }
}

interface WorkerResult {
  readonly ok: boolean
  readonly content: string
  /** Present only when the task declared `output_schema` and parsing succeeded. */
  readonly structured?: unknown
}

/** Append the JSON-only instruction for a structured-output worker. */
function structuredInstruction(schema: Record<string, unknown>): string {
  return (
    '\n\n---\n' +
    'Return your final answer as a SINGLE JSON object that conforms to this JSON Schema. ' +
    'Output ONLY the JSON object — no prose, no markdown code fences, nothing before or after it.\n\n' +
    'Schema:\n' +
    JSON.stringify(schema, null, 2)
  )
}

/** Extract a JSON object from worker output, tolerating fences and stray prose. */
function parseStructured(content: string): { ok: boolean; value?: unknown } {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const body = fenced ? fenced[1]! : trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) }
  } catch {
    return { ok: false }
  }
}

/** Top-level `required` keys from the schema that are absent on the value. */
function missingRequired(schema: Record<string, unknown>, value: unknown): string[] {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  if (required.length === 0) return []
  if (typeof value !== 'object' || value === null) return required
  return required.filter(k => !(k in (value as Record<string, unknown>)))
}

/**
 * Run one worker to completion. Never throws — failures become a labeled result.
 *
 * When `outputSchema` is set, the worker must return a JSON object matching it.
 * Malformed output gets one retry with a sharper instruction; if it still fails,
 * the result is marked `ok: false` and the raw content is returned for triage.
 */
async function runWorker(
  spawner: InjectedSpawner,
  spec: unknown,
  userMessage: string,
  outputSchema?: Record<string, unknown>,
): Promise<WorkerResult> {
  if (!outputSchema) {
    try {
      const handle = await spawner.spawn(spec, 'isolated', [{ role: 'user', content: userMessage }])
      const result = await spawner.waitForAgent(handle.id)
      return { ok: true, content: result.content }
    } catch (e) {
      return { ok: false, content: `[failed: ${e instanceof Error ? e.message : String(e)}]` }
    }
  }

  let lastContent = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const message =
      userMessage +
      structuredInstruction(outputSchema) +
      (attempt === 0 ? '' : '\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object, nothing else.')
    try {
      const handle = await spawner.spawn(spec, 'isolated', [{ role: 'user', content: message }])
      const result = await spawner.waitForAgent(handle.id)
      lastContent = result.content
      const parsed = parseStructured(result.content)
      if (parsed.ok && missingRequired(outputSchema, parsed.value).length === 0) {
        return { ok: true, content: JSON.stringify(parsed.value), structured: parsed.value }
      }
    } catch (e) {
      return { ok: false, content: `[failed: ${e instanceof Error ? e.message : String(e)}]` }
    }
  }
  return { ok: false, content: lastContent || '[no valid structured output]' }
}

function labeled(name: string, content: string): string {
  return `--- ${name} ---\n${content}`
}

/** Per-worker structured payload for the tool's metadata (null when absent/failed). */
function resultsMeta(tasks: readonly TaskInput[], mapped: readonly WorkerResult[]) {
  return mapped.map((r, i) => ({
    name: tasks[i]!.name,
    ok: r.ok,
    structured: r.structured ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const orchestrate: Tool = defineTool({
  name: 'orchestrate',
  description:
    'Run multiple sub-agents in a chosen shape and get the combined result. ' +
    'shape="fan-out": run all tasks in parallel (independent work — research, ' +
    'multi-file reads, broad search). shape="pipeline": run tasks in order, ' +
    'feeding each output into the next (dependent steps — research → draft → ' +
    'verify). shape="map-reduce": fan-out the tasks, then a reducer merges them ' +
    'into a single answer (wide work that must end as ONE result). Prefer this ' +
    'over many separate agent_spawn calls when the work is genuinely parallel or ' +
    'staged. Each task runs in its own fresh context with its own model.',
  category: 'agent',
  isReadOnly: true,
  requiresPermission: false,
  disableTimeout: true,
  uiDescriptor: {
    kind: 'conversational',
    summary: { verb: 'Orchestrated', primaryField: 'shape' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      shape: {
        type: 'string',
        enum: ['fan-out', 'pipeline', 'map-reduce'],
        description:
          'fan-out = parallel independent tasks; pipeline = ordered, output→input; map-reduce = parallel tasks then a reducer merges them.',
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short label for this worker (3-5 words).' },
            prompt: { type: 'string', description: 'The complete task for this worker. It starts with zero prior context.' },
            subagent_type: { type: 'string', description: 'Which subagent profile to use (e.g. "explore"). Omit for a generic worker.' },
            model: { type: 'string', description: 'Model override for this worker (e.g. a cheap model for wide reads).' },
            max_turns: { type: 'number', description: 'Max turns for this worker. Default 10.' },
            output_schema: {
              type: 'object',
              description:
                'Optional JSON Schema. When set, this worker returns a single JSON object matching it (parsed + validated, one retry on malformed output) instead of free-form prose. Use it for clean, uniform, mergeable results.',
            },
          },
          required: ['name', 'prompt'],
        },
        description:
          'The workers. For fan-out/map-reduce they run in parallel and are independent. For pipeline they run in the given order, each receiving the previous worker\'s output.',
      },
      reducer: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string', description: 'How to combine the mapped results into one answer.' },
          subagent_type: { type: 'string' },
          model: { type: 'string' },
          output_schema: {
            type: 'object',
            description: 'Optional JSON Schema for the reducer to return a single JSON object matching it.',
          },
        },
        required: ['prompt'],
        description: 'REQUIRED for shape="map-reduce" only: the agent that merges all task outputs into a single result.',
      },
    },
    required: ['shape', 'tasks'],
  },

  async execute(input, context: ToolContext) {
    const { shape, tasks, reducer } = input as unknown as OrchestrateInput

    const configAny = context.config as Record<string, unknown>
    const spawner = configAny.agentSpawner as InjectedSpawner | undefined
    if (!spawner) {
      return {
        content:
          'Orchestration is not available in this session. Do the work yourself or break it into smaller steps.',
        isError: true,
        metadata: { reason: 'no_spawner' },
      }
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { content: 'orchestrate requires at least one task.', isError: true, metadata: { reason: 'no_tasks' } }
    }
    if (shape === 'map-reduce' && (!reducer || !reducer.prompt)) {
      return {
        content: 'shape="map-reduce" requires a `reducer` with a prompt that merges the mapped results.',
        isError: true,
        metadata: { reason: 'no_reducer' },
      }
    }

    const defs = configAny.subagentDefs as SubagentDefs
    const workspacePath = typeof configAny.workspacePath === 'string' ? configAny.workspacePath : undefined
    const spec = (t: TaskInput) => buildSpec(t, defs, workspacePath)

    try {
      if (shape === 'pipeline') {
        // Sequential — each stage receives the previous stage's output.
        let prior = ''
        let last = ''
        for (const task of tasks) {
          const userMessage = prior
            ? `Previous step output:\n${prior}\n\n---\nYour task: ${task.prompt}`
            : task.prompt
          const r = await runWorker(spawner, spec(task), userMessage, task.output_schema)
          last = r.content
          prior = r.content
        }
        return {
          content: last,
          isError: false,
          metadata: { shape, stages: tasks.length },
        }
      }

      // fan-out + map-reduce both start by running every task in parallel.
      const mapped = await Promise.all(tasks.map(t => runWorker(spawner, spec(t), t.prompt, t.output_schema)))

      if (shape === 'fan-out') {
        const content = mapped.map((r, i) => labeled(tasks[i]!.name, r.content)).join('\n\n')
        return {
          content,
          isError: false,
          metadata: {
            shape,
            workers: tasks.length,
            failures: mapped.filter(m => !m.ok).length,
            results: resultsMeta(tasks, mapped),
          },
        }
      }

      // map-reduce: combine the mapped outputs and hand them to the reducer.
      const combined = mapped.map((r, i) => labeled(tasks[i]!.name, r.content)).join('\n\n')
      const reduceMessage = `${reducer!.prompt}\n\nResults to combine:\n${combined}`
      const reduced = await runWorker(spawner, spec(reducer!), reduceMessage, reducer!.output_schema)
      return {
        content: reduced.content,
        isError: !reduced.ok,
        metadata: {
          shape,
          workers: tasks.length,
          failures: mapped.filter(m => !m.ok).length,
          results: resultsMeta(tasks, mapped),
        },
      }
    } catch (e) {
      return {
        content: `orchestrate (${shape}) failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        metadata: { shape, error: String(e) },
      }
    }
  },
})

export const orchestrateTools: Tool[] = [orchestrate]
