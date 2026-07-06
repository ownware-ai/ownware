/**
 * Macro Economic Tools
 *
 * Data sources:
 * - FRED API (Federal Reserve Economic Data) — free key, 120 req/min
 * - Finnhub (economic calendar) — free key, 60 req/min
 *
 * Tools:
 * - get_macro_snapshot: Key economic indicators (Fed rate, CPI, GDP, unemployment, yield curve)
 * - get_economic_calendar: Upcoming economic events and earnings dates
 */

import { defineTool } from '@ownware/loom'
import type { Tool, ToolContext } from '@ownware/loom'
import { getCredential, missingCredentialResult } from './shared.js'

function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// FRED API
// ---------------------------------------------------------------------------

interface FREDObservation {
  date: string
  value: string
}

async function fetchFREDSeries(
  key: string,
  seriesId: string,
  limit = 5,
): Promise<FREDObservation[]> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`FRED API error: ${res.status}`)

  const json = (await res.json()) as Record<string, unknown>
  return (json.observations as FREDObservation[]) ?? []
}

async function fetchFREDLatest(key: string, seriesId: string): Promise<{ value: number | null; date: string }> {
  const obs = await fetchFREDSeries(key, seriesId, 1)
  if (obs.length === 0) return { value: null, date: '' }
  const val = obs[0].value === '.' ? null : parseFloat(obs[0].value)
  return { value: val, date: obs[0].date }
}

async function fetchFREDTrend(key: string, seriesId: string, points = 4): Promise<Array<{ date: string; value: number | null }>> {
  const obs = await fetchFREDSeries(key, seriesId, points)
  return obs.map(o => ({
    date: o.date,
    value: o.value === '.' ? null : parseFloat(o.value),
  })).reverse()
}

// ---------------------------------------------------------------------------
// Finnhub economic calendar
// ---------------------------------------------------------------------------

async function fetchEconomicCalendar(key: string | null): Promise<Array<{
  event: string
  date: string
  impact: string
  country: string
  actual: string | null
  estimate: string | null
  previous: string | null
}>> {
  if (!key) return []

  const from = new Date().toISOString().split('T')[0]
  const to = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`,
    )
    if (!res.ok) return []

    const json = (await res.json()) as Record<string, unknown>
    const events = (json.economicCalendar as Record<string, unknown>[]) ?? []

    return events
      .filter(e => (e.country as string) === 'US')
      .slice(0, 15)
      .map(e => ({
        event: (e.event as string) ?? '',
        date: (e.time as string) ?? '',
        impact: (e.impact as string) ?? 'low',
        country: 'US',
        actual: (e.actual as string) ?? null,
        estimate: (e.estimate as string) ?? null,
        previous: (e.prev as string) ?? null,
      }))
  } catch {
    return []
  }
}

async function fetchEarningsCalendar(key: string | null, symbol?: string): Promise<Array<{
  symbol: string
  date: string
  epsEstimate: number | null
  revenueEstimate: number | null
}>> {
  if (!key) return []

  const from = new Date().toISOString().split('T')[0]
  const to = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]

  try {
    let url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`
    if (symbol) url += `&symbol=${encodeURIComponent(symbol)}`

    const res = await fetch(url)
    if (!res.ok) return []

    const json = (await res.json()) as Record<string, unknown>
    const calendar = (json.earningsCalendar as Record<string, unknown>[]) ?? []

    return calendar.slice(0, 10).map(e => ({
      symbol: (e.symbol as string) ?? '',
      date: (e.date as string) ?? '',
      epsEstimate: (e.epsEstimate as number) ?? null,
      revenueEstimate: (e.revenueEstimate as number) ?? null,
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Tool: get_macro_snapshot
// ---------------------------------------------------------------------------

export const getMacroSnapshot: Tool = defineTool({
  name: 'get_macro_snapshot',
  description:
    'Get current macroeconomic indicators from FRED: Fed funds rate, CPI (inflation), ' +
    'GDP growth, unemployment rate, 10Y/2Y treasury yields (yield curve), and S&P 500 level. ' +
    'Includes trend data (last 4 readings) and regime assessment. Requires FRED_API_KEY.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 30_000,
  async execute(_input, context: ToolContext) {
    const key = getCredential(context, 'FRED_API_KEY')
    if (!key) {
      return missingCredentialResult({
        variableName: 'FRED_API_KEY',
        label: 'FRED API key',
        hint: 'Free key — register at https://fred.stlouisfed.org/docs/api/api_key.html and paste the key here.',
        usage: 'Fetch Federal Reserve macro data (Fed funds rate, CPI, GDP, unemployment, Treasury yields).',
      })
    }

    try {
      // Fetch all indicators in parallel
      const [
        fedRate,
        cpi,
        gdp,
        unemployment,
        treasury10y,
        treasury2y,
        sp500,
        cpiTrend,
        fedRateTrend,
      ] = await Promise.all([
        fetchFREDLatest(key, 'FEDFUNDS'),          // Fed funds rate
        fetchFREDLatest(key, 'CPIAUCSL'),          // CPI (all items)
        fetchFREDLatest(key, 'GDP'),               // GDP (quarterly, billions)
        fetchFREDLatest(key, 'UNRATE'),            // Unemployment rate
        fetchFREDLatest(key, 'GS10'),              // 10Y treasury yield
        fetchFREDLatest(key, 'GS2'),               // 2Y treasury yield
        fetchFREDLatest(key, 'SP500'),             // S&P 500
        fetchFREDTrend(key, 'CPIAUCSL', 6),        // CPI trend
        fetchFREDTrend(key, 'FEDFUNDS', 6),        // Fed rate trend
      ])

      // Yield curve
      const yieldSpread = treasury10y.value != null && treasury2y.value != null
        ? round(treasury10y.value - treasury2y.value, 3)
        : null

      // CPI year-over-year change (approximate from 12-month comparison)
      const latestCPI = cpiTrend.length > 0 ? cpiTrend[cpiTrend.length - 1].value : null
      const prevCPI = cpiTrend.length > 1 ? cpiTrend[cpiTrend.length - 2].value : null
      const cpiMoM = latestCPI != null && prevCPI != null && prevCPI > 0
        ? round(((latestCPI - prevCPI) / prevCPI) * 100, 2)
        : null

      // Regime assessment
      const flags: string[] = []

      if (fedRate.value != null) {
        const latest = fedRateTrend[fedRateTrend.length - 1]?.value ?? fedRate.value
        const prev = fedRateTrend.length > 1 ? fedRateTrend[fedRateTrend.length - 2]?.value : null
        if (prev != null) {
          if (latest > prev) flags.push('Fed HIKING — headwind for growth stocks')
          else if (latest < prev) flags.push('Fed CUTTING — tailwind for risk assets')
          else flags.push('Fed on HOLD')
        }
      }

      if (yieldSpread != null) {
        if (yieldSpread < 0) flags.push('INVERTED yield curve — recession signal')
        else if (yieldSpread < 0.2) flags.push('FLAT yield curve — slowdown risk')
        else flags.push('NORMAL yield curve — no recession signal')
      }

      if (unemployment.value != null) {
        if (unemployment.value < 4) flags.push('TIGHT labor market — inflationary pressure')
        else if (unemployment.value > 5.5) flags.push('RISING unemployment — recession risk')
      }

      const result = {
        snapshot: {
          fedFundsRate: fedRate.value != null ? `${fedRate.value}%` : null,
          fedFundsDate: fedRate.date,
          cpiLevel: latestCPI,
          cpiMonthOverMonth: cpiMoM != null ? `${cpiMoM}%` : null,
          gdpBillions: gdp.value,
          gdpDate: gdp.date,
          unemploymentRate: unemployment.value != null ? `${unemployment.value}%` : null,
          unemploymentDate: unemployment.date,
          treasury10Y: treasury10y.value != null ? `${treasury10y.value}%` : null,
          treasury2Y: treasury2y.value != null ? `${treasury2y.value}%` : null,
          yieldCurveSpread: yieldSpread != null ? `${yieldSpread > 0 ? '+' : ''}${yieldSpread}%` : null,
          sp500: sp500.value,
          sp500Date: sp500.date,
        },
        trends: {
          fedRateHistory: fedRateTrend.map(t => `${t.date}: ${t.value}%`),
          cpiHistory: cpiTrend.map(t => `${t.date}: ${t.value}`),
        },
        regime: flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching macro data: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: get_economic_calendar
// ---------------------------------------------------------------------------

export const getEconomicCalendar: Tool = defineTool({
  name: 'get_economic_calendar',
  description:
    'Get upcoming economic events (Fed meetings, CPI releases, GDP, jobs reports) ' +
    'and earnings dates for the next 2 weeks. Requires FINNHUB_API_KEY for full data. ' +
    'Returns events sorted by date with impact assessment.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Optional: ticker to check for upcoming earnings specifically',
      },
    },
    required: [],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 20_000,
  async execute(input, context: ToolContext) {
    const { symbol } = (input ?? {}) as { symbol?: string }
    const finnhubKey = getCredential(context, 'FINNHUB_API_KEY')

    if (!finnhubKey) {
      return missingCredentialResult({
        variableName: 'FINNHUB_API_KEY',
        label: 'Finnhub API key',
        hint: 'Free key — sign up at https://finnhub.io and copy the token from your dashboard.',
        usage: 'Fetch the economic and earnings calendar for the next 2 weeks.',
      })
    }

    try {
      const [econ, earnings] = await Promise.all([
        fetchEconomicCalendar(finnhubKey),
        fetchEarningsCalendar(finnhubKey, symbol),
      ])

      const hasData = econ.length > 0 || earnings.length > 0

      if (!hasData) {
        return {
          content: 'No upcoming economic events or earnings found for the next 2 weeks.',
          isError: false,
        }
      }

      const result = {
        economicEvents: econ.length > 0 ? econ : 'No economic events in range.',
        earningsCalendar: earnings.length > 0 ? earnings : 'No earnings in range.',
        note: 'High-impact events (Fed decisions, CPI, NFP) can move markets 1-3% in minutes.',
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching calendar: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
