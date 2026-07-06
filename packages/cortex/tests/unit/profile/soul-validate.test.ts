/**
 * Unit tests for validateSoul — the deterministic post-write SOUL gate.
 *
 * Two halves:
 *   - PRECISION: real, good SOULs (incl. the actual generated Lex/Ship/Patchwork
 *     output) must PASS. A false reject frustrates every build.
 *   - TRUE POSITIVES: marketing language, capability overpromises (over the
 *     resolved tool surface), and missing guardrails must REJECT.
 */

import { describe, it, expect } from 'vitest'
import { validateSoul } from '../../../src/profile/soul-validate.js'

// --- real generated fixtures (from the chunk-1 e2e builds) -------------------

const LEX_SOUL = `## Role
You are Lex, a contract reviewer for the user. Your job is to read agreements the user pastes in, flag risky or unusual clauses, point out missing protections, and explain each issue in plain language — not to give legal advice or rewrite documents as a lawyer.

## Voice
Clear, direct, and calm: explain like a careful colleague who has read a lot of contracts, with no alarmism and no marketing speak.

## How you work
1. Read the full pasted text before analyzing. If only an excerpt is provided, note what may be missing from context.
2. Identify the contract type and the parties if they are clear.
3. Flag clauses that are one-sided, ambiguous, punitive, or omit standard protections.
4. For each flag, state the clause, what it says in plain terms, why it matters, and what to check.

## Hard rules
- NEVER sign, send, or edit contracts on the user's behalf. You analyze only.
- ALWAYS add the non-lawyer disclaimer at the end of any review.
- Ask before saving, copying, or sharing any contract text outside this chat.
- When a request conflicts with these rules, the rules win — explain briefly and stop.`

const SHIP_SOUL = `## Role
You are Ship, a release-notes writer for the user's codebase. Your job is to turn merged PRs and commits into a clean, accurate release-notes draft — not to edit code, cut releases, or publish anything.

## Voice
Plain, concise, and slightly dry; organize before you opine.

## How you work
1. Understand the span the user wants covered.
2. Group items by kind: breaking changes, fixes, features, performance, docs/tests, chores.
3. Draft release notes in Markdown: a one-line summary and a concise changelog list per group.
4. Present the draft and explain the range it covers.

## Hard rules
- You only write notes. NEVER publish releases or packages.
- Never invent PR numbers, commit SHAs, dates, or contributor names.
- When a request conflicts with these Hard rules, the Hard rules win — say so and stop.`

// --- helpers -----------------------------------------------------------------

const codingTools = (deny: string[] = ['shell_execute']) => ({ preset: 'coding', deny, composio: { toolkits: [] } })
const readonlyTools = { preset: 'readonly', deny: ['shell_execute'], composio: { toolkits: [] } }
const fullTools = { preset: 'full', deny: ['shell_execute'], composio: { toolkits: [] } }
const noneWithConnector = { preset: 'none', deny: [], composio: { toolkits: ['gmail'] } }
const noneTools = { preset: 'none', deny: [], composio: { toolkits: [] } }

describe('validateSoul — precision (good SOULs pass)', () => {
  it('passes a clean readonly contract reviewer (Lex)', () => {
    const r = validateSoul(LEX_SOUL, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r).toEqual({ ok: true, reasons: [] })
  })

  it('does NOT treat "write release notes" / "write notes" as a file-write claim', () => {
    // Ship is readonly here (no writeFile) yet only "writes notes" — must pass.
    const r = validateSoul(SHIP_SOUL, { tools: { preset: 'readonly', deny: [], composio: { toolkits: [] } }, permissionMode: 'auto' })
    expect(r.reasons.find((x) => x.includes('editing or writing files'))).toBeUndefined()
  })

  it('does NOT flag "read the pasted text" as a capability claim', () => {
    const r = validateSoul(LEX_SOUL, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })

  it('passes a coding agent that legitimately HAS shell when claiming to run tests', () => {
    const soul = `## Role\nYou are Dev.\n## How you work\n1. Run the failing test and reproduce the bug.\n## Hard rules\n- NEVER push without approval.`
    const r = validateSoul(soul, { tools: codingTools([]) /* shell not denied */, permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })

  it('skips capability checks when no tools config is given', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Run the tests and edit the code.\n## Hard rules\n- Never delete anything.`
    const r = validateSoul(soul, { permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })

  it('does not false-fire banned-marketing on benign words (e.g. "permission")', () => {
    const soul = `## Role\nYou are Gate, a permission reviewer.\n## How you work\n1. Check each permission grant.\n## Hard rules\n- Never approve without review.`
    const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })
})

describe('validateSoul — banned marketing', () => {
  for (const [word, soul] of [
    ['seamless', '## Role\nYou are X. Seamless integration with your stack.\n## Hard rules\n- Never act without asking.'],
    ['empower', '## Role\nYou are X, here to empower your team.\n## Hard rules\n- Never act without asking.'],
    ['world-class', '## Role\nYou are X, a world-class assistant.\n## Hard rules\n- Never act without asking.'],
  ] as const) {
    it(`rejects "${word}"`, () => {
      const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'ask' })
      expect(r.ok).toBe(false)
      expect(r.reasons.some((x) => x.toLowerCase().includes('marketing'))).toBe(true)
    })
  }
})

describe('validateSoul — capability overpromises (resolved surface)', () => {
  it('rejects a readonly agent claiming to edit files', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. I edit your files and modify the code as needed.\n## Hard rules\n- Never delete.`
    const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.includes('editing or writing files'))).toBe(true)
  })

  it('rejects a coding agent (shell denied) claiming to run tests', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Run the failing test, then run the build.\n## Hard rules\n- Never push.`
    const r = validateSoul(soul, { tools: codingTools(['shell_execute']), permissionMode: 'ask' })
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.includes('running commands'))).toBe(true)
  })

  it('rejects a coding agent (shell denied) claiming to run git', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Gather material with git log and git tag.\n## Hard rules\n- Never push.`
    const r = validateSoul(soul, { tools: codingTools(['shell_execute']), permissionMode: 'ask' })
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.includes('git'))).toBe(true)
  })

  it('rejects an agent with no web tool claiming to search the web', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Search the web for the latest docs.\n## Hard rules\n- Never act without asking.`
    const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.includes('web'))).toBe(true)
  })

  it('rejects a no-connector agent claiming to send email', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Draft a reply and send the email for you.\n## Hard rules\n- Never act without asking.`
    const r = validateSoul(soul, { tools: noneTools, permissionMode: 'ask' })
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.includes('sending email'))).toBe(true)
  })

  it('passes a send claim when a connector IS present', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Draft a reply and send the email for you.\n## Hard rules\n- Always ask before sending.`
    const r = validateSoul(soul, { tools: noneWithConnector, permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })

  it('passes web claims when the full preset grants web tools', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Search the web for sources.\n## Hard rules\n- Never act without asking.`
    const r = validateSoul(soul, { tools: { preset: 'full', deny: [], composio: { toolkits: [] } }, permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })
})

describe('validateSoul — autonomy / guardrail', () => {
  it('rejects an ask-mode SOUL with no guardrail', () => {
    const soul = `## Role\nYou are X, a helpful summarizer.\n## How you work\n1. Read input.\n2. Summarize it.\n3. Present the summary.`
    const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.includes('guardrail'))).toBe(true)
  })

  it('allows an auto-mode SOUL without an explicit guardrail', () => {
    const soul = `## Role\nYou are X, a read-only summarizer.\n## How you work\n1. Read input.\n2. Summarize it.\n3. Present the summary.`
    const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'auto' })
    expect(r.ok).toBe(true)
  })

  it('accepts a "never" line as a guardrail even without a Hard rules heading', () => {
    const soul = `## Role\nYou are X.\n## How you work\n1. Read input and summarize.\nI never send or delete anything without asking.`
    const r = validateSoul(soul, { tools: readonlyTools, permissionMode: 'ask' })
    expect(r.ok).toBe(true)
  })
})
