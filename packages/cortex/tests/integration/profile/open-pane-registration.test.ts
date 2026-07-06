/**
 * Integration test for `open_pane` per-session registration (slice 3.3).
 *
 * Drives `assembleAgent(profile, { paneRuntime })` end-to-end against a
 * real `GatewayState` SQLite-backed instance and a real loaded profile
 * directory. Asserts:
 *   - `open_pane` lands in `agent.tools` when paneRuntime is wired AND
 *     the profile permits at least one kind.
 *   - The advertised input schema's `kind` enum matches
 *     `profile.config.panes.allowedKinds` verbatim.
 *   - `open_pane` is OMITTED when paneRuntime is unset (no tool added,
 *     no surprises for tests / CLI / direct-Loom callers).
 *   - `open_pane` is OMITTED when the profile sets
 *     `panes.allowedKinds: []` (a profile that explicitly permits no
 *     kinds shouldn't expose the tool).
 *   - `open_pane` is FILTERED OUT when the profile lists it in
 *     `tools.deny` — the deny path runs after Cortex-shipped tool
 *     injection, so deny wins as the architecture promises.
 *
 * Each test mints a fresh temp profile dir + temp gateway DB and
 * cleans them up after — same pattern as the rest of the assembler
 * suite.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { OPEN_PANE_TOOL_NAME } from '../../../src/tools/open-pane/index.js'
import { createMinimalProfile, type TempProfile } from '../../helpers/fixtures.js'

interface Bindings {
  readonly state: GatewayState
  readonly workspaceId: string
  readonly stateDir: string
  readonly profile: TempProfile
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

async function bindings(profileOverrides: Record<string, unknown>): Promise<Bindings> {
  const stateDir = await mkdtemp(join(tmpdir(), 'cortex-open-pane-reg-'))
  const state = new GatewayState(join(stateDir, 'ownware.db'))
  const ws = state.createWorkspace(stateDir, 'reg-ws')
  const profile = await createMinimalProfile(profileOverrides)
  cleanups.push(async () => {
    state.close()
    await rm(stateDir, { recursive: true, force: true })
    await profile.cleanup()
  })
  return { state, workspaceId: ws.id, stateDir, profile }
}

function findOpenPane(tools: { readonly name: string }[]) {
  return tools.find((t) => t.name === OPEN_PANE_TOOL_NAME)
}

describe('assembleAgent: open_pane registration', () => {
  it('registers open_pane when paneRuntime is wired and profile permits kinds', async () => {
    const { state, workspaceId, profile } = await bindings({
      panes: { allowedKinds: ['chat', 'markdown'], defaultAgentPlacement: 'split' },
    })
    const loaded = await loadProfile(profile.dir)
    const agent = await assembleAgent(loaded, {
      paneRuntime: { state, workspaceId },
    })

    const tool = findOpenPane(agent.tools)
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('open_pane')
  })

  it('narrows the advertised input schema to profile.panes.allowedKinds', async () => {
    const { state, workspaceId, profile } = await bindings({
      // Pick a non-default subset so we can prove the narrow is real.
      panes: { allowedKinds: ['markdown', 'code', 'image'], defaultAgentPlacement: 'new-tab' },
    })
    const loaded = await loadProfile(profile.dir)
    const agent = await assembleAgent(loaded, {
      paneRuntime: { state, workspaceId },
    })

    const tool = findOpenPane(agent.tools)
    expect(tool).toBeDefined()
    const kindEnum = tool!.inputSchema.properties.config?.properties?.kind?.enum
    expect(kindEnum).toEqual(['markdown', 'code', 'image'])
  })

  it('omits open_pane entirely when paneRuntime is not provided', async () => {
    const { profile } = await bindings({
      panes: { allowedKinds: ['chat', 'markdown'] },
    })
    const loaded = await loadProfile(profile.dir)
    const agent = await assembleAgent(loaded) // no paneRuntime
    expect(findOpenPane(agent.tools)).toBeUndefined()
  })

  it('omits open_pane when profile.panes.allowedKinds is empty', async () => {
    const { state, workspaceId, profile } = await bindings({
      panes: { allowedKinds: [] },
    })
    const loaded = await loadProfile(profile.dir)
    const agent = await assembleAgent(loaded, {
      paneRuntime: { state, workspaceId },
    })
    expect(findOpenPane(agent.tools)).toBeUndefined()
  })

  it('respects tools.deny: ["open_pane"] — explicit deny removes the registered tool', async () => {
    const { state, workspaceId, profile } = await bindings({
      panes: { allowedKinds: ['markdown'] },
      tools: { preset: 'none', deny: ['open_pane'] },
    })
    const loaded = await loadProfile(profile.dir)
    const agent = await assembleAgent(loaded, {
      paneRuntime: { state, workspaceId },
    })
    expect(findOpenPane(agent.tools)).toBeUndefined()
  })
})
