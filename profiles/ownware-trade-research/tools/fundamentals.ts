/**
 * Fundamentals + Ownership + Earnings Tools
 *
 * Data source: Yahoo Finance quoteSummary API (no key required)
 * Returns pre-computed analysis with key metrics, not raw CSV.
 *
 * Tools:
 * - get_financial_health: Balance sheet, cash flow, income, valuation
 * - get_ownership_intelligence: Institutional, insider, short interest
 * - get_earnings_intelligence: Estimates, revisions, surprise history, analyst targets
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Yahoo Finance quoteSummary API
//
// As of mid-2024 the `/v10/finance/quoteSummary` endpoint rejects anonymous
// requests with 401 "Unauthorized / Invalid Crumb". To make it work we have
// to do the standard crumb dance:
//
//   1. Hit `https://fc.yahoo.com/` to pick up consent + A3/A1 session cookies.
//   2. Call `/v1/test/getcrumb` with those cookies to receive a short crumb.
//   3. Pass both the crumb (query param) and the cookies (header) on the
//      actual quoteSummary request.
//
// The crumb is tied to the cookie jar, so we cache them together. They
// expire after ~24h in practice — cheap to refresh on demand.
// ---------------------------------------------------------------------------

const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

interface YahooSession {
  cookie: string
  crumb: string
  fetchedAt: number
}

let cachedSession: YahooSession | null = null
const SESSION_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

function extractCookies(setCookieValues: string[]): string {
  // Parse set-cookie into name=value pairs. We don't need path/domain — we
  // only echo the essential ones (A1, A3, GUC, B) back on future calls.
  const pairs: string[] = []
  for (const raw of setCookieValues) {
    const first = raw.split(';')[0]?.trim()
    if (first && first.length > 0) pairs.push(first)
  }
  return pairs.join('; ')
}

async function establishYahooSession(): Promise<YahooSession> {
  // Step 1: consent / cookie bootstrap.
  const consentRes = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': YAHOO_BROWSER_UA, Accept: '*/*' },
    redirect: 'manual',
  }).catch(() => null)

  const setCookieEntries: string[] = []
  if (consentRes != null) {
    // Node/Bun: getSetCookie() returns all set-cookie lines individually.
    const entries =
      typeof consentRes.headers.getSetCookie === 'function'
        ? consentRes.headers.getSetCookie()
        : (consentRes.headers.get('set-cookie') ?? '').split(/,(?=[^ ])/g)
    setCookieEntries.push(...entries)
  }
  const cookie = extractCookies(setCookieEntries)

  // Step 2: fetch crumb with the cookies we just picked up.
  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': YAHOO_BROWSER_UA,
      Accept: 'text/plain,*/*',
      ...(cookie.length > 0 ? { Cookie: cookie } : {}),
    },
  })
  if (!crumbRes.ok) {
    throw new Error(
      `Yahoo Finance is blocking anonymous requests (getcrumb returned ${crumbRes.status}). ` +
        'This is a Yahoo-side policy, not a bug in the tool — try again in a few minutes or ' +
        'switch to an authenticated data source.',
    )
  }
  const crumb = (await crumbRes.text()).trim()
  if (crumb.length === 0) {
    throw new Error('Yahoo Finance returned an empty crumb — cookie session was rejected.')
  }

  return { cookie, crumb, fetchedAt: Date.now() }
}

async function getYahooSession(force = false): Promise<YahooSession> {
  const stale =
    cachedSession == null || Date.now() - cachedSession.fetchedAt > SESSION_TTL_MS
  if (force || stale) {
    cachedSession = await establishYahooSession()
  }
  return cachedSession
}

async function fetchQuoteSummary(
  symbol: string,
  modules: string[],
): Promise<Record<string, unknown>> {
  const run = async (session: YahooSession): Promise<Response> => {
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules.join(',')}&crumb=${encodeURIComponent(session.crumb)}`

    return fetch(url, {
      headers: {
        'User-Agent': YAHOO_BROWSER_UA,
        Accept: 'application/json',
        ...(session.cookie.length > 0 ? { Cookie: session.cookie } : {}),
      },
    })
  }

  let session = await getYahooSession()
  let res = await run(session)

  // 401 / 403 → crumb is stale. Refresh once and retry.
  if (res.status === 401 || res.status === 403) {
    session = await getYahooSession(true)
    res = await run(session)
  }

  if (!res.ok) {
    throw new Error(`Yahoo Finance API error: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as Record<string, unknown>
  const qs = json.quoteSummary as Record<string, unknown>
  const results = (qs.result as Record<string, unknown>[])?.[0]
  if (!results) throw new Error(`No data returned for ${symbol}`)
  return results
}

function extractRaw(obj: unknown): unknown {
  if (obj == null) return null
  if (typeof obj === 'object' && 'raw' in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>).raw
  }
  return obj
}

function extractFmt(obj: unknown): unknown {
  if (obj == null) return null
  if (typeof obj === 'object' && 'fmt' in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>).fmt
  }
  return obj
}

function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// Tool: get_financial_health
// ---------------------------------------------------------------------------

export const getFinancialHealth: Tool = defineTool({
  name: 'get_financial_health',
  description:
    'Get comprehensive financial health assessment including balance sheet strength, ' +
    'cash flow quality, profitability metrics, and valuation ratios. ' +
    'Pre-computed with red/green flags highlighted.',
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
  timeoutMs: 30_000,
  async execute(input) {
    const { symbol } = input as { symbol: string }

    try {
      const data = await fetchQuoteSummary(symbol, [
        'financialData',
        'defaultKeyStatistics',
        'balanceSheetHistoryQuarterly',
        'cashflowStatementHistoryQuarterly',
        'incomeStatementHistoryQuarterly',
      ])

      const fd = (data.financialData ?? {}) as Record<string, unknown>
      const ks = (data.defaultKeyStatistics ?? {}) as Record<string, unknown>
      const bsHistory = data.balanceSheetHistoryQuarterly as Record<string, unknown> | undefined
      const cfHistory = data.cashflowStatementHistoryQuarterly as Record<string, unknown> | undefined
      const isHistory = data.incomeStatementHistoryQuarterly as Record<string, unknown> | undefined

      // Latest balance sheet
      const bsItems = (bsHistory?.balanceSheetStatements as Record<string, unknown>[]) ?? []
      const latestBS = bsItems[0] ?? {}

      // Latest cash flow
      const cfItems = (cfHistory?.cashflowStatements as Record<string, unknown>[]) ?? []
      const latestCF = cfItems[0] ?? {}

      // Latest income
      const isItems = (isHistory?.incomeStatementHistory as Record<string, unknown>[]) ?? []
      const latestIS = isItems[0] ?? {}

      const totalDebt = extractRaw(fd.totalDebt) as number | null
      const totalCash = extractRaw(fd.totalCash) as number | null
      const totalRevenue = extractRaw(fd.totalRevenue) as number | null
      const ebitda = extractRaw(fd.ebitda) as number | null
      const freeCashflow = extractRaw(fd.freeCashflow) as number | null
      const profitMargins = extractRaw(fd.profitMargins) as number | null
      const operatingMargins = extractRaw(fd.operatingMargins) as number | null
      const grossMargins = extractRaw(fd.grossMargins) as number | null
      const returnOnEquity = extractRaw(fd.returnOnEquity) as number | null
      const returnOnAssets = extractRaw(fd.returnOnAssets) as number | null
      const debtToEquity = extractRaw(fd.debtToEquity) as number | null
      const currentRatio = extractRaw(fd.currentRatio) as number | null
      const revenueGrowth = extractRaw(fd.revenueGrowth) as number | null
      const earningsGrowth = extractRaw(fd.earningsGrowth) as number | null

      const pe = extractRaw(ks.trailingPE) as number | null
      const forwardPe = extractRaw(ks.forwardPE) as number | null
      const peg = extractRaw(ks.pegRatio) as number | null
      const priceToBook = extractRaw(ks.priceToBook) as number | null
      const enterpriseValue = extractRaw(ks.enterpriseValue) as number | null
      const evToEbitda = extractRaw(ks.enterpriseToEbitda) as number | null
      const evToRevenue = extractRaw(ks.enterpriseToRevenue) as number | null
      const beta = extractRaw(ks.beta) as number | null

      // Flag generation
      const flags: string[] = []
      if (debtToEquity != null && debtToEquity > 200) flags.push('RED: High debt-to-equity ratio')
      if (currentRatio != null && currentRatio < 1) flags.push('RED: Current ratio below 1 (liquidity risk)')
      if (profitMargins != null && profitMargins < 0) flags.push('RED: Negative profit margins')
      if (earningsGrowth != null && earningsGrowth < -0.1) flags.push('RED: Earnings declining >10%')
      if (revenueGrowth != null && revenueGrowth < -0.05) flags.push('RED: Revenue declining')

      if (freeCashflow != null && freeCashflow > 0 && totalRevenue != null && totalRevenue > 0) {
        const fcfMargin = freeCashflow / totalRevenue
        if (fcfMargin > 0.2) flags.push('GREEN: Strong free cash flow margin (>20%)')
      }
      if (revenueGrowth != null && revenueGrowth > 0.15) flags.push('GREEN: Revenue growing >15%')
      if (earningsGrowth != null && earningsGrowth > 0.2) flags.push('GREEN: Earnings growing >20%')
      if (returnOnEquity != null && returnOnEquity > 0.2) flags.push('GREEN: High ROE (>20%)')
      if (currentRatio != null && currentRatio > 2) flags.push('GREEN: Strong liquidity')
      if (peg != null && peg > 0 && peg < 1) flags.push('GREEN: PEG ratio below 1 (undervalued vs growth)')

      const result = {
        symbol,
        valuation: {
          trailingPE: pe != null ? round(pe) : null,
          forwardPE: forwardPe != null ? round(forwardPe) : null,
          pegRatio: peg != null ? round(peg) : null,
          priceToBook: priceToBook != null ? round(priceToBook) : null,
          enterpriseValue: enterpriseValue != null ? `$${round(enterpriseValue / 1e9, 1)}B` : null,
          evToEbitda: evToEbitda != null ? round(evToEbitda) : null,
          evToRevenue: evToRevenue != null ? round(evToRevenue) : null,
          beta,
        },
        profitability: {
          grossMargin: grossMargins != null ? `${round(grossMargins * 100)}%` : null,
          operatingMargin: operatingMargins != null ? `${round(operatingMargins * 100)}%` : null,
          profitMargin: profitMargins != null ? `${round(profitMargins * 100)}%` : null,
          returnOnEquity: returnOnEquity != null ? `${round(returnOnEquity * 100)}%` : null,
          returnOnAssets: returnOnAssets != null ? `${round(returnOnAssets * 100)}%` : null,
        },
        growth: {
          revenueGrowth: revenueGrowth != null ? `${round(revenueGrowth * 100)}%` : null,
          earningsGrowth: earningsGrowth != null ? `${round(earningsGrowth * 100)}%` : null,
        },
        balanceSheet: {
          totalCash: totalCash != null ? `$${round(totalCash / 1e9, 1)}B` : null,
          totalDebt: totalDebt != null ? `$${round(totalDebt / 1e9, 1)}B` : null,
          netCash: totalCash != null && totalDebt != null ? `$${round((totalCash - totalDebt) / 1e9, 1)}B` : null,
          debtToEquity: debtToEquity != null ? round(debtToEquity) : null,
          currentRatio: currentRatio != null ? round(currentRatio) : null,
        },
        cashFlow: {
          freeCashFlow: freeCashflow != null ? `$${round(freeCashflow / 1e9, 1)}B` : null,
          ebitda: ebitda != null ? `$${round(ebitda / 1e9, 1)}B` : null,
          totalRevenue: totalRevenue != null ? `$${round(totalRevenue / 1e9, 1)}B` : null,
        },
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching financials for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: get_ownership_intelligence
// ---------------------------------------------------------------------------

export const getOwnershipIntelligence: Tool = defineTool({
  name: 'get_ownership_intelligence',
  description:
    'Get institutional ownership, insider activity, and short interest data. ' +
    'Shows smart money flow: who is buying, who is selling, and short squeeze potential.',
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
  timeoutMs: 30_000,
  async execute(input) {
    const { symbol } = input as { symbol: string }

    try {
      const data = await fetchQuoteSummary(symbol, [
        'institutionOwnership',
        'insiderHolders',
        'insiderTransactions',
        'majorHoldersBreakdown',
        'defaultKeyStatistics',
      ])

      const inst = (data.institutionOwnership ?? {}) as Record<string, unknown>
      const insiderHolders = (data.insiderHolders ?? {}) as Record<string, unknown>
      const insiderTxns = (data.insiderTransactions ?? {}) as Record<string, unknown>
      const major = (data.majorHoldersBreakdown ?? {}) as Record<string, unknown>
      const ks = (data.defaultKeyStatistics ?? {}) as Record<string, unknown>

      // Institutional holders
      const instOwners = (inst.ownershipList as Record<string, unknown>[]) ?? []
      const topInstitutions = instOwners.slice(0, 5).map(o => ({
        name: extractRaw(o.organization),
        pctHeld: extractFmt(o.pctHeld),
        shares: extractRaw(o.position),
        change: extractRaw(o.pctChange),
      }))

      // Insider transactions
      const txns = (insiderTxns.transactions as Record<string, unknown>[]) ?? []
      const recentInsider = txns.slice(0, 10).map(t => ({
        name: extractRaw(t.filerName),
        relation: extractRaw(t.filerRelation),
        transaction: extractRaw(t.transactionText),
        shares: extractRaw(t.shares),
        value: extractRaw(t.value),
        date: extractFmt(t.startDate),
      }))

      // Aggregate insider activity
      let insiderBuys = 0
      let insiderSells = 0
      let insiderBuyValue = 0
      let insiderSellValue = 0
      for (const t of txns.slice(0, 20)) {
        const text = (extractRaw(t.transactionText) as string) ?? ''
        const val = (extractRaw(t.value) as number) ?? 0
        if (text.toLowerCase().includes('purchase') || text.toLowerCase().includes('buy')) {
          insiderBuys++
          insiderBuyValue += val
        } else if (text.toLowerCase().includes('sale') || text.toLowerCase().includes('sell')) {
          insiderSells++
          insiderSellValue += val
        }
      }

      // Short interest from key statistics
      const sharesShort = extractRaw(ks.sharesShort) as number | null
      const shortRatio = extractRaw(ks.shortRatio) as number | null
      const shortPctFloat = extractRaw(ks.shortPercentOfFloat) as number | null
      const sharesShortPrior = extractRaw(ks.sharesShortPriorMonth) as number | null

      const shortTrend = sharesShort != null && sharesShortPrior != null
        ? sharesShort > sharesShortPrior ? 'increasing' : sharesShort < sharesShortPrior ? 'decreasing' : 'flat'
        : 'unknown'

      // Flags
      const flags: string[] = []
      if (insiderBuys > insiderSells * 2) flags.push('GREEN: Heavy insider buying')
      if (insiderSells > insiderBuys * 3) flags.push('RED: Heavy insider selling')
      if (shortPctFloat != null && shortPctFloat > 0.1) flags.push('ALERT: High short interest (>10% float)')
      if (shortPctFloat != null && shortPctFloat > 0.2) flags.push('ALERT: Very high short interest (>20% float) — squeeze potential')
      if (shortRatio != null && shortRatio > 5) flags.push('ALERT: Days to cover >5 — short squeeze risk')
      if (shortTrend === 'increasing') flags.push('NOTE: Short interest rising')
      if (shortTrend === 'decreasing') flags.push('NOTE: Short interest declining (shorts covering)')

      const result = {
        symbol,
        ownershipBreakdown: {
          insidersPercent: extractFmt(major.insidersPercentHeld),
          institutionsPercent: extractFmt(major.institutionsPercentHeld),
          institutionCount: extractRaw(major.institutionsCount),
        },
        topInstitutions,
        insiderActivity: {
          recentBuys: insiderBuys,
          recentSells: insiderSells,
          buyValue: insiderBuyValue > 0 ? `$${round(insiderBuyValue / 1e6, 1)}M` : '$0',
          sellValue: insiderSellValue > 0 ? `$${round(insiderSellValue / 1e6, 1)}M` : '$0',
          netDirection: insiderBuys > insiderSells ? 'net_buying' : insiderSells > insiderBuys ? 'net_selling' : 'balanced',
          recentTransactions: recentInsider.slice(0, 5),
        },
        shortInterest: {
          sharesShort: sharesShort != null ? `${round(sharesShort / 1e6, 1)}M` : null,
          shortRatio: shortRatio != null ? round(shortRatio, 1) : null,
          shortPercentOfFloat: shortPctFloat != null ? `${round(shortPctFloat * 100, 1)}%` : null,
          trend: shortTrend,
          priorMonth: sharesShortPrior != null ? `${round(sharesShortPrior / 1e6, 1)}M` : null,
        },
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching ownership data for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: get_earnings_intelligence
// ---------------------------------------------------------------------------

export const getEarningsIntelligence: Tool = defineTool({
  name: 'get_earnings_intelligence',
  description:
    'Get earnings estimates, revision trends, surprise history, and analyst consensus. ' +
    'Shows whether the street is getting more bullish or bearish, and how the company has historically performed vs expectations.',
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
  timeoutMs: 30_000,
  async execute(input) {
    const { symbol } = input as { symbol: string }

    try {
      const data = await fetchQuoteSummary(symbol, [
        'earningsTrend',
        'earningsHistory',
        'financialData',
        'recommendationTrend',
        'upgradeDowngradeHistory',
        'calendarEvents',
      ])

      const trend = (data.earningsTrend ?? {}) as Record<string, unknown>
      const history = (data.earningsHistory ?? {}) as Record<string, unknown>
      const fd = (data.financialData ?? {}) as Record<string, unknown>
      const recTrend = (data.recommendationTrend ?? {}) as Record<string, unknown>
      const udHistory = (data.upgradeDowngradeHistory ?? {}) as Record<string, unknown>
      const calendar = (data.calendarEvents ?? {}) as Record<string, unknown>

      // Earnings trend (estimates and revisions)
      const trendItems = (trend.trend as Record<string, unknown>[]) ?? []
      const estimates = trendItems.map(t => {
        const epsEst = t.earningsEstimate as Record<string, unknown> | undefined
        const revEst = t.revenueEstimate as Record<string, unknown> | undefined
        const epsTrend = t.epsTrend as Record<string, unknown> | undefined
        const epsRevisions = t.epsRevisions as Record<string, unknown> | undefined
        return {
          period: extractRaw(t.period),
          epsAvg: extractRaw(epsEst?.avg),
          epsLow: extractRaw(epsEst?.low),
          epsHigh: extractRaw(epsEst?.high),
          numAnalysts: extractRaw(epsEst?.numberOfAnalysts),
          epsGrowth: extractRaw(epsEst?.growth),
          revAvg: extractRaw(revEst?.avg),
          revGrowth: extractRaw(revEst?.growth),
          eps7dAgo: extractRaw(epsTrend?.['7daysAgo']),
          eps30dAgo: extractRaw(epsTrend?.['30daysAgo']),
          eps90dAgo: extractRaw(epsTrend?.['90daysAgo']),
          upRevisions7d: extractRaw(epsRevisions?.upLast7days),
          downRevisions7d: extractRaw(epsRevisions?.downLast7days),
          upRevisions30d: extractRaw(epsRevisions?.upLast30days),
          downRevisions30d: extractRaw(epsRevisions?.downLast30days),
        }
      })

      // Earnings history (surprise)
      const histItems = (history.history as Record<string, unknown>[]) ?? []
      const surpriseHistory = histItems.slice(0, 4).map(h => ({
        quarter: extractFmt(h.quarter),
        epsEstimate: extractRaw(h.epsEstimate),
        epsActual: extractRaw(h.epsActual),
        surprise: extractRaw(h.surprisePercent),
      }))

      // Analyst recommendations
      const recItems = (recTrend.trend as Record<string, unknown>[]) ?? []
      const latestRec = recItems[0]
      const recommendations = latestRec ? {
        strongBuy: extractRaw(latestRec.strongBuy),
        buy: extractRaw(latestRec.buy),
        hold: extractRaw(latestRec.hold),
        sell: extractRaw(latestRec.sell),
        strongSell: extractRaw(latestRec.strongSell),
      } : null

      // Analyst price targets
      const targetHigh = extractRaw(fd.targetHighPrice) as number | null
      const targetLow = extractRaw(fd.targetLowPrice) as number | null
      const targetMean = extractRaw(fd.targetMeanPrice) as number | null
      const targetMedian = extractRaw(fd.targetMedianPrice) as number | null
      const currentPrice = extractRaw(fd.currentPrice) as number | null
      const recMean = extractRaw(fd.recommendationMean) as number | null
      const recKey = extractRaw(fd.recommendationKey) as string | null
      const numAnalysts = extractRaw(fd.numberOfAnalystOpinions) as number | null

      // Recent upgrades/downgrades
      const udItems = (udHistory.history as Record<string, unknown>[]) ?? []
      const recentActions = udItems.slice(0, 5).map(u => ({
        firm: extractRaw(u.firm),
        toGrade: extractRaw(u.toGrade),
        fromGrade: extractRaw(u.fromGrade),
        action: extractRaw(u.action),
        date: extractFmt(u.epochGradeDate),
      }))

      // Calendar
      const earnings = calendar.earnings as Record<string, unknown> | undefined
      const earningsDates = (earnings?.earningsDate as Record<string, unknown>[])?.map(d => extractFmt(d)) ?? []

      // Flags
      const flags: string[] = []
      const currentQ = estimates[0]
      if (currentQ) {
        const up7 = (currentQ.upRevisions7d as number) ?? 0
        const down7 = (currentQ.downRevisions7d as number) ?? 0
        if (up7 > down7 * 2) flags.push('GREEN: Estimate revisions trending up')
        if (down7 > up7 * 2) flags.push('RED: Estimate revisions trending down')

        const current = currentQ.epsAvg as number | null
        const ago30 = currentQ.eps30dAgo as number | null
        if (current != null && ago30 != null) {
          if (current > ago30) flags.push('GREEN: EPS estimate raised in last 30 days')
          if (current < ago30) flags.push('RED: EPS estimate cut in last 30 days')
        }
      }

      const beats = surpriseHistory.filter(s => (s.surprise as number) > 0).length
      if (beats === surpriseHistory.length && surpriseHistory.length >= 4) {
        flags.push('GREEN: Beat estimates 4 consecutive quarters')
      }

      if (targetMean != null && currentPrice != null) {
        const upside = round(((targetMean - currentPrice) / currentPrice) * 100)
        if (upside > 20) flags.push(`GREEN: Analyst consensus implies ${upside}% upside`)
        if (upside < -10) flags.push(`RED: Analyst consensus implies ${Math.abs(upside)}% downside`)
      }

      const result = {
        symbol,
        analystConsensus: {
          rating: recKey,
          ratingScore: recMean != null ? `${round(recMean, 1)}/5 (1=Strong Buy, 5=Strong Sell)` : null,
          numAnalysts,
          recommendations,
          priceTargets: {
            current: currentPrice,
            mean: targetMean,
            median: targetMedian,
            low: targetLow,
            high: targetHigh,
            impliedUpside: targetMean != null && currentPrice != null
              ? `${round(((targetMean - currentPrice) / currentPrice) * 100)}%`
              : null,
          },
        },
        earningsEstimates: estimates.slice(0, 2),
        earningsSurpriseHistory: surpriseHistory,
        recentAnalystActions: recentActions,
        nextEarningsDate: earningsDates[0] ?? null,
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching earnings data for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
