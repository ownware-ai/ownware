/**
 * Options Flow Intelligence Tool
 *
 * Data source: Yahoo Finance options API (no key required)
 * Computes put/call ratios, unusual volume detection, IV analysis.
 * This is the #1 sentiment signal institutional traders use.
 *
 * Tools:
 * - get_options_intelligence: Options chain analysis with unusual activity detection
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Yahoo Finance options data
// ---------------------------------------------------------------------------

interface OptionContract {
  strike: number
  lastPrice: number
  bid: number
  ask: number
  volume: number
  openInterest: number
  impliedVolatility: number
  inTheMoney: boolean
  expiration: string
}

interface OptionsChain {
  calls: OptionContract[]
  puts: OptionContract[]
  expiration: string
}

async function fetchOptionsChain(symbol: string): Promise<{
  expirations: number[]
  chains: OptionsChain[]
}> {
  // First, get available expiration dates
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Ownware/1.0 (trading-firm-profile)' },
  })

  if (!res.ok) throw new Error(`Options API error: ${res.status}`)

  const json = (await res.json()) as Record<string, unknown>
  const optionChain = json.optionChain as Record<string, unknown>
  const results = (optionChain.result as Record<string, unknown>[])?.[0]
  if (!results) throw new Error(`No options data for ${symbol}`)

  const expirations = (results.expirationDates as number[]) ?? []

  // Parse the first expiration's chain (included in initial response)
  const options = (results.options as Record<string, unknown>[])?.[0]
  const chains: OptionsChain[] = []

  if (options) {
    chains.push(parseChain(options))
  }

  // Fetch next 2 expirations for broader view
  for (const exp of expirations.slice(1, 3)) {
    try {
      const expUrl = `${url}?date=${exp}`
      const expRes = await fetch(expUrl, {
        headers: { 'User-Agent': 'Ownware/1.0 (trading-firm-profile)' },
      })
      if (expRes.ok) {
        const expJson = (await expRes.json()) as Record<string, unknown>
        const expChain = expJson.optionChain as Record<string, unknown>
        const expResult = (expChain.result as Record<string, unknown>[])?.[0]
        const expOptions = (expResult?.options as Record<string, unknown>[])?.[0]
        if (expOptions) chains.push(parseChain(expOptions))
      }
    } catch {
      // Skip failed expirations
    }
  }

  return { expirations, chains }
}

function parseChain(options: Record<string, unknown>): OptionsChain {
  const expDate = new Date((options.expirationDate as number) * 1000).toISOString().split('T')[0]
  const calls = ((options.calls as Record<string, unknown>[]) ?? []).map(parseContract)
  const puts = ((options.puts as Record<string, unknown>[]) ?? []).map(parseContract)
  return { calls, puts, expiration: expDate }
}

function parseContract(c: Record<string, unknown>): OptionContract {
  return {
    strike: (c.strike as number) ?? 0,
    lastPrice: (c.lastPrice as number) ?? 0,
    bid: (c.bid as number) ?? 0,
    ask: (c.ask as number) ?? 0,
    volume: (c.volume as number) ?? 0,
    openInterest: (c.openInterest as number) ?? 0,
    impliedVolatility: (c.impliedVolatility as number) ?? 0,
    inTheMoney: (c.inTheMoney as boolean) ?? false,
    expiration: '',
  }
}

function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// Tool: get_options_intelligence
// ---------------------------------------------------------------------------

export const getOptionsIntelligence: Tool = defineTool({
  name: 'get_options_intelligence',
  description:
    'Analyze options chain for a stock: put/call ratios, unusual volume detection, ' +
    'implied volatility analysis, max pain calculation, and smart money signals. ' +
    'This is the #1 institutional sentiment indicator.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Ticker symbol (e.g., AAPL, NVDA)',
      },
    },
    required: ['symbol'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 45_000,
  async execute(input) {
    const { symbol } = input as { symbol: string }

    try {
      const { expirations, chains } = await fetchOptionsChain(symbol)

      if (chains.length === 0) {
        return { content: `No options data available for ${symbol}`, isError: true }
      }

      const expirationAnalysis = chains.map(chain => {
        const totalCallVolume = chain.calls.reduce((s, c) => s + c.volume, 0)
        const totalPutVolume = chain.puts.reduce((s, c) => s + c.volume, 0)
        const totalCallOI = chain.calls.reduce((s, c) => s + c.openInterest, 0)
        const totalPutOI = chain.puts.reduce((s, c) => s + c.openInterest, 0)

        const pcRatioVolume = totalCallVolume > 0 ? round(totalPutVolume / totalCallVolume, 3) : null
        const pcRatioOI = totalCallOI > 0 ? round(totalPutOI / totalCallOI, 3) : null

        // Average IV
        const callIVs = chain.calls.filter(c => c.impliedVolatility > 0).map(c => c.impliedVolatility)
        const putIVs = chain.puts.filter(c => c.impliedVolatility > 0).map(c => c.impliedVolatility)
        const avgCallIV = callIVs.length > 0 ? round(callIVs.reduce((s, v) => s + v, 0) / callIVs.length * 100) : null
        const avgPutIV = putIVs.length > 0 ? round(putIVs.reduce((s, v) => s + v, 0) / putIVs.length * 100) : null

        // IV skew (put IV vs call IV — higher put IV means more demand for downside protection)
        const ivSkew = avgCallIV != null && avgPutIV != null ? round(avgPutIV - avgCallIV) : null

        // Unusual volume detection (contracts with volume > 3x open interest)
        const unusualCalls = chain.calls
          .filter(c => c.openInterest > 0 && c.volume > c.openInterest * 3)
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 3)
          .map(c => ({
            strike: c.strike,
            volume: c.volume,
            openInterest: c.openInterest,
            volumeToOI: round(c.volume / c.openInterest, 1),
            iv: round(c.impliedVolatility * 100),
          }))

        const unusualPuts = chain.puts
          .filter(c => c.openInterest > 0 && c.volume > c.openInterest * 3)
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 3)
          .map(c => ({
            strike: c.strike,
            volume: c.volume,
            openInterest: c.openInterest,
            volumeToOI: round(c.volume / c.openInterest, 1),
            iv: round(c.impliedVolatility * 100),
          }))

        // Max pain calculation (strike where most options expire worthless)
        const strikes = [...new Set([...chain.calls.map(c => c.strike), ...chain.puts.map(p => p.strike)])].sort((a, b) => a - b)
        let minPain = Infinity
        let maxPainStrike = 0

        for (const strike of strikes) {
          let totalPain = 0
          for (const call of chain.calls) {
            if (strike > call.strike) totalPain += (strike - call.strike) * call.openInterest
          }
          for (const put of chain.puts) {
            if (strike < put.strike) totalPain += (put.strike - strike) * put.openInterest
          }
          if (totalPain < minPain) {
            minPain = totalPain
            maxPainStrike = strike
          }
        }

        // Highest OI strikes (support/resistance from options market)
        const topCallOI = chain.calls
          .filter(c => c.openInterest > 0)
          .sort((a, b) => b.openInterest - a.openInterest)
          .slice(0, 3)
          .map(c => ({ strike: c.strike, openInterest: c.openInterest }))

        const topPutOI = chain.puts
          .filter(c => c.openInterest > 0)
          .sort((a, b) => b.openInterest - a.openInterest)
          .slice(0, 3)
          .map(c => ({ strike: c.strike, openInterest: c.openInterest }))

        return {
          expiration: chain.expiration,
          putCallRatio: {
            byVolume: pcRatioVolume,
            byOpenInterest: pcRatioOI,
            signal: pcRatioVolume != null
              ? pcRatioVolume > 1.2 ? 'bearish (heavy put buying)'
              : pcRatioVolume < 0.7 ? 'bullish (heavy call buying)'
              : 'neutral'
              : 'unknown',
          },
          impliedVolatility: {
            avgCallIV: avgCallIV != null ? `${avgCallIV}%` : null,
            avgPutIV: avgPutIV != null ? `${avgPutIV}%` : null,
            skew: ivSkew != null ? `${ivSkew > 0 ? '+' : ''}${ivSkew}%` : null,
            skewSignal: ivSkew != null
              ? ivSkew > 5 ? 'bearish skew (put protection demand high)'
              : ivSkew < -5 ? 'bullish skew (call demand high)'
              : 'balanced'
              : 'unknown',
          },
          volume: {
            totalCallVolume,
            totalPutVolume,
            totalCallOI,
            totalPutOI,
          },
          unusualActivity: {
            calls: unusualCalls,
            puts: unusualPuts,
            hasUnusualActivity: unusualCalls.length > 0 || unusualPuts.length > 0,
          },
          maxPain: maxPainStrike,
          keyLevels: {
            highestCallOI: topCallOI,
            highestPutOI: topPutOI,
          },
        }
      })

      // Aggregate signals across expirations
      const flags: string[] = []
      const nearest = expirationAnalysis[0]
      if (nearest) {
        const pcr = nearest.putCallRatio.byVolume
        if (pcr != null && pcr > 1.5) flags.push('ALERT: Very high put/call ratio — heavy bearish positioning')
        if (pcr != null && pcr < 0.5) flags.push('ALERT: Very low put/call ratio — heavy bullish positioning')
        if (nearest.unusualActivity.hasUnusualActivity) {
          const callSweeps = nearest.unusualActivity.calls.length
          const putSweeps = nearest.unusualActivity.puts.length
          if (callSweeps > putSweeps) flags.push(`ALERT: Unusual CALL volume detected (${callSweeps} sweeps) — smart money bullish?`)
          else if (putSweeps > callSweeps) flags.push(`ALERT: Unusual PUT volume detected (${putSweeps} sweeps) — smart money bearish?`)
          else flags.push('ALERT: Unusual activity in both calls and puts — big move expected?')
        }
      }

      const result = {
        symbol,
        availableExpirations: expirations.length,
        analyzedExpirations: expirationAnalysis.length,
        analysis: expirationAnalysis,
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching options data for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
