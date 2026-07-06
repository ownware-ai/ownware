/**
 * Unit tests for GatewayState (SQLite-backed).
 *
 * Each test gets a fresh temp database that's cleaned up after.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'

describe('GatewayState', () => {
  let state: GatewayState
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-state-test-'))
    state = new GatewayState(join(tempDir, 'test.db'))
  })

  afterEach(async () => {
    state.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Threads ──────────────────────────────────────────────────────────

  describe('threads', () => {
    it('creates a thread with generated id', () => {
      const thread = state.createThread('example')
      expect(thread.id).toMatch(/^thread_[a-f0-9]{12}$/)
      expect(thread.profileId).toBe('example')
      expect(thread.status).toBe('active')
      expect(thread.messageCount).toBe(0)
      expect(thread.totalTokens).toBe(0)
      expect(thread.totalCost).toBe(0)
    })

    it('creates a thread with title', () => {
      const thread = state.createThread('example', 'My Chat')
      expect(thread.title).toBe('My Chat')
    })

    it('creates a thread with null title by default', () => {
      const thread = state.createThread('example')
      expect(thread.title).toBeNull()
    })

    it('getThread returns created thread', () => {
      const created = state.createThread('example')
      const fetched = state.getThread(created.id)
      expect(fetched).toBeDefined()
      expect(fetched!.id).toBe(created.id)
    })

    it('getThread returns undefined for unknown id', () => {
      expect(state.getThread('nonexistent')).toBeUndefined()
    })

    it('listThreads returns all threads sorted by updatedAt desc', () => {
      state.createThread('a')
      state.createThread('b')
      state.createThread('c')

      const result = state.listThreads()
      const list = result.items
      expect(list).toHaveLength(3)
      expect(result.total).toBe(3)
      for (let i = 0; i < list.length - 1; i++) {
        expect(new Date(list[i]!.updatedAt).getTime())
          .toBeGreaterThanOrEqual(new Date(list[i + 1]!.updatedAt).getTime())
      }
    })

    it('listThreads filters by profileId', () => {
      state.createThread('profile-a')
      state.createThread('profile-a')
      state.createThread('profile-b')

      expect(state.listThreads('profile-a').items).toHaveLength(2)
      expect(state.listThreads('profile-b').items).toHaveLength(1)
      expect(state.listThreads('profile-c').items).toHaveLength(0)
      expect(state.listThreads().items).toHaveLength(3) // no filter = all
    })

    it('updateThread modifies fields and updatedAt', () => {
      const thread = state.createThread('example')
      state.updateThread(thread.id, { title: 'Updated', status: 'completed', messageCount: 5 })

      const updated = state.getThread(thread.id)!
      expect(updated.title).toBe('Updated')
      expect(updated.status).toBe('completed')
      expect(updated.messageCount).toBe(5)
    })

    it('updateThread returns undefined for unknown id', () => {
      expect(state.updateThread('nope', { title: 'x' })).toBeUndefined()
    })

    it('deleteThread removes thread and cascades to messages', () => {
      const thread = state.createThread('example')
      state.addMessage(thread.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: new Date().toISOString(),
      })

      expect(state.deleteThread(thread.id)).toBe(true)
      expect(state.getThread(thread.id)).toBeUndefined()
      expect(state.getMessages(thread.id)).toEqual([])
    })

    it('deleteThread returns false for unknown id', () => {
      expect(state.deleteThread('nope')).toBe(false)
    })

    it('threadCount reflects current state', () => {
      expect(state.threadCount).toBe(0)
      state.createThread('a')
      state.createThread('b')
      expect(state.threadCount).toBe(2)
    })

    it('threads persist — survive new GatewayState instance', async () => {
      const dbPath = join(tempDir, 'persist-test.db')
      const state1 = new GatewayState(dbPath)

      const thread = state1.createThread('example', 'Persisted thread')
      state1.addMessage(thread.id, {
        id: 'msg_1',
        role: 'user',
        content: 'this should survive restart',
        timestamp: new Date().toISOString(),
      })
      state1.close()

      // Create new instance pointing to same DB — simulates restart
      const state2 = new GatewayState(dbPath)

      const threads = state2.listThreads()
      expect(threads.items).toHaveLength(1)
      expect(threads.items[0]!.title).toBe('Persisted thread')

      const messages = state2.getMessages(thread.id)
      expect(messages).toHaveLength(1)
      expect(messages[0]!.content).toBe('this should survive restart')

      state2.close()
    })
  })

  // ── Messages ─────────────────────────────────────────────────────────

  describe('messages', () => {
    it('addMessage stores messages for thread', () => {
      const thread = state.createThread('example')
      state.addMessage(thread.id, {
        id: 'msg_1',
        role: 'user',
        content: 'hello',
        timestamp: new Date().toISOString(),
      })
      state.addMessage(thread.id, {
        id: 'msg_2',
        role: 'assistant',
        content: 'hi there',
        timestamp: new Date().toISOString(),
      })

      const messages = state.getMessages(thread.id)
      expect(messages).toHaveLength(2)
      expect(messages[0]!.role).toBe('user')
      expect(messages[1]!.role).toBe('assistant')
    })

    it('getMessages returns empty array for thread with no messages', () => {
      const thread = state.createThread('example')
      expect(state.getMessages(thread.id)).toEqual([])
    })

    it('getMessages returns empty array for unknown thread', () => {
      expect(state.getMessages('nope')).toEqual([])
    })

    it('stores messages with tools, subAgents, attachments', () => {
      const thread = state.createThread('example')
      state.addMessage(thread.id, {
        id: 'msg_complex',
        role: 'assistant',
        content: 'I used some tools',
        tools: [{ name: 'readFile', input: { path: '/tmp/x' }, output: 'contents', durationMs: 50 }],
        subAgents: [{ agentId: 'agent_1', profileName: 'coder', status: 'completed' }],
        attachments: [{ filename: 'img.png', mimeType: 'image/png', category: 'image' as const }],
        thinking: 'Let me think about this...',
        usage: { inputTokens: 100, outputTokens: 50 },
        timestamp: new Date().toISOString(),
      })

      const msgs = state.getMessages(thread.id)
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.tools).toHaveLength(1)
      expect(msgs[0]!.tools![0]!.name).toBe('readFile')
      expect(msgs[0]!.subAgents).toHaveLength(1)
      expect(msgs[0]!.attachments).toHaveLength(1)
      expect(msgs[0]!.thinking).toBe('Let me think about this...')
      expect(msgs[0]!.usage?.inputTokens).toBe(100)
    })
  })

  // ── Usage tracking ──────────────────────────────────────────────────

  describe('usage', () => {
    it('tracks usage records', () => {
      const thread = state.createThread('example')
      state.addUsageRecord({
        threadId: thread.id,
        profileId: 'example',
        model: 'claude-sonnet',
        provider: 'anthropic',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.015,
      })

      const summary = state.getUsageSummary('example')
      expect(summary.totalTokens).toBe(1500)
      expect(summary.totalCost).toBeCloseTo(0.015)
      expect(summary.requestCount).toBe(1)
    })

    it('returns zero summary when no records', () => {
      const summary = state.getUsageSummary('nonexistent')
      expect(summary.totalTokens).toBe(0)
      expect(summary.totalCost).toBe(0)
      expect(summary.requestCount).toBe(0)
    })
  })

  // ── Managed Chrome launches (browser.autoLaunch) ───────────────────

  describe('chrome launches', () => {
    /**
     * Tests use a minimal fake `RunningChrome` — the real thing spawns
     * a Chrome process, which is neither safe nor fast for a unit
     * test. All GatewayState needs is the `stop` contract.
     */
    const makeFakeRunning = (
      overrides: Partial<{ throwOnStop: boolean }> = {},
    ) => {
      let stopCalls = 0
      const running = {
        cdpUrl: 'http://127.0.0.1:9999',
        pid: 1,
        port: 9999,
        executable: { kind: 'chrome' as const, path: '/fake/chrome' },
        userDataDir: '/tmp/fake-profile',
        userDataDirIsTemporary: true,
        startedAt: Date.now(),
        stop: async (): Promise<void> => {
          stopCalls += 1
          if (overrides.throwOnStop) {
            throw new Error('simulated kill failure')
          }
        },
        get stopCalls(): number {
          return stopCalls
        },
      }
      return running
    }

    it('stores and retrieves a Chrome handle', () => {
      const running = makeFakeRunning()
      state.setChromeLaunch('thread_1', running as never)
      expect(state.getChromeLaunch('thread_1')).toBe(running)
    })

    it('clears the slot when set to null', () => {
      const running = makeFakeRunning()
      state.setChromeLaunch('thread_1', running as never)
      state.setChromeLaunch('thread_1', null)
      expect(state.getChromeLaunch('thread_1')).toBeUndefined()
    })

    it('shutdownChromeLaunchForThread calls stop() once and evicts', async () => {
      const running = makeFakeRunning()
      state.setChromeLaunch('thread_1', running as never)
      await state.shutdownChromeLaunchForThread('thread_1')
      expect(running.stopCalls).toBe(1)
      expect(state.getChromeLaunch('thread_1')).toBeUndefined()
    })

    it('shutdownChromeLaunchForThread is a no-op when no handle is attached', async () => {
      await expect(
        state.shutdownChromeLaunchForThread('nope'),
      ).resolves.toBeUndefined()
    })

    it('still evicts the slot when stop() throws', async () => {
      const running = makeFakeRunning({ throwOnStop: true })
      state.setChromeLaunch('thread_1', running as never)
      // Must not reject — a misbehaving Chrome cannot leak the slot.
      await state.shutdownChromeLaunchForThread('thread_1')
      expect(state.getChromeLaunch('thread_1')).toBeUndefined()
    })

    it('shutdownAllChromeLaunches stops every handle and empties the map', async () => {
      const a = makeFakeRunning()
      const b = makeFakeRunning()
      const c = makeFakeRunning({ throwOnStop: true })
      state.setChromeLaunch('t1', a as never)
      state.setChromeLaunch('t2', b as never)
      state.setChromeLaunch('t3', c as never)
      await state.shutdownAllChromeLaunches()
      expect(a.stopCalls).toBe(1)
      expect(b.stopCalls).toBe(1)
      // c threw, but shutdownAll uses Promise.allSettled so other kills
      // still happen and the map ends up empty.
      expect(state.getChromeLaunch('t1')).toBeUndefined()
      expect(state.getChromeLaunch('t2')).toBeUndefined()
      expect(state.getChromeLaunch('t3')).toBeUndefined()
    })

    it('deleteThread kills the attached Chrome', async () => {
      const running = makeFakeRunning()
      const thread = state.createThread('example')
      state.setChromeLaunch(thread.id, running as never)
      state.deleteThread(thread.id)
      // deleteThread schedules shutdown with `void`, so give the
      // microtask queue a turn to run before asserting.
      await new Promise(resolve => setImmediate(resolve))
      expect(running.stopCalls).toBe(1)
      expect(state.getChromeLaunch(thread.id)).toBeUndefined()
    })
  })

  // ── Deferred Chrome launchers (lazy-launch path) ───────────────────
  //
  // Launchers are registered at session-create for every profile that
  // may use a browser. They do not spawn Chrome until their getCdpUrl()
  // fires. The state must still track them so shutdown paths can kill
  // Chrome if it DID spawn — and be a no-op if it didn't.

  describe('chrome launchers (lazy)', () => {
    const makeFakeLauncher = (overrides: { throwOnStop?: boolean } = {}) => {
      let stopCalls = 0
      const launcher = {
        getCdpUrl: async () => 'http://127.0.0.1:0',
        stop: async (): Promise<void> => {
          stopCalls += 1
          if (overrides.throwOnStop) throw new Error('simulated')
        },
        isLaunched: () => false,
        getRunning: () => null,
        get stopCalls(): number {
          return stopCalls
        },
      }
      return launcher
    }

    it('stores and retrieves a launcher', () => {
      const l = makeFakeLauncher()
      state.setChromeLauncher('thread_1', l as never)
      expect(state.getChromeLauncher('thread_1')).toBe(l)
    })

    it('null clears the slot', () => {
      state.setChromeLauncher('thread_1', makeFakeLauncher() as never)
      state.setChromeLauncher('thread_1', null)
      expect(state.getChromeLauncher('thread_1')).toBeUndefined()
    })

    it('shutdownChromeLauncherForThread calls stop() once and evicts', async () => {
      const l = makeFakeLauncher()
      state.setChromeLauncher('thread_1', l as never)
      await state.shutdownChromeLauncherForThread('thread_1')
      expect(l.stopCalls).toBe(1)
      expect(state.getChromeLauncher('thread_1')).toBeUndefined()
    })

    it('shutdownChromeLauncherForThread is a no-op when no launcher is attached', async () => {
      await expect(
        state.shutdownChromeLauncherForThread('nope'),
      ).resolves.toBeUndefined()
    })

    it('still evicts when launcher.stop() throws', async () => {
      const l = makeFakeLauncher({ throwOnStop: true })
      state.setChromeLauncher('thread_1', l as never)
      await state.shutdownChromeLauncherForThread('thread_1')
      expect(state.getChromeLauncher('thread_1')).toBeUndefined()
    })

    it('shutdownAllChromeLaunchers stops every launcher', async () => {
      const a = makeFakeLauncher()
      const b = makeFakeLauncher()
      const c = makeFakeLauncher({ throwOnStop: true })
      state.setChromeLauncher('t1', a as never)
      state.setChromeLauncher('t2', b as never)
      state.setChromeLauncher('t3', c as never)
      await state.shutdownAllChromeLaunchers()
      expect(a.stopCalls).toBe(1)
      expect(b.stopCalls).toBe(1)
      expect(state.getChromeLauncher('t1')).toBeUndefined()
      expect(state.getChromeLauncher('t2')).toBeUndefined()
      expect(state.getChromeLauncher('t3')).toBeUndefined()
    })

    it('deleteThread stops both the launcher AND any launched Chrome', async () => {
      // A session that HAS used the browser ends up with both entries
      // populated: the launcher (registered at session create) and the
      // RunningChrome (stashed by onLaunched). Both must be torn down.
      const l = makeFakeLauncher()
      const running = {
        cdpUrl: 'http://127.0.0.1:9999',
        pid: 1,
        port: 9999,
        executable: { kind: 'chrome' as const, path: '/fake' },
        userDataDir: '/tmp/fake',
        userDataDirIsTemporary: true,
        startedAt: Date.now(),
        stopCalls: 0,
        stop: async (): Promise<void> => {
          running.stopCalls += 1
        },
      }
      const thread = state.createThread('example')
      state.setChromeLauncher(thread.id, l as never)
      state.setChromeLaunch(thread.id, running as never)
      state.deleteThread(thread.id)
      await new Promise(resolve => setImmediate(resolve))
      expect(running.stopCalls).toBe(1)
      expect(l.stopCalls).toBe(1)
      expect(state.getChromeLauncher(thread.id)).toBeUndefined()
      expect(state.getChromeLaunch(thread.id)).toBeUndefined()
    })
  })

  // ── Event log (still in-memory) ────────────────────────────────────

  describe('event log', () => {
    it('logs and retrieves events', () => {
      const event = { type: 'text.delta', text: 'hello' } as any
      state.logEvent('thread_1', event)

      const log = state.getEventLog('thread_1')
      expect(log).toHaveLength(1)
      expect(log[0]!.event.type).toBe('text.delta')
    })

    it('returns empty for unknown thread', () => {
      expect(state.getEventLog('nope')).toEqual([])
    })
  })
})
