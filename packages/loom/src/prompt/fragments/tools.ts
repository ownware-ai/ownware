/**
 * Tools Fragment
 *
 * Two prompt sections in the tools slot:
 * 1. Tool usage rules — WHEN to use each tool (shared by all profiles)
 * 2. Available tool documentation — auto-generated from tool definitions
 *
 * Usage rules cover the cross-tool patterns that have the highest
 * impact on output quality: dedicated tools over shell, parallel tool
 * calls, read-before-edit, unique-old-string, safe deletions, and
 * when to reach for a subagent.
 */

import type { PromptFragment } from '../types.js'
import type { Tool } from '../../tools/types.js'
import type {
  ToolDescriptionSelection,
} from '../../tools/descriptions/types.js'
import type { ToolDescriptionRegistry } from '../../tools/descriptions/registry.js'
import { renderToolDoc } from '../../tools/descriptions/render.js'

// ---------------------------------------------------------------------------
// Tool usage rules (engine-level, same for all profiles)
// ---------------------------------------------------------------------------

/**
 * Create a fragment with tool usage rules.
 */
export function createToolUsageFragment(
  tools: Tool[],
  label = 'tool-usage-rules',
): PromptFragment {
  const hasFilesystem = tools.some(t => t.category === 'filesystem')
  const hasShell = tools.some(t => t.category === 'shell')
  const hasAgentSpawn = tools.some(t => t.name === 'agent_spawn')
  const hasTodoWrite = tools.some(t => t.name === 'todo_write')
  const hasConnectors = tools.some(t => t.name === 'connectors')

  const lines: string[] = ['# Using your tools']

  if (hasFilesystem && hasShell) {
    lines.push(
      '',
      'Prefer dedicated tools over shell commands. Dedicated tools produce structured output the user can review; shell equivalents hide what you did in a blob of stdout.',
      '- Read files → `readFile` (not `cat`, `head`, `tail`, `sed`)',
      '- Edit files → `editFile` (not `sed`, `awk`)',
      '- Create files → `writeFile` (not `echo >`, `cat <<EOF`)',
      '- Find files → `glob` (not `find`, `ls`)',
      '- Search content → `grep` (not the `grep` or `rg` shell command)',
      '- Reserve shell execution for system commands only: running tests, installing packages, git operations, build tools.',
    )
  }

  lines.push(
    '',
    'General rules:',
    '- Call multiple tools in a single response when they don\'t depend on each other. Parallel tool calls cut latency and token cost.',
    '- If one call depends on another\'s output, run them sequentially. Never guess parameters from an unfinished call.',
    '- Read a file before editing it. Always.',
    '- Don\'t propose changes to code you haven\'t read.',
    '- If a tool call fails, diagnose why before retrying. Don\'t retry blindly, and don\'t switch tactics after a single failure without understanding the error.',
  )

  if (hasFilesystem) {
    lines.push(
      '',
      'Editing files safely:',
      '- `editFile` requires the `old_string` to match EXACTLY — whitespace, indentation, and all. Copy from `readFile` output; don\'t retype.',
      '- `old_string` must be unique in the file. If it isn\'t, include more surrounding lines until it is. The edit fails otherwise.',
      '- For deletions, include 2–3 lines BEFORE and AFTER the removed code in `old_string` (including lines that stay) so the edit is unambiguous and you can\'t orphan a `}` or a caller.',
      '- Never use `writeFile` to change a few lines in an existing file. `writeFile` is for new files only.',
      '- For multi-file edits, work in dependency order: foundational files (types, schemas, migrations) first, dependents after.',
      '- After a non-trivial edit, re-read the edited region to verify the change applied correctly and nothing adjacent was corrupted.',
    )
  }

  if (hasAgentSpawn) {
    lines.push(
      '',
      'Spawning subagents (`agent_spawn`):',
      '- Use for tasks that would fill your context with raw output you won\'t need again (broad searches, multi-file analysis).',
      '- Use for genuinely independent work that can run in parallel with what you\'re doing.',
      '- Do NOT use for a single-file read, a known-path lookup, or a task you can do in 1–2 tool calls — just do it directly.',
      '- The subagent sees NONE of this conversation. Write a complete, self-contained prompt with all context, file paths, and what you expect back.',
      '- Never delegate understanding. Don\'t write "based on the research, fix the bug" — that pushes synthesis onto the agent instead of doing it yourself. Include specifics: file paths, line numbers, what to change.',
      '- When the subagent returns, the user cannot see its output. Write a short summary of the result back to the user.',
    )
  }

  if (hasTodoWrite) {
    lines.push(
      '',
      'Task tracking (`todo_write`):',
      '- Use at the start of any multi-step task (3+ distinct steps). Capture each step as its own entry.',
      '- Update as you go: mark a task `in_progress` before you start it and `completed` as soon as it\'s done — don\'t batch completions.',
      '- Exactly one task should be `in_progress` at a time.',
      '- Skip for single-step, trivial, or purely conversational requests — the tool is overhead if there\'s only one thing to do.',
    )
  }

  if (hasConnectors) {
    lines.push(
      '',
      'Third-party services (`connectors`):',
      '- Call ONLY when the user explicitly asks to connect, set up, find, or check a third-party service ("connect Gmail", "find a task app", "is Slack connected"). Do NOT call during general conversation, code work, or unrelated tasks.',
      '- Use `action: "search"` with the user\'s phrasing as `query` to find services. Use `"list_attached"` for "what is already connected." Use `"status"` with the connector id to check ONE connection.',
      '- **The UI renders the result as inline cards. Say almost nothing in your text.** When the result has at least one item: say at most one short sentence ("Here you go." / "Found it." / "Already connected.") and stop. Do NOT list connector names, descriptions, features, or steps in prose — the card already shows them. Do NOT instruct the user how to click Connect; the card has the button.',
      '- **Never repeat the suggestions banner in your text.** Suggestions about Composio / MCP-registry / Settings → Advanced are rendered by the UI ONLY when the search returned zero matches. If your `items` array is non-empty, do NOT mention enabling other sources in your reply.',
      '- When zero matches AND suggestions are present, mention them in ONE concise sentence so the user knows the option exists.',
      '- After a successful connect, the user\'s context updates with the new tools — call `connectors(action: "list_attached")` once if you need to confirm before using a connected service.',
      '- **Ready-but-not-loaded.** If a connector reports `status: "ready"` (or appears in `list_attached`) but its tools are NOT in your tool list, the user connected it during this conversation. Today the running session keeps its original tool set; the new MCP server doesn\'t spawn until a new chat starts. Tell the user honestly: "✓ Connected. Open a new chat for the [connector] tools to be available." Do NOT pretend you have the tool, do NOT try to call a tool you don\'t actually have, and do NOT say it\'s broken — explain the new-chat-needed step in one sentence and stop. (This is a known v1 limitation; live mid-session MCP injection is on the roadmap.)',
    )
  }

  return {
    slot: 'tools',
    content: lines.join('\n'),
    priority: 100,
    label,
    cacheControl: true,
  }
}

// ---------------------------------------------------------------------------
// Tool documentation (auto-generated from tool definitions)
// ---------------------------------------------------------------------------

/**
 * Options accepted by `createToolsFragment`. Backwards-compatible: the
 * legacy single-arg form (`createToolsFragment(tools)`) keeps the
 * pre-Phase-4 behaviour. Pass `descriptions` to opt into modular tool
 * descriptions; a tool without a registered description still renders
 * via its flat `description: string` so existing profiles see no
 * change until they wire the registry.
 */
export interface CreateToolsFragmentOptions {
  /** Label for debugging output. */
  readonly label?: string
  /** Modular tool-description registry. Tools without an entry fall back to flat-description rendering. */
  readonly descriptions?: ToolDescriptionRegistry
  /** Profile-supplied section selection. Ignored when `descriptions` is undefined. */
  readonly selection?: ToolDescriptionSelection
}

/**
 * Create a tools prompt fragment from available tool definitions.
 */
export function createToolsFragment(
  tools: Tool[],
  options: CreateToolsFragmentOptions = {},
): PromptFragment {
  const label = options.label ?? 'available-tools'
  if (tools.length === 0) {
    return {
      slot: 'tools',
      content: '',
      priority: 50,
      label,
      cacheControl: true,
    }
  }

  const toolDocs = tools.map(tool =>
    renderToolDoc(tool, options.descriptions?.get(tool.name), options.selection),
  )

  const content = [
    '# Available Tools',
    '',
    `You have ${tools.length} tool${tools.length === 1 ? '' : 's'} available:`,
    '',
    ...toolDocs,
  ].join('\n')

  return {
    slot: 'tools',
    content,
    priority: 50,
    label,
    cacheControl: true,
  }
}
