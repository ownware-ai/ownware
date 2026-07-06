/**
 * Integration tests — plan_draft → plan_submit flow, end-to-end.
 *
 * Production-grade verification (no API key required):
 *   1. The assembler injects `plan_draft` and `plan_submit` into every
 *      profile's tool set.
 *   2. `plan_draft.execute()` against a temp workspace creates
 *      `.ownware/plans/<YYYYMMDD>-<slug>.md` with the agent-provided
 *      content. Idempotent across multiple iterations (each call
 *      overwrites the file with the latest body).
 *   3. `plan_submit.execute()` reads the file, parses the trailing
 *      `- [ ]` checklist, and returns a structured tool result with
 *      the parsed items.
 *   4. Errors are surfaced cleanly when:
 *      - The plan file doesn't exist (agent skipped plan_draft).
 *      - The plan body has no trailing checklist.
 *      - The feature name has no alphanumeric content.
 *
 * No LLM. No network. Catches real wiring + I/O + parser bugs that
 * unit tests alone wouldn't.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefaultConfig } from '@ownware/loom'
import type { Tool, ToolContext, ToolResult, ToolProgress } from '@ownware/loom'

import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'
import { resolvePlanPath } from '../../../src/plans/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-plan-test-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function makeContext(workspacePath: string): ToolContext {
  return {
    cwd: workspacePath,
    signal: new AbortController().signal,
    sessionId: 'plan-test-session',
    agentId: null,
    workspacePath,
    additionalWorkspaceRoots: [],
    config: createDefaultConfig('anthropic:claude-sonnet-4-6'),
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

async function runTool(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const out = tool.execute(input, context)
  if (
    out &&
    typeof (out as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  ) {
    const gen = out as AsyncGenerator<ToolProgress, ToolResult>
    let next = await gen.next()
    while (!next.done) next = await gen.next()
    return next.value
  }
  return await (out as Promise<ToolResult>)
}

describe('plans: assembler injection', () => {
  it('plan_draft and plan_submit are in every profile\'s assembled tool set', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    const toolNames = new Set(assembled.tools.map(t => t.name))
    expect(toolNames.has('plan_draft')).toBe(true)
    expect(toolNames.has('plan_submit')).toBe(true)
  })

  it('a profile that denies plan_draft does not see it in the assembled set', async () => {
    const { dir } = track(await createMinimalProfile({
      tools: { preset: 'full', deny: ['plan_draft'] },
    }))
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    const toolNames = new Set(assembled.tools.map(t => t.name))
    expect(toolNames.has('plan_draft')).toBe(false)
    // plan_submit still present — deny is per-tool.
    expect(toolNames.has('plan_submit')).toBe(true)
  })
})

describe('plans: plan_draft execute()', () => {
  it('creates .ownware/plans/<date>-<slug>.md with the supplied content on first call', async () => {
    const ws = await makeTempWorkspace()
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const planDraft = assembled.tools.find(t => t.name === 'plan_draft')!
    expect(planDraft).toBeDefined()

    const ctx = makeContext(ws)
    const body = [
      '# Refactor auth — Plan',
      '',
      'Change the session validator to accept JWT tokens.',
      '',
      '- [ ] Read auth/session.ts',
      '- [ ] Refactor validator',
      '- [ ] Update tests',
    ].join('\n')

    const result = await runTool(
      planDraft,
      { feature: 'Refactor auth', content: body },
      ctx,
    )

    expect(result.isError).toBe(false)
    expect(result.metadata?.['feature']).toBe('Refactor auth')

    // File must exist at the canonical path.
    const expectedPath = resolvePlanPath(ws, 'Refactor auth')
    const fileStat = await stat(expectedPath)
    expect(fileStat.isFile()).toBe(true)

    const onDisk = await readFile(expectedPath, 'utf-8')
    expect(onDisk).toBe(body)
  })

  it('overwrites the file on subsequent calls (iteration model)', async () => {
    const ws = await makeTempWorkspace()
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const planDraft = assembled.tools.find(t => t.name === 'plan_draft')!
    const ctx = makeContext(ws)

    // First draft
    const firstBody = '# v1\n\n- [ ] step one'
    await runTool(planDraft, { feature: 'iter-test', content: firstBody }, ctx)

    // Refined draft (agent rewrites)
    const secondBody = '# v2 — refined\n\nNow with risks section.\n\n- [ ] step one\n- [ ] step two'
    await runTool(planDraft, { feature: 'iter-test', content: secondBody }, ctx)

    const path = resolvePlanPath(ws, 'iter-test')
    const onDisk = await readFile(path, 'utf-8')
    expect(onDisk).toBe(secondBody)
    expect(onDisk).not.toContain('v1')
  })

  it('returns an error result on a feature name with no alphanumeric content', async () => {
    const ws = await makeTempWorkspace()
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const planDraft = assembled.tools.find(t => t.name === 'plan_draft')!

    const result = await runTool(
      planDraft,
      { feature: '!!!', content: '- [ ] anything' },
      makeContext(ws),
    )
    expect(result.isError).toBe(true)
    expect(result.content.toLowerCase()).toContain('feature')
  })
})

describe('plans: plan_submit execute()', () => {
  it('parses the trailing checklist and returns it as structured metadata', async () => {
    const ws = await makeTempWorkspace()
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const planDraft = assembled.tools.find(t => t.name === 'plan_draft')!
    const planSubmit = assembled.tools.find(t => t.name === 'plan_submit')!
    const ctx = makeContext(ws)

    const body = [
      '# Add OAuth — Plan',
      '',
      'Reading first, then editing.',
      '',
      '- [ ] Read auth.ts',
      '- [ ] Add OAuth flow',
      '- [x] Already prototyped',
    ].join('\n')

    await runTool(planDraft, { feature: 'Add OAuth', content: body }, ctx)
    const submitResult = await runTool(planSubmit, { feature: 'Add OAuth' }, ctx)

    expect(submitResult.isError).toBe(false)
    const checklist = submitResult.metadata?.['checklist'] as Array<{ text: string; done: boolean }>
    expect(checklist).toBeDefined()
    expect(checklist).toHaveLength(3)
    expect(checklist.map(c => c.text)).toEqual([
      'Read auth.ts',
      'Add OAuth flow',
      'Already prototyped',
    ])
    expect(checklist.map(c => c.done)).toEqual([false, false, true])

    // Result body must instruct the agent to call todo_write next.
    expect(submitResult.content).toContain('todo_write')
  })

  it('errors clearly when the plan file does not exist', async () => {
    const ws = await makeTempWorkspace()
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const planSubmit = assembled.tools.find(t => t.name === 'plan_submit')!

    const result = await runTool(
      planSubmit,
      { feature: 'never-drafted' },
      makeContext(ws),
    )
    expect(result.isError).toBe(true)
    expect(result.content.toLowerCase()).toContain('plan file not found')
    expect(result.content.toLowerCase()).toContain('plan_draft')
  })

  it('errors clearly when the plan body has no trailing checklist', async () => {
    const ws = await makeTempWorkspace()
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const planDraft = assembled.tools.find(t => t.name === 'plan_draft')!
    const planSubmit = assembled.tools.find(t => t.name === 'plan_submit')!
    const ctx = makeContext(ws)

    // Plan with prose but no checklist.
    const body = [
      '# Some plan',
      '',
      'This is design discussion. No action items yet.',
      '',
      'Considering options A and B.',
    ].join('\n')

    await runTool(planDraft, { feature: 'no-checklist', content: body }, ctx)
    const result = await runTool(planSubmit, { feature: 'no-checklist' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/checklist/i)
  })
})
