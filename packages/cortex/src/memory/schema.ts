/**
 * Memory system — wire schemas.
 *
 * Zod boundary types for the memory feature (memories, proposals,
 * user identity). Used by the gateway HTTP handlers AND the in-process
 * stores so the same shapes serialise to JSON and parse back losslessly.
 *
 * Naming convention mirrors gateway/types.ts: PascalCase types, camelCase
 * fields, ISO-8601 strings with offset for timestamps. SQLite rows live
 * elsewhere (snake_case) and are converted at the store boundary.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MemoryKindSchema = z.enum(['fact', 'preference', 'correction', 'identity'])
export type MemoryKind = z.infer<typeof MemoryKindSchema>

export const MemorySourceSchema = z.enum([
  'user_pinned',
  'agent_proposed',
  'reflection',
  'legacy_import',
])
export type MemorySource = z.infer<typeof MemorySourceSchema>

export const MemoryStatusSchema = z.enum(['active', 'superseded', 'archived'])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

export const MemoryScopeSchema = z.enum(['agent', 'workspace', 'user'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const ProposalStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'edited'])
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>

// ---------------------------------------------------------------------------
// Limits — defended at the boundary so a misbehaving agent or oversize
// API call cannot blow up the system prompt or the database row.
// ---------------------------------------------------------------------------

/** Hard cap on memory text length (chars). 2 KB is generous for facts. */
export const MAX_MEMORY_CONTENT_CHARS = 2000

/** Default top-N memories loaded into the system prompt at assembly. */
export const DEFAULT_MEMORY_TOP_N = 30

// ---------------------------------------------------------------------------
// Memory wire shape
// ---------------------------------------------------------------------------

export const MemorySchema = z.object({
  id: z.string(),
  profileId: z.string(),
  scope: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  kind: MemoryKindSchema,
  content: z.string(),
  source: MemorySourceSchema,
  sourceThreadId: z.string().nullable(),
  sourceProposalId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  status: MemoryStatusSchema,
  supersededBy: z.string().nullable(),
  pinned: z.boolean(),
  referenceCount: z.number().int().nonnegative(),
  lastReferencedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Memory = z.infer<typeof MemorySchema>

// ---------------------------------------------------------------------------
// Proposal wire shape
// ---------------------------------------------------------------------------

export const MemoryProposalSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  threadId: z.string(),
  proposedContent: z.string(),
  proposedKind: MemoryKindSchema,
  status: ProposalStatusSchema,
  resolvedContent: z.string().nullable(),
  resolvedMemoryId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
})

export type MemoryProposal = z.infer<typeof MemoryProposalSchema>

// ---------------------------------------------------------------------------
// User identity wire shape
// ---------------------------------------------------------------------------

export const UserIdentitySchema = z.object({
  name: z.string().nullable(),
  role: z.string().nullable(),
  company: z.string().nullable(),
  timezone: z.string().nullable(),
  pronouns: z.string().nullable(),
  preferences: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

export type UserIdentity = z.infer<typeof UserIdentitySchema>

// ---------------------------------------------------------------------------
// Request bodies (HTTP API)
// ---------------------------------------------------------------------------

/** POST /memories — manual user pin. */
export const CreateMemoryRequestSchema = z.object({
  profileId: z.string().min(1),
  content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
  kind: MemoryKindSchema.default('fact'),
  pinned: z.boolean().default(false),
})

export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequestSchema>

/** PATCH /memories/:id — edit content / pin / archive. */
export const UpdateMemoryRequestSchema = z.object({
  content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS).optional(),
  kind: MemoryKindSchema.optional(),
  pinned: z.boolean().optional(),
  status: MemoryStatusSchema.optional(),
})

export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequestSchema>

/** POST /memories/proposals/:id/accept — final content optionally edited. */
export const AcceptProposalRequestSchema = z.object({
  content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS).optional(),
  kind: MemoryKindSchema.optional(),
  pinned: z.boolean().default(false),
})

export type AcceptProposalRequest = z.infer<typeof AcceptProposalRequestSchema>

/** POST /memories/proposals/:id/reject — optional reason. */
export const RejectProposalRequestSchema = z.object({
  reason: z.string().max(500).optional(),
})

export type RejectProposalRequest = z.infer<typeof RejectProposalRequestSchema>

/** PUT /user/identity — partial update; null clears a field. */
export const UpdateUserIdentityRequestSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  role: z.string().max(200).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  pronouns: z.string().max(50).nullable().optional(),
  preferences: z.string().max(4000).nullable().optional(),
})

export type UpdateUserIdentityRequest = z.infer<typeof UpdateUserIdentityRequestSchema>

// ---------------------------------------------------------------------------
// Tool input — `remember()` built-in
// ---------------------------------------------------------------------------

export const RememberInputSchema = z.object({
  content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
  kind: MemoryKindSchema.optional(),
})

export type RememberInput = z.infer<typeof RememberInputSchema>

// ---------------------------------------------------------------------------
// SSE event payloads
// ---------------------------------------------------------------------------

export const MemoryEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('memory.proposed'),
    profileId: z.string(),
    threadId: z.string(),
    proposalId: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('memory.proposal.resolved'),
    profileId: z.string(),
    proposalId: z.string(),
    status: ProposalStatusSchema,
    at: z.string(),
  }),
  z.object({
    type: z.literal('memory.changed'),
    profileId: z.string(),
    memoryId: z.string(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('memory.identity.changed'),
    at: z.string(),
  }),
])

export type MemoryEvent = z.infer<typeof MemoryEventSchema>
