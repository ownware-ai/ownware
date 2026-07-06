/**
 * Profile Loader
 *
 * Loads a complete agent profile from a directory. A profile directory
 * contains:
 *   - agent.json or agent.yaml — configuration
 *   - SOUL.md — system prompt / identity (optional)
 *   - AGENTS.md — persistent memory (optional)
 *   - skills/ — skill definitions (optional)
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LoadedProfile, ProfileConfig } from './types.js'
import { ProfileError } from './types.js'
import { validateProfile } from './validator.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a complete profile from a directory.
 *
 * @param dirPath - Absolute or relative path to the profile directory
 * @returns Fully loaded and validated profile
 * @throws ProfileError if the directory or config file doesn't exist
 */
export async function loadProfile(dirPath: string): Promise<LoadedProfile> {
  const basePath = resolve(dirPath)

  // 1. Load and parse config file
  const config = await loadConfig(basePath)

  // 2. Load SOUL.md (system prompt)
  const soulMd = await loadOptionalFile(join(basePath, 'SOUL.md'))

  // 3. Load AGENTS.md (memory)
  const agentsMd = await loadOptionalFile(join(basePath, 'AGENTS.md'))

  // 4. Detect skills directory
  const skillsDir = await detectSkillsDir(basePath, config.skills)

  return {
    config,
    soulMd,
    agentsMd,
    skillsDir: skillsDir ?? undefined,
    basePath,
  }
}

/**
 * Load just the config file from a profile directory (without SOUL.md, etc.).
 * Useful for quick scanning without loading all files.
 */
export async function loadProfileConfig(dirPath: string): Promise<ProfileConfig> {
  return loadConfig(resolve(dirPath))
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Try agent.json first, then agent.yaml */
async function loadConfig(basePath: string): Promise<ProfileConfig> {
  // Try JSON first
  const jsonPath = join(basePath, 'agent.json')
  const jsonContent = await loadOptionalFile(jsonPath)
  if (jsonContent) {
    try {
      const raw = JSON.parse(jsonContent)
      return validateProfile(raw)
    } catch (err) {
      if (err instanceof ProfileError) throw err
      throw new ProfileError(
        `Invalid JSON in agent.json: ${err instanceof Error ? err.message : String(err)}`,
        basePath,
      )
    }
  }

  // Try YAML (simple key: value parsing)
  const yamlPath = join(basePath, 'agent.yaml')
  const yamlContent = await loadOptionalFile(yamlPath)
  if (yamlContent) {
    try {
      const raw = parseSimpleYaml(yamlContent)
      return validateProfile(raw)
    } catch (err) {
      if (err instanceof ProfileError) throw err
      throw new ProfileError(
        `Invalid YAML in agent.yaml: ${err instanceof Error ? err.message : String(err)}`,
        basePath,
      )
    }
  }

  throw new ProfileError(
    `No agent.json or agent.yaml found in ${basePath}`,
    basePath,
  )
}

/** Read a file, returning empty string if it doesn't exist. */
async function loadOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Detect skills directory — check explicit paths from config, or default skills/ subdir. */
async function detectSkillsDir(
  basePath: string,
  skillPaths?: readonly string[],
): Promise<string | null> {
  // If explicit skill paths provided, use the first that exists
  if (skillPaths && skillPaths.length > 0) {
    for (const sp of skillPaths) {
      const abs = resolve(basePath, sp)
      try {
        const s = await stat(abs)
        if (s.isDirectory()) return abs
      } catch { /* skip */ }
    }
  }

  // Check default skills/ subdirectory
  const defaultDir = join(basePath, 'skills')
  try {
    const s = await stat(defaultDir)
    if (s.isDirectory()) return defaultDir
  } catch { /* doesn't exist */ }

  return null
}

/**
 * Minimal YAML parser for profile configs.
 * Handles flat key: value pairs and simple nested objects.
 * Not a full YAML parser — use JSON for complex configs.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = content.split('\n')
  let currentKey = ''

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue

    // Array item
    const arrayMatch = line.match(/^\s+-\s+(.+)$/)
    if (arrayMatch && currentKey) {
      if (currentKey !== undefined) {
        const arr = result[currentKey]
        if (Array.isArray(arr)) {
          arr.push(parseYamlValue(arrayMatch[1]!.trim()))
        }
      }
      continue
    }

    // Key: value
    const kvMatch = line.match(/^(\w[\w.]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      const key = kvMatch[1]!
      const rawValue = (kvMatch[2] ?? '').trim()

      if (rawValue === '' || rawValue === '[]') {
        result[key] = []
        currentKey = key
      } else {
        result[key] = parseYamlValue(rawValue)
        currentKey = key
      }
    }
  }

  return result
}

function parseYamlValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw)
  return raw.replace(/^["']|["']$/g, '')
}
