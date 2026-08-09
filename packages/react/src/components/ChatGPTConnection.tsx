import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type {
  CodexLoginPresentation,
  CodexModelCatalog,
  CodexRuntimeStatus,
  OwnwareClient,
} from '@ownware/client'
import {
  OW_CONNECTION_STYLE_ID,
  ownwareConnectionCss,
} from './styles.js'

export type ChatGPTConnectionClient = Pick<
  OwnwareClient,
  | 'codexRuntime'
  | 'startCodexLogin'
  | 'waitForCodexLogin'
  | 'cancelCodexLogin'
  | 'logoutCodex'
  | 'codexModels'
>

export interface ChatGPTConnectionProps {
  readonly client: ChatGPTConnectionClient
  readonly theme?: 'dark' | 'light'
  readonly className?: string
  readonly style?: CSSProperties
  readonly onStatusChange?: (status: CodexRuntimeStatus) => void
}

type Action = 'loading' | 'starting' | 'waiting' | 'cancelling' | 'logging_out'
type Failure = 'status' | 'start' | 'wait' | 'cancel' | 'logout'

/**
 * Owner-facing ChatGPT subscription connection surface.
 *
 * The Codex-managed route is operable. The direct route is shown separately
 * and remains unavailable until its own gateway/provider acceptance lane is
 * proven. Login URLs and device codes live only in component state and are
 * discarded as soon as the attempt ends.
 */
export function ChatGPTConnection(props: ChatGPTConnectionProps) {
  const { client, onStatusChange } = props
  const [status, setStatus] = useState<CodexRuntimeStatus>()
  const [presentation, setPresentation] = useState<CodexLoginPresentation>()
  const [catalog, setCatalog] = useState<CodexModelCatalog>()
  const [action, setAction] = useState<Action | undefined>('loading')
  const [failure, setFailure] = useState<Failure>()
  const [catalogFailed, setCatalogFailed] = useState(false)
  const mounted = useRef(true)

  useInjectConnectionStyles()

  const publish = useCallback((next: CodexRuntimeStatus): void => {
    if (!mounted.current) return
    setStatus(next)
    onStatusChange?.(next)
  }, [onStatusChange])

  const readModels = useCallback(async (): Promise<void> => {
    try {
      const next = await client.codexModels()
      if (!mounted.current) return
      setCatalog(next)
      setCatalogFailed(false)
    } catch {
      if (!mounted.current) return
      setCatalog(undefined)
      setCatalogFailed(true)
    }
  }, [client])

  const refresh = useCallback(async (): Promise<void> => {
    setAction('loading')
    setFailure(undefined)
    try {
      const next = await client.codexRuntime()
      publish(next)
      if (next.account.state === 'authenticated') await readModels()
      else {
        setCatalog(undefined)
        setCatalogFailed(false)
      }
    } catch {
      if (mounted.current) setFailure('status')
    } finally {
      if (mounted.current) setAction(undefined)
    }
  }, [client, publish, readModels])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  const waitForLogin = useCallback(async (): Promise<void> => {
    setAction('waiting')
    setFailure(undefined)
    try {
      const next = await client.waitForCodexLogin(20_000)
      publish(next)
      if (next.login.phase !== 'pending' && next.login.phase !== 'cancelling') {
        setPresentation(undefined)
      }
      if (next.account.state === 'authenticated') await readModels()
    } catch {
      if (mounted.current) setFailure('wait')
    } finally {
      if (mounted.current) setAction(undefined)
    }
  }, [client, publish, readModels])

  const connect = useCallback(async (kind: 'browser' | 'device'): Promise<void> => {
    setAction('starting')
    setFailure(undefined)
    setPresentation(undefined)
    try {
      const next = await client.startCodexLogin(kind)
      if (!mounted.current) return
      setPresentation(next)
      await waitForLogin()
    } catch {
      if (mounted.current) {
        setFailure('start')
        setAction(undefined)
      }
    }
  }, [client, waitForLogin])

  const cancel = useCallback(async (): Promise<void> => {
    setAction('cancelling')
    setFailure(undefined)
    try {
      const next = await client.cancelCodexLogin()
      publish(next)
      setPresentation(undefined)
    } catch {
      if (mounted.current) setFailure('cancel')
    } finally {
      if (mounted.current) setAction(undefined)
    }
  }, [client, publish])

  const logout = useCallback(async (): Promise<void> => {
    setAction('logging_out')
    setFailure(undefined)
    try {
      const next = await client.logoutCodex()
      publish(next)
      setPresentation(undefined)
      setCatalog(undefined)
      setCatalogFailed(false)
    } catch {
      if (mounted.current) setFailure('logout')
    } finally {
      if (mounted.current) setAction(undefined)
    }
  }, [client, publish])

  const connected = status?.account.state === 'authenticated'
  const pending = status?.login.phase === 'pending'
    || status?.login.phase === 'cancelling'
    || presentation !== undefined
  const busy = action !== undefined
  const defaultModel = catalog?.models.find((model) => model.isDefault)

  return (
    <section
      className={props.className ? `ow-connection ${props.className}` : 'ow-connection'}
      data-ow-theme={props.theme ?? 'dark'}
      style={props.style}
      aria-busy={busy}
      aria-labelledby="ow-connection-title"
    >
      <header className="ow-connection-head">
        <div>
          <p className="ow-connection-eyebrow">Model access</p>
          <h2 id="ow-connection-title">ChatGPT connection</h2>
          <p>Use your own ChatGPT subscription on this Ownware installation.</p>
        </div>
        <span className={connected ? 'ow-connection-state connected' : 'ow-connection-state'}>
          <span aria-hidden="true" />
          {connected ? 'Connected' : action === 'loading' ? 'Checking' : 'Not connected'}
        </span>
      </header>

      <div className="ow-route-list">
        <article className="ow-route active">
          <div className="ow-route-copy">
            <div className="ow-route-title">
              <h3>Codex managed</h3>
              <span className="ow-badge">Experimental</span>
            </div>
            <p>Codex handles sign-in and keeps the subscription tokens in its own local home.</p>
            {status && (
              <p className="ow-route-meta">
                Protocol {status.runtime.protocolVersion} · official app-server route
              </p>
            )}
          </div>

          <div className="ow-route-action">
            {connected ? (
              <button className="ow-connection-btn ghost" type="button" onClick={() => void logout()} disabled={busy}>
                {action === 'logging_out' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            ) : pending ? (
              <button className="ow-connection-btn ghost" type="button" onClick={() => void cancel()} disabled={action === 'cancelling'}>
                {action === 'cancelling' ? 'Cancelling…' : 'Cancel'}
              </button>
            ) : (
              <div className="ow-connection-actions">
                <button className="ow-connection-btn primary" type="button" onClick={() => void connect('browser')} disabled={busy}>
                  Connect in browser
                </button>
                <button className="ow-connection-btn ghost" type="button" onClick={() => void connect('device')} disabled={busy}>
                  Use a code
                </button>
              </div>
            )}
          </div>
        </article>

        <article className="ow-route unavailable" aria-disabled="true">
          <div className="ow-route-copy">
            <div className="ow-route-title">
              <h3>Direct transport</h3>
              <span className="ow-badge muted">Not enabled</span>
            </div>
            <p>A lower-level subscription route. It remains off while its compatibility and account-flow testing is incomplete.</p>
          </div>
        </article>
      </div>

      {presentation && (
        <div className="ow-login-panel" role="status" aria-live="polite">
          {presentation.kind === 'browser' ? (
            <>
              <strong>Continue in ChatGPT</strong>
              <p>Open the sign-in page, finish there, then return to this screen.</p>
              <a href={presentation.url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in ↗</a>
            </>
          ) : (
            <>
              <strong>Enter this one-time code</strong>
              <code>{presentation.userCode}</code>
              <a href={presentation.verificationUrl} target="_blank" rel="noopener noreferrer">Open device sign-in ↗</a>
            </>
          )}
          {action === 'waiting' ? (
            <p className="ow-connection-wait">Waiting for Codex to confirm the connection…</p>
          ) : (
            <button className="ow-connection-btn ghost" type="button" onClick={() => void waitForLogin()}>
              Check connection
            </button>
          )}
        </div>
      )}

      {connected && (
        <div className="ow-connected-detail" role="status" aria-live="polite">
          <div>
            <span>Subscription</span>
            <strong>{status.account.state === 'authenticated' ? status.account.plan : 'Connected'}</strong>
          </div>
          <div>
            <span>Available models</span>
            <strong>{catalog ? catalog.models.length : 'Checking…'}</strong>
          </div>
          <div>
            <span>Default model</span>
            <strong>{defaultModel?.displayName ?? defaultModel?.model ?? 'Provider default'}</strong>
          </div>
        </div>
      )}

      {catalogFailed && (
        <p className="ow-connection-note" role="status">
          Connected, but the model catalog could not be refreshed. Try again from this installation.
        </p>
      )}

      {failure && (
        <div className="ow-connection-error" role="alert">
          <span>{failureMessage(failure)}</span>
          <button type="button" onClick={() => void refresh()}>Try again</button>
        </div>
      )}

      <footer className="ow-connection-foot">
        Ownware does not read or copy your ChatGPT token. This route is experimental because the upstream app-server interface is not supported for production yet.
      </footer>
    </section>
  )
}

function failureMessage(failure: Failure): string {
  switch (failure) {
    case 'status': return 'Could not inspect the local Codex connection.'
    case 'start': return 'Could not start ChatGPT sign-in.'
    case 'wait': return 'Codex did not confirm the sign-in yet.'
    case 'cancel': return 'Could not cancel the current sign-in.'
    case 'logout': return 'Could not disconnect the ChatGPT subscription.'
  }
}

function useInjectConnectionStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(OW_CONNECTION_STYLE_ID)) return
    const element = document.createElement('style')
    element.id = OW_CONNECTION_STYLE_ID
    element.textContent = ownwareConnectionCss
    document.head.appendChild(element)
  }, [])
}
