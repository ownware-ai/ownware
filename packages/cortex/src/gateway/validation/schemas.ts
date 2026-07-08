/**
 * Zod validation schemas for all gateway request bodies.
 *
 * Every POST/PUT endpoint validates its body through these schemas.
 * Schemas are strict — unknown keys are rejected.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const CreateThreadSchema = z.object({
  profileId: z.string().min(1),
  title: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict()

export const UpdateThreadSchema = z.object({
  title: z.string().nullable().optional(),
  status: z.enum(['active', 'completed', 'error']).optional(),
  /**
   * Canonical model id for this thread. Persisted by the model picker
   * onChange — fires immediately, not waiting for the next /run, so a
   * pick survives a refresh even without sending a message. Empty
   * string is rejected; pass `null` to clear back to "use profile
   * default" semantics. Run handler still does its own setThreadModel
   * on dispatch — both writers converge on the same column, idempotent.
   */
  model: z.string().min(1).nullable().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const CreateWorkspaceSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
}).strict()

export const UpdateWorkspaceSchema = z.object({
  name: z.string().optional(),
  pinned: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Run — the run/resume request bodies are validated by the run handler's own
// strict schema (handlers/run.ts); the public wire contract is documented in
// @ownware/client's spec/openapi.yaml. Duplicated (and drifted) copies that
// used to live here were removed — one source of truth only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const CreateProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  model: z.string().optional(),
  soulMd: z.string().optional(),
  tools: z.object({
    preset: z.string().optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  security: z.object({
    level: z.string().optional(),
    permissionMode: z.string().optional(),
  }).optional(),
}).strict()

export const UpdateProfileSchema = z.object({
  config: z.record(z.unknown()).optional(),
  soulMd: z.string().optional(),
  agentsMd: z.string().optional(),
}).strict()

export const GenerateProfileSchema = z.object({
  purpose: z.string().min(1),
  model: z.string().optional(),
}).strict()

export const ProfileFileSchema = z.object({
  type: z.enum(['soul_md', 'agents_md', 'skill']),
  content: z.string().min(1),
  skillName: z.string().optional(),
}).strict()

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export const CreateMCPServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'http', 'websocket']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  registryId: z.string().optional(),
}).strict()

export const SaveCredentialsSchema = z.object({
  env: z.record(z.string()),
}).strict()

export const AddMCPToProfileSchema = z.object({
  serverId: z.string().min(1),
}).strict()

// ---------------------------------------------------------------------------
// Local Profile
// ---------------------------------------------------------------------------

export const CreateLocalProfileSchema = z.object({
  displayName: z.string().min(1).max(100),
  avatarUrl: z.string().url().optional(),
}).strict()

export const UpdateLocalProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().nullable().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SetSettingSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string(),
}).strict()

// ---------------------------------------------------------------------------
// Provider Keys
// ---------------------------------------------------------------------------

export const SetProviderKeySchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1),
}).strict()

// ---------------------------------------------------------------------------
// Profile Metadata
// ---------------------------------------------------------------------------

export const SetProfileMetadataSchema = z.object({
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
}).strict()

// (The desktop pane schemas were removed with the legacy desktop shell.)

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

export const SetAppStateSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string(),
}).strict()

// ---------------------------------------------------------------------------
// Settings (section-based)
// ---------------------------------------------------------------------------

export const SaveSettingsSchema = z.record(z.string()).refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'At least one setting key is required' },
)

// ---------------------------------------------------------------------------
// Provider Keys (for handler validation)
// ---------------------------------------------------------------------------

export const SaveProviderSchema = z.object({
  provider: z.string().min(1),
  key: z.string().min(1),
}).strict()

export const ValidateProviderSchema = z.object({
  provider: z.string().min(1),
  key: z.string().min(1),
}).strict()

// Speech-to-text dictation: base64 audio in, text out. Audio rides as
// base64-in-JSON (mirrors the attachment wire shape) so it reuses the
// existing JSON client; the router's 10 MB body cap allows ~7 MB of raw
// audio — ample for dictation clips.
export const TranscribeSchema = z.object({
  audio: z.string().min(1),
  mimeType: z.string().min(1),
  language: z.string().min(2).max(10).optional(),
}).strict()

// (Onboarding-wizard schemas removed — the legacy desktop first-run
// endpoints /api/v1/onboarding/{role,complete} were deleted from the gateway.)
