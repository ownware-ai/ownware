/**
 * Built-in Tools Index
 *
 * Exports all built-in tools as a single array and provides
 * a factory function for creating the standard tool set.
 *
 * Tool categories:
 * - filesystem: readFile, writeFile, editFile, listFiles, glob, grep
 * - shell: shell_execute
 * - agent: agent_spawn
 * - browser: web_fetch, browser_navigate, browser_click, browser_type,
 *            browser_screenshot, browser_snapshot, browser_evaluate,
 *            browser_tab_list, browser_tab_open, browser_tab_close,
 *            browser_console
 * - search: web_search
 * - memory: memory_store, memory_search, memory_forget
 * - custom: ask_user, image_generate, speech_synthesize, speech_transcribe
 */

import type { Tool } from '../types.js'
import { filesystemTools } from './filesystem.js'
import { shellTools } from './shell.js'
import { askUserTools } from './ask-user.js'
import { agentTools } from './agent.js'
import { orchestrateTools } from './orchestrate.js'
import { webFetchTools } from './web-fetch.js'
import { webSearchTools } from './web-search.js'
import { browserSensitiveType, browserTools } from './browser.js'
import { memoryTools } from './memory.js'
import { taskTools } from './tasks.js'
import { imageGenerateTools } from './image-generate.js'
import { speechTools } from './speech.js'
import { credentialTools } from './credential.js'

function declareEgress(
  tools: readonly Tool[],
  mediation: NonNullable<Tool['egress']>['mediation'],
): Tool[] {
  return tools.map(tool => ({
    ...tool,
    egress: {
      contractRevision: 'ownware.tool-egress.v1',
      mediation,
    },
  }))
}

/** All built-in tools */
const declaredBrowserTools = declareEgress(browserTools, 'uncontained')

export const builtinTools: Tool[] = [
  ...declareEgress(filesystemTools, 'none'),
  ...declareEgress(shellTools, 'uncontained'),
  ...declareEgress(askUserTools, 'none'),
  ...declareEgress(agentTools, 'none'),
  ...declareEgress(orchestrateTools, 'none'),
  ...declareEgress(webFetchTools, 'uncontained'),
  ...declareEgress(webSearchTools, 'uncontained'),
  ...declaredBrowserTools,
  ...declareEgress(memoryTools, 'none'),
  ...declareEgress(taskTools, 'none'),
  ...declareEgress(imageGenerateTools, 'uncontained'),
  ...declareEgress(speechTools, 'uncontained'),
  ...declareEgress(credentialTools, 'none'),
]

/**
 * Exact final Tool object trusted hosts may bind to their browser-sensitive
 * injector. The object has already crossed the built-in egress declaration
 * seam; matching by name would let an unrelated profile tool claim authority.
 */
export const builtinBrowserSensitiveInputTool: Tool =
  declaredBrowserTools[browserTools.indexOf(browserSensitiveType)]!

/**
 * Create the standard set of built-in tools.
 * Returns a fresh array each time (safe to mutate/filter).
 */
export function createBuiltinTools(): Tool[] {
  return [...builtinTools]
}

/** Create a Map of built-in tools keyed by name */
export function createBuiltinToolMap(): Map<string, Tool> {
  const map = new Map<string, Tool>()
  for (const tool of builtinTools) {
    map.set(tool.name, tool)
  }
  return map
}

export { filesystemTools } from './filesystem.js'
export { shellTools } from './shell.js'
export { askUserTools } from './ask-user.js'
export { agentTools } from './agent.js'
export { orchestrateTools, orchestrate } from './orchestrate.js'
export { webFetchTools } from './web-fetch.js'
export { webSearchTools } from './web-search.js'
export { browserTools } from './browser.js'
export { memoryTools } from './memory.js'
export {
  taskTools,
  todoWrite,
  type TaskStore,
  type TaskEntry,
  type TaskStatus,
  type TaskStoreWriteInput,
} from './tasks.js'
export { imageGenerateTools } from './image-generate.js'
export { speechTools } from './speech.js'
export { credentialTools, requestCredential } from './credential.js'
