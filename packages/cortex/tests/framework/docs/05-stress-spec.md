# Stress Tests Specification

Stress tests verify the gateway handles extreme conditions
without data corruption, crashes, or silent failures.

## Test Files

### `stress/concurrent-runs.stress.ts`

**What**: 3 parallel POST /run on different threads simultaneously.
**Why**: Verifies SQLite WAL mode handles concurrent writes.
**Checks**:
- All 3 SSE streams complete without error
- Each thread has correct messageCount (no cross-contamination)
- Each thread has correct totalTokens (no double-counting)
- usage_records has exactly 3 entries
- Dashboard todayRuns = 3

### `stress/pagination-limits.stress.ts`

**What**: Create 500 threads, test pagination edge cases.
**Why**: Verifies LIMIT/OFFSET with large datasets.
**Checks**:
- GET /threads?limit=200 → exactly 200 items, total=500
- GET /threads?limit=999 → capped at 200
- GET /threads?offset=498 → 2 items
- GET /threads?offset=500 → 0 items, total still 500
- All 500 threads reachable by paginating through
- No duplicates across pages

### `stress/large-message.stress.ts`

**What**: Send 10KB prompt, verify no truncation.
**Why**: Some HTTP parsers or DB columns may truncate.
**Checks**:
- POST /run with 10KB prompt → SSE stream completes
- GET /threads/:id/messages → user message content = full 10KB
- lastMessagePreview truncated to 200 chars (expected)
- No DB errors or partial writes

### `stress/rapid-fire.stress.ts`

**What**: 20 sequential requests in under 2 seconds.
**Why**: Verifies rate limiter behavior.
**Checks**:
- First 10 requests succeed (200)
- Rate limiter may kick in after threshold
- No server crash or unhandled rejection
- All successful requests have valid response bodies
- Server still responds after burst

### `stress/db-recovery.stress.ts`

**What**: Verify WAL mode and transaction safety.
**Why**: If the process crashes mid-write, data must be consistent.
**Checks**:
- Write 100 usage records in rapid succession
- Verify all 100 are readable
- Close DB without clean shutdown (simulate crash)
- Reopen DB → all data intact (WAL recovery)
- No partial/corrupt rows
