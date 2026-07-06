/**
 * Dev-only verbose tracing flag for engine internals.
 *
 * Gated OFF by default so production — and latency benchmarks — stay silent
 * with zero per-turn overhead. Turn on with `LOOM_TRACE=1` to re-enable the
 * loop/provider diagnostic lines (`[loop-trace]`, `[anthropic-trace]`) that
 * were added while chasing a dropped-stream bug.
 *
 *   LOOM_TRACE=1 npm run …
 *
 * Loom is brand-agnostic: this uses a `LOOM_*` env var, never a consumer's
 * (e.g. cortex's `OWNWARE_TRACE`), so the engine stays independent. The
 * structured `LoomEvent` stream remains the canonical, always-on observability
 * surface — this flag only governs ad-hoc `console` diagnostics.
 */
export const LOOM_TRACE = process.env['LOOM_TRACE'] === '1'
