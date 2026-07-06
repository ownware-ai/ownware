/**
 * Checkpoint Serializer
 *
 * Handles serialization, deserialization, and validation of checkpoints.
 * Used by FileCheckpointStore and any store that persists checkpoints as JSON.
 */

import type { Checkpoint } from './types.js'
import type { SessionState } from '../core/session.js'

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a checkpoint to a pretty-printed JSON string.
 */
export function serializeCheckpoint(checkpoint: Checkpoint): string {
  return JSON.stringify(checkpoint, null, 2)
}

/**
 * Deserialize a JSON string to a validated Checkpoint.
 *
 * @throws Error if the JSON is malformed or doesn't match the Checkpoint shape
 */
export function deserializeCheckpoint(json: string): Checkpoint {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(
      `Failed to parse checkpoint JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!validateCheckpoint(parsed)) {
    throw new Error('Invalid checkpoint data: missing or malformed required fields')
  }

  return parsed
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create a Checkpoint from a SessionState.
 *
 * Maps session state (from `Session.getState()`) to the checkpoint format
 * used by checkpoint stores. Adds a timestamp if the session state doesn't
 * include one.
 */
export function createCheckpoint(session: SessionState): Checkpoint {
  return {
    sessionId: session.sessionId,
    messages: [...session.messages],
    turnIndex: session.turnCount,
    usage: {
      inputTokens: session.totalUsage.inputTokens,
      outputTokens: session.totalUsage.outputTokens,
      cacheReadTokens: session.totalUsage.cacheReadTokens,
      cacheCreationTokens: session.totalUsage.cacheCreationTokens,
      costUsd: session.totalUsage.costUsd,
    },
    timestamp: session.updatedAt || Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Type guard that validates an unknown value matches the Checkpoint shape.
 *
 * Checks all required fields and their types. Does not deeply validate
 * individual messages (the message serializer handles that).
 */
export function validateCheckpoint(data: unknown): data is Checkpoint {
  if (data === null || typeof data !== 'object') {
    return false
  }

  const obj = data as Record<string, unknown>

  // Required string fields
  if (typeof obj.sessionId !== 'string' || !obj.sessionId) {
    return false
  }

  // Messages must be an array
  if (!Array.isArray(obj.messages)) {
    return false
  }

  // turnIndex must be a non-negative number
  if (typeof obj.turnIndex !== 'number' || obj.turnIndex < 0 || !Number.isFinite(obj.turnIndex)) {
    return false
  }

  // timestamp must be a positive number
  if (typeof obj.timestamp !== 'number' || obj.timestamp <= 0 || !Number.isFinite(obj.timestamp)) {
    return false
  }

  // usage must be an object with the expected numeric fields
  if (!validateUsage(obj.usage)) {
    return false
  }

  return true
}

/**
 * Validate the usage sub-object of a checkpoint.
 */
function validateUsage(usage: unknown): boolean {
  if (usage === null || typeof usage !== 'object') {
    return false
  }

  const u = usage as Record<string, unknown>
  const requiredFields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'costUsd',
  ] as const

  for (const field of requiredFields) {
    if (typeof u[field] !== 'number' || !Number.isFinite(u[field] as number)) {
      return false
    }
  }

  return true
}
