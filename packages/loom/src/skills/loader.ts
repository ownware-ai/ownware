/**
 * Skill Loader
 *
 * Reads SKILL.md files from a directory and parses them into
 * SkillDefinition objects. Each file has YAML frontmatter for
 * metadata and a markdown body for the skill content.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillDefinition, SkillFrontmatter } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load skill definitions from a directory of SKILL.md files.
 *
 * Files must have the pattern `*.skill.md` or `SKILL.md` and contain
 * YAML frontmatter delimited by `---` lines, followed by the markdown body.
 *
 * Files that fail to parse are skipped with a warning.
 *
 * @param dirPath - Absolute path to the skills directory
 * @returns Array of parsed skill definitions
 */
export async function loadSkills(dirPath: string): Promise<SkillDefinition[]> {
  let entries: string[]
  try {
    entries = await readdir(dirPath)
  } catch {
    return [] // Directory doesn't exist — no skills
  }

  const skillFiles = entries.filter(
    f => f.endsWith('.skill.md') || f === 'SKILL.md',
  )

  const results = await Promise.allSettled(
    skillFiles.map(file => loadSkillFile(join(dirPath, file))),
  )

  const skills: SkillDefinition[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      skills.push(result.value)
    }
  }

  return skills
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Load and parse a single SKILL.md file.
 */
async function loadSkillFile(filePath: string): Promise<SkillDefinition | null> {
  const raw = await readFile(filePath, 'utf-8')
  return parseSkillFile(raw)
}

/**
 * Parse a skill file's content into a SkillDefinition.
 * Exported for testing.
 */
export function parseSkillFile(raw: string): SkillDefinition | null {
  const { frontmatter, body } = parseFrontmatter(raw)
  if (!frontmatter || !body) return null

  const meta = parseYamlFrontmatter(frontmatter)
  if (!meta?.name || !meta?.trigger) return null

  const trigger: string | RegExp = meta.triggerIsRegex
    ? new RegExp(meta.trigger)
    : meta.trigger

  return {
    name: meta.name,
    description: meta.description ?? '',
    trigger,
    content: body.trim(),
    allowedTools: meta.allowedTools,
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Split a file into YAML frontmatter and markdown body.
 */
function parseFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: trimmed }
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return { frontmatter: null, body: trimmed }
  }

  const frontmatter = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 3).trim()

  return { frontmatter, body }
}

/**
 * Minimal YAML frontmatter parser.
 * Handles simple key: value pairs and arrays.
 * Not a full YAML parser — sufficient for skill metadata.
 */
function parseYamlFrontmatter(yaml: string): SkillFrontmatter | null {
  const result: Record<string, unknown> = {}

  const lines = yaml.split('\n')
  let currentKey = ''

  for (const line of lines) {
    // Array item
    const arrayMatch = line.match(/^\s+-\s+(.+)$/)
    if (arrayMatch && currentKey) {
      const arr = result[currentKey]
      if (Array.isArray(arr)) {
        arr.push(arrayMatch[1]!.trim())
      }
      continue
    }

    // Key: value
    const kvMatch = line.match(/^(\w+)\s*:\s*(.*)$/)
    if (kvMatch) {
      const key = kvMatch[1]!
      const value = (kvMatch[2] ?? '').trim()

      if (value === '' || value === '[]') {
        // Start of array or empty
        result[key] = []
        currentKey = key
      } else if (value === 'true') {
        result[key] = true
        currentKey = key
      } else if (value === 'false') {
        result[key] = false
        currentKey = key
      } else {
        // Remove surrounding quotes if present
        result[key] = value.replace(/^["']|["']$/g, '')
        currentKey = key
      }
    }
  }

  if (!result.name) return null

  return {
    name: result.name as string,
    description: (result.description as string) ?? '',
    trigger: (result.trigger as string) ?? '',
    triggerIsRegex: result.triggerIsRegex as boolean | undefined,
    allowedTools: result.allowedTools as string[] | undefined,
  }
}
