/**
 * Tool Description Parser
 *
 * Parses a markdown source into a `ToolDescription`. The format mirrors
 * the conventions Cortex profiles already use for skills:
 *
 *   ---
 *   name: <tool-name>
 *   ---
 *
 *   ## overview
 *   <body>
 *
 *   ## usage
 *   <body>
 *
 *   ## safety
 *   <body>
 *
 * Section names outside the standard taxonomy throw — typos are caught
 * at parse time rather than silently dropped.
 *
 * Loom never reads .md files from disk for builtin tool descriptions
 * (those are TS objects under `builtins/descriptions/`). The parser
 * exists for Cortex to load profile- or plugin-supplied descriptions
 * from disk into the same `ToolDescription` shape.
 */

import type {
  ToolDescription,
  ToolDescriptionSection,
  ToolDescriptionSections,
} from './types.js'

const FRONTMATTER_FENCE = '---'
const SECTION_HEADING = /^##\s+([a-z][a-z0-9-]*)\s*$/

const SECTION_NAMES: readonly ToolDescriptionSection[] = [
  'overview',
  'usage',
  'safety',
  'parallel',
  'alternatives',
  'examples',
]

const SECTION_NAME_SET = new Set<string>(SECTION_NAMES)

function isSection(value: string): value is ToolDescriptionSection {
  return SECTION_NAME_SET.has(value)
}

/**
 * Parse a markdown document into a `ToolDescription`. Throws on
 * malformed input — missing frontmatter `name`, missing `overview`
 * section, or unknown section names.
 */
export function parseToolDescription(source: string): ToolDescription {
  const { frontmatter, body } = splitFrontmatter(source)

  const name = readFrontmatterField(frontmatter, 'name')
  if (!name) {
    throw new Error('Tool description is missing required `name` in frontmatter.')
  }

  const sections = parseBody(body)
  if (!sections.overview) {
    throw new Error(
      `Tool description "${name}" is missing the required \`## overview\` section.`,
    )
  }

  return { name, sections }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface SplitResult {
  readonly frontmatter: string
  readonly body: string
}

function splitFrontmatter(source: string): SplitResult {
  const trimmed = source.replace(/^﻿/, '') // strip BOM if present
  if (!trimmed.startsWith(FRONTMATTER_FENCE)) {
    return { frontmatter: '', body: trimmed }
  }
  const closingIdx = trimmed.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length)
  if (closingIdx === -1) {
    throw new Error('Tool description frontmatter is not closed with `---`.')
  }
  const frontmatter = trimmed.slice(FRONTMATTER_FENCE.length, closingIdx).trim()
  const body = trimmed.slice(closingIdx + FRONTMATTER_FENCE.length + 1).trim()
  return { frontmatter, body }
}

function readFrontmatterField(frontmatter: string, key: string): string | null {
  if (!frontmatter) return null
  const lines = frontmatter.split('\n')
  for (const line of lines) {
    const match = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (match && match[1] === key) {
      const value = match[2] ?? ''
      const cleaned = value.replace(/^['"]|['"]$/g, '').trim()
      return cleaned.length > 0 ? cleaned : null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function parseBody(body: string): ToolDescriptionSections {
  if (!body.trim()) {
    throw new Error('Tool description body is empty — at least an `## overview` section is required.')
  }

  const lines = body.split('\n')
  const collected: Partial<Record<ToolDescriptionSection, string[]>> = {}
  let current: ToolDescriptionSection | null = null

  for (const rawLine of lines) {
    const headingMatch = SECTION_HEADING.exec(rawLine)
    if (headingMatch) {
      const name = headingMatch[1]!.toLowerCase()
      if (!isSection(name)) {
        throw new Error(
          `Unknown tool description section "${name}". Expected one of: ${SECTION_NAMES.join(', ')}.`,
        )
      }
      if (collected[name] !== undefined) {
        throw new Error(`Duplicate tool description section: "${name}".`)
      }
      collected[name] = []
      current = name
      continue
    }

    if (current !== null) {
      collected[current]!.push(rawLine)
    }
  }

  // Build the result, trimming each section's body and dropping
  // empty/whitespace-only sections.
  const sections: { -readonly [K in ToolDescriptionSection]?: string } = {}
  for (const name of SECTION_NAMES) {
    const lines = collected[name]
    if (lines === undefined) continue
    const text = lines.join('\n').trim()
    if (text.length === 0) continue
    sections[name] = text
  }

  // `overview` is required at the type level; assert at runtime.
  if (sections.overview === undefined) {
    throw new Error('Tool description is missing the required `## overview` section.')
  }

  return sections as ToolDescriptionSections
}
