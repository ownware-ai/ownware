/**
 * @ownware/react — the Ownware chat kit for React.
 *
 * `useOwnwareAgent()` is the headless brain: it drives a live agent (run +
 * stream + resume) through the @ownware/ui reducer and hands you state +
 * actions. Build your own UI on it, or use the forthcoming <OwnwareChat>
 * drop-in (design-system-v2 skin, uiDescriptor tool cards, approval card).
 *
 * Re-exports the state types from @ownware/ui so consumers need one import.
 */

export { useOwnwareAgent } from './useOwnwareAgent.js'
export type {
  OwnwareAgent,
  UseOwnwareAgentOptions,
  AgentTransport,
} from './useOwnwareAgent.js'

export { OwnwareChat } from './components/OwnwareChat.js'
export type { OwnwareChatProps } from './components/OwnwareChat.js'
export { OwnwareStudio } from './components/OwnwareStudio.js'
export type { OwnwareStudioProps, StudioProfile } from './components/OwnwareStudio.js'
export { ownwareChatCss, ownwareStudioCss } from './components/styles.js'

export type {
  ChatState,
  ChatStatus,
  Message,
  ToolCall,
  ToolCallStatus,
  PendingApproval,
  AgentEvent,
} from '@ownware/ui'
