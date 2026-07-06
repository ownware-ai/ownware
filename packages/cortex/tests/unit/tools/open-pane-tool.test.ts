/**
 * Unit tests for the `open_pane` tool body (slice 3.3).
 *
 * Covers the runtime tool factory `createOpenPaneTool(...)`:
 *   - Tool name is the canonical `'open_pane'`.
 *   - JSON Schema is built with the `kind` enum filtered to allowedKinds.
 *   - `execute()` paths:
 *       * happy   — input parses + workspace exists → pane is persisted
 *       * kind_not_permitted — model passes a kind not in allowedKinds
 *       * invalid_input     — schema validation fails (e.g. missing
 *                             discriminator field for the chosen kind)
 *       * workspace_unknown — paneRuntime.workspaceId no longer exists
 *       * persist_failed    — state.createWorkspacePane throws
 *   - Empty allowedKinds throws at factory time (not execute time).
 *
 * Tests use a real SQLite-backed `GatewayState` in a temp dir — the
 * tool's contract is "calls into state.createWorkspacePane(...)" and
 * exercising that against the real implementation gives us a true
 * round-trip without mocking the persistence layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import {
  createOpenPaneTool,
  OPEN_PANE_TOOL_NAME,
  type OpenPaneToolResponse,
} from '../../../src/tools/open-pane/index.js'
import type { Tool, ToolContext, ToolResult } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal ToolContext stub. The tool's execute() only reads `input`
 * and the closure-captured state — none of the context callbacks are
 * exercised. We don't need a full session.
 */
function stubContext(): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'session-test',
    agentId: null,
    workspacePath: '/tmp',
    additionalWorkspaceRoots: [],
    config: {} as ToolContext['config'],
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

async function runExecute(
  tool: Tool,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await tool.execute(input, stubContext())
  // Tool body never returns an AsyncGenerator path — assert + cast.
  if (result == null || typeof (result as ToolResult).content !== 'string') {
    throw new Error('Tool unexpectedly returned a generator instead of a ToolResult.')
  }
  return result as ToolResult
}

function parseResponse(result: ToolResult): OpenPaneToolResponse {
  return JSON.parse(result.content) as OpenPaneToolResponse
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createOpenPaneTool', () => {
  let state: GatewayState
  let tempDir: string
  let workspaceId: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-open-pane-test-'))
    state = new GatewayState(join(tempDir, 'test.db'))
    const ws = state.createWorkspace(tempDir, 'test-ws')
    workspaceId = ws.id
  })

  afterEach(async () => {
    state.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Tool definition
  // -----------------------------------------------------------------------

  it('returns a tool whose name is the canonical OPEN_PANE_TOOL_NAME', () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['markdown', 'chat'],
      defaultPlacement: 'split',
    })
    expect(tool.name).toBe(OPEN_PANE_TOOL_NAME)
    expect(tool.name).toBe('open_pane')
  })

  it('advertises an inputSchema where config.kind enum equals allowedKinds', () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['markdown', 'code'],
      defaultPlacement: 'split',
    })
    const schema = tool.inputSchema
    expect(schema.type).toBe('object')
    const config = schema.properties.config
    expect(config).toBeDefined()
    const kindProp = config!.properties?.kind
    expect(kindProp).toBeDefined()
    expect(kindProp!.type).toBe('string')
    expect(kindProp!.enum).toEqual(['markdown', 'code'])
  })

  it('throws at factory time when allowedKinds is empty (the schema has no options)', () => {
    expect(() =>
      createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: [],
        defaultPlacement: 'split',
      }),
    ).toThrow(/allowedKinds is empty/i)
  })

  // -----------------------------------------------------------------------
  // execute() — happy path
  // -----------------------------------------------------------------------

  it('persists a markdown pane in the side zone (rip-dockview Phase F) and echoes the typed result', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['markdown'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: {
        kind: 'markdown',
        source: { origin: 'inline', content: '# hello' },
      },
      title: 'README',
    })

    expect(result.isError).toBe(false)
    const response = parseResponse(result)
    expect(response.status).toBe('opened')
    if (response.status !== 'opened') throw new Error('unreachable')

    expect(response.kind).toBe('markdown')
    expect(response.title).toBe('README')
    // Placement is meaningless in the side zone (single-slot surface);
    // the response echoes null.
    expect(response.placement).toBeNull()
    expect(response.paneId).toMatch(/^pane_/)
    // Side-zone panes auto-focus too — the side panel is single-slot
    // and displays whatever is focused, so the agent's "open this for
    // the user" intent must translate to "the user sees it now".
    expect(response.focused).toBe(true)

    // Round-trip through the gateway state — pane was persisted in the
    // side zone with openedBy='agent'.
    const panes = state.getWorkspacePanes(workspaceId)
    expect(panes).toHaveLength(1)
    expect(panes[0]?.kind).toBe('markdown')
    expect(panes[0]?.metadata.openedBy).toBe('agent')
    expect(panes[0]?.zone).toBe('side')
  })

  it('persists a chat pane in the tabs zone with split placement', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['chat'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: { kind: 'chat', profileId: 'pf_x', threadId: 'th_x' },
    })
    const response = parseResponse(result)
    if (response.status !== 'opened') throw new Error('unreachable')
    expect(response.kind).toBe('chat')
    expect(response.placement).toBe('split')

    const panes = state.getWorkspacePanes(workspaceId)
    expect(panes[0]?.zone).toBe('tabs')
  })

  it('uses the profile defaultPlacement when input.placement is omitted (tabs-zone kind)', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['chat'],
      defaultPlacement: 'new-tab',
    })

    const result = await runExecute(tool, {
      config: { kind: 'chat', profileId: 'pf_x', threadId: 'th_x' },
    })
    const response = parseResponse(result)
    if (response.status !== 'opened') throw new Error('unreachable')
    expect(response.placement).toBe('new-tab')
  })

  it('returns placement: null for side-zone kinds (placement is meaningless there)', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['terminal'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: { kind: 'terminal' },
    })
    const response = parseResponse(result)
    if (response.status !== 'opened') throw new Error('unreachable')
    expect(response.placement).toBeNull()

    const panes = state.getWorkspacePanes(workspaceId)
    expect(panes[0]?.zone).toBe('side')
  })

  // -----------------------------------------------------------------------
  // execute() — failure paths
  // -----------------------------------------------------------------------

  it('returns kind_not_permitted when the model passes a kind not in allowedKinds', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['markdown'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: { kind: 'code', source: { origin: 'inline', content: 'console.log(1)' } },
    })

    expect(result.isError).toBe(true)
    const response = parseResponse(result)
    expect(response.status).toBe('failed')
    if (response.status !== 'failed') throw new Error('unreachable')
    expect(response.reason.code).toBe('kind_not_permitted')
    if (response.reason.code !== 'kind_not_permitted') throw new Error('unreachable')
    expect(response.reason.kind).toBe('code')
    expect(response.reason.allowedKinds).toEqual(['markdown'])

    // No pane was persisted on failure.
    expect(state.getWorkspacePanes(workspaceId)).toHaveLength(0)
  })

  it('returns invalid_input when required per-kind fields are missing', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['chat'],
      defaultPlacement: 'split',
    })

    // chat requires { profileId, threadId } but we pass nothing.
    const result = await runExecute(tool, {
      config: { kind: 'chat' },
    })

    expect(result.isError).toBe(true)
    const response = parseResponse(result)
    expect(response.status).toBe('failed')
    if (response.status !== 'failed') throw new Error('unreachable')
    expect(response.reason.code).toBe('invalid_input')
    if (response.reason.code !== 'invalid_input') throw new Error('unreachable')
    expect(response.reason.message.length).toBeGreaterThan(0)

    expect(state.getWorkspacePanes(workspaceId)).toHaveLength(0)
  })

  // Forgiveness pass — smaller models (notably GPT-5.4-mini) tend to
  // flatten the `config` wrapper and send `{ kind, source, … }` at the
  // root. The tool coerces that into the canonical shape so the user
  // sees the pane instead of an "Unrecognized key(s)" Zod error.
  it('accepts a flat input shape and opens the pane', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['markdown'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      // Note: no `config` wrapper — flat at the root, the broken shape
      // GPT-5.4-mini and similar models send.
      kind: 'markdown',
      source: { origin: 'inline', content: '# Hello' },
    })

    expect(result.isError).toBe(false)
    const response = parseResponse(result)
    expect(response.status).toBe('opened')
    if (response.status !== 'opened') throw new Error('unreachable')
    expect(response.kind).toBe('markdown')
    expect(state.getWorkspacePanes(workspaceId)).toHaveLength(1)
  })

  it('still accepts the canonical wrapped shape unchanged', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['markdown'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: { kind: 'markdown', source: { origin: 'inline', content: '# Hi' } },
      title: 'Greeting',
    })

    expect(result.isError).toBe(false)
    const response = parseResponse(result)
    expect(response.status).toBe('opened')
    if (response.status !== 'opened') throw new Error('unreachable')
    expect(response.title).toBe('Greeting')
  })

  it('keeps title and placement at the root when coercing a flat input', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId,
      allowedKinds: ['code'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      // Flat shape; title and placement are SCHEMA-LEVEL fields (not
      // pane-config fields) — they should stay at the root after
      // coercion, not get lifted into `config`.
      kind: 'code',
      source: { origin: 'inline', content: 'const x = 1' },
      language: 'ts',
      title: 'snippet.ts',
      placement: 'new-tab',
    })

    expect(result.isError).toBe(false)
    const response = parseResponse(result)
    expect(response.status).toBe('opened')
    if (response.status !== 'opened') throw new Error('unreachable')
    expect(response.title).toBe('snippet.ts')
    // The coerced root-level `placement` is accepted, but code panes
    // live in the side zone (only chat panes are tab-strip), and
    // side-zone panes don't honour placement — the echo is null.
    expect(response.placement).toBeNull()
  })

  it('returns workspace_unknown when the captured workspaceId no longer exists', async () => {
    const tool = createOpenPaneTool({
      state,
      workspaceId: 'ws_does_not_exist',
      allowedKinds: ['markdown'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
    })

    expect(result.isError).toBe(true)
    const response = parseResponse(result)
    expect(response.status).toBe('failed')
    if (response.status !== 'failed') throw new Error('unreachable')
    expect(response.reason.code).toBe('workspace_unknown')
    if (response.reason.code !== 'workspace_unknown') throw new Error('unreachable')
    expect(response.reason.workspaceId).toBe('ws_does_not_exist')
  })

  it('returns persist_failed when state.createWorkspacePane throws', async () => {
    // Wrap the real state so createWorkspacePane throws but every other
    // method (getWorkspace) keeps working. Cast through unknown so we
    // don't have to fake the entire GatewayState interface.
    const wrappedState = new Proxy(state, {
      get(target, prop) {
        if (prop === 'createWorkspacePane') {
          return () => {
            throw new Error('disk write blew up')
          }
        }
        return Reflect.get(target, prop) as unknown
      },
    })

    const tool = createOpenPaneTool({
      state: wrappedState,
      workspaceId,
      allowedKinds: ['markdown'],
      defaultPlacement: 'split',
    })

    const result = await runExecute(tool, {
      config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
    })

    expect(result.isError).toBe(true)
    const response = parseResponse(result)
    expect(response.status).toBe('failed')
    if (response.status !== 'failed') throw new Error('unreachable')
    expect(response.reason.code).toBe('persist_failed')
    if (response.reason.code !== 'persist_failed') throw new Error('unreachable')
    expect(response.reason.message).toMatch(/disk write blew up/)
  })

  // -----------------------------------------------------------------------
  // execute() — auto-scope to active chat (workspace-tab-architecture 3a)
  // -----------------------------------------------------------------------

  describe('activeThreadId auto-scoping', () => {
    it('sets metadata.scopedToChatId on a non-chat pane to the chat pane owning the thread', async () => {
      // Seed the workspace with a chat pane for thread "thread-A".
      const chatPane = state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['markdown'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-A',
      })

      const result = await runExecute(tool, {
        config: { kind: 'markdown', source: { origin: 'inline', content: '# scoped' } },
      })

      expect(result.isError).toBe(false)
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted).toBeDefined()
      expect(persisted!.metadata.scopedToChatId).toBe(chatPane.id)
    })

    it('does NOT auto-scope when activeThreadId is omitted', async () => {
      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['markdown'],
        defaultPlacement: 'split',
      })

      const result = await runExecute(tool, {
        config: { kind: 'markdown', source: { origin: 'inline', content: '# unscoped' } },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBeUndefined()
    })

    it('does NOT auto-scope chat-kind panes (a chat scoping to itself is nonsense)', async () => {
      // Seed a chat pane that exists for thread-A; agent opens a
      // SECOND chat pane (a different conversation). The new chat
      // pane must NOT be scoped — it's a standalone surface.
      state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['chat'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-A',
      })

      const result = await runExecute(tool, {
        config: { kind: 'chat', profileId: 'p_other', threadId: 'thread-B' },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBeUndefined()
    })

    it('opens unscoped when activeThreadId is set but no chat pane exists yet for that thread', async () => {
      // No chat pane seeded. This is the "very first tool call, the client
      // hasn't created the chat tab yet" path — fall back to unscoped
      // rather than failing.
      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['markdown'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-ghost',
      })

      const result = await runExecute(tool, {
        config: { kind: 'markdown', source: { origin: 'inline', content: '# orphan' } },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBeUndefined()
    })

    it('does NOT auto-scope workspace-wide kinds (terminal) even when activeThreadId is set', async () => {
      // Policy-driven: kinds the pane-kind-policy declares as
      // 'workspace-wide' (terminal, files) must stay unscoped even
      // when the agent opens them inside a conversation. Otherwise
      // closing the chat would cascade-delete the user's shared
      // shell session, which is the wrong UX.
      state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['terminal'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-A',
      })

      const result = await runExecute(tool, {
        config: { kind: 'terminal' },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBeUndefined()
    })

    it('does NOT auto-scope workspace-wide kinds (files) even when activeThreadId is set', async () => {
      state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['files'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-A',
      })

      const result = await runExecute(tool, {
        config: { kind: 'files', rootPath: '/tmp' },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBeUndefined()
    })

    it('DOES auto-scope conversation-specific kinds (tasks) when activeThreadId is set', async () => {
      // Inverse of the above — tasks/plan are declared chat-scoped in
      // the policy because each conversation has its own todo list.
      const chatPane = state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['tasks'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-A',
      })

      const result = await runExecute(tool, {
        config: { kind: 'tasks', workspaceId },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBe(chatPane.id)
    })

    it('DOES auto-scope conversation-specific kinds (plan) when activeThreadId is set', async () => {
      const chatPane = state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['plan'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-A',
      })

      const result = await runExecute(tool, {
        config: { kind: 'plan', planId: 'plan_test' },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBe(chatPane.id)
    })

    it('scopes correctly when multiple chat panes exist (picks the one whose threadId matches)', async () => {
      // Two chat panes for two different threads. activeThreadId
      // is thread-B → scoped pane must point at chat-B, not chat-A.
      state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-A' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })
      const chatB = state.createWorkspacePane(workspaceId, {
        config: { kind: 'chat', profileId: 'p_test', threadId: 'thread-B' },
        metadata: { openedBy: 'user', pinned: false, closeable: true },
        zone: 'tabs',
      })

      const tool = createOpenPaneTool({
        state,
        workspaceId,
        allowedKinds: ['markdown'],
        defaultPlacement: 'split',
        activeThreadId: 'thread-B',
      })

      const result = await runExecute(tool, {
        config: { kind: 'markdown', source: { origin: 'inline', content: '# scoped-to-B' } },
      })
      const response = parseResponse(result)
      if (response.status !== 'opened') throw new Error('unreachable')

      const persisted = state.getWorkspacePane(response.paneId)
      expect(persisted!.metadata.scopedToChatId).toBe(chatB.id)
    })
  })
})
