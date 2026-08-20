/**
 * @ownware/react — the Ownware chat kit for React.
 *
 * `useOwnwareAgent()` is the headless brain: it drives a live agent (run +
 * hydration + run stream + exact actions) through the @ownware/ui reducer and hands you state +
 * actions. Build your own UI on it, or use the <OwnwareChat> drop-in with
 * descriptor-driven tool cards and explicit approval handling.
 *
 * Re-exports the state types from @ownware/ui so consumers need one import.
 */

export { useOwnwareAgent } from './useOwnwareAgent.js'
export type {
  OwnwareAgent,
  OwnwareAgentEvidence,
  OwnwareAgentSupport,
  SendOptions,
  UseOwnwareAgentOptions,
  AgentTransport,
} from './useOwnwareAgent.js'

export {
  OwnwareChat,
  ConnectionStatus,
  RunEvidenceSummary,
  ToolEvidenceStatus,
  PermissionDecision,
  SensitiveInputRequest,
  SkillActivationEvidence,
  ReversalOfferAction,
} from './components/OwnwareChat.js'
export type { OwnwareChatProps } from './components/OwnwareChat.js'
export { OwnwareStudio } from './components/OwnwareStudio.js'
export type { OwnwareStudioProps, StudioProfile } from './components/OwnwareStudio.js'
export { ChatGPTConnection } from './components/ChatGPTConnection.js'
export type {
  ChatGPTConnectionClient,
  ChatGPTConnectionProps,
} from './components/ChatGPTConnection.js'
export {
  ownwareChatCss,
  ownwareConnectionCss,
  ownwareStudioCss,
} from './components/styles.js'

export type {
  ChatState,
  ChatStatus,
  Message,
  MessagePart,
  ToolCall,
  ToolCallStatus,
  PendingApproval,
  PendingSensitiveInput,
  ProjectionResource,
  CapabilitySupport,
  RunConsequenceProjection,
  ToolEffectProjection,
  EgressProjection,
  SkillPlacementProjection,
  ReversalProjection,
  AgentEvent,
} from '@ownware/ui'
