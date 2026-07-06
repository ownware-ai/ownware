/**
 * Abort Controller Management
 *
 * Creates linked abort signals so parent session abort cascades
 * to sub-agents. Also provides timeout signals.
 */

export function createLinkedAbortController(
  parent?: AbortSignal | null,
): AbortController {
  const controller = new AbortController()

  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason)
    } else {
      parent.addEventListener('abort', () => {
        controller.abort(parent.reason)
      }, { once: true })
    }
  }

  return controller
}

export function createTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

export function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted ?? false
}

export function createCombinedSignal(
  ...signals: (AbortSignal | null | undefined)[]
): AbortSignal {
  const controller = new AbortController()
  const activeSignals = signals.filter((s): s is AbortSignal => s != null)

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => {
      controller.abort(signal.reason)
    }, { once: true })
  }

  return controller.signal
}
