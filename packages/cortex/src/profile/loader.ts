/**
 * Profile Loader
 *
 * Loads a complete agent profile from a directory on disk.
 * Validates everything at load time — no silent failures at runtime.
 *
 * Profile directory structure:
 *   profile-name/
 *   ├── agent.json (or agent.yaml)
 *   ├── SOUL.md (system prompt)
 *   ├── AGENTS.md (memory)
 *   ├── skills/ (skill files)
 *   └── tools/ (custom tool files)
 */

import { readFile, readdir, stat } from 'fs/promises'
import { join, resolve } from 'path'
import YAML from 'yaml'
import { ProfileSchema } from './schema.js'
import type { ProfileConfig } from './schema.js'
import { parseTimeout } from './timeout.js'
import type { SkillDefinition } from '@ownware/loom'

// ---------------------------------------------------------------------------
// LoadedProfile — the fully resolved profile, ready for assembly
// ---------------------------------------------------------------------------

export interface LoadedProfile {
  /** Validated profile config */
  readonly config: ProfileConfig
  /** SOUL.md contents (system prompt) */
  readonly soulMd: string | null
  /** AGENTS.md contents (memory) */
  readonly agentsMd: string | null
  /** Loaded skill definitions */
  readonly skills: SkillDefinition[]
  /** Absolute path to the profile directory */
  readonly basePath: string
  /** Parsed timeout in milliseconds */
  readonly timeoutMs: number
}

// ---------------------------------------------------------------------------
// Load a profile from a directory
// ---------------------------------------------------------------------------

/**
 * Load and fully validate a profile from a directory.
 *
 * Steps:
 * 1. Read agent.json or agent.yaml
 * 2. Validate with Zod schema
 * 3. Load SOUL.md and AGENTS.md
 * 4. Discover and load skills
 * 5. Validate all file references exist
 * 6. Resolve env vars in MCP configs
 * 7. Parse timeout
 *
 * @param dirPath - Path to the profile directory
 * @returns A fully validated LoadedProfile
 * @throws Error with descriptive message on any validation failure
 */
export async function loadProfile(dirPath: string): Promise<LoadedProfile> {
  const basePath = resolve(dirPath)

  // 1. Read config file (JSON takes priority over YAML)
  const rawConfig = await readConfigFile(basePath)

  // 2. Validate with Zod
  const config = validateConfig(rawConfig, basePath)

  // 3. Load SOUL.md
  const soulMd = await tryRead(join(basePath, 'SOUL.md'))

  // 4. Load AGENTS.md
  const agentsMd = await tryRead(join(basePath, 'AGENTS.md'))

  // 5. Discover and load skills
  const skills = await loadSkills(basePath, config.skills.dirs)

  // 6. Validate custom tool file references exist
  await validateCustomToolPaths(config.tools.custom, basePath)

  // 7. (intentional no-op) MCP env-var resolution moved to assembly time.
  //    Previously the loader called `validateMCPEnvVars` here which threw
  //    if any ${VAR} reference in any MCP server config wasn't already in
  //    process.env. That broke the entire profile load whenever a single
  //    credential was missing or stored only in the credential store.
  //    The assembler now resolves per-server with credentialStore as the
  //    fallback and skips the individual server on failure — the rest of
  //    the profile keeps working. See profile/assembler.ts:connectMCPServers.

  // 8. Parse timeout
  const timeoutMs = parseTimeout(config.execution.timeout)

  return { config, soulMd, agentsMd, skills, basePath, timeoutMs }
}

// ---------------------------------------------------------------------------
// Config file reading
// ---------------------------------------------------------------------------

async function readConfigFile(basePath: string): Promise<unknown> {
  // JSON takes priority
  const jsonPath = join(basePath, 'agent.json')
  const yamlPath = join(basePath, 'agent.yaml')
  const ymlPath = join(basePath, 'agent.yml')

  const jsonContent = await tryRead(jsonPath)
  if (jsonContent !== null) {
    try {
      return JSON.parse(jsonContent) as unknown
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${jsonPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Check for trailing commas, missing quotes, or syntax errors.`,
      )
    }
  }

  const yamlContent = await tryRead(yamlPath) ?? await tryRead(ymlPath)
  if (yamlContent !== null) {
    try {
      return YAML.parse(yamlContent) as unknown
    } catch (err) {
      throw new Error(
        `Invalid YAML in agent.yaml: ${err instanceof Error ? err.message : String(err)}.`,
      )
    }
  }

  throw new Error(
    `No agent.json or agent.yaml found in ${basePath}. ` +
    `Create an agent.json file to define this profile.`,
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(raw: unknown, basePath: string): ProfileConfig {
  const result = ProfileSchema.safeParse(raw)

  if (!result.success) {
    const issues = result.error.issues.map(issue => {
      const path = issue.path.join('.')
      return `  - ${path || 'root'}: ${issue.message}`
    })

    throw new Error(
      `Invalid profile config in ${basePath}/agent.json:\n${issues.join('\n')}\n\n` +
      `Fix the fields above and try again.`,
    )
  }

  return result.data
}

async function validateCustomToolPaths(
  custom: ProfileConfig['tools']['custom'],
  basePath: string,
): Promise<void> {
  for (const entry of custom) {
    const absolutePath = resolve(basePath, entry.path)
    try {
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile()) {
        throw new Error(
          `Custom tool path "${entry.path}" is a directory, not a file. ` +
          `Point to a .ts or .js file that exports Tool objects.`,
        )
      }
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new Error(
          `Custom tool file "${entry.path}" not found (expected at: ${absolutePath}). ` +
          `Check the path in your agent.json "tools.custom" section.`,
        )
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Skills loading
// ---------------------------------------------------------------------------

async function loadSkills(
  basePath: string,
  skillDirs: string[],
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  for (const dir of skillDirs) {
    const skillPath = resolve(basePath, dir)
    const entries = await safeReaddir(skillPath)

    for (const entry of entries) {
      const fullPath = join(skillPath, entry)

      // Layout 1 (legacy / flat): <dir>/<name>.md
      if (entry.endsWith('.md')) {
        const fileStat = await safeStatLoader(fullPath)
        if (!fileStat?.isFile()) continue
        const content = await tryRead(fullPath)
        if (content === null) continue
        const skill = parseSkillFile(content, entry)
        if (skill) skills.push(skill)
        continue
      }

      // Layout 2 (current / nested): <dir>/<slug>/SKILL.md
      const dirStat = await safeStatLoader(fullPath)
      if (!dirStat?.isDirectory()) continue
      const skillFile = await findSkillFile(fullPath)
      if (skillFile === null) continue
      const content = await tryRead(skillFile.path)
      if (content === null) continue
      // Use the slug (folder name) as the filename hint so default name
      // becomes the slug, not the file's literal name.
      const skill = parseSkillFile(content, `${entry}.md`)
      if (!skill) continue
      // .disabled marker = skill stays on disk but is inactive at runtime.
      // The UI still sees it (so the user can re-enable from the toggle);
      // the assembler filters it out before it reaches the system prompt.
      const disabled = await fileExistsLoader(join(fullPath, '.disabled'))
      skills.push(disabled ? { ...skill, active: false } : { ...skill, active: true })
    }
  }

  return skills
}

async function fileExistsLoader(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

async function safeStatLoader(p: string) {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

/** Find the SKILL.md (case-insensitive) inside a skill folder. */
async function findSkillFile(
  folderPath: string,
): Promise<{ path: string } | null> {
  const entries = await safeReaddir(folderPath)
  for (const entry of entries) {
    if (entry.toLowerCase() === 'skill.md') {
      return { path: join(folderPath, entry) }
    }
  }
  return null
}

/**
 * Parse a SKILL.md file with YAML frontmatter.
 *
 * Format:
 * ```
 * ---
 * name: my-skill
 * description: Does something
 * trigger: /my-skill
 * ---
 * <skill content>
 * ```
 */
function parseSkillFile(content: string, filename: string): SkillDefinition | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) return null

  const frontmatterStr = frontmatterMatch[1]
  const body = frontmatterMatch[2]

  if (!frontmatterStr || body === undefined) return null

  let frontmatter: Record<string, unknown>
  try {
    frontmatter = YAML.parse(frontmatterStr) as Record<string, unknown>
  } catch (err) {
    // A malformed frontmatter previously dropped the skill silently, leaving
    // the user with a missing slash command and no clue why. Surface it.
    // Common cause: an unquoted colon-space (`description: foo: bar`) parses
    // as a nested key. Wrap descriptions in single quotes to be safe.
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[ownware] Skipping skill ${filename}: invalid YAML frontmatter — ${message}`)
    return null
  }

  const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : filename.replace(/\.md$/, '')
  const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : ''
  const trigger = typeof frontmatter['trigger'] === 'string' ? frontmatter['trigger'] : `/${name}`

  return {
    name,
    description,
    trigger,
    content: body.trim(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tryRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function safeReaddir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath)
  } catch {
    return []
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
