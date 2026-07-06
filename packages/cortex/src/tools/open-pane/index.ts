/**
 * `open_pane` tool — barrel.
 *
 * Slice 3.2c shipped the contract layer (types + schemas + the
 * `narrowPaneConfigSchema` helper). Slice 3.3 added the runtime tool
 * factory `createOpenPaneTool(...)` which the profile assembler
 * injects per session.
 */

export {
  OPEN_PANE_TOOL_NAME,
  type OpenPaneToolInput,
  type OpenPaneToolResult,
  type OpenPaneToolFailure,
  type OpenPaneToolError,
  type OpenPaneToolResponse,
} from './types.js'

export {
  OpenPaneToolInputSchema,
  type OpenPaneToolInputParsed,
  narrowPaneConfigSchema,
  PaneKindSchema,
  PANE_KINDS,
} from './schema.js'

export {
  createOpenPaneTool,
  type CreateOpenPaneToolOptions,
} from './tool.js'
