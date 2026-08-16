/**
 * @ownware/ui — the headless core of the Ownware chat kit.
 *
 * The framework-agnostic brain: a pure reducer that turns the gateway's SSE
 * event stream into `ChatState`. Feed it @ownware/client's `.events(threadId)`;
 * render the resulting state however you like. The React binding
 * (@ownware/react) and terminal clients build on the same state model.
 *
 *   import { OwnwareClient } from '@ownware/client'
 *   import { initialChatState, chatReducer } from '@ownware/ui'
 *
 *   let state = initialChatState()
 *   const client = new OwnwareClient({ baseUrl, token })
 *   const { threadId } = await client.run({ profileId: 'assistant', prompt: 'hi' })
 *   for await (const ev of client.events(threadId, { since: state.lastSeq })) {
 *     state = chatReducer(state, ev)   // → messages, streaming, toolCalls, pendingApproval
 *     render(state)
 *   }
 */

export type {
  AgentEvent,
  ChatState,
  ChatStatus,
  Message,
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
export { BUILTIN_DESCRIPTORS, describeToolCall } from './descriptors.js'

export * from './projection.js'
