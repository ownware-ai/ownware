/**
 * Built-in Memory Tools
 *
 * Store, search, and manage persistent memory across agent sessions.
 * Backed by a pluggable MemoryStore interface — consumers inject
 * their own implementation (vector DB, SQLite, etc.) via config.
 *
 * Engine-level — any agent may need to remember facts, decisions,
 * or user preferences across conversations.
 *
 * Design:
 *   - Zero external deps (store implementations live in Cortex)
 *   - MemoryStore interface is injected via config.memoryStore
 *   - If no store is configured, tools return clear errors
 *   - memory_search is read-only → runs in parallel with other reads
 *   - memory_store is write but doesn't require permission (additive)
 *   - memory_forget requires permission (destructive)
 *
 * @security
 *   - Memory content is not sanitized (it's user/agent-generated)
 *   - Deletion requires explicit permission
 *   - No PII detection (responsibility of the store implementation)
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Memory store interface.
 * Consumers inject their own implementation via config.memoryStore.
 *
 * Implementations may use:
 *   - Vector databases (LanceDB, Pinecone, Qdrant) for semantic search
 *   - SQLite with FTS5 for full-text search
 *   - Simple in-memory Map for testing
 */
export interface MemoryStore {
  /**
   * Store a memory entry. Returns the assigned ID.
   */
  store(entry: {
    content: string
    metadata?: Record<string, unknown>
  }): Promise<string>

  /**
   * Search memories by semantic similarity or keyword match.
   * Returns entries sorted by relevance (highest score first).
   */
  search(
    query: string,
    options?: {
      limit?: number
      threshold?: number
    },
  ): Promise<MemoryEntry[]>

  /**
   * Delete a memory by ID. Returns true if found and deleted.
   */
  delete(id: string): Promise<boolean>
}

export interface MemoryEntry {
  readonly id: string
  readonly content: string
  readonly score: number
  readonly metadata?: Record<string, unknown>
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_SEARCH_THRESHOLD = 0.0
const MAX_CONTENT_LENGTH = 50_000

// ---------------------------------------------------------------------------
// memory_store
// ---------------------------------------------------------------------------

export const memoryStore: Tool = defineTool({
  name: 'memory_store',
  description:
    'Save information to persistent memory for recall in future sessions.\n' +
    '- Use for facts, decisions, user preferences, or important context.\n' +
    '- Stored memories persist across conversations and sessions.\n' +
    '- Each entry gets a unique ID for later retrieval or deletion.\n' +
    '- Add metadata tags to help with search and organization.\n' +
    '- Do NOT store transient information (current task progress, temp state).\n' +
    '- Do NOT store large code blocks — reference file paths instead.',
  category: 'memory',
  isReadOnly: false,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Remembered', primaryField: 'content' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The information to store. Be specific and self-contained — ' +
          'this will be read without the original conversation context.',
      },
      metadata: {
        type: 'object',
        description:
          'Optional key-value metadata. Use for categorization (e.g., ' +
          '{"type": "decision", "topic": "auth", "project": "cortex"}).',
      },
    },
    required: ['content'],
  },
  async execute(input, context) {
    const store = (context.config as Record<string, unknown>).memoryStore as
      | MemoryStore | undefined

    if (!store) {
      return {
        content:
          'Memory is not configured in this session. ' +
          'No memory store is available. Proceed without persistent memory.',
        isError: true,
        metadata: { reason: 'no_store' },
      }
    }

    const { content, metadata } = input as {
      content: string
      metadata?: Record<string, unknown>
    }

    if (!content || content.trim().length === 0) {
      return { content: 'Cannot store empty content.', isError: true }
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      return {
        content: `Content too large (${content.length} chars). Maximum is ${MAX_CONTENT_LENGTH} characters. Store a summary or reference instead.`,
        isError: true,
      }
    }

    try {
      const id = await store.store({ content: content.trim(), metadata })

      return {
        content: `Memory stored (ID: ${id}).`,
        isError: false,
        metadata: { id, contentLength: content.length },
      }
    } catch (e) {
      return {
        content: `Failed to store memory: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      }
    }
  },
})

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export const memorySearch: Tool = defineTool({
  name: 'memory_search',
  description:
    'Search persistent memory for relevant information.\n' +
    '- Finds memories matching your query by semantic similarity or keywords.\n' +
    '- Returns results sorted by relevance with confidence scores.\n' +
    '- Use before starting tasks to recall previous context, decisions, or preferences.\n' +
    '- Use specific, descriptive queries for best results.\n' +
    '- Results include the memory ID (for deletion) and creation timestamp.',
  category: 'memory',
  isReadOnly: true,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'search',
    summary: { verb: 'Recalled', primaryField: 'query' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for. Be specific — "auth middleware decision" is better than "auth".',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return. Default: 10.',
      },
      threshold: {
        type: 'number',
        description: 'Minimum relevance score (0-1). Default: 0 (return all matches).',
      },
    },
    required: ['query'],
  },
  async execute(input, context) {
    const store = (context.config as Record<string, unknown>).memoryStore as
      | MemoryStore | undefined

    if (!store) {
      return {
        content:
          'Memory is not configured in this session. ' +
          'No memory store is available.',
        isError: true,
        metadata: { reason: 'no_store' },
      }
    }

    const { query, limit, threshold } = input as {
      query: string
      limit?: number
      threshold?: number
    }

    try {
      const entries = await store.search(query, {
        limit: limit ?? DEFAULT_SEARCH_LIMIT,
        threshold: threshold ?? DEFAULT_SEARCH_THRESHOLD,
      })

      if (entries.length === 0) {
        return {
          content: `No memories found for: "${query}"`,
          isError: false,
          metadata: { query, resultCount: 0 },
        }
      }

      const formatted = entries.map((entry, i) => {
        const meta = entry.metadata
          ? `\n   Tags: ${JSON.stringify(entry.metadata)}`
          : ''
        return (
          `${i + 1}. [${entry.id}] (score: ${entry.score.toFixed(3)}, ${entry.createdAt})\n` +
          `   ${entry.content}${meta}`
        )
      }).join('\n\n')

      return {
        content: `Memory search results for "${query}" (${entries.length} matches):\n\n${formatted}`,
        isError: false,
        metadata: { query, resultCount: entries.length },
      }
    } catch (e) {
      return {
        content: `Memory search failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        metadata: { query, error: String(e) },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// memory_forget
// ---------------------------------------------------------------------------

export const memoryForget: Tool = defineTool({
  name: 'memory_forget',
  description:
    'Delete a specific memory by its ID.\n' +
    '- Use memory_search first to find the ID of the memory to delete.\n' +
    '- This is permanent — the memory cannot be recovered after deletion.\n' +
    '- Use when information is outdated, incorrect, or no longer relevant.',
  category: 'memory',
  isReadOnly: false,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Forgot', primaryField: 'id' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The ID of the memory to delete (from memory_search results).',
      },
    },
    required: ['id'],
  },
  async execute(input, context) {
    const store = (context.config as Record<string, unknown>).memoryStore as
      | MemoryStore | undefined

    if (!store) {
      return {
        content: 'Memory is not configured in this session.',
        isError: true,
        metadata: { reason: 'no_store' },
      }
    }

    const { id } = input as { id: string }

    try {
      const deleted = await store.delete(id)

      if (!deleted) {
        return {
          content: `No memory found with ID "${id}". Use memory_search to find valid IDs.`,
          isError: true,
          metadata: { id, found: false },
        }
      }

      return {
        content: `Memory ${id} deleted.`,
        isError: false,
        metadata: { id, deleted: true },
      }
    } catch (e) {
      return {
        content: `Failed to delete memory: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        metadata: { id, error: String(e) },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const memoryTools: Tool[] = [memoryStore, memorySearch, memoryForget]
