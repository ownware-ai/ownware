# Harness Specification

The harness is the shared infrastructure that all tests use.
No test should create its own gateway or manual fetch calls.

## Files

### `harness/gateway.ts` — Test Gateway Manager

```typescript
// Creates an isolated gateway with:
// - OS-assigned port (port: 0)
// - Temporary directory for DB + profiles
// - Minimal test profile pre-seeded
// - Auto-cleanup on close

interface TestGateway {
  port: number
  token: string
  state: GatewayState    // Direct DB access for setup/verification
  baseUrl: string
  client: ApiClient       // Pre-configured HTTP client
  start(): Promise<void>
  stop(): Promise<void>
}

function createTestGateway(opts?: {
  profiles?: ProfileDefinition[]   // Extra profiles to seed
  seed?: (state: GatewayState) => void  // Pre-populate data
}): Promise<TestGateway>
```

**Usage:**
```typescript
let gw: TestGateway

beforeAll(async () => {
  gw = await createTestGateway()
})

afterAll(async () => {
  await gw.stop()  // Cleans up temp dir + DB
})
```

### `harness/api-client.ts` — Typed HTTP Client

```typescript
// Wraps fetch with:
// - Auto auth token header
// - JSON parsing
// - Status code in response
// - Optional Zod validation per call

interface ApiResponse<T> {
  status: number
  body: T
  headers: Record<string, string>
  raw: string  // Raw response text (for debugging)
}

class ApiClient {
  get<T>(path: string, schema?: ZodType<T>): Promise<ApiResponse<T>>
  post<T>(path: string, body: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>>
  put<T>(path: string, body: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>>
  patch<T>(path: string, body: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>>
  delete(path: string): Promise<ApiResponse<unknown>>
  sse(path: string, body: unknown): Promise<SSEStream> // POST /run bootstrap + GET /threads/:tid/agents/:aid/events
}
```

**Usage:**
```typescript
const { status, body } = await gw.client.get('/api/v1/threads', ThreadListSchema)
// body is typed as PaginatedResult<Thread>
// Zod validation ran automatically — throws if shape is wrong
```

### `harness/sse-parser.ts` — SSE Stream Parser

```typescript
// Parses raw SSE text into typed event objects
// Handles: multi-line data, keepalive comments, event names

interface SSEEvent {
  event: string   // e.g., 'text.delta', 'tool.call.start'
  data: unknown   // Parsed JSON
}

interface SSEStream {
  events: SSEEvent[]                    // All events
  text(): string                        // Accumulated text.delta
  thinking(): string                    // Accumulated thinking.delta
  tools(): ToolCallRecord[]             // Completed tool calls
  agents(): SubAgentRecord[]            // Sub-agent activity
  permissions(): PermissionRecord[]     // Permission events
  usage(): { inputTokens: number; outputTokens: number; costUsd: number }
  hasEvent(type: string): boolean
  eventsOfType<T>(type: string): T[]
}

function parseSSE(rawText: string): SSEStream
```

**Usage:**
```typescript
const stream = await gw.client.sse('/api/v1/run', {
  prompt: 'Hello',
  profileId: 'mini',
  threadId: 'thread_abc',
})
expect(stream.text()).toContain('Hello')
expect(stream.usage().inputTokens).toBeGreaterThan(0)
expect(stream.hasEvent('done')).toBe(true)
```

### `harness/schema-validator.ts` — Response Schemas

```typescript
// Zod schemas for EVERY response type
// These mirror types.ts but are runtime-checkable

export const ThreadSchema: ZodType<Thread>
export const PaginatedThreadsSchema: ZodType<PaginatedResult<Thread>>
export const ProfileSummarySchema: ZodType<ProfileSummary>
export const ProfileDetailSchema: ZodType<ProfileDetail>
export const WorkspaceSchema: ZodType<Workspace>
export const WorkspaceDetailSchema: ZodType<WorkspaceDetail>
export const DashboardStatsSchema: ZodType<DashboardStats>
export const DashboardKPIsSchema: ZodType<DashboardKPIs>
export const UsageBucketSchema: ZodType<UsageBucket>
export const ProfileBreakdownRowSchema: ZodType<ProfileBreakdownRow>
export const MCPServerRecordSchema: ZodType<MCPServerRecord>
export const ApiErrorSchema: ZodType<ApiError>
export const SSETextDeltaSchema: ZodType<{ text: string }>
export const SSETurnEndSchema: ZodType<{ turnIndex: number; usage: { ... } }>
// ... every response type
```

### `harness/fixture-recorder.ts` — Response Snapshot Saver

```typescript
// Saves real API responses to fixtures/ directory
// Frontend devs use these for offline Storybook/component tests

class FixtureRecorder {
  record(name: string, response: ApiResponse<unknown>): void
  recordSSE(name: string, stream: SSEStream): void
  flush(): Promise<void>  // Write all to disk
}
```

**Generates files like:**
```
fixtures/
├── profiles-list.json          ← GET /profiles response
├── thread-detail.json          ← GET /threads/:id response
├── run-sse-simple.json         ← SSE events from a simple prompt
├── run-sse-with-tools.json     ← SSE events with tool calls
├── dashboard-stats.json        ← GET /dashboard response
├── dashboard-kpis-7d.json      ← KPIs for 7d range
└── workspace-detail.json       ← GET /workspaces/:id response
```

### `harness/assertions.ts` — Custom Test Matchers

```typescript
// Vitest custom matchers for common assertions

expect(response).toMatchSchema(ThreadSchema)
expect(sseStream).toHaveEvent('text.delta')
expect(sseStream).toHaveCompletedSuccessfully()
expect(paginatedResult).toHavePagination({ total: 5, limit: 50 })
expect(thread).toHaveAccurateCounters()  // messageCount matches actual messages
```
