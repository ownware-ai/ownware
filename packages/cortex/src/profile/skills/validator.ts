/**
 * Skill Validator
 *
 * Strict, fail-loud validation for an installation boundary. Distinct
 * from {@link parseSkillFile} in the loader (which is best-effort: a
 * malformed skill is silently dropped from the runtime catalog). Here a
 * malformed skill produces a typed error code, surfaced to the user.
 *
 * Frontmatter contract (compatible with both Cortex and Anthropic Claude
 * skill formats):
 *   - name (required, 1–60 chars)
 *   - description (required, 1–280 chars)
 *   - trigger (optional, defaults to `/<slug>`)
 *   - any additional fields are preserved on disk but ignored by validation
 */

import YAML from 'yaml'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_NAME_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 280
export const MAX_FILE_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SkillValidationErrorCode =
  | 'TOO_LARGE'
  | 'MALFORMED_FRONTMATTER'
  | 'INVALID_YAML'
  | 'MISSING_OR_INVALID_NAME'
  | 'MISSING_OR_INVALID_DESCRIPTION'
  | 'UNSAFE_NAME'
  | 'EMPTY_BODY'

export class SkillValidationError extends Error {
  readonly code: SkillValidationErrorCode
  constructor(code: SkillValidationErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'SkillValidationError'
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ValidatedSkill {
  /** Filename slug, derived from `name`. Matches /^[a-zA-Z0-9_-]+$/. */
  readonly slug: string
  /** Frontmatter `name` field, verbatim. */
  readonly name: string
  /** Frontmatter `description` field, verbatim. */
  readonly description: string
  /** Frontmatter `trigger` if provided, else `/<slug>`. */
  readonly trigger: string
  /** Body of the skill (everything after the closing `---`), trimmed. */
  readonly body: string
  /** Raw frontmatter object, useful when re-emitting the file. */
  readonly frontmatter: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

export function validateSkillContent(content: string): ValidatedSkill {
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
    throw new SkillValidationError(
      'TOO_LARGE',
      `Skill exceeds ${MAX_FILE_BYTES} bytes.`,
    )
  }

  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new SkillValidationError(
      'MALFORMED_FRONTMATTER',
      'Skill is missing a `---` frontmatter block at the top of the file.',
    )
  }
  const frontmatterStr = match[1] ?? ''
  const bodyRaw = match[2] ?? ''

  let frontmatter: Record<string, unknown>
  try {
    const parsed = YAML.parse(frontmatterStr) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('frontmatter must be a YAML mapping')
    }
    frontmatter = parsed as Record<string, unknown>
  } catch (err) {
    throw new SkillValidationError(
      'INVALID_YAML',
      `Skill frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const name = readString(frontmatter, 'name')
  if (!name || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new SkillValidationError(
      'MISSING_OR_INVALID_NAME',
      `\`name\` must be a non-empty string of 1–${MAX_NAME_LENGTH} characters.`,
    )
  }

  const description = readString(frontmatter, 'description')
  if (
    !description ||
    description.length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw new SkillValidationError(
      'MISSING_OR_INVALID_DESCRIPTION',
      `\`description\` must be a non-empty string of 1–${MAX_DESCRIPTION_LENGTH} characters.`,
    )
  }

  const slug = deriveSlug(name)
  if (slug.length === 0 || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new SkillValidationError(
      'UNSAFE_NAME',
      'Skill name produces an empty or unsafe filename. Use letters, numbers, hyphens, or underscores.',
    )
  }

  const triggerRaw = readString(frontmatter, 'trigger')
  const trigger = triggerRaw && triggerRaw.length > 0 ? triggerRaw : `/${slug}`

  const body = bodyRaw.trim()
  if (body.length === 0) {
    throw new SkillValidationError(
      'EMPTY_BODY',
      'Skill has no body content under the frontmatter.',
    )
  }

  return { slug, name, description, trigger, body, frontmatter }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a string field from frontmatter, trimming. Null if absent or wrong type. */
function readString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | null {
  const v = frontmatter[key]
  if (typeof v !== 'string') return null
  return v.trim()
}

/**
 * Derive a filesystem-safe slug from a skill `name`. Lowercases, swaps
 * whitespace runs for `-`, drops anything not matching the safe charset.
 */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
}
