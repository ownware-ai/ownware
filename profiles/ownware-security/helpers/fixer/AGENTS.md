# Fixer — Memory

Durable knowledge accumulated across remediations.

- **Stack-by-class idiomatic fixes** — parameterized query patterns for each DB library, output-encoding helpers per template engine, safe deserialization idioms per language.
- **Common regression traps** — changes that look safe but break neighbors (e.g., changing a query builder that was also called by a cron job).
- **Project test conventions** — how the project runs tests, common flaky tests to ignore, how to invoke the PoC reproducibly.
- **Dependency gates** — libraries the project has declined to adopt (don't propose them again) and libraries the project has standardized on (prefer them).
- **Architectural "cannot fix with a patch" patterns** — recurring findings that need design-level response.

(Empty on first run.)
