/**
 * ConnectorError hierarchy — vendor-agnostic typed errors.
 *
 * The client renders different UI for each subclass. The 2b Composio tool
 * adapter (and every future vendor adapter) translates these into the
 * `ConnectorNotReadyError`-shaped metadata the M1 stub-tool already
 * emits, so a single downstream discriminator
 * (`metadata.kind === 'connector_not_ready'` plus `code`) serves the
 * whole UI surface.
 *
 * Concrete subclasses:
 *   - AuthExpired       → Reconnect button
 *   - RateLimited       → countdown + retry
 *   - Network           → "Check your connection"
 *   - Validation        → inline form errors
 *   - Vendor            → generic vendor 5xx card with code
 *   - NotConfigured     → Set-up card
 *
 * Each one is a real Error subclass (not a plain object) so stack
 * traces survive `await`/`catch` and the 2b adapter can do
 * `instanceof ConnectorAuthExpiredError` at its catch site.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Code enum (serialized into error metadata)
// ---------------------------------------------------------------------------

export const ConnectorErrorCodeSchema = z.enum([
  'auth_expired',
  'rate_limited',
  'network',
  'validation',
  'vendor',
  'not_configured',
  'unknown',
])
export type ConnectorErrorCode = z.infer<typeof ConnectorErrorCodeSchema>

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface ConnectorErrorContext {
  /** Source this error came from (`'composio'`, `'pipedream'`, ...). */
  readonly source: string
  /** Connector id (e.g. `'notion'`). Optional — some errors are source-wide. */
  readonly connectorId?: string
  /** Optional cause. Preserved on the instance for debugging. */
  readonly cause?: unknown
}

export abstract class ConnectorError extends Error {
  abstract readonly code: ConnectorErrorCode
  readonly source: string
  readonly connectorId?: string

  constructor(message: string, ctx: ConnectorErrorContext) {
    super(message)
    this.name = new.target.name
    this.source = ctx.source
    if (ctx.connectorId !== undefined) {
      this.connectorId = ctx.connectorId
    }
    if (ctx.cause !== undefined) {
      // Node's Error supports options.cause; set it defensively so older
      // engines (or subclass miswiring) still retain the reference.
      ;(this as { cause?: unknown }).cause = ctx.cause
    }
  }

  /**
   * Serialize into a plain object suitable for embedding in
   * `ToolResult.metadata`. The 2b Composio tool adapter calls this
   * to produce the `ConnectorNotReadyError`-compatible payload.
   */
  toMetadata(): ConnectorErrorMetadata {
    const out: ConnectorErrorMetadata = {
      code: this.code,
      message: this.message,
      source: this.source,
      ...(this.connectorId !== undefined ? { connectorId: this.connectorId } : {}),
      ...this.extraMetadata(),
    }
    return out
  }

  /** Subclasses override to contribute type-specific fields. */
  protected extraMetadata(): Record<string, unknown> {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

export class ConnectorAuthExpiredError extends ConnectorError {
  readonly code = 'auth_expired' as const
}

export class ConnectorRateLimitedError extends ConnectorError {
  readonly code = 'rate_limited' as const
  readonly retryAfterMs?: number

  constructor(
    message: string,
    ctx: ConnectorErrorContext & { retryAfterMs?: number },
  ) {
    super(message, ctx)
    if (ctx.retryAfterMs !== undefined) this.retryAfterMs = ctx.retryAfterMs
  }

  protected override extraMetadata(): Record<string, unknown> {
    return this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}
  }
}

export class ConnectorNetworkError extends ConnectorError {
  readonly code = 'network' as const
}

export class ConnectorValidationError extends ConnectorError {
  readonly code = 'validation' as const
  readonly fieldErrors?: Readonly<Record<string, string>>

  constructor(
    message: string,
    ctx: ConnectorErrorContext & { fieldErrors?: Readonly<Record<string, string>> },
  ) {
    super(message, ctx)
    if (ctx.fieldErrors !== undefined) this.fieldErrors = ctx.fieldErrors
  }

  protected override extraMetadata(): Record<string, unknown> {
    return this.fieldErrors ? { fieldErrors: { ...this.fieldErrors } } : {}
  }
}

export class ConnectorVendorError extends ConnectorError {
  readonly code = 'vendor' as const
  readonly statusCode?: number

  constructor(
    message: string,
    ctx: ConnectorErrorContext & { statusCode?: number },
  ) {
    super(message, ctx)
    if (ctx.statusCode !== undefined) this.statusCode = ctx.statusCode
  }

  protected override extraMetadata(): Record<string, unknown> {
    return this.statusCode !== undefined ? { statusCode: this.statusCode } : {}
  }
}

export class ConnectorNotConfiguredError extends ConnectorError {
  readonly code = 'not_configured' as const
}

// ---------------------------------------------------------------------------
// Metadata Zod schema (validates the serialized error)
// ---------------------------------------------------------------------------

export const ConnectorErrorMetadataSchema = z.object({
  code: ConnectorErrorCodeSchema,
  message: z.string().min(1),
  source: z.string().min(1),
  connectorId: z.string().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  fieldErrors: z.record(z.string()).optional(),
  statusCode: z.number().int().optional(),
})
export type ConnectorErrorMetadata = z.infer<typeof ConnectorErrorMetadataSchema>

/**
 * True if the given value is a `ConnectorError` (any subclass).
 * Convenience predicate — 2b's tool adapter uses this before
 * calling `.toMetadata()`.
 */
export function isConnectorError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError
}
