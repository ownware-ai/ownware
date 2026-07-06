/**
 * Intelligence Tools — News, Sentiment, Analyst Actions
 *
 * Data sources:
 * - Yahoo Finance (news, analyst upgrades/downgrades) — no key
 * - ApeWisdom (Reddit mentions across WSB, stocks, options) — no key
 * - Tradestie (WSB sentiment scores) — no key
 * - Finnhub (social sentiment, if key available) — free key
 *
 * Tools:
 * - get_news_digest: Recent news with relevance assessment
 * - get_social_sentiment: Reddit/social sentiment aggregation
 * - get_analyst_actions: Recent upgrades, downgrades, target changes
 */

import { defineTool } from '@ownware/loom'
import type { Tool, ToolContext } from '@ownware/loom'
import { getCredential } from './shared.js'

function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// Yahoo Finance news
// ---------------------------------------------------------------------------

async function fetchYahooNews(symbol: string): Promise<Array<{
  title: string
  publisher: string
  summary: string
  publishedAt: string
}>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  // News endpoint via search
  const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=15&enableFuzzyQuery=false&quotesCount=0&listsCount=0`

  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Ownware/1.0 (trading-firm-profile)' },
    })
    if (!res.ok) return []

    const json = (await res.json()) as Record<string, unknown>
    const news = (json.news as Record<string, unknown>[]) ?? []

    return news.map(article => ({
      title: (article.title as string) ?? '',
      publisher: (article.publisher as string) ?? 'Unknown',
      summary: (article.snippet as string) ?? '',
      publishedAt: article.providerPublishTime
        ? new Date((article.providerPublishTime as number) * 1000).toISOString().split('T')[0]
        : '',
    })).filter(a => a.title.length > 0)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// ApeWisdom — Reddit mentions (WSB, stocks, options)
// ---------------------------------------------------------------------------

interface ApeWisdomResult {
  ticker: string
  mentions: number
  upvotes: number
  rank: number
  rankChange: number
}

async function fetchApeWisdom(symbol: string): Promise<ApeWisdomResult | null> {
  try {
    // ApeWisdom lists top mentioned tickers across Reddit
    const res = await fetch('https://apewisdom.io/api/v1.0/filter/all-stocks/page/1', {
      headers: { 'User-Agent': 'Ownware/1.0' },
    })
    if (!res.ok) return null

    const json = (await res.json()) as Record<string, unknown>
    const results = (json.results as Record<string, unknown>[]) ?? []

    const match = results.find(r => (r.ticker as string)?.toUpperCase() === symbol.toUpperCase())
    if (!match) return null

    return {
      ticker: (match.ticker as string) ?? symbol,
      mentions: (match.mentions as number) ?? 0,
      upvotes: (match.upvotes as number) ?? 0,
      rank: (match.rank as number) ?? 0,
      rankChange: (match.rank_24h_ago as number) != null
        ? (match.rank_24h_ago as number) - (match.rank as number)
        : 0,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tradestie — WSB sentiment
// ---------------------------------------------------------------------------

interface TradestieSentiment {
  ticker: string
  sentiment: string
  sentimentScore: number
  comments: number
}

async function fetchTradestie(symbol: string): Promise<TradestieSentiment | null> {
  try {
    const res = await fetch('https://tradestie.com/api/v1/apps/reddit', {
      headers: { 'User-Agent': 'Ownware/1.0' },
    })
    if (!res.ok) return null

    const results = (await res.json()) as Record<string, unknown>[]
    const match = results.find(r => (r.ticker as string)?.toUpperCase() === symbol.toUpperCase())
    if (!match) return null

    return {
      ticker: (match.ticker as string) ?? symbol,
      sentiment: (match.sentiment as string) ?? 'neutral',
      sentimentScore: (match.sentiment_score as number) ?? 0,
      comments: (match.no_of_comments as number) ?? 0,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Finnhub social sentiment (optional — needs FINNHUB_API_KEY)
// ---------------------------------------------------------------------------

async function fetchFinnhubSentiment(
  symbol: string,
  key: string | null,
): Promise<Record<string, unknown> | null> {
  if (!key) return null

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/social-sentiment?symbol=${encodeURIComponent(symbol)}&from=${getDateDaysAgo(7)}&to=${new Date().toISOString().split('T')[0]}&token=${key}`,
    )
    if (!res.ok) return null

    const json = (await res.json()) as Record<string, unknown>
    const reddit = (json.reddit as Record<string, unknown>[]) ?? []
    const twitter = (json.twitter as Record<string, unknown>[]) ?? []

    const redditAvg = reddit.length > 0
      ? round(reddit.reduce((s, r) => s + ((r.score as number) ?? 0), 0) / reddit.length, 3)
      : null
    const twitterAvg = twitter.length > 0
      ? round(twitter.reduce((s, t) => s + ((t.score as number) ?? 0), 0) / twitter.length, 3)
      : null

    return {
      reddit: { dataPoints: reddit.length, avgScore: redditAvg },
      twitter: { dataPoints: twitter.length, avgScore: twitterAvg },
    }
  } catch {
    return null
  }
}

function getDateDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Tool: get_news_digest
// ---------------------------------------------------------------------------

export const getNewsDigest: Tool = defineTool({
  name: 'get_news_digest',
  description:
    'Get recent news articles for a stock from Yahoo Finance. ' +
    'Returns titles, publishers, and summaries. Filtered for relevance.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol' },
    },
    required: ['symbol'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 20_000,
  async execute(input) {
    const { symbol } = input as { symbol: string }

    try {
      const articles = await fetchYahooNews(symbol)

      if (articles.length === 0) {
        return { content: `No recent news found for ${symbol}`, isError: false }
      }

      const result = {
        symbol,
        articleCount: articles.length,
        articles: articles.slice(0, 10).map((a, i) => ({
          rank: i + 1,
          title: a.title,
          publisher: a.publisher,
          summary: a.summary.slice(0, 200),
          date: a.publishedAt,
        })),
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching news for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: get_social_sentiment
// ---------------------------------------------------------------------------

export const getSocialSentiment: Tool = defineTool({
  name: 'get_social_sentiment',
  description:
    'Get social media sentiment from Reddit (r/wallstreetbets, r/stocks, r/options). ' +
    'Aggregates mentions, upvotes, sentiment scores from ApeWisdom and Tradestie APIs. ' +
    'Optionally includes Finnhub sentiment if API key is set.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol' },
    },
    required: ['symbol'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 20_000,
  async execute(input, context: ToolContext) {
    const { symbol } = input as { symbol: string }
    // Finnhub is optional here — ApeWisdom + Tradestie already give us a
    // sentiment signal. When the key isn't available we just skip that
    // third source rather than failing the whole tool.
    const finnhubKey = getCredential(context, 'FINNHUB_API_KEY')

    try {
      // Fetch all sentiment sources in parallel
      const [apeWisdom, tradestie, finnhub] = await Promise.all([
        fetchApeWisdom(symbol),
        fetchTradestie(symbol),
        fetchFinnhubSentiment(symbol, finnhubKey),
      ])

      const flags: string[] = []

      if (apeWisdom) {
        if (apeWisdom.rank <= 10) flags.push(`ALERT: Top ${apeWisdom.rank} most mentioned on Reddit`)
        if (apeWisdom.rankChange > 5) flags.push('ALERT: Reddit mentions surging (rank rising fast)')
        if (apeWisdom.mentions > 100) flags.push('NOTE: High retail attention')
      }

      if (tradestie) {
        if (tradestie.sentimentScore > 0.6) flags.push('NOTE: WSB sentiment strongly bullish')
        if (tradestie.sentimentScore < -0.6) flags.push('NOTE: WSB sentiment strongly bearish')
      }

      const result = {
        symbol,
        reddit: {
          apeWisdom: apeWisdom ?? 'Ticker not in top Reddit mentions (low retail attention)',
          tradestie: tradestie ?? 'No WSB sentiment data available',
        },
        finnhub: finnhub ?? 'Finnhub sentiment not available (set FINNHUB_API_KEY for Reddit/Twitter scores)',
        overallSentiment: tradestie
          ? tradestie.sentimentScore > 0.3 ? 'bullish'
            : tradestie.sentimentScore < -0.3 ? 'bearish'
            : 'neutral'
          : apeWisdom
          ? apeWisdom.rank <= 20 ? 'elevated_attention' : 'low_attention'
          : 'no_data',
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching sentiment for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: get_analyst_actions
// ---------------------------------------------------------------------------

export const getAnalystActions: Tool = defineTool({
  name: 'get_analyst_actions',
  description:
    'Get recent analyst upgrades, downgrades, and price target changes from Yahoo Finance. ' +
    'Shows which Wall Street firms are changing their view and in which direction.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol' },
    },
    required: ['symbol'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 20_000,
  async execute(input) {
    const { symbol } = input as { symbol: string }

    try {
      const url =
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=upgradeDowngradeHistory,recommendationTrend`

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Ownware/1.0 (trading-firm-profile)' },
      })

      if (!res.ok) throw new Error(`API error: ${res.status}`)

      const json = (await res.json()) as Record<string, unknown>
      const qs = json.quoteSummary as Record<string, unknown>
      const results = (qs.result as Record<string, unknown>[])?.[0]
      if (!results) throw new Error(`No data for ${symbol}`)

      const udHistory = (results.upgradeDowngradeHistory ?? {}) as Record<string, unknown>
      const recTrend = (results.recommendationTrend ?? {}) as Record<string, unknown>

      const items = (udHistory.history as Record<string, unknown>[]) ?? []
      const recent = items.slice(0, 10).map(u => {
        const raw = u.epochGradeDate as number
        return {
          date: raw ? new Date(raw * 1000).toISOString().split('T')[0] : null,
          firm: u.firm as string,
          action: u.action as string,
          fromGrade: u.fromGrade as string,
          toGrade: u.toGrade as string,
        }
      })

      // Count recent actions by type
      const last30 = recent.filter(r => {
        if (!r.date) return false
        const d = new Date(r.date)
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - 30)
        return d >= cutoff
      })

      let upgrades = 0
      let downgrades = 0
      let initiations = 0
      for (const a of last30) {
        const action = (a.action ?? '').toLowerCase()
        if (action.includes('upgrade') || action === 'up') upgrades++
        else if (action.includes('downgrade') || action === 'down') downgrades++
        else if (action.includes('init')) initiations++
      }

      // Recommendation trend (monthly)
      const trendItems = (recTrend.trend as Record<string, unknown>[]) ?? []
      const monthlyTrend = trendItems.slice(0, 3).map(t => ({
        period: t.period as string,
        strongBuy: t.strongBuy as number,
        buy: t.buy as number,
        hold: t.hold as number,
        sell: t.sell as number,
        strongSell: t.strongSell as number,
      }))

      const flags: string[] = []
      if (upgrades > downgrades * 2 && upgrades >= 3) flags.push('GREEN: Strong upgrade momentum (last 30 days)')
      if (downgrades > upgrades * 2 && downgrades >= 3) flags.push('RED: Strong downgrade momentum (last 30 days)')
      if (upgrades === 0 && downgrades >= 2) flags.push('RED: Only downgrades in last 30 days')

      const result = {
        symbol,
        last30Days: { upgrades, downgrades, initiations },
        recentActions: recent,
        monthlyRecommendationTrend: monthlyTrend,
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching analyst actions for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
