import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFileWatcher,
  __testables,
  type WatcherHandle,
} from '../../../src/files/file-watcher.js'

/**
 * Fake chokidar handle we can drive manually. `emit(event)` fires
 * the named handler without any real filesystem activity.
 */
type FakeEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'error'

function makeFakeHandle(): WatcherHandle & {
  emit(event: FakeEvent, arg?: unknown): void
  closed: boolean
} {
  const handlers: Partial<Record<string, (arg?: unknown) => void>> = {}
  const fake = {
    on(event: string, fn: (arg?: unknown) => void) {
      handlers[event] = fn
      return this
    },
    async close() {
      fake.closed = true
    },
    emit(event: string, arg?: unknown) {
      handlers[event]?.(arg)
    },
    closed: false,
  }
  return fake as unknown as WatcherHandle & {
    emit(event: FakeEvent, arg?: unknown): void
    closed: boolean
  }
}

describe('createFileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onChange exactly once after a debounce window despite many events', async () => {
    const fake = makeFakeHandle()
    const onChange = vi.fn()
    createFileWatcher('/tmp/fake', onChange, {
      debounceMs: 100,
      factory: () => fake,
    })

    for (let i = 0; i < 5; i++) fake.emit('change')
    expect(onChange).toHaveBeenCalledTimes(0)

    vi.advanceTimersByTime(99)
    expect(onChange).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('coalesces bursts separated by less than the debounce window', () => {
    const fake = makeFakeHandle()
    const onChange = vi.fn()
    createFileWatcher('/tmp/fake', onChange, {
      debounceMs: 100,
      factory: () => fake,
    })

    fake.emit('change')
    vi.advanceTimersByTime(50)
    fake.emit('change')
    vi.advanceTimersByTime(50)
    fake.emit('change')
    // Still nothing — timer keeps resetting.
    expect(onChange).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(101)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('fires again after the burst settles and a new burst begins', () => {
    const fake = makeFakeHandle()
    const onChange = vi.fn()
    createFileWatcher('/tmp/fake', onChange, {
      debounceMs: 50,
      factory: () => fake,
    })

    fake.emit('change')
    vi.advanceTimersByTime(60)
    expect(onChange).toHaveBeenCalledTimes(1)

    fake.emit('change')
    vi.advanceTimersByTime(60)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('responds to add / unlink / addDir / unlinkDir the same way', () => {
    const fake = makeFakeHandle()
    const onChange = vi.fn()
    createFileWatcher('/tmp/fake', onChange, {
      debounceMs: 20,
      factory: () => fake,
    })

    fake.emit('add')
    fake.emit('unlink')
    fake.emit('addDir')
    fake.emit('unlinkDir')
    vi.advanceTimersByTime(30)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('stop() drops any pending debounce and closes the handle', async () => {
    const fake = makeFakeHandle()
    const onChange = vi.fn()
    const watcher = createFileWatcher('/tmp/fake', onChange, {
      debounceMs: 50,
      factory: () => fake,
    })

    fake.emit('change')
    await watcher.stop()
    vi.advanceTimersByTime(100)
    expect(onChange).not.toHaveBeenCalled()
    expect(fake.closed).toBe(true)
  })

  it('stop() is idempotent', async () => {
    const fake = makeFakeHandle()
    const watcher = createFileWatcher('/tmp/fake', () => {}, {
      factory: () => fake,
    })
    await watcher.stop()
    await expect(watcher.stop()).resolves.toBeUndefined()
  })

  it('swallows a throwing onChange without killing the watcher', () => {
    const fake = makeFakeHandle()
    const onChange = vi.fn(() => {
      throw new Error('boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createFileWatcher('/tmp/fake', onChange, {
      debounceMs: 10,
      factory: () => fake,
    })
    fake.emit('change')
    vi.advanceTimersByTime(20)
    expect(onChange).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('handles chokidar error events without crashing', () => {
    const fake = makeFakeHandle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createFileWatcher('/tmp/fake', () => {}, {
      factory: () => fake,
    })
    // Simulate an EMFILE from chokidar — previously this was
    // an uncaught exception that killed the gateway.
    const err = new Error('too many open files') as NodeJS.ErrnoException
    err.code = 'EMFILE'
    err.errno = -24
    err.syscall = 'watch'
    expect(() => fake.emit('error', err)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    // EMFILE should also trigger a proactive close.
    expect(fake.closed).toBe(true)
    warn.mockRestore()
  })

  it('handles non-EMFILE error events without force-closing', () => {
    const fake = makeFakeHandle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createFileWatcher('/tmp/fake', () => {}, {
      factory: () => fake,
    })
    const err = new Error('something else') as NodeJS.ErrnoException
    err.code = 'EPERM'
    fake.emit('error', err)
    expect(warn).toHaveBeenCalled()
    // EPERM doesn't exhaust fds, so we don't force-close.
    expect(fake.closed).toBe(false)
    warn.mockRestore()
  })
})

describe('makeIgnorePredicate', () => {
  const predicate = __testables.makeIgnorePredicate([])

  it('prunes node_modules by basename', () => {
    expect(predicate('/ws/node_modules')).toBe(true)
  })

  it('prunes .git by basename', () => {
    expect(predicate('/ws/.git')).toBe(true)
  })

  it('prunes any nested segment that matches', () => {
    expect(predicate('/ws/packages/foo/node_modules/bar/index.js')).toBe(true)
    expect(predicate('/ws/packages/foo/dist/bundle.js')).toBe(true)
  })

  it('allows normal source paths', () => {
    expect(predicate('/ws/src/features/files/foo.ts')).toBe(false)
    expect(predicate('/ws/README.md')).toBe(false)
  })

  it('respects extra segments passed by the caller', () => {
    const custom = __testables.makeIgnorePredicate(['my-secret-dir'])
    expect(custom('/ws/my-secret-dir/file.js')).toBe(true)
    expect(custom('/ws/src/features/files/foo.ts')).toBe(false)
  })
})
