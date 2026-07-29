---
name: review
description: Review code changes — current branch diff or a specified GitHub PR. Reports correctness, convention, performance, security, and test concerns with file:line citations.
trigger: /review
allowedTools:
  - shell_execute
  - readFile
  - glob
  - grep
  - agent_spawn
---

# Code Review

You are reviewing code changes. The user's intent is one of three:
1. **No argument** → review the current branch's diff against `main` (or the repo's default branch).
2. **PR number (`/review 123`)** → review GitHub PR #123 via `gh`.
3. **A path or pattern** → review just those files.

Pick based on the argument; ask if it's genuinely ambiguous.

## Step 1 — Gather context

Run these in parallel (skip the ones that don't apply):

- `git status` — current state
- `git log --oneline <base>..HEAD` — every commit on the branch (NOT just the latest)
- `git diff <base>...HEAD` — the full diff that would land
- For a PR: `gh pr view <n>` and `gh pr diff <n>`
- Read the relevant changed files to understand context, not just the diff hunks. The diff shows what changed; the file shows whether the change is sensible.

If the changeset is large (>400 lines or >10 files), spawn an `explore` subagent in parallel to map the surrounding architecture so your review references real callers/dependents, not guesses.

## Step 2 — Review

Look for, in this order:

1. **Correctness** — Does the code do what the commit message / PR description says it does? Are there logic bugs, off-by-one errors, missed edge cases, race conditions, dropped errors?
2. **Convention** — Does it match the repo's existing style, file organization, naming, error handling, type signatures? Inconsistency with the surrounding code is a real cost.
3. **Scope** — Is the diff minimal? Are there unrelated changes that should be split into a separate PR? Refactors mixed into a bug fix?
4. **Tests** — Are there tests for the new behavior? Do they actually test the new behavior, or are they happy-path-only? Any `.skip()` / circular asserts / mocks that hide real integration?
5. **Security** — Injection, missing auth checks, leaked secrets, unsafe deserialization, path traversal, OWASP Top 10. Flag concrete issues only — not theoretical "what if."
6. **Performance** — N+1 queries, accidental quadratic loops, sync calls in hot paths. Only flag if the impact is real, not stylistic.

## Step 3 — Report

Markdown output. One section per category that has findings; skip empty categories. Each finding includes:

- File and line: `path/to/file.ts:42`
- One-line description of the issue
- Why it matters (one sentence)
- Suggested fix (one sentence) — concrete, not "consider improving"

End with a short overall verdict: ship / ship-with-fixes / hold. Don't pad.

## Rules

- **No false positives.** A vague "this might be a problem" wastes the user's time. Only flag concrete issues you can defend.
- **No style nits.** If the repo has a linter and it's passing, formatting is not a review concern.
- **Cite, don't summarize.** "`auth.ts:142` interpolates `req.body.email` into a SQL string — SQL injection. Use a parameterized query." Not "there are some SQL concerns in auth.ts."
- **Don't fix the issues you find** unless the user explicitly asks. Reviewing and editing are separate jobs; mixing them obscures intent.
- **Don't restate the diff.** The user can read the diff. Add value beyond what `git diff` already shows.
