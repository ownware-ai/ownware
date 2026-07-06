/**
 * Memory Module
 *
 * Persistent context management — loads memory files, injects them
 * into prompts, tracks corrections, and recalls past sessions.
 */

// Types
export type {
  MemorySource,
  MemoryEntry,
  MemoryConfig,
  SessionSummary,
} from './types.js'

// Loader
export { loadMemory, layerMemoryEntries, clearMemoryCache } from './loader.js'

// Injector
export { injectMemory, injectRawMemory } from './injector.js'

// Correction memory
export { CorrectionMemory } from './correction.js'

// Session recall
export { recallRelevantSessions } from './session-recall.js'
