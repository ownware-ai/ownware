---
name: simplify
description: Review your recent changes for reuse, quality, and efficiency, then fix what you find. Fans out three review agents in parallel against the diff.
trigger: /simplify
allowedTools:
  - shell_execute
  - readFile
  - editFile
  - writeFile
  - glob
  - grep
  - agent_spawn
---

# Simplify — review your own changes before declaring done

You just finished a piece of work. Before reporting it complete, **review it** the way a senior engineer would on a PR — but with three angles in parallel.

## Step 1 — Get the diff

Run `git diff` (or `git diff HEAD` when there are staged changes). If nothing is in the diff, fall back to the files you edited earlier in this conversation.

If the diff is more than ~500 lines, write a one-line "what this change does" framing so the reviewers can ground their work — they each get the full diff, but a brief intent note helps them flag drift vs. on-target additions.

## Step 2 — Fan out three reviewers

Use `agent_spawn` to launch three sub-agents **in the same response** (parallel calls). Pass the full diff plus the intent framing to each.

Use `general` for reviewers that may need to read other files; use `explore` for the reuse-finder if you only want it to search and read.

### Reviewer A — Reuse

For every new function, hook, type, util, or component in the diff:

1. Search the codebase for an existing helper that already does this. Common locations: `lib/`, `utils/`, `shared/`, files adjacent to the changed ones, sibling packages.
2. Flag any new code that duplicates existing functionality — name the existing symbol with `file_path:line_number`.
3. Flag inline logic that should call an existing util — hand-rolled string mangling, manual path joining, ad-hoc env checks, custom type guards.

### Reviewer B — Quality

Walk the same diff for sharp-edge patterns:

- Redundant state — state that duplicates other state, derivable values cached as fields, effects that could be direct calls.
- Parameter sprawl — adding a fifth boolean to a function instead of restructuring.
- Near-duplicate code blocks that should share an abstraction.
- Leaky abstractions exposing internals other modules now depend on.
- Stringly-typed code where a const, enum, or branded type already exists.
- Comments that explain WHAT instead of WHY, narrate the change, or reference the task. Delete; keep only non-obvious WHY.
- Defensive `try`/`catch` around scenarios that can't happen, validation in the middle of a chain that already validated upstream.

### Reviewer C — Efficiency

Walk the same diff for waste:

- Redundant work — re-reading the same file, repeated network calls, N+1 patterns.
- Independent operations run sequentially that could run in parallel.
- Hot-path bloat — new blocking work added to startup, render, or per-request paths.
- Unbounded data structures, missed cleanup, listener leaks.
- Reading whole files when only a section is needed; loading all rows when filtering for one.
- Existence pre-checks before operating (TOCTOU smell) — operate directly and handle the error.

## Step 3 — Aggregate and fix

When all three reviewers return, merge their findings. **Fix what's real.** For each finding:

- Solid → fix it directly.
- False positive or out of scope → note one line and skip.

Do not argue with reviewers in the response. They saw the diff cold; if they were wrong, that's information about how the change reads to a fresh reader, not a reason to defend it.

## Step 4 — Report

One short summary: what was fixed, what was already clean, what was deferred and why. End there.
