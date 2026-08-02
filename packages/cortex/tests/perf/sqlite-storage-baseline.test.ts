import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { GatewayState } from '../../src/gateway/state.js'

const THREADS = 100
const MESSAGES_PER_THREAD = 3
const EVENTS_PER_THREAD = 5

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))]!
}

function bytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

describe('SQLite deterministic storage baseline', () => {
  it.runIf(process.env['RUN_STORAGE_BASELINE'] === '1')(
    'records adapter latency and growth for a fixed durable workload',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'ownware-storage-baseline-'))
      const dbPath = join(directory, 'ownware.db')
      const createLatency: number[] = []
      const messageLatency: number[] = []
      const eventLatency: number[] = []
      let state: GatewayState | undefined

      try {
        state = new GatewayState(dbPath, {
          permissionHashSecret: 'storage-baseline-permission-secret',
        })
        await state.initializeStorage()
        await state.closeStorage()
        state = undefined
        const freshMainBytes = bytes(dbPath)
        const freshLockBytes = bytes(`${dbPath}.migration-lock.sqlite`)

        state = new GatewayState(dbPath, {
          permissionHashSecret: 'storage-baseline-permission-secret',
        })
        await state.initializeStorage()
        const threadIds: string[] = []
        for (let threadIndex = 0; threadIndex < THREADS; threadIndex += 1) {
          let started = performance.now()
          const thread = await state.createThread(
            'storage-baseline',
            `Storage baseline ${threadIndex}`,
          )
          createLatency.push(performance.now() - started)
          threadIds.push(thread.id)

          for (let messageIndex = 0; messageIndex < MESSAGES_PER_THREAD; messageIndex += 1) {
            started = performance.now()
            await state.addMessage(thread.id, {
              id: `baseline_message_${threadIndex}_${messageIndex}`,
              role: messageIndex % 2 === 0 ? 'user' : 'assistant',
              content: `fixed baseline payload ${threadIndex}/${messageIndex} ` + 'x'.repeat(160),
              timestamp: `2026-08-02T00:${String(threadIndex % 60).padStart(2, '0')}:${String(messageIndex).padStart(2, '0')}.000Z`,
            })
            messageLatency.push(performance.now() - started)
          }

          for (let eventIndex = 0; eventIndex < EVENTS_PER_THREAD; eventIndex += 1) {
            started = performance.now()
            await state.eventIngestor.ingest({
              threadId: thread.id,
              agentId: 'root',
              parentAgentId: null,
              event: {
                type: 'text.delta',
                text: `fixed event ${threadIndex}/${eventIndex} ` + 'y'.repeat(80),
              },
            })
            eventLatency.push(performance.now() - started)
          }
        }
        expect(await state.countAgentEvents()).toBe(THREADS * EVENTS_PER_THREAD)
        await state.closeStorage()
        state = undefined

        const populatedMainBytes = bytes(dbPath)
        const populatedLockBytes = bytes(`${dbPath}.migration-lock.sqlite`)
        const walBytesAfterClose = bytes(`${dbPath}-wal`)
        const shmBytesAfterClose = bytes(`${dbPath}-shm`)

        state = new GatewayState(dbPath, {
          permissionHashSecret: 'storage-baseline-permission-secret',
        })
        await state.initializeStorage()
        const reopened = await state.listThreads('storage-baseline', { limit: THREADS })
        expect(reopened.items).toHaveLength(THREADS)
        expect(await state.getMessages(threadIds[0]!)).toHaveLength(MESSAGES_PER_THREAD)
        expect(await state.countAgentEvents()).toBe(THREADS * EVENTS_PER_THREAD)

        const result = {
          workload: {
            threads: THREADS,
            messages: THREADS * MESSAGES_PER_THREAD,
            events: THREADS * EVENTS_PER_THREAD,
          },
          storageBytes: {
            freshMain: freshMainBytes,
            populatedMain: populatedMainBytes,
            growth: populatedMainBytes - freshMainBytes,
            migrationLockFresh: freshLockBytes,
            migrationLockPopulated: populatedLockBytes,
            walAfterClose: walBytesAfterClose,
            shmAfterClose: shmBytesAfterClose,
          },
          latencyMs: {
            createThreadP50: percentile(createLatency, 0.5),
            createThreadP99: percentile(createLatency, 0.99),
            addMessageP50: percentile(messageLatency, 0.5),
            addMessageP99: percentile(messageLatency, 0.99),
            appendEventP50: percentile(eventLatency, 0.5),
            appendEventP99: percentile(eventLatency, 0.99),
          },
        }
        expect(result.storageBytes.growth).toBeGreaterThan(0)
        expect(result.storageBytes.migrationLockPopulated).toBe(result.storageBytes.migrationLockFresh)
        console.log(`STORAGE_BASELINE ${JSON.stringify(result)}`)
      } finally {
        await state?.closeStorage().catch(() => {})
        rmSync(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
