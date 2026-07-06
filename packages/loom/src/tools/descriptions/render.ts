/**
 * Tool Description Renderer
 *
 * Builds the markdown block for a single tool that gets dropped into
 * the system prompt. Two paths:
 *
 *   - When a `ToolDescription` is registered for the tool, emit the
 *     selected sections in canonical order under named sub-headings.
 *   - Otherwise, fall back to the legacy flat-description rendering
 *     (the existing `description: string` + parameter list).
 *
 * Backwards-compatible: tools without a registered description render
 * exactly as before.
 */

import type { Tool } from '../types.js'
import type {
  ToolDescription,
  ToolDescriptionSection,
  ToolDescriptionSections,
  ToolDescriptionSelection,
} from './types.js'
import { STANDARD_SECTIONS } from './types.js'

/**
 * Render a single tool's documentation block.
 *
 * @param tool - the tool definition (always provided)
 * @param desc - registered modular description, if any
 * @param selection - profile's section selection, if any
 */
export function renderToolDoc(
  tool: Tool,
  desc: ToolDescription | undefined,
  selection: ToolDescriptionSelection | undefined,
): string {
  if (desc) {
    return renderModular(tool, desc, selection)
  }
  return renderLegacy(tool)
}

// ---------------------------------------------------------------------------
// Modular path
// ---------------------------------------------------------------------------

function renderModular(
  tool: Tool,
  desc: ToolDescription,
  selection: ToolDescriptionSelection | undefined,
): string {
  const sectionsToInclude = pickSections(tool.name, desc.sections, selection)

  const lines: string[] = [`## ${tool.name}`]

  for (const name of STANDARD_SECTIONS) {
    if (!sectionsToInclude.has(name)) continue
    const body = desc.sections[name]
    if (body === undefined || body.trim().length === 0) continue
    if (name === 'overview') {
      // Overview is the lede — emit directly under the tool heading,
      // no sub-heading. Matches the legacy shape and keeps the prompt
      // density high for the most common section.
      lines.push(body.trim())
    } else {
      lines.push('', `### ${name}`, body.trim())
    }
  }

  // Capability flags (read-only / requires-permission) still rendered
  // verbatim — they're metadata about the tool, not part of the
  // prose description, and consumers rely on them.
  if (tool.isReadOnly) lines.push('(read-only, safe for parallel execution)')
  if (tool.requiresPermission) lines.push('(requires user permission)')

  // Parameters always emitted from the schema — modular descriptions
  // describe behaviour; the schema describes shape. Keeping schema
  // rendering here means a tool author cannot drift the prose
  // documentation away from the actual JSON-Schema input.
  const params = renderParameters(tool)
  if (params.length > 0) {
    lines.push('Parameters:')
    lines.push(...params)
  }

  return lines.join('\n')
}

function pickSections(
  toolName: string,
  available: ToolDescriptionSections,
  selection: ToolDescriptionSelection | undefined,
): ReadonlySet<ToolDescriptionSection> {
  // The canonical present-in-description section list — used when a
  // profile hasn't expressed a selection.
  const allPresent = new Set<ToolDescriptionSection>(
    STANDARD_SECTIONS.filter(name => available[name] !== undefined),
  )

  if (!selection) return allPresent

  const explicit =
    selection.perTool?.[toolName] ?? selection.default
  if (!explicit) return allPresent

  // Filter the explicit selection against what the description actually
  // ships — selecting `safety` on a tool with no safety section is a
  // no-op rather than an error.
  const selected = new Set<ToolDescriptionSection>()
  for (const name of explicit) {
    if (available[name] !== undefined) selected.add(name)
  }
  // Always include `overview` even if a profile forgot it. Without
  // overview, the model has no idea what the tool does.
  if (available.overview) selected.add('overview')
  return selected
}

// ---------------------------------------------------------------------------
// Legacy path (matches the pre-Phase-4 output exactly)
// ---------------------------------------------------------------------------

function renderLegacy(tool: Tool): string {
  const lines: string[] = [`## ${tool.name}`, tool.description]
  if (tool.isReadOnly) lines.push('(read-only, safe for parallel execution)')
  if (tool.requiresPermission) lines.push('(requires user permission)')
  const params = renderParameters(tool)
  if (params.length > 0) {
    lines.push('Parameters:')
    lines.push(...params)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Shared parameter rendering
// ---------------------------------------------------------------------------

function renderParameters(tool: Tool): string[] {
  const schema = tool.inputSchema
  if (!schema || typeof schema !== 'object' || !('properties' in schema)) return []
  const props = schema.properties as Record<string, { description?: string; type?: string }>
  const required = new Set((schema.required as string[]) ?? [])
  return Object.entries(props).map(([name, prop]) => {
    const req = required.has(name) ? ' (required)' : ''
    const desc = prop.description ? `: ${prop.description}` : ''
    return `  - ${name}${req}${desc}`
  })
}
