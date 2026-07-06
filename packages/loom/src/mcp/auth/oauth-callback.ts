/**
 * OAuth Callback Server
 *
 * Starts a temporary localhost HTTP server to receive the OAuth redirect.
 * The server listens on a random port, waits for the provider to redirect
 * the user's browser back with an authorization code, then shuts down.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { OAuthCallbackResult } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Port range: IANA dynamic/private (macOS ephemeral range) */
const PORT_MIN = 49152
const PORT_MAX = 65535

/** How long to wait for the callback before giving up */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Max port allocation attempts */
const MAX_PORT_ATTEMPTS = 20

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

/**
 * Find an available port in the ephemeral range.
 * Uses net.createServer().listen(0) for reliability.
 */
export async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN))
    const available = await testPort(port)
    if (available) return port
  }

  // Fallback: let the OS pick
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('Failed to find available port'))
      })
    })
    srv.on('error', reject)
  })
}

/**
 * Test if a port is available by attempting to bind.
 */
function testPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

// ---------------------------------------------------------------------------
// Redirect URI
// ---------------------------------------------------------------------------

/**
 * Build the OAuth redirect URI for a given port.
 * Always localhost — RFC 8252 loopback redirect.
 */
export function buildRedirectUri(port: number): string {
  return `http://localhost:${port}/oauth/callback`
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

/**
 * Start a one-shot HTTP server that waits for the OAuth redirect.
 *
 * Returns a promise that resolves with { code, state } when the provider
 * redirects back, or rejects on timeout/error.
 *
 * The server automatically shuts down after receiving the callback or
 * after the timeout expires.
 */
export function startCallbackServer(
  port: number,
  expectedState: string,
): { promise: Promise<OAuthCallbackResult>; server: Server; shutdown: () => void } {
  let server: Server
  let timeoutId: ReturnType<typeof setTimeout>

  const promise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)

      // Only handle the callback path
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }

      // Check for OAuth error response
      const error = url.searchParams.get('error')
      if (error) {
        const desc = url.searchParams.get('error_description') ?? undefined
        sendErrorPage(res, error, desc)
        cleanup()
        reject(new OAuthFlowError(
          error,
          desc ?? `OAuth provider returned error: ${error}`,
        ))
        return
      }

      // Extract authorization code
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!code) {
        sendErrorPage(res, 'missing_code', 'No authorization code in callback')
        cleanup()
        reject(new OAuthFlowError('missing_code', 'No authorization code received'))
        return
      }

      // CSRF check: verify state matches
      if (state !== expectedState) {
        sendErrorPage(res, 'state_mismatch', 'Security check failed — state token mismatch')
        cleanup()
        reject(new OAuthFlowError(
          'state_mismatch',
          'OAuth state mismatch — possible CSRF attack. Expected state does not match received state.',
        ))
        return
      }

      // Success — send confirmation page and resolve
      sendSuccessPage(res)
      cleanup()
      resolve({ code, state })
    })

    server!.listen(port, '127.0.0.1', () => {
      // Server is ready — waiting for callback
    })

    server!.on('error', (err) => {
      cleanup()
      reject(new OAuthFlowError('server_error', `Callback server error: ${err.message}`))
    })

    // Timeout: 5 minutes to complete login
    timeoutId = setTimeout(() => {
      cleanup()
      reject(new OAuthFlowError(
        'timeout',
        `OAuth flow timed out after ${CALLBACK_TIMEOUT_MS / 1000}s — no callback received`,
      ))
    }, CALLBACK_TIMEOUT_MS)

    // Don't keep the process alive just for the timeout
    if (timeoutId.unref) timeoutId.unref()
  })

  function cleanup(): void {
    clearTimeout(timeoutId)
    if (server!) {
      server!.close()
    }
  }

  // @ts-expect-error — server is assigned in the promise executor synchronously
  return { promise, server, shutdown: cleanup }
}

// ---------------------------------------------------------------------------
// HTML responses
// ---------------------------------------------------------------------------

function sendSuccessPage(res: import('node:http').ServerResponse): void {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cortex — Authenticated</title>
  <style>
    body {
      font-family: 'IBM Plex Sans', -apple-system, sans-serif;
      background: #0A0B10;
      color: #E8E8ED;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      text-align: center;
      padding: 3rem;
      border-radius: 16px;
      background: rgba(255,255,255,0.04);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.06);
    }
    .check { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 500; margin: 0 0 8px; }
    p { color: #9898A6; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Authentication successful</h1>
    <p>You can close this tab and return to Cortex.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000)</script>
</body>
</html>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

/**
 * HTML-entity-encode a string for safe insertion into element text or
 * attribute values. Replaces the legacy "strip these characters"
 * approach which was technically correct for the current text-node
 * placement but brittle: any future change to the template that moved
 * the value into an attribute or `<script>` block would have been a
 * one-shot stored XSS. Encoding handles both cases. Audit Hazard 17.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;') // & must come first
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sendErrorPage(
  res: import('node:http').ServerResponse,
  error: string,
  description?: string,
): void {
  // Cap provider-supplied strings so a malicious provider can't ship
  // megabytes of HTML through the error page.
  const safeError = escapeHtml(error.slice(0, 200))
  const safeDesc = escapeHtml(
    (description ?? 'An error occurred during authentication.').slice(0, 500),
  )

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cortex — Authentication Failed</title>
  <style>
    body {
      font-family: 'IBM Plex Sans', -apple-system, sans-serif;
      background: #0A0B10;
      color: #E8E8ED;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      text-align: center;
      padding: 3rem;
      border-radius: 16px;
      background: rgba(255,255,255,0.04);
      box-shadow: 0 0 0 1px rgba(255,255,255,0.06);
    }
    .icon { font-size: 48px; margin-bottom: 16px; color: #F14060; }
    h1 { font-size: 20px; font-weight: 500; margin: 0 0 8px; }
    p { color: #9898A6; font-size: 14px; margin: 0; }
    code { color: #F14060; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10007;</div>
    <h1>Authentication failed</h1>
    <p>${safeDesc}</p>
    <p style="margin-top: 12px"><code>${safeError}</code></p>
  </div>
</body>
</html>`
  res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class OAuthFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}
