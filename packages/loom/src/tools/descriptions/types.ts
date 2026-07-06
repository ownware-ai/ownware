/**
 * Tool Description Types
 *
 * A modular alternative to a tool's flat `description: string`. Each
 * tool ships a structured description split into named sections:
 *
 *   overview      → what the tool does (1–2 sentences). REQUIRED.
 *   usage         → bullet list of usage rules and parameter prose.
 *   safety        → destructive ops, side effects, things to never do.
 *   parallel      → concurrency guidance — read-only / serial / async.
 *   alternatives  → when to prefer a different tool.
 *   examples      → concrete usage patterns.
 *
 * Profiles select which sections to include via `ToolDescriptionSelection`.
 * Defaults to "all sections present in the description." A read-only
 * research agent can drop `safety` for `bash`-style tools where the
 * destructive-ops paragraph isn't relevant; a coding agent keeps it.
 *
 * Loom owns the section taxonomy; Cortex owns the per-profile selection.
 */

// ---------------------------------------------------------------------------
// Section names
// ---------------------------------------------------------------------------

/**
 * The fixed taxonomy of section names. Six is the cap on purpose — finer
 * granularity (CC's bash-* explosion into 45 files) buys little once
 * profiles are the unit of variation. Adding a new section is a public-API
 * change.
 */
export type ToolDescriptionSection =
  | 'overview'
  | 'usage'
  | 'safety'
  | 'parallel'
  | 'alternatives'
  | 'examples'

/** Canonical ordering for prompt rendering. `overview` always first. */
export const STANDARD_SECTIONS: readonly ToolDescriptionSection[] = [
  'overview',
  'usage',
  'safety',
  'parallel',
  'alternatives',
  'examples',
] as const

// ---------------------------------------------------------------------------
// Description shape
// ---------------------------------------------------------------------------

/**
 * Structured replacement for a tool's flat `description: string`. The
 * `overview` section is required (every tool needs at least a one-line
 * summary). All other sections are optional — a tool with no
 * destructive ops simply omits `safety`.
 *
 * `name` matches the `Tool.name` it describes; the registry indexes by
 * it. The fields shipped here override the tool's flat description for
 * profiles that have this description registered.
 */
export interface ToolDescription {
  readonly name: string
  readonly sections: ToolDescriptionSections
}

export interface ToolDescriptionSections {
  readonly overview: string
  readonly usage?: string
  readonly safety?: string
  readonly parallel?: string
  readonly alternatives?: string
  readonly examples?: string
}

// ---------------------------------------------------------------------------
// Profile-side selection
// ---------------------------------------------------------------------------

/**
 * Which sections a profile wants to include for which tools.
 *
 *   `default`  — sections to include when a tool has no per-tool override.
 *                Undefined = include every section the description ships.
 *   `perTool`  — override the default for specific tools by name.
 *
 * Section names not present in a tool's description are silently ignored
 * — selecting `safety` for a tool that doesn't define a safety section
 * is not an error, it just emits nothing for that section.
 *
 * Cortex puts this on `agent.json` as `toolDescriptions`.
 */
export interface ToolDescriptionSelection {
  readonly default?: readonly ToolDescriptionSection[]
  readonly perTool?: Readonly<Record<string, readonly ToolDescriptionSection[]>>
}
