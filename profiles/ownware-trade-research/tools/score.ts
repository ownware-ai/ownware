/**
 * Composite Quantitative Score Tool
 *
 * Computes a DETERMINISTIC numeric signal from all available data.
 * No LLM involved — pure math. This is what makes the system backtestable.
 *
 * The score ranges from -15 to +15:
 *   - Technical signals: 6 checks (RSI, MACD, SMA20, SMA50, SMA200, multi-TF alignment)
 *   - Fundamental signals: 5 checks (earnings beat, est revisions, revenue growth, insider, short interest)
 *   - Sentiment signals: 4 checks (put/call ratio, analyst consensus, upgrades, price target upside)
 *
 * The LLM sees this score alongside its research. It provides qualitative overlay
 * but CANNOT override a strongly negative score into a Buy recommendation.
 *
 * Tools:
 * - compute_composite_score: Full score with all data sources (real-time)
 * - compute_technical_score: Technical-only score from price data (for backtesting)
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'
import {
  fetchOHLCVWithRetry,
  fetchWithRetry,
  dataFreshness,
  round,
  monthsAgoUnix,
  unixNow,
  computeRSI,
  computeMACDSignal,
  computeSMA,
  computeEMA,
  computeATR,
  lastVal,
} from './shared.ts'

// ---------------------------------------------------------------------------
// Technical score (computable from price data alone — backtestable)
// ---------------------------------------------------------------------------

interface TechnicalScoreResult {
  score: number
  maxScore: number
  signals: Record<string, { value: number; signal: number; reason: string }>
}

export function computeTechScore(closes: number[], highs: number[], lows: number[], volumes: number[]): TechnicalScoreResult {
  const signals: Record<string, { value: number; signal: number; reason: string }> = {}
  let score = 0

  // 1. RSI
  const rsi = computeRSI(closes)
  const rsiVal = lastVal(rsi)
  if (rsiVal != null) {
    const sig = rsiVal > 50 ? 1 : -1
    signals.rsi = { value: round(rsiVal), signal: sig, reason: rsiVal > 70 ? 'overbought' : rsiVal < 30 ? 'oversold' : rsiVal > 50 ? 'bullish momentum' : 'bearish momentum' }
    score += sig
  }

  // 2. MACD above signal
  const macd = computeMACDSignal(closes)
  const macdVal = lastVal(macd.macd)
  const sigVal = lastVal(macd.signal)
  if (macdVal != null && sigVal != null) {
    const sig = macdVal > sigVal ? 1 : -1
    signals.macd = { value: round(macdVal, 4), signal: sig, reason: sig > 0 ? 'MACD above signal line' : 'MACD below signal line' }
    score += sig
  }

  // 3. Price > SMA20
  const sma20 = computeSMA(closes, 20)
  const sma20Val = lastVal(sma20)
  const latestClose = closes[closes.length - 1]
  if (sma20Val != null) {
    const sig = latestClose > sma20Val ? 1 : -1
    signals.sma20 = { value: round(sma20Val), signal: sig, reason: sig > 0 ? 'Price above 20-day SMA' : 'Price below 20-day SMA' }
    score += sig
  }

  // 4. Price > SMA50
  const sma50 = computeSMA(closes, 50)
  const sma50Val = lastVal(sma50)
  if (sma50Val != null) {
    const sig = latestClose > sma50Val ? 1 : -1
    signals.sma50 = { value: round(sma50Val), signal: sig, reason: sig > 0 ? 'Price above 50-day SMA' : 'Price below 50-day SMA' }
    score += sig
  }

  // 5. Price > SMA200
  const sma200 = computeSMA(closes, 200)
  const sma200Val = lastVal(sma200)
  if (sma200Val != null) {
    const sig = latestClose > sma200Val ? 1 : -1
    signals.sma200 = { value: round(sma200Val), signal: sig, reason: sig > 0 ? 'Price above 200-day SMA (long-term bullish)' : 'Price below 200-day SMA (long-term bearish)' }
    score += sig
  }

  // 6. Volume confirmation — above-average volume on up day = bullish
  if (closes.length >= 2 && volumes.length >= 50) {
    const avgVol50 = volumes.slice(-50).reduce((s, v) => s + v, 0) / 50
    const latestVol = volumes[volumes.length - 1]
    const priceUp = latestClose > closes[closes.length - 2]
    const volAboveAvg = latestVol > avgVol50 * 1.2

    if (volAboveAvg && priceUp) {
      signals.volume = { value: round(latestVol / avgVol50, 1), signal: 1, reason: 'Above-average volume on up day — buying conviction' }
      score += 1
    } else if (volAboveAvg && !priceUp) {
      signals.volume = { value: round(latestVol / avgVol50, 1), signal: -1, reason: 'Above-average volume on down day — selling pressure' }
      score -= 1
    } else {
      signals.volume = { value: round(latestVol / avgVol50, 1), signal: 0, reason: 'Normal volume — no conviction signal' }
    }
  }

  return { score, maxScore: 6, signals }
}

// ---------------------------------------------------------------------------
// Tool: compute_technical_score (for backtesting — price data only)
// ---------------------------------------------------------------------------

export const computeTechnicalScore: Tool = defineTool({
  name: 'compute_technical_score',
  description:
    'Compute a deterministic technical score from price data alone. ' +
    'Range: -6 to +6. Uses RSI, MACD, SMA20/50/200, and volume confirmation. ' +
    'This is the backtestable core signal — no LLM, no external APIs, pure math.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol' },
      trade_date: { type: 'string', description: 'Analysis date YYYY-MM-DD (fetches 12 months of data ending here)' },
    },
    required: ['symbol', 'trade_date'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 30_000,
  async execute(input) {
    const { symbol, trade_date } = input as { symbol: string; trade_date: string }

    try {
      const endUnix = Math.floor(new Date(trade_date).getTime() / 1000) + 86400
      const startUnix = endUnix - 365 * 86400 // 12 months for SMA200

      const rows = await fetchOHLCVWithRetry(symbol, startUnix, endUnix)
      if (rows.length < 50) {
        return { content: `Insufficient data for ${symbol}: ${rows.length} days (need 50+)`, isError: true }
      }

      const techScore = computeTechScore(
        rows.map(r => r.close),
        rows.map(r => r.high),
        rows.map(r => r.low),
        rows.map(r => r.volume),
      )

      const result = {
        symbol,
        date: trade_date,
        price: rows[rows.length - 1].close,
        technicalScore: {
          score: techScore.score,
          maxPossible: techScore.maxScore,
          normalized: `${techScore.score}/${techScore.maxScore}`,
          rating: techScore.score >= 4 ? 'strong_buy'
            : techScore.score >= 2 ? 'buy'
            : techScore.score >= -1 ? 'neutral'
            : techScore.score >= -3 ? 'sell'
            : 'strong_sell',
        },
        signals: techScore.signals,
        ...dataFreshness(),
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error computing score for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: compute_composite_score (full score — all data sources)
// ---------------------------------------------------------------------------

export const computeCompositeScore: Tool = defineTool({
  name: 'compute_composite_score',
  description:
    'Compute a comprehensive quantitative score from ALL data sources: ' +
    'technical indicators, fundamental data, and sentiment signals. ' +
    'Range: -15 to +15. This is the deterministic core of the decision process. ' +
    'The CIO should NOT recommend Buy when this score is below -5, or Sell when above +5.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol' },
      trade_date: { type: 'string', description: 'Analysis date YYYY-MM-DD' },
    },
    required: ['symbol', 'trade_date'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 60_000,
  async execute(input) {
    const { symbol, trade_date } = input as { symbol: string; trade_date: string }

    try {
      // ── Fetch price data for technical score ──────────────────────
      const endUnix = Math.floor(new Date(trade_date).getTime() / 1000) + 86400
      const startUnix = endUnix - 365 * 86400

      const rows = await fetchOHLCVWithRetry(symbol, startUnix, endUnix)
      if (rows.length < 50) {
        return { content: `Insufficient data for ${symbol}: ${rows.length} days`, isError: true }
      }

      const techScore = computeTechScore(
        rows.map(r => r.close),
        rows.map(r => r.high),
        rows.map(r => r.low),
        rows.map(r => r.volume),
      )

      // ── Fetch fundamental + sentiment data from Yahoo Finance ─────
      const qsUrl =
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=defaultKeyStatistics,financialData,earningsTrend,earningsHistory,recommendationTrend,upgradeDowngradeHistory`

      let fundamentalScore = 0
      let sentimentScore = 0
      const fundamentalSignals: Record<string, { value: unknown; signal: number; reason: string }> = {}
      const sentimentSignals: Record<string, { value: unknown; signal: number; reason: string }> = {}

      try {
        const qsRes = await fetchWithRetry(qsUrl)
        if (qsRes.ok) {
          const qsJson = (await qsRes.json()) as Record<string, unknown>
          const qs = qsJson.quoteSummary as Record<string, unknown>
          const data = (qs.result as Record<string, unknown>[])?.[0] ?? {}

          const ks = (data.defaultKeyStatistics ?? {}) as Record<string, unknown>
          const fd = (data.financialData ?? {}) as Record<string, unknown>
          const trend = (data.earningsTrend ?? {}) as Record<string, unknown>
          const history = (data.earningsHistory ?? {}) as Record<string, unknown>
          const recTrend = (data.recommendationTrend ?? {}) as Record<string, unknown>
          const udHistory = (data.upgradeDowngradeHistory ?? {}) as Record<string, unknown>

          const raw = (obj: unknown): unknown => {
            if (obj == null) return null
            if (typeof obj === 'object' && 'raw' in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>).raw
            return obj
          }

          // ── Fundamental signals ────────────────────────────────────

          // F1: Earnings beat last quarter
          const histItems = (history.history as Record<string, unknown>[]) ?? []
          if (histItems.length > 0) {
            const lastSurprise = raw(histItems[0].surprisePercent) as number | null
            if (lastSurprise != null) {
              const sig = lastSurprise > 0 ? 1 : -1
              fundamentalSignals.earningsBeat = { value: `${round(lastSurprise)}%`, signal: sig, reason: sig > 0 ? `Beat estimates by ${round(lastSurprise)}%` : `Missed estimates by ${round(Math.abs(lastSurprise))}%` }
              fundamentalScore += sig
            }
          }

          // F2: Estimate revisions trending up
          const trendItems = (trend.trend as Record<string, unknown>[]) ?? []
          if (trendItems.length > 0) {
            const epsRevisions = trendItems[0].epsRevisions as Record<string, unknown> | undefined
            if (epsRevisions) {
              const up30 = (raw(epsRevisions.upLast30days) as number) ?? 0
              const down30 = (raw(epsRevisions.downLast30days) as number) ?? 0
              const sig = up30 > down30 ? 1 : down30 > up30 ? -1 : 0
              fundamentalSignals.epsRevisions = { value: `${up30} up / ${down30} down (30d)`, signal: sig, reason: sig > 0 ? 'More upward revisions' : sig < 0 ? 'More downward revisions' : 'Balanced revisions' }
              fundamentalScore += sig
            }
          }

          // F3: Revenue growth > 0
          const revenueGrowth = raw(fd.revenueGrowth) as number | null
          if (revenueGrowth != null) {
            const sig = revenueGrowth > 0.05 ? 1 : revenueGrowth < -0.05 ? -1 : 0
            fundamentalSignals.revenueGrowth = { value: `${round(revenueGrowth * 100)}%`, signal: sig, reason: sig > 0 ? 'Revenue growing' : sig < 0 ? 'Revenue declining' : 'Revenue flat' }
            fundamentalScore += sig
          }

          // F4: Short interest declining (bullish)
          const sharesShort = raw(ks.sharesShort) as number | null
          const sharesShortPrior = raw(ks.sharesShortPriorMonth) as number | null
          if (sharesShort != null && sharesShortPrior != null && sharesShortPrior > 0) {
            const shortChange = (sharesShort - sharesShortPrior) / sharesShortPrior
            const sig = shortChange < -0.05 ? 1 : shortChange > 0.1 ? -1 : 0
            fundamentalSignals.shortInterest = { value: `${round(shortChange * 100)}% change`, signal: sig, reason: sig > 0 ? 'Shorts covering (bullish)' : sig < 0 ? 'Shorts increasing (bearish)' : 'Short interest stable' }
            fundamentalScore += sig
          }

          // F5: PEG ratio (value vs growth)
          const peg = raw(ks.pegRatio) as number | null
          if (peg != null && peg > 0) {
            const sig = peg < 1 ? 1 : peg > 2.5 ? -1 : 0
            fundamentalSignals.pegRatio = { value: round(peg), signal: sig, reason: sig > 0 ? 'PEG < 1 (undervalued vs growth)' : sig < 0 ? 'PEG > 2.5 (expensive vs growth)' : 'PEG fair' }
            fundamentalScore += sig
          }

          // ── Sentiment signals ──────────────────────────────────────

          // S1: Analyst consensus
          const recKey = raw(fd.recommendationKey) as string | null
          const recMean = raw(fd.recommendationMean) as number | null
          if (recMean != null) {
            const sig = recMean <= 2.0 ? 1 : recMean >= 3.5 ? -1 : 0
            sentimentSignals.analystConsensus = { value: `${recKey} (${round(recMean, 1)}/5)`, signal: sig, reason: sig > 0 ? 'Analyst consensus is Buy' : sig < 0 ? 'Analyst consensus is Sell/Hold' : 'Analyst consensus neutral' }
            sentimentScore += sig
          }

          // S2: Price target upside
          const targetMean = raw(fd.targetMeanPrice) as number | null
          const currentPrice = raw(fd.currentPrice) as number | null
          if (targetMean != null && currentPrice != null && currentPrice > 0) {
            const upside = (targetMean - currentPrice) / currentPrice
            const sig = upside > 0.1 ? 1 : upside < -0.05 ? -1 : 0
            sentimentSignals.priceTargetUpside = { value: `${round(upside * 100)}%`, signal: sig, reason: sig > 0 ? `Consensus target implies ${round(upside * 100)}% upside` : sig < 0 ? `Consensus target implies ${round(Math.abs(upside) * 100)}% downside` : 'Near consensus target' }
            sentimentScore += sig
          }

          // S3: Recent upgrades vs downgrades (30 days)
          const udItems = (udHistory.history as Record<string, unknown>[]) ?? []
          let upgrades = 0
          let downgrades = 0
          const cutoff = Date.now() / 1000 - 30 * 86400
          for (const u of udItems.slice(0, 20)) {
            const epoch = u.epochGradeDate as number | undefined
            if (!epoch || epoch < cutoff) continue
            const action = ((u.action as string) ?? '').toLowerCase()
            if (action.includes('upgrade') || action === 'up') upgrades++
            else if (action.includes('downgrade') || action === 'down') downgrades++
          }
          if (upgrades + downgrades > 0) {
            const sig = upgrades > downgrades ? 1 : downgrades > upgrades ? -1 : 0
            sentimentSignals.analystMomentum = { value: `${upgrades} up / ${downgrades} down`, signal: sig, reason: sig > 0 ? 'More upgrades than downgrades' : sig < 0 ? 'More downgrades than upgrades' : 'Balanced' }
            sentimentScore += sig
          }

          // S4: Recommendation trend (improving or worsening)
          const recItems = (recTrend.trend as Record<string, unknown>[]) ?? []
          if (recItems.length >= 2) {
            const current = recItems[0]
            const prior = recItems[1]
            const currentBulls = ((current.strongBuy as number) ?? 0) + ((current.buy as number) ?? 0)
            const priorBulls = ((prior.strongBuy as number) ?? 0) + ((prior.buy as number) ?? 0)
            const sig = currentBulls > priorBulls ? 1 : currentBulls < priorBulls ? -1 : 0
            sentimentSignals.recommendationTrend = { value: `${currentBulls} now vs ${priorBulls} prior month`, signal: sig, reason: sig > 0 ? 'More analysts turning bullish' : sig < 0 ? 'Analysts turning less bullish' : 'Stable analyst sentiment' }
            sentimentScore += sig
          }
        }
      } catch {
        // If Yahoo quoteSummary fails, we still have the technical score
        fundamentalSignals.error = { value: 'fetch_failed', signal: 0, reason: 'Could not fetch fundamental data — score based on technicals only' }
      }

      // ── Composite ───────────────────────────────────────────────
      const totalScore = techScore.score + fundamentalScore + sentimentScore
      const maxPossible = 6 + 5 + 4 // 15

      const rating = totalScore >= 8 ? 'strong_buy'
        : totalScore >= 4 ? 'buy'
        : totalScore >= -3 ? 'neutral'
        : totalScore >= -7 ? 'sell'
        : 'strong_sell'

      // Guardrail warnings for the CIO
      const guardrails: string[] = []
      if (totalScore <= -5) guardrails.push('GUARDRAIL: Score is strongly negative — CIO should NOT recommend Buy')
      if (totalScore >= 5) guardrails.push('GUARDRAIL: Score is strongly positive — CIO should NOT recommend Sell')
      if (techScore.score <= -4 && fundamentalScore >= 2) guardrails.push('CONFLICT: Technicals bearish but fundamentals bullish — possible value trap or early reversal')
      if (techScore.score >= 4 && fundamentalScore <= -2) guardrails.push('CONFLICT: Technicals bullish but fundamentals bearish — possible momentum trap')

      const result = {
        symbol,
        date: trade_date,
        compositeScore: {
          total: totalScore,
          maxPossible,
          normalized: `${totalScore}/${maxPossible}`,
          rating,
          breakdown: {
            technical: { score: techScore.score, max: 6 },
            fundamental: { score: fundamentalScore, max: 5 },
            sentiment: { score: sentimentScore, max: 4 },
          },
        },
        technicalSignals: techScore.signals,
        fundamentalSignals,
        sentimentSignals,
        guardrails,
        ...dataFreshness(),
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error computing composite score for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
