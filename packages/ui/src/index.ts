/**
 * @ownware/ui — the headless core of the Ownware chat kit.
 *
 * The framework-agnostic brain: a pure reducer that turns the gateway's SSE
 * event stream into `ChatState`. Feed it @ownware/client's `.events(runId)`;
 * render the resulting state however you like. The React binding
 * (@ownware/react) and terminal clients build on the same state model.
 *
 *   import { OwnwareClient } from '@ownware/client'
 *   import { initialChatState, chatReducer } from '@ownware/ui'
 *
 *   let state = initialChatState()
 *   const client = new OwnwareClient({ baseUrl, token })
 *   const run = await client.run({ profileId: 'assistant', prompt: 'hi' })
 *   for await (const ev of client.events(run.runId ?? run.threadId, { since: state.lastSeq })) {
 *     state = chatReducer(state, ev)   // → messages, streaming, toolCalls, pendingApproval
 *     render(state)
 *   }
 */

export type {
  AgentEvent,
  ChatState,
  ChatStatus,
  Message,
  MessagePart,
  ToolCall,
  ToolCallStatus,
  PendingApproval,
  PendingSensitiveInput,
  SkillActivationEvidence,
  StreamProjection,
  StreamProjectionPhase,
} from './types.js'

export {
  initialChatState,
  chatReducer,
  applyEvents,
  addUserMessage,
  seedReplayCursor,
} from './reducer.js'

export type {
  ToolUIKind,
  ToolUISummary,
  ToolUIPreview,
  ToolUIOpenAction,
  ToolUIDescriptor,
  ToolRender,
} from './descriptors.js'
export { describeToolCall, normalizeToolUIDescriptor } from './descriptors.js'

export type { HydratedToolCall, HydratedMessage, ChatHydration } from './hydration.js'
export { hydrateChatState } from './hydration.js'

export * from './projection.js'
