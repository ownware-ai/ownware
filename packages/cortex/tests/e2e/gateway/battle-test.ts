/**
 * LIVE BATTLE TEST — starts real gateway, hits real Anthropic API.
 *
 * Usage: npx tsx tests/e2e/gateway/battle-test.ts
 */

import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const tmpDir = await mkdtemp(join(tmpdir(), 'cortex-battle-'))
const profilesDir = join(tmpDir, 'profiles', 'mini')
await mkdir(profilesDir, { recursive: true })
await writeFile(join(profilesDir, 'agent.json'), JSON.stringify({
  name: 'mini',
  description: 'Minimal test agent',
  model: 'anthropic:claude-sonnet-4-20250514',
  tools: { preset: 'none' },
  context: { cwd: false, datetime: false },
}))

const gw = new OwnwareGateway({
  port: 0,
  profilesDir: join(tmpDir, 'profiles'),
  dbPath: join(tmpDir, 'test.db'),
  dataDir: join(tmpDir, 'data'),
})
await gw.start()

const TOKEN = gw.token
const BASE = `http://127.0.0.1:${gw.port}`
const h: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${name}`)
    passed++
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

console.log(`\n🔥 BATTLE TEST — Gateway on port ${gw.port}\n`)

// ── 1. Health ──
let r = await api('GET', '/api/v1/health')
check('GET /health returns 200', r.status === 200)

// ── 2. Profiles ──
r = await api('GET', '/api/v1/profiles')
check('GET /profiles returns array', r.status === 200 && Array.isArray(r.body))
check('Mini profile is listed', r.body.some((p: any) => p.name === 'mini'))

// ── 3. Workspace ──
r = await api('POST', '/api/v1/workspaces', { path: tmpDir, name: 'Battle WS' })
check('POST /workspaces creates workspace', r.status === 201 || r.status === 200)
const wsId = r.body.id
check('Workspace has id', typeof wsId === 'string' && wsId.startsWith('ws_'))

// ── 4. Workspaces list (paginated) ──
r = await api('GET', '/api/v1/workspaces')
check('GET /workspaces returns PaginatedResult', r.status === 200 && typeof r.body.total === 'number')
check('PaginatedResult has items array', Array.isArray(r.body.items))
check('PaginatedResult has limit/offset', typeof r.body.limit === 'number' && typeof r.body.offset === 'number')

// ── 5. Thread ──
r = await api('POST', '/api/v1/threads', { profileId: 'mini', workspaceId: wsId })
check('POST /threads creates thread', r.status === 201)
const threadId = r.body.id
check('Thread has id', typeof threadId === 'string' && threadId.startsWith('thread_'))
check('Thread messageCount starts at 0', r.body.messageCount === 0)

// ── 6. Threads list (paginated) ──
r = await api('GET', '/api/v1/threads')
check('GET /threads returns PaginatedResult', r.status === 200 && typeof r.body.total === 'number')
check('Thread is in list', r.body.items.some((t: any) => t.id === threadId))

// ── 7. REAL LLM RUN ──
console.log('\n  ⏳ Running real Anthropic API call...')
const runRes = await fetch(`${BASE}/api/v1/run`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ prompt: 'Say exactly this and nothing else: BATTLE TEST PASSED', threadId, profileId: 'mini' }),
})
const sseText = await runRes.text()
const events = sseText.split('\n\n').filter(e => e.startsWith('event:'))
const textDeltas = events.filter(e => e.includes('text.delta'))
const fullText = textDeltas.map(e => {
  const dataLine = e.split('\n').find(l => l.startsWith('data:'))
  if (!dataLine) return ''
  try { return JSON.parse(dataLine.slice(5)).text || '' } catch { return '' }
}).join('')
console.log(`  📝 LLM response: "${fullText.slice(0, 100)}"`)

check('SSE stream has events', events.length > 0, `got ${events.length}`)
check('SSE has text.delta events', textDeltas.length > 0, `got ${textDeltas.length}`)
check('LLM responded with BATTLE TEST PASSED', fullText.toUpperCase().includes('BATTLE') && fullText.toUpperCase().includes('PASSED'))
check('SSE has done event', events.some(e => e.includes('event: done')))

// ── 8. Thread after run — verify data layer ──
r = await api('GET', `/api/v1/threads/${threadId}`)
check('GET /threads/:id returns 200', r.status === 200)
check('messageCount > 0 after run (atomic counter works)', r.body.messageCount > 0, `got ${r.body.messageCount}`)
check('totalTokens > 0 after run (usage propagation works)', r.body.totalTokens > 0, `got ${r.body.totalTokens}`)
check('totalCost > 0 after run', r.body.totalCost > 0, `got ${r.body.totalCost}`)
check('messages array present', Array.isArray(r.body.messages) && r.body.messages.length > 0)
check('Has user message', r.body.messages.some((m: any) => m.role === 'user'))
check('Has assistant message', r.body.messages.some((m: any) => m.role === 'assistant'))

// ── 9. Dashboard stats ──
r = await api('GET', '/api/v1/dashboard')
check('GET /dashboard returns 200', r.status === 200)
check('Dashboard todayRuns > 0', r.body.todayRuns > 0, `got ${r.body.todayRuns}`)
check('Dashboard todayTokens > 0', r.body.todayTokens > 0)

// ── 10. Usage time series ──
const buckets = gw.state.getUsageTimeSeries('7d')
check('getUsageTimeSeries(7d) returns 7 buckets', buckets.length === 7)
const todayDate = new Date().toISOString().split('T')[0]!
const todayBucket = buckets.find(b => b.date === todayDate)
check('Today bucket has runs > 0', todayBucket !== undefined && todayBucket.runs > 0)
check('Today bucket has tokens > 0', todayBucket !== undefined && todayBucket.tokens > 0)

const hourBuckets = gw.state.getUsageTimeSeries('24h')
check('getUsageTimeSeries(24h) returns 24 buckets', hourBuckets.length === 24)

// ── 11. KPIs ──
const kpis = gw.state.getKPIs('7d')
check('getKPIs returns 4 cards', kpis.cards.length === 4)
check('KPI cards: Tokens, Cost, Runs, Avg Duration', kpis.cards.map(c => c.label).join(',') === 'Tokens,Cost,Runs,Avg Duration')
check('Each card has 12-pt sparkline', kpis.cards.every(c => c.sparkline.length === 12))
check('Tokens KPI value > 0', kpis.cards[0]!.value > 0)
check('Runs KPI value > 0', kpis.cards[2]!.value > 0)

// ── 12. Profile breakdown ──
const breakdown = gw.state.getProfileBreakdown()
check('getProfileBreakdown has entries', breakdown.length > 0)
const miniRow = breakdown.find(r => r.profileId === 'mini')
check('Mini profile in breakdown', miniRow !== undefined)
check('Mini has runs > 0', miniRow !== undefined && miniRow.runs > 0)
check('Mini has successRate between 0 and 1', miniRow !== undefined && miniRow.successRate >= 0 && miniRow.successRate <= 1)

// ── 13. Recent activity ──
const activity = gw.state.getRecentActivity(5)
check('getRecentActivity returns entries', activity.length > 0)
check('Activity entry has expected fields', activity.length > 0 && activity[0]!.id.startsWith('usage_') && typeof activity[0]!.totalTokens === 'number')

// ── 14. incrementProfileUsage ──
gw.state.incrementProfileUsage('battle-profile', 0.05)
gw.state.incrementProfileUsage('battle-profile', 0.10)
gw.state.incrementProfileUsage('battle-profile', 0.15)
const meta = gw.state.getProfileMetadata('battle-profile')!
check('incrementProfileUsage: useCount = 3', meta.useCount === 3)
check('incrementProfileUsage: totalCost ≈ 0.30', Math.abs(meta.totalCost - 0.30) < 0.001)
check('incrementProfileUsage: lastUsedAt set', meta.lastUsedAt !== null)

// ── 15. Pagination edge cases ──
for (let i = 0; i < 5; i++) gw.state.createThread('mini', `Paginate ${i}`, wsId)
const { items: page1Items, total } = gw.state.listThreads(undefined, { limit: 2, offset: 0 })
const { items: page2Items } = gw.state.listThreads(undefined, { limit: 2, offset: 2 })
check('Pagination: page1 has 2 items', page1Items.length === 2)
check('Pagination: page2 has 2 items', page2Items.length === 2)
check('Pagination: total >= 6', total >= 6)
check('Pagination: pages have different items', page1Items[0]!.id !== page2Items[0]!.id)

const beyondResult = gw.state.listThreads(undefined, { limit: 10, offset: 9999 })
check('Pagination: offset beyond total returns empty items', beyondResult.items.length === 0)
check('Pagination: total still correct when offset beyond', beyondResult.total >= 6)

// ── 16. MCP servers (N+1 fix) ──
gw.state.createMCPServer({ id: 'battle-srv', name: 'Battle Server', transport: 'stdio' })
gw.state.assignServerToProfile('battle-srv', 'profile-a')
gw.state.assignServerToProfile('battle-srv', 'profile-b')
const { items: servers } = gw.state.listMCPServers()
const battleSrv = servers.find(s => s.id === 'battle-srv')
check('MCP server has profileIds (no N+1)', battleSrv !== undefined && Array.isArray(battleSrv.profileIds))
check('MCP server profileIds has 2 entries', battleSrv !== undefined && battleSrv.profileIds!.length === 2)

// ── 17. Settings ──
r = await api('PUT', '/api/v1/settings/appearance', { theme: 'dark', fontSize: '14' })
check('PUT /settings/appearance returns 200', r.status === 200)

// ── 18. Session persistence ──
gw.state.saveSessionState()
const sessionState = gw.state.getSessionState()
check('Session state saved', sessionState !== null && sessionState.hasSession)

// ── 19. Thread export ──
r = await api('GET', `/api/v1/threads/${threadId}/export?format=markdown`)
check('Thread export as markdown', r.status === 200)
r = await api('GET', `/api/v1/threads/${threadId}/export?format=json`)
check('Thread export as JSON', r.status === 200 && r.body.thread && r.body.messages)

// ── 20. Search ──
r = await api('GET', '/api/v1/search?q=Paginate')
check('Search returns results', r.status === 200 && Array.isArray(r.body) && r.body.length > 0)

// ── Summary ──
console.log(`\n${'='.repeat(50)}`)
console.log(`🔥 BATTLE TEST RESULTS: ${passed} passed, ${failed} failed`)
console.log(`${'='.repeat(50)}\n`)

await gw.stop()
await rm(tmpDir, { recursive: true, force: true })
process.exit(failed > 0 ? 1 : 0)
