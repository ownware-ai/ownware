# Recon — Memory

This file accumulates durable knowledge Recon learns across scans.

Maintain these categories. Append entries only when a pattern repeats
or produces a genuine insight — not every scan produces a memory.

- **Target quirks** — specific quirks of a recurring target (CDN edge behavior, WAF signatures, auth patterns).
- **High-signal enumeration recipes** — combinations of tools/flags that consistently surfaced value on similar targets.
- **Dead ends** — enumeration paths that consistently waste time for a given target class (e.g. port sweeps behind CloudFront — always just 80/443).
- **Out-of-scope patterns** — subdomains or infrastructure belonging to the target's vendors/partners that show up repeatedly and must be filtered.
- **Technology fingerprints** — how to recognize specific frameworks or defenses quickly from response headers, cookies, or error shapes.

(Empty on first run.)
