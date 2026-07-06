/**
 * `ask` — the designer's one way to ask the user clarifying questions.
 *
 * Design-scoped on purpose. The generic `ask_user` builtin is denied for this
 * profile (see agent.json `tools.deny`) so the agent has exactly ONE way to ask
 * — this one — with a richer, options-first, *batched* schema and design
 * guidance baked into the description.
 *
 * Mechanism mirrors the `ask_user` builtin's **fire-and-end-turn** model
 * (loom `tools/builtins/ask-user.ts`): the tool returns immediately with an
 * "await the user's reply" result; the model ends its turn; the user's next
 * message carries the answers and the next run continues. There is NO
 * suspend/resume — the loop is not parked. The client renders the question form
 * from this tool's call input (uiDescriptor `kind: 'conversational'` opts it
 * out of inline-row rendering; the Design product's tool-renderer registry
 * keys on the tool name `ask` to draw the batched canvas form).
 *
 * Auto-discovered by Cortex: any valid Tool export under the profile's
 * `tools/` directory is registered with no agent.json entry needed.
 */

import { defineTool } from '@ownware/loom'

const DESCRIPTION = `Ask the user 1–5 clarifying questions as a SINGLE batched form shown on the design canvas. This is how you ask — do not ask in prose.

## When to use
- AFTER you've drafted something the user can see (a first cover, a hero, a rough page) and you've hit a real fork that changes the output. Show first, then ask.
- At the start of a non-trivial brief when the lobby/conversation hasn't already pinned the direction — bundle every open question into ONE ask. Never drip questions one message at a time.
- When a decision is genuinely the user's (tone, accent, scope, what to avoid) and a wrong guess would waste a whole build.

## When NOT to use
- Never open with this. Don't interrogate before showing a single pixel.
- Don't ask what the lobby brief or the conversation already answered.
- Don't ask what you can reasonably decide yourself with a documented default — pick the default and say what you chose. Only ask when the answer truly changes the work.
- Don't both call this tool AND ask the same thing in prose. This tool IS the question.

## How to write good questions
- Batch up to 5 RELATED questions into one form. Fewer is better. Order them most-important first.
- EVERY single/multi/swatch question gives concrete options the user taps — never make them compose prose. \`kind: "text"\` (free typing) is the last-resort escape, not the default.
- Mark one option as \`default\` (your recommended pick / "decide for me") so the user can skip the whole form with confidence.
- \`helper\` explains the CHOICE in one short line ("Bigger, fewer words — more statement than article"). Never explain your internal rules.
- On subjective calls, include a "Decide for me" / "Let the designer pick" option.
- kinds: \`single\` (pick one), \`multi\` (pick any), \`swatch\` (pick ONE of a fixed set of named colours — each option carries a \`color\` hex), \`colorpicker\` (the user picks ANY colour via a real picker; your \`options\` become recommended quick-pick chips beside it and \`default\` seeds the picker), \`text\` (free-text escape, no options).

## Picking a colour: swatch vs colorpicker
- Use \`swatch\` when you want the user to choose from a SMALL CURATED SET you stand behind ("these three accents fit the brand"). They can't go off-list.
- Use \`colorpicker\` when the user should be able to choose ANY colour — a brand hex, an exact shade. Still give 2–4 \`options\` as recommended starting points (rendered as quick chips) and set \`default\` to your top pick. The user can tap a chip OR open the picker for any colour.

## What happens next
Calling this tool ENDS your turn. The form appears on the canvas; the user answers (or skips) and their reply arrives as the next user message, shaped roughly:
\`{ "answers": { "<questionId>": <string | string[] | text> }, "skipped": ["<questionId>", ...] }\`
Read it, act on it, and keep moving. For any skipped question, proceed with the \`default\` you set and briefly say what you chose. Do not re-confirm each answer.`

export const ASK_TOOL = defineTool({
  name: 'ask',
  description: DESCRIPTION,
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'conversational',
    summary: { verb: 'Asked', primaryField: 'intro' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      intro: {
        type: 'string',
        description:
          'Optional one-line header for the form, e.g. "Cover\'s drafted — lock the direction before I build the rest."',
      },
      note: {
        type: 'string',
        description:
          'Optional sub-line under the header. Good place to say the form is skippable and you\'ll choose sensible defaults.',
      },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        description:
          'The questions, batched into one form. 1–5 related questions. Fewer is better. Order them most-important first.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Stable short id used to key the answer back to you, e.g. "headline-energy". Lowercase kebab-case.',
            },
            title: { type: 'string', description: 'The question itself, in plain language.' },
            helper: {
              type: 'string',
              description:
                'Optional one-line explanation of the CHOICE (not your rules). Helps the user pick fast.',
            },
            kind: {
              type: 'string',
              enum: ['single', 'multi', 'swatch', 'colorpicker', 'text'],
              description:
                'single = pick one · multi = pick any · swatch = pick one of a fixed set of named colours (options carry color hex) · colorpicker = pick ANY colour via a real picker, options are recommended quick-pick chips · text = free-text escape (no options).',
            },
            options: {
              type: 'array',
              description:
                'Required for single/multi/swatch — at least 2 concrete choices. For colorpicker, 2–4 recommended colours shown as quick chips beside the picker. Omit only for kind="text".',
              items: {
                type: 'object',
                properties: {
                  value: { type: 'string', description: 'Stable value returned when chosen.' },
                  label: { type: 'string', description: 'What the user sees on the chip.' },
                  desc: {
                    type: 'string',
                    description: 'Optional one-line description shown under the label.',
                  },
                  color: {
                    type: 'string',
                    description:
                      'For kind="swatch": the hex colour this option represents, e.g. "#7C5CFC".',
                  },
                },
                required: ['value', 'label'],
              },
            },
            default: {
              type: 'string',
              description:
                'The `value` of your recommended option — the "decide for me" pick used when the user skips. Strongly encouraged on every question.',
            },
            freeText: {
              type: 'boolean',
              description:
                'When true, also show an optional "Other…" free-text field beneath the options. Default false.',
            },
          },
          required: ['id', 'title', 'kind'],
        },
      },
    },
    required: ['questions'],
  },
  // Fire-and-end-turn — identical model to the `ask_user` builtin. The UI reads
  // the structured questions from this call's input + the metadata below; this
  // `content` is the agent-facing signal to stop and wait for the user's reply.
  async execute(input) {
    const { questions } = input as {
      questions?: Array<{ id?: string; title?: string }>
    }
    const count = Array.isArray(questions) ? questions.length : 0
    return {
      content:
        `Posed ${count} question${count === 1 ? '' : 's'} to the user as a form on the canvas. ` +
        `Your turn is now complete. End this turn and wait for the user's reply in their next ` +
        `message — it carries their answers (and any skipped questions, for which you use the ` +
        `default you set). Do not call more tools or generate prose now.`,
      isError: false,
      metadata: { questions: questions ?? [], awaitingUserResponse: true },
    }
  },
})
