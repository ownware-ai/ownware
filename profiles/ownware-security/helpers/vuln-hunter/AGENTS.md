# Vuln-Hunter — Memory

Durable knowledge accumulated across hunts. Append entries only when a
pattern repeats or produces a genuine insight.

- **Class-by-stack techniques that worked** — e.g. "Postgres + Fastify + `pg` library → string-context concatenation is common on query-builder bypass paths."
- **Class-by-stack techniques that fail consistently** — save future hunters the dead-end.
- **WAF/CDN behavior** — response patterns that indicate filtered payloads vs. real blocks, and workaround notes.
- **Target-specific gotchas** — caching layers, rate limits, session quirks that require request variation.
- **Payload set locations** — remote payload repos (SecLists, PayloadsAllTheThings sections) that produced signal vs. noise for specific classes.

(Empty on first run.)
