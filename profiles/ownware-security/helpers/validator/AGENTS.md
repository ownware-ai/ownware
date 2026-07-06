# Validator — Memory

Durable knowledge accumulated across validations.

- **Reproduction recipes that consistently work for a class** — e.g. "for time-based SQLi, run three probes with escalating delays to rule out network jitter."
- **False-positive patterns** — signal shapes that look like a finding but are WAF behavior, cache differences, or rate-limit artifacts; save validators from re-investigating.
- **CVSS scoring templates** — vector strings for common finding shapes as a starting point; always adjust for business context.
- **Destructive payloads to avoid** — class-by-class list of payloads that look demonstrative but produce side-effects; prefer safer alternatives.
- **Target-specific reproduction quirks** — session handling, cookie names, CSRF token flows, etc. that recur on repeat engagements.

(Empty on first run.)
