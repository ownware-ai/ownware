/**
 * Memory system — public exports.
 *
 * The kernel-level "what does this agent know about working with the
 * user, across all threads of THIS profile" feature. Replaces the
 * static AGENTS.md notebook with a DB-backed approval-gated learning
 * loop:
 *
 *   agent calls remember(text)  →  memory_proposals (pending)
 *                                  ↓ user accepts via UI
 *                                  memories (active)
 *                                  ↓ next session assembled
 *                                  top-N ranked rows render into
 *                                  the system prompt, plus the
 *                                  global user identity layer.
 */

export {
  MemorySchema,
  MemoryProposalSchema,
  UserIdentitySchema,
  MemoryKindSchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  MemoryScopeSchema,
  ProposalStatusSchema,
  MemoryEventSchema,
  CreateMemoryRequestSchema,
  UpdateMemoryRequestSchema,
  AcceptProposalRequestSchema,
  RejectProposalRequestSchema,
  UpdateUserIdentityRequestSchema,
  RememberInputSchema,
  MAX_MEMORY_CONTENT_CHARS,
  DEFAULT_MEMORY_TOP_N,
  type Memory,
  type MemoryProposal,
  type UserIdentity,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
  type MemoryScope,
  type ProposalStatus,
  type MemoryEvent,
  type CreateMemoryRequest,
  type UpdateMemoryRequest,
  type AcceptProposalRequest,
  type RejectProposalRequest,
  type UpdateUserIdentityRequest,
  type RememberInput,
} from './schema.js'

export { MemoryEventBus, type MemoryEventListener } from './event-bus.js'

export {
  SqliteMemoryStore,
  type CreateMemoryInput,
  type UpdateMemoryInput,
} from './store.js'

export {
  SqliteMemoryProposalsStore,
  type ProposeInput,
  type AcceptInput,
} from './proposals.js'

export { SqliteUserIdentityStore } from './identity-store.js'

export {
  parseAgentsMd,
  seedFromAgentsMd,
  exportToAgentsMd,
  type ParsedAgentsBullet,
} from './agents-md.js'

export {
  createRememberTool,
  type RememberHook,
  type RememberToolDeps,
} from './remember-tool.js'

import { MemoryEventBus } from './event-bus.js'
import type {
  MemoryProposalRepository,
  MemoryRepository,
  UserIdentityRepository,
} from '../storage/platform-repositories.js'

/**
 * Convenience wiring — one bag of stores backed by a single SQLite
 * handle, sharing one event bus. Prefer this over wiring stores
 * individually so callers always pass the same bus instance into
 * every store and SSE consumers receive a unified stream.
 */
export interface MemorySystem {
  readonly memories: MemoryRepository
  readonly proposals: MemoryProposalRepository
  readonly identity: UserIdentityRepository
  readonly bus: MemoryEventBus
}
