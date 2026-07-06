/**
 * Zod Response Schemas
 *
 * Runtime-validated mirrors of every response type in src/gateway/types.ts.
 * Used by ApiClient.get/post/etc. to validate responses against the contract.
 *
 * RULE: When you add a new type to types.ts, add a schema here too.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

export function PaginatedResultSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  })
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export const ThreadSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string().nullable(),
  status: z.enum(['active', 'completed', 'error']),
  messageCount: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessagePreview: z.string().nullable(),
})

export const PaginatedThreadsSchema = PaginatedResultSchema(ThreadSchema)

export const ThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool_result', 'system', 'error']),
  content: z.string(),
  tools: z.array(z.object({
    name: z.string(),
    input: z.unknown(),
    output: z.string().optional(),
    isError: z.boolean().optional(),
    durationMs: z.number().optional(),
    startedAt: z.string().optional(),
  })).optional(),
  subAgents: z.array(z.object({
    agentId: z.string(),
    profileName: z.string(),
    task: z.string().optional(),
    status: z.enum(['running', 'completed', 'error']),
    result: z.string().optional(),
    durationMs: z.number().optional(),
    toolCount: z.number().optional(),
    turnCount: z.number().optional(),
  })).optional(),
  permissions: z.array(z.object({
    toolName: z.string(),
    input: z.record(z.unknown()).optional(),
    reason: z.string(),
    decision: z.enum(['approved', 'denied', 'pending']),
    zoneLevel: z.number().optional(),
    zoneName: z.string().optional(),
    explanation: z.string().optional(),
  })).optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().optional(),
    category: z.enum(['image', 'pdf', 'notebook', 'text', 'binary']),
  })).optional(),
  thinking: z.string().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }).optional(),
  timestamp: z.string(),
})

export const ThreadWithMessagesSchema = ThreadSchema.extend({
  messages: z.array(ThreadMessageSchema),
})

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  status: z.enum(['active', 'archived']),
  lastProfileId: z.string().nullable(),
  pinned: z.boolean(),
  // Migration 032 (product-base shift Phase 2 · slice-01): products
  // enabled in this workspace. Non-empty by contract; legacy rows
  // backfill to `['ownware']`.
  activeProducts: z.array(z.string().min(1)).min(1),
  lastOpenedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const PaginatedWorkspacesSchema = PaginatedResultSchema(WorkspaceSchema)

export const WorkspaceDetailSchema = WorkspaceSchema.extend({
  profiles: z.array(z.object({
    profileId: z.string(),
    threadCount: z.number(),
    lastUsedAt: z.string(),
  })),
  activeThreads: z.number(),
  totalThreads: z.number(),
})

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

// Note: ProfileSummary in types.ts has many fields the current handler
// doesn't populate. We use a permissive schema here so contracts pass on
// existing handlers, and a STRICT schema for what handlers should return.

export const ProfileSummaryPermissiveSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.string(),
  tags: z.array(z.string()),
  toolCount: z.number(),
  hasSkills: z.boolean(),
  hasMcp: z.boolean(),
  // Optional fields the handler may not yet populate
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  useCount: z.number().optional(),
  totalCost: z.number().optional(),
  lastUsedAt: z.string().nullable().optional(),
  helperCount: z.number().optional(),
  isLive: z.boolean().optional(),
})

export const ProfileSummaryStrictSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.string(),
  tags: z.array(z.string()),
  toolCount: z.number(),
  hasSkills: z.boolean(),
  hasMcp: z.boolean(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  category: z.string().nullable(),
  useCount: z.number(),
  totalCost: z.number(),
  lastUsedAt: z.string().nullable(),
  helperCount: z.number(),
  isLive: z.boolean(),
})

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const DashboardStatsSchema = z.object({
  activeAgents: z.number(),
  todayRuns: z.number(),
  todayTokens: z.number(),
  todayCost: z.number(),
  weekCost: z.number(),
  workspaceCount: z.number(),
  byProfile: z.array(z.object({
    profileId: z.string(),
    runCount: z.number(),
    runPercent: z.number(),
    weekCost: z.number(),
  })),
  byWorkspace: z.array(z.object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    threadCount: z.number(),
    weekCost: z.number(),
  })),
})

export const DashboardKPICardSchema = z.object({
  label: z.string(),
  value: z.number(),
  unit: z.string(),
  delta: z.number().nullable(),
  sparkline: z.array(z.number()).length(12),
})

export const DashboardKPIsSchema = z.object({
  range: z.enum(['24h', '7d', '30d', '90d']),
  cards: z.array(DashboardKPICardSchema),
})

export const UsageBucketSchema = z.object({
  date: z.string(),
  tokens: z.number(),
  cost: z.number(),
  runs: z.number(),
})

export const ProfileBreakdownRowSchema = z.object({
  profileId: z.string(),
  runs: z.number(),
  tokens: z.number(),
  cost: z.number(),
  avgDurationMs: z.number().nullable(),
  successRate: z.number(),
})

export const RecentActivityRowSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  threadId: z.string().nullable(),
  model: z.string(),
  totalTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number().nullable(),
  success: z.boolean(),
  createdAt: z.string(),
})

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export const MCPServerRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'http', 'websocket']),
  url: z.string().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  headers: z.record(z.string()),
  registryId: z.string().nullable(),
  toolCount: z.number().nullable(),
  status: z.enum(['configured', 'connected', 'error']),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  profileIds: z.array(z.string()).optional(),
})

// ---------------------------------------------------------------------------
// Local Profile, Settings, Providers
// ---------------------------------------------------------------------------

export const LocalProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const UserSettingsSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  updatedAt: z.string(),
})

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  hasKey: z.boolean(),
  models: z.array(z.string()),
})

// ---------------------------------------------------------------------------
// SSE Event payloads
// ---------------------------------------------------------------------------

export const SSEStreamStartSchema = z.object({
  threadId: z.string(),
  profileId: z.string(),
  attachments: z.array(z.unknown()).optional(),
})

export const SSETextDeltaSchema = z.object({
  type: z.string().optional(),
  text: z.string(),
})

export const SSEToolCallStartSchema = z.object({
  type: z.string().optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
})

export const SSEToolCallEndSchema = z.object({
  type: z.string().optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.string(),
  isError: z.boolean(),
  durationMs: z.number(),
})

export const SSETurnEndSchema = z.object({
  type: z.string().optional(),
  turnIndex: z.number().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
  }),
})

export const SSEPermissionRequestSchema = z.object({
  type: z.string().optional(),
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  reason: z.string(),
  zoneLevel: z.number().optional(),
  zoneName: z.string().optional(),
  explanation: z.string().optional(),
})

export const SSEAgentSpawnSchema = z.object({
  type: z.string().optional(),
  agentId: z.string(),
  profileName: z.string(),
  task: z.string().optional(),
})

export const SSEAgentCompleteSchema = z.object({
  type: z.string().optional(),
  agentId: z.string(),
  result: z.string(),
  durationMs: z.number(),
  toolCount: z.number().optional(),
  turnCount: z.number().optional(),
})

export const SSEDoneSchema = z.object({
  status: z.literal('complete'),
})
