---
title: Storage performance
description: Reproducible SQLite and PostgreSQL storage measurements, including where PostgreSQL is slower.
type: reference
---

# Storage performance

Storage choice is an operations decision, not a speed claim. The benchmark is a
correctness-guarded adapter workload in
`packages/cortex/tests/perf/storage-adapter-benchmark.test.ts`:

```bash
cd packages/cortex
RUN_STORAGE_ADAPTER_BENCHMARK=1 \
OWNWARE_TEST_POSTGRES_URL='<disposable-admin-url>' \
bunx vitest run tests/perf/storage-adapter-benchmark.test.ts
```

It creates disposable storage only. PostgreSQL must be an explicitly disposable
test cluster because the harness creates and drops unique test databases. The
test verifies committed counts, order, event sequences, unique job claims and
checkpoints before it prints a receipt.

## Recorded run — 2026-08-02

- Apple M4 Pro, 14 logical CPUs, 24 GiB memory, macOS arm64
- Node 26.0.0; `better-sqlite3` 12.11.1; `pg` 8.22.0
- SQLite 3.53.2, WAL, local file
- PostgreSQL 18.4 in a local container, pool maximum 8
- 16 warmup thread/message/event operations, one warmup job pipeline
- measured: 160 thread creates, 160 message appends, 320 durable event
  appends, 160 thread reads, 160 message-list reads, 80 job claims and 80
  checkpoint writes; concurrency 8

Latency is milliseconds; throughput is operations/second. Values are one local
run, not service-level objectives.

### SQLite

| Operation | p50 | p95 | p99 | Throughput |
|---|---:|---:|---:|---:|
| Create thread | 0.327 | 0.484 | 1.078 | 20,767 |
| Add message | 0.528 | 1.475 | 2.564 | 11,800 |
| Append durable event | 0.180 | 0.285 | 2.204 | 30,587 |
| Get thread | 0.070 | 0.100 | 0.116 | 95,832 |
| List messages | 0.089 | 0.144 | 0.150 | 79,930 |
| Claim source job | 0.831 | 1.822 | 1.900 | 8,060 |
| Advance job checkpoint | 0.235 | 0.302 | 0.306 | 32,522 |

Measured database growth was 503,808 bytes.

### PostgreSQL over loopback

| Operation | p50 | p95 | p99 | Throughput |
|---|---:|---:|---:|---:|
| Create thread | 1.835 | 4.282 | 11.844 | 3,375 |
| Add message | 3.143 | 4.651 | 6.256 | 2,506 |
| Append durable event | 2.012 | 3.077 | 3.480 | 3,768 |
| Get thread | 0.452 | 0.795 | 0.948 | 15,786 |
| List messages | 0.547 | 0.990 | 1.221 | 13,420 |
| Claim source job | 8.099 | 13.974 | 16.906 | 870 |
| Advance job checkpoint | 3.282 | 8.190 | 8.586 | 2,119 |

Measured database growth was 1,073,152 bytes. PostgreSQL was slower at p99 for
every operation in this single-tenant loopback run. The largest direct p99
ratios were checkpoint writes (28.0×), thread creation (11.0×), job claims
(8.9×), thread reads (8.2×) and message-list reads (8.2×). This is expected to
vary with hardware, filesystem, server tuning and workload; it is recorded
rather than hidden.

### Delayed-loopback PostgreSQL signal

A TCP proxy applied a minimum 5 ms delay to each wire chunk in each direction.
This is a latency sensitivity signal, not a real remote-network measurement and
not an exact 10 ms RTT emulator.

| Operation | p50 | p95 | p99 | Throughput |
|---|---:|---:|---:|---:|
| Create thread | 40.955 | 44.472 | 49.993 | 195 |
| Add message | 51.949 | 59.829 | 61.165 | 154 |
| Append durable event | 53.787 | 60.526 | 62.595 | 148 |
| Get thread | 13.927 | 15.914 | 16.554 | 574 |
| List messages | 12.551 | 14.151 | 16.062 | 636 |
| Claim source job | 68.789 | 96.762 | 96.891 | 108 |
| Advance job checkpoint | 28.021 | 35.401 | 37.423 | 269 |

The delayed run grew by 1,400,832 bytes. PostgreSQL physical allocation varies,
so one small growth delta is not a storage-efficiency guarantee.

## How to interpret the result

The durable event append is on the path before an SSE event becomes live, so
database round trips directly affect streamed response cadence. Keep
PostgreSQL close to the gateway, size the pool for actual concurrency, and
measure the production topology. Do not use a remote database merely because
PostgreSQL is available.

The benchmark excludes model latency, HTTP/TLS framing, external source bytes,
vacuum/checkpoint behavior over time, backups, replicas, failover and multiple
gateway processes. It does not set pass/fail timing thresholds because shared
CI hardware would turn environmental noise into a product claim. Correctness
guards always run when the benchmark is enabled; the measurements are the
receipt.
