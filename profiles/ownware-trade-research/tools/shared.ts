/**
 * Shared utilities for all trading-research tools.
 *
 * - Retry wrapper with exponential backoff (handles Yahoo 429s, network errors)
 * - Data freshness tracking (timestamps on every response)
 * - Yahoo Finance chart fetcher (used by market-data, risk, backtest, score)
 * - Credential helpers that prefer session-stored secrets (from
 *   `request_credential`) over `process.env` so tools work correctly after the
 *   agent prompts the user for a missing key.
 */

import type { ToolContext, ToolResult } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Credentials — read from session first, fall back to process.env
// ---------------------------------------------------------------------------

/**
 * Resolve a named env-placed credential.
 *
 * Order:
 *   1. The session's credential runtime (populated by `request_credential`
 *      calls the agent makes on the user's behalf).
 *   2. `process.env` — developer-set env vars at Cortex launch.
 *
 * Returns the raw value or `null` when no credential exists under that name.
 * Callers MUST NOT log or echo the returned string.
 */
export function getCredential(
  context: ToolContext | undefined,
  variableName: string,
): string | null {
  if (context != null) {
    for (const entry of context.listEnvCredentials()) {
      if (entry.variableName === variableName) {
        const value = context.resolveCredential(entry.credentialId)
        if (value != null && value.length > 0) return value
      }
    }
  }
  const fromEnv = process.env[variableName]
  return fromEnv != null && fromEnv.length > 0 ? fromEnv : null
}

/**
 * Structured guidance returned when a required credential is missing.
 *
 * The message tells the agent exactly how to recover: call
 * `request_credential` with a specific `placement.variableName`, then retry.
 * Models reliably follow this format — it turns a raw 401 into a one-click
 * secret prompt for the user.
 */
export function missingCredentialResult(args: {
  variableName: string
  label: string
  hint: string
  usage: string
}): ToolResult {
  const { variableName, label, hint, usage } = args
  const body = [
    `MISSING_CREDENTIAL: ${variableName}`,
    '',
    `This tool needs ${label} to run. Ask the user for it by calling`,
    '`request_credential` with exactly:',
    '',
    JSON.stringify(
      {
        label,
        hint,
        usage,
        placement: { type: 'env', variableName },
        isRequired: true,
      },
      null,
      2,
    ),
    '',
    'When the user stores the credential, retry this tool with the same input.',
  ].join('\n')

  return { content: body, isError: true, metadata: { missingCredential: variableName } }
}

// ---------------------------------------------------------------------------
// Retry fetch — handles 429, 500, 502, 503, network errors
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts?: RetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 3
  const baseDelay = opts?.baseDelayMs ?? 1000
  const maxDelay = opts?.maxDelayMs ?? 10_000

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          'User-Agent': 'Ownware/1.0 (trading-research-profile)',
          ...(init?.headers ?? {}),
        },
      })

      // Retry on rate limit or server errors
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * 500, maxDelay)
          await sleep(delay)
          continue
        }
      }

      return res
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * 500, maxDelay)
        await sleep(delay)
      }
    }
  }

  throw lastError ?? new Error(`Failed after ${maxRetries + 1} attempts`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Data freshness — every tool result should include this
// ---------------------------------------------------------------------------

export function dataFreshness(): { fetchedAt: string; note: string } {
  return {
    fetchedAt: new Date().toISOString(),
    note: 'Yahoo Finance free data may be 15-20min delayed for intraday. Daily close prices are accurate.',
  }
}

// ---------------------------------------------------------------------------
// Round helper
// ---------------------------------------------------------------------------

export function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// OHLCV row type
// ---------------------------------------------------------------------------

export interface OHLCVRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ---------------------------------------------------------------------------
// Yahoo Finance chart API — shared fetcher with retry
// ---------------------------------------------------------------------------

export async function fetchOHLCVWithRetry(
  symbol: string,
  startUnix: number,
  endUnix: number,
  interval: '1d' | '1wk' | '1mo' = '1d',
): Promise<OHLCVRow[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${startUnix}&period2=${endUnix}&interval=${interval}&includePrePost=false`

  const res = await fetchWithRetry(url)

  if (!res.ok) {
    throw new Error(`Yahoo Finance API error for ${symbol}: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as Record<string, unknown>
  const chart = json.chart as Record<string, unknown>
  const error = chart.error as Record<string, unknown> | null
  if (error) {
    throw new Error(`Yahoo Finance error for ${symbol}: ${(error.description as string) ?? 'unknown'}`)
  }

  const results = (chart.result as Record<string, unknown>[])?.[0]
  if (!results) throw new Error(`No data returned for ${symbol}`)

  const timestamps = results.timestamp as number[] | undefined
  if (!timestamps || timestamps.length === 0) {
    throw new Error(`No price data for ${symbol} in the given date range`)
  }

  const quote = (results.indicators as Record<string, unknown>).quote as Record<string, unknown>[]
  const q = quote[0]

  const opens = q.open as (number | null)[]
  const highs = q.high as (number | null)[]
  const lows = q.low as (number | null)[]
  const closes = q.close as (number | null)[]
  const volumes = q.volume as (number | null)[]

  const rows: OHLCVRow[] = []
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue
    rows.push({
      date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
      open: round(opens[i] ?? closes[i]!, 4),
      high: round(highs[i] ?? closes[i]!, 4),
      low: round(lows[i] ?? closes[i]!, 4),
      close: round(closes[i]!, 4),
      volume: volumes[i] ?? 0,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function dateToUnix(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000)
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function monthsAgoUnix(months: number): number {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return Math.floor(d.getTime() / 1000)
}

// ---------------------------------------------------------------------------
// Technical indicator helpers (shared by score + backtest)
// ---------------------------------------------------------------------------

export function computeSMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += data[j]
    result.push(sum / period)
  }
  return result
}

export function computeEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  const mult = 2 / (period + 1)
  let prev: number | null = null
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    if (prev === null) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += data[j]
      prev = sum / period
    } else {
      prev = (data[i] - prev) * mult + prev
    }
    result.push(prev)
  }
  return result
}

export function computeRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = [null]
  let avgGain = 0
  let avgLoss = 0

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    if (i <= period) {
      if (change > 0) avgGain += change; else avgLoss += Math.abs(change)
      if (i === period) {
        avgGain /= period
        avgLoss /= period
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
        result.push(100 - 100 / (1 + rs))
      } else {
        result.push(null)
      }
    } else {
      const gain = change > 0 ? change : 0
      const loss = change < 0 ? Math.abs(change) : 0
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
      result.push(100 - 100 / (1 + rs))
    }
  }
  return result
}

export function computeMACDSignal(closes: number[]): { macd: (number | null)[]; signal: (number | null)[] } {
  const ema12 = computeEMA(closes, 12)
  const ema26 = computeEMA(closes, 26)
  const macdLine: (number | null)[] = []
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] == null || ema26[i] == null) { macdLine.push(null); continue }
    macdLine.push(ema12[i]! - ema26[i]!)
  }
  const macdValues = macdLine.filter((v): v is number => v !== null)
  const signalRaw = computeEMA(macdValues, 9)
  const signal: (number | null)[] = []
  let si = 0
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) { signal.push(null); continue }
    signal.push(signalRaw[si] ?? null)
    si++
  }
  return { macd: macdLine, signal }
}

export function computeATR(rows: OHLCVRow[], period = 14): (number | null)[] {
  const tr: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) { tr.push(rows[i].high - rows[i].low); continue }
    tr.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close),
    ))
  }
  const result: (number | null)[] = []
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    if (i === period - 1) {
      result.push(tr.slice(0, period).reduce((s, v) => s + v, 0) / period)
    } else {
      result.push((result[i - 1]! * (period - 1) + tr[i]) / period)
    }
  }
  return result
}

/** Get the last non-null value from an array */
export function lastVal<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i]
  }
  return null
}
