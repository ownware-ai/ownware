/**
 * Built-in Ask User Tool
 *
 * Lets the agent ask the user a question to clarify ambiguity,
 * gather preferences, or get decisions. This is engine-level —
 * ANY agent type needs the ability to ask for clarification.
 *
 * The actual user interaction is handled by the consumer (CLI, TUI, web)
 * through the ToolContext.requestPermission callback or a custom
 * interaction handler injected via config.
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'

export const askUser: Tool = defineTool({
  name: 'ask_user',
  description:
    'Ask the user a question to gather information or clarify ambiguity.\n' +
    '- Use when the task is ambiguous and you need clarification before proceeding.\n' +
    '- Use when you need the user to choose between multiple valid approaches.\n' +
    '- Do NOT use for rhetorical questions or confirmations you can figure out yourself.\n' +
    '- Do NOT ask multiple questions at once — ask the most important one first.\n' +
    '- Provide clear, specific options when possible.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'conversational',
    summary: { verb: 'Asked', primaryField: 'question' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user. Be specific and concise.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of choices. If provided, the user picks from these. ' +
          'If omitted, the user responds with free text.',
      },
      context: {
        type: 'string',
        description:
          'Optional context explaining why you need this information. ' +
          'Helps the user make an informed decision.',
      },
    },
    required: ['question'],
  },
  async execute(input, _context) {
    const { question, options, context: questionContext } = input as {
      question: string
      options?: string[]
      context?: string
    }

    // ── Fire-and-end-turn semantics ──────────────────────────────────
    //
    // Earlier revisions of this tool blocked on `context.requestPermission`
    // as a "wait for user" primitive. That was wrong in two ways:
    //
    //   1. The permission path in the loop only yields a
    //      `permission.request` LoomEvent when `tool.requiresPermission`
    //      is true AND the zone check returns 'ask'. Because ask_user
    //      sets `requiresPermission: false`, no event was ever emitted
    //      — the consumer UI had no idea the tool was parked, and the
    //      HITL ran to its 2-minute timeout every time.
    //   2. Permissions are not wait primitives. Asking the user a
    //      question is not a security decision.
    //
    // The correct model: return immediately with a clear "awaiting user
    // response" result. The model, seeing that result + the explicit
    // instruction in `content`, ends its turn. The user's answer
    // arrives as the next user message on the next run. The UI renders
    // the question (a client's question card, CLI's own prompt, etc.) from
    // the tool's input payload + `tool.call.start` event — not from a
    // permission event. The return content below is the *agent-facing*
    // signal; UIs ignore it and read `input.question` directly.
    //
    // If a model ever fails to end its turn after seeing this result
    // (empirically rare with frontier models), the session's max-turns
    // guard bounds the loop and the user's next message interrupts
    // cleanly via the normal path.

    return {
      content:
        `Question posed to the user: "${question}"` +
        (questionContext ? `\nContext shown to user: ${questionContext}` : '') +
        (options && options.length > 0
          ? `\nOptions offered: ${options.map((o, i) => `(${i + 1}) ${o}`).join(', ')}`
          : '') +
        `\n\nYour turn is now complete. End this turn and wait for the user's reply ` +
        `in their next message. Do not call more tools, do not generate prose. ` +
        `The user's next message IS the answer to this question.`,
      isError: false,
      metadata: { question, options, awaitingUserResponse: true },
    }
  },
})

export const askUserTools: Tool[] = [askUser]
