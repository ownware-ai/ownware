/**
 * Profile Validator
 *
 * Validates and normalizes profile configuration objects.
 * Checks required fields, applies defaults, and returns a
 * type-safe ProfileConfig or throws a descriptive error.
 */

import type { ProfileConfig } from './types.js'
import { ProfileError } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a raw config object and return a typed ProfileConfig.
 *
 * @param raw - Untyped config (from JSON.parse or YAML parser)
 * @returns Validated ProfileConfig with defaults applied
 * @throws ProfileError with field path on validation failure
 */
export function validateProfile(raw: unknown): ProfileConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProfileError('Profile config must be an object', '', 'root')
  }

  const obj = raw as Record<string, unknown>

  // Required: name
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new ProfileError('Profile "name" is required and must be a non-empty string', '', 'name')
  }

  // Validate optional fields
  const config: ProfileConfig = {
    name: obj.name.trim(),
    description: optionalString(obj, 'description'),
    model: optionalString(obj, 'model'),
    temperature: optionalNumber(obj, 'temperature', 0, 2),
    maxTurns: optionalInteger(obj, 'maxTurns', 1),
    maxTokens: optionalInteger(obj, 'maxTokens', 1),
    systemPrompt: optionalString(obj, 'systemPrompt'),
    tools: validateToolConfig(obj.tools),
    middleware: optionalStringArray(obj, 'middleware'),
    skills: optionalStringArray(obj, 'skills'),
    memory: optionalStringArray(obj, 'memory'),
    mcpServers: validateMcpServers(obj.mcpServers),
    workspace: validateWorkspace(obj.workspace),
    sandbox: validateSandbox(obj.sandbox),
    subagents: validateSubagents(obj.subagents),
  }

  return config
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined
  if (typeof obj[field] !== 'string') {
    throw new ProfileError(`"${field}" must be a string`, '', field)
  }
  return obj[field] as string
}

function optionalNumber(
  obj: Record<string, unknown>,
  field: string,
  min?: number,
  max?: number,
): number | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined
  if (typeof obj[field] !== 'number') {
    throw new ProfileError(`"${field}" must be a number`, '', field)
  }
  const val = obj[field] as number
  if (min !== undefined && val < min) {
    throw new ProfileError(`"${field}" must be >= ${min}`, '', field)
  }
  if (max !== undefined && val > max) {
    throw new ProfileError(`"${field}" must be <= ${max}`, '', field)
  }
  return val
}

function optionalInteger(
  obj: Record<string, unknown>,
  field: string,
  min?: number,
): number | undefined {
  const val = optionalNumber(obj, field, min)
  if (val !== undefined && !Number.isInteger(val)) {
    throw new ProfileError(`"${field}" must be an integer`, '', field)
  }
  return val
}

function optionalStringArray(obj: Record<string, unknown>, field: string): string[] | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined
  if (!Array.isArray(obj[field])) {
    throw new ProfileError(`"${field}" must be an array`, '', field)
  }
  return (obj[field] as unknown[]).map((v, i) => {
    if (typeof v !== 'string') {
      throw new ProfileError(`"${field}[${i}]" must be a string`, '', `${field}[${i}]`)
    }
    return v
  })
}

function validateToolConfig(raw: unknown): ProfileConfig['tools'] {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError('"tools" must be an object', '', 'tools')
  }
  const obj = raw as Record<string, unknown>
  return {
    builtin: obj.builtin ? toStringArray(obj.builtin, 'tools.builtin') : undefined,
    custom: obj.custom ? toStringArray(obj.custom, 'tools.custom') : undefined,
    deny: obj.deny ? toStringArray(obj.deny, 'tools.deny') : undefined,
  }
}

function validateMcpServers(raw: unknown): ProfileConfig['mcpServers'] {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new ProfileError('"mcpServers" must be an array', '', 'mcpServers')
  }
  return raw.map((server, i) => {
    if (typeof server !== 'object' || server === null) {
      throw new ProfileError(`"mcpServers[${i}]" must be an object`, '', `mcpServers[${i}]`)
    }
    const s = server as Record<string, unknown>
    if (typeof s.name !== 'string') throw new ProfileError(`mcpServers[${i}].name required`, '', `mcpServers[${i}].name`)

    const transport = s.transport === 'sse' ? 'sse' as const
      : s.transport === 'http' ? 'http' as const
      : s.transport === 'websocket' ? 'websocket' as const
      : 'stdio' as const

    const env = s.env && typeof s.env === 'object' ? s.env as Record<string, string> : undefined

    switch (transport) {
      case 'sse':
      case 'http': {
        if (typeof s.url !== 'string') throw new ProfileError(`mcpServers[${i}].url required for ${transport}`, '', `mcpServers[${i}].url`)
        return {
          name: s.name,
          transport,
          url: s.url,
          headers: s.headers && typeof s.headers === 'object' ? s.headers as Record<string, string> : undefined,
          env,
        }
      }
      case 'websocket': {
        if (typeof s.url !== 'string') throw new ProfileError(`mcpServers[${i}].url required for websocket`, '', `mcpServers[${i}].url`)
        return {
          name: s.name,
          transport,
          url: s.url,
          headers: s.headers && typeof s.headers === 'object' ? s.headers as Record<string, string> : undefined,
          env,
        }
      }
      case 'stdio':
      default: {
        if (typeof s.command !== 'string') throw new ProfileError(`mcpServers[${i}].command required`, '', `mcpServers[${i}].command`)
        return {
          name: s.name,
          transport: 'stdio' as const,
          command: s.command,
          args: s.args ? toStringArray(s.args, `mcpServers[${i}].args`) : undefined,
          env,
        }
      }
    }
  })
}

function validateWorkspace(raw: unknown): ProfileConfig['workspace'] {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError('"workspace" must be an object', '', 'workspace')
  }
  const obj = raw as Record<string, unknown>
  const mode = obj.mode as string | undefined
  if (mode !== undefined && mode !== 'cwd' && mode !== 'isolated') {
    throw new ProfileError('"workspace.mode" must be "cwd" or "isolated"', '', 'workspace.mode')
  }
  return {
    root: typeof obj.root === 'string' ? obj.root : undefined,
    mode: mode as 'cwd' | 'isolated' | undefined,
  }
}

function validateSandbox(raw: unknown): ProfileConfig['sandbox'] {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileError('"sandbox" must be an object', '', 'sandbox')
  }
  const obj = raw as Record<string, unknown>
  return { enabled: obj.enabled === true }
}

function validateSubagents(raw: unknown): ProfileConfig['subagents'] {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new ProfileError('"subagents" must be an array', '', 'subagents')
  }
  return raw.map((agent, i) => {
    if (typeof agent !== 'object' || agent === null) {
      throw new ProfileError(`"subagents[${i}]" must be an object`, '', `subagents[${i}]`)
    }
    const a = agent as Record<string, unknown>
    if (typeof a.name !== 'string') throw new ProfileError(`subagents[${i}].name required`, '', `subagents[${i}].name`)
    if (typeof a.description !== 'string') throw new ProfileError(`subagents[${i}].description required`, '', `subagents[${i}].description`)
    return {
      name: a.name,
      description: a.description,
      profile: typeof a.profile === 'string' ? a.profile : undefined,
      model: typeof a.model === 'string' ? a.model : undefined,
      tools: a.tools ? toStringArray(a.tools, `subagents[${i}].tools`) : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new ProfileError(`"${field}" must be an array`, '', field)
  return raw.map((v, i) => {
    if (typeof v !== 'string') throw new ProfileError(`"${field}[${i}]" must be a string`, '', `${field}[${i}]`)
    return v
  })
}
