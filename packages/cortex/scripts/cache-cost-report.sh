#!/usr/bin/env bash
#
# cache-cost-report.sh — measure REAL token/cache/cost behaviour from the
# gateway's own usage records. The honest baseline: it reads what actually
# happened on this machine, not a synthetic run.
#
# Source of truth: the `messages` table records per-turn provider usage —
# usage_cache_read (billed ~0.1x), usage_cache_creation (~1.25x),
# usage_input (full 1x), usage_output. The cache-hit % is the fraction of
# input-side tokens served from cache; low = paying full price to re-read
# history every turn.
#
# Usage:  ./cache-cost-report.sh [path-to-ownware.db]
# Default DB: ~/.ownware/ownware.db   (override with $1 or $CORTEX_DB)
#
# Read-only. Safe to run against a live gateway (opens the DB read-only).

set -euo pipefail
DB="${1:-${CORTEX_DB:-$HOME/.ownware/ownware.db}}"

if [[ ! -f "$DB" ]]; then
  echo "ownware.db not found at: $DB" >&2
  echo "Pass the path as the first arg or set \$CORTEX_DB." >&2
  exit 1
fi

q() { sqlite3 -readonly -header -column "$DB" "$1"; }

echo "════════════════════════════════════════════════════════════════════"
echo " Cache / cost report — $DB"
echo "════════════════════════════════════════════════════════════════════"

echo
echo "── Coverage ─────────────────────────────────────────────────────────"
q "SELECT
     COUNT(*)                                                       AS total_messages,
     SUM(CASE WHEN usage_output IS NOT NULL AND usage_output>0 THEN 1 ELSE 0 END) AS model_turns,
     MIN(created_at) AS earliest, MAX(created_at) AS latest
   FROM messages;"

echo
echo "── Headline: input-side token split (all model turns) ───────────────"
echo "   cache_hit_pct = cache_read / (cache_read + cache_write + uncached_input)"
q "SELECT
     SUM(COALESCE(usage_cache_read,0))     AS cache_read_010x,
     SUM(COALESCE(usage_cache_creation,0)) AS cache_write_125x,
     SUM(COALESCE(usage_input,0))          AS uncached_in_1x,
     SUM(COALESCE(usage_output,0))         AS output,
     ROUND(100.0*SUM(COALESCE(usage_cache_read,0))/
       NULLIF(SUM(COALESCE(usage_cache_read,0))+SUM(COALESCE(usage_cache_creation,0))+SUM(COALESCE(usage_input,0)),0),1) AS cache_hit_pct
   FROM messages WHERE usage_output IS NOT NULL;"

echo
echo "── By model (cache support varies hugely by provider/route) ─────────"
q "SELECT COALESCE(model,'(null)') AS model, COUNT(*) AS turns,
     SUM(COALESCE(usage_cache_read,0))     AS cache_read,
     SUM(COALESCE(usage_input,0))          AS uncached_in,
     ROUND(100.0*SUM(COALESCE(usage_cache_read,0))/
       NULLIF(SUM(COALESCE(usage_cache_read,0))+SUM(COALESCE(usage_cache_creation,0))+SUM(COALESCE(usage_input,0)),0),1) AS hit_pct
   FROM messages WHERE usage_output IS NOT NULL
   GROUP BY model ORDER BY (SUM(COALESCE(usage_cache_read,0))+SUM(COALESCE(usage_input,0))) DESC LIMIT 15;"

echo
echo "── Where caching mechanics apply: Anthropic-direct vs OpenRouter ────"
echo "   (Loom's prompt-cache fixes — reminder marker, 5m→1h TTL, cache_control"
echo "    placement — only affect Anthropic-direct traffic.)"
q "SELECT
     SUM(CASE WHEN model LIKE 'anthropic:%' THEN COALESCE(usage_cache_read,0)+COALESCE(usage_input,0) ELSE 0 END) AS anthropic_direct_input,
     SUM(CASE WHEN model LIKE 'openrouter:%' THEN COALESCE(usage_cache_read,0)+COALESCE(usage_input,0) ELSE 0 END) AS openrouter_input,
     SUM(CASE WHEN model NOT LIKE 'anthropic:%' AND model NOT LIKE 'openrouter:%' THEN COALESCE(usage_cache_read,0)+COALESCE(usage_input,0) ELSE 0 END) AS other_input
   FROM messages WHERE usage_output IS NOT NULL;"

echo
echo "── Recorded cost ────────────────────────────────────────────────────"
q "SELECT ROUND(SUM(total_cost),2) AS total_usd, SUM(message_count) AS messages, COUNT(*) AS threads FROM threads;"
q "SELECT ROUND(SUM(cost_usd),2) AS usage_records_usd, COUNT(*) AS records,
     SUM(CASE WHEN cost_usd=0 THEN 1 ELSE 0 END) AS zero_cost_records
   FROM usage_records;"

echo
echo "── Top threads by tokens ────────────────────────────────────────────"
q "SELECT profile_id, message_count AS msgs, total_tokens AS tokens, ROUND(total_cost,3) AS cost_usd, model
   FROM threads WHERE total_tokens>0 ORDER BY total_tokens DESC LIMIT 8;"

echo
echo "Done. Re-run after any caching change to measure the delta."
