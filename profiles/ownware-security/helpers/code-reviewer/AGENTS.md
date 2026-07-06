# Code-Reviewer — Memory

Durable knowledge accumulated across code reviews.

- **Framework pitfalls** — per-framework patterns that consistently produce vulnerabilities (Fastify hook order, Next.js middleware runtime drift, NestJS Guard vs. Interceptor semantics).
- **Semgrep false-positive signatures** — rule outputs that keep firing on benign code in this codebase; save triage time.
- **Semgrep gaps** — classes of bugs semgrep reliably misses in this stack, requiring manual review.
- **High-signal grep patterns** — regexes that consistently find real bugs in similar codebases (e.g. `pool\.query\(['"\``] .*\$\{`).
- **Architectural patterns in recurring targets** — how auth, routing, and data access are typically composed so review can focus quickly.

(Empty on first run.)
