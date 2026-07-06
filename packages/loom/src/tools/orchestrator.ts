/**
 * Tool Orchestrator
 *
 * Handles parallel execution of read-only tools and serial
 * execution of write tools. Respects concurrency limits.
 *
 * Read-only tools run concurrently (up to maxConcurrency),
 * write/mutating tools run serially (one at a time).
 */

import type { Tool, ToolCall, ToolResult, ToolContext } from './types.js'
import type { ToolUseBlock } from '../messages/types.js'

export interface OrchestratedResult {
  readonly toolCall: ToolCall
  readonly result: ToolResult
  readonly durationMs: number
}

/**
 * Partition tool calls into read-only (parallel) and write (serial) groups.
 */
export function partitionToolCalls(
  calls: ToolUseBlock[],
  tools: Map<string, Tool>,
): {
  readOnly: Array<{ call: ToolUseBlock; tool: Tool }>
  write: Array<{ call: ToolUseBlock; tool: Tool }>
  unknown: ToolUseBlock[]
} {
  const readOnly: Array<{ call: ToolUseBlock; tool: Tool }> = []
  const write: Array<{ call: ToolUseBlock; tool: Tool }> = []
  const unknown: ToolUseBlock[] = []

  for (const call of calls) {
    const tool = tools.get(call.name)
    if (!tool) {
      unknown.push(call)
      continue
    }
    if (tool.isReadOnly) {
      readOnly.push({ call, tool })
    } else {
      write.push({ call, tool })
    }
  }

  return { readOnly, write, unknown }
}

/**
 * Execute tools with concurrency control.
 * Read-only tools run in parallel, write tools run serially.
 */
export async function executeOrchestrated(
  calls: ToolUseBlock[],
  tools: Map<string, Tool>,
  context: ToolContext,
  maxConcurrency: number,
): Promise<OrchestratedResult[]> {
  const results: OrchestratedResult[] = []
  const { readOnly, write, unknown } = partitionToolCalls(calls, tools)

  // Handle unknown tools
  for (const call of unknown) {
    results.push({
      toolCall: { id: call.id, name: call.name, input: call.input },
      result: { content: `Unknown tool: ${call.name}`, isError: true },
      durationMs: 0,
    })
  }

  // Execute read-only tools in parallel (bounded concurrency)
  if (readOnly.length > 0) {
    const batches = chunk(readOnly, maxConcurrency)
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(({ call, tool }) => executeSingle(call, tool, context)),
      )
      results.push(...batchResults)
    }
  }

  // Execute write tools serially
  for (const { call, tool } of write) {
    const result = await executeSingle(call, tool, context)
    results.push(result)
  }

  return results
}

async function executeSingle(
  call: ToolUseBlock,
  tool: Tool,
  context: ToolContext,
): Promise<OrchestratedResult> {
  const start = Date.now()
  try {
    const resultOrGen = tool.execute(call.input, context)
    let result: ToolResult

    if (Symbol.asyncIterator in Object(resultOrGen)) {
      // Drain generator to get final result
      const gen = resultOrGen as AsyncGenerator<unknown, ToolResult>
      let next = await gen.next()
      while (!next.done) {
        next = await gen.next()
      }
      result = next.value
    } else {
      result = await (resultOrGen as Promise<ToolResult>)
    }

    return {
      toolCall: { id: call.id, name: call.name, input: call.input },
      result,
      durationMs: Date.now() - start,
    }
  } catch (error) {
    return {
      toolCall: { id: call.id, name: call.name, input: call.input },
      result: {
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      },
      durationMs: Date.now() - start,
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}
