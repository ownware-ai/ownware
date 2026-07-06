/**
 * Tool Descriptions — public API
 *
 * Modular replacement for a tool's flat `description: string`. See
 * ./types.ts for the design overview.
 */

export type {
  ToolDescription,
  ToolDescriptionSections,
  ToolDescriptionSection,
  ToolDescriptionSelection,
} from './types.js'

export { STANDARD_SECTIONS } from './types.js'

export { ToolDescriptionRegistry } from './registry.js'

export { parseToolDescription } from './parser.js'

export { renderToolDoc } from './render.js'
