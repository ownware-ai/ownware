---
name: verify
description: Verify a change by running the actual flow it touches. Build, run, drive to the surface where the change executes, capture evidence. Distinct from /review (correctness reading) and the verifier helper (adversarial test runs).
trigger: /verify
allowedTools:
  - shell_execute
  - readFile
  - glob
  - grep
  - browser_navigate
  - browser_screenshot
  - browser_snapshot
  - browser_click
  - browser_type
  - web_fetch
---

# Verify — runtime observation, not code review

Verification is **what happens when you actually run the thing**. The diff tells you what the author intended; the running app tells you what users will see. Your job is to drive the surface that the change reaches and capture what it does.

## What this skill is NOT

- Not running the test suite. CI ran tests before you got here. Re-running them proves you can run CI; it doesn't verify the change.
- Not running the typechecker. Same logic.
- Not import-and-call (`import { foo } from './src/...'; console.log(foo(x))`). That's a unit test you wrote. The function did what it does — you knew that from reading. The app never ran. Whatever calls `foo` in the real codebase ends at a CLI command, an HTTP route, or a window. Go there.
- Not reading the code and reporting "looks correct." That's `/review`, not `/verify`.

## Step 1 — Find the change

Establish the full range, not just the latest commit:

- `git log --oneline @{u}..HEAD` — count commits on this branch.
- `git diff @{u}.. --stat` — files touched.
- `git diff @{u}..` — the full diff. If huge, redirect to a temp file (`git diff @{u}.. > /tmp/diff.patch`) and `readFile` it.
- For a PR (`/verify 123`): `gh pr view 123` and `gh pr diff 123`.

State the commit count in your report. **The diff is ground truth.** The PR description is a claim about it; if description and diff disagree, that's already a finding.

## Step 2 — Identify the surface

The surface is where a real user — human or programmatic — meets the change. That's the thing you observe.

| Change reaches | Surface | What you do |
|---|---|---|
| CLI / TUI | terminal | type the command, capture stdout + exit code |
| Server / API | HTTP socket | send the request, capture status + response body |
| GUI | pixels | drive via browser tools, screenshot, read the DOM |
| Library / package | public export | sample code through `import pkg`, NOT `import './src/...'` |
| Prompt / agent config | the agent itself | run a prompt through it, capture behavior |
| CI workflow | GitHub Actions | dispatch it, read the run |

**Internal function with no surface?** Not verifiable in isolation — find the CLI command, HTTP route, or render path that reaches it, and verify there. The surface of an auth check isn't its return value; it's the login screen prompting or letting you in.

**No runtime surface at all** — docs-only diff, type-only declarations with no emit, build config with no behavior change — report `SKIP` with one-line reason. Don't run tests to fill the space.

## Step 3 — Get a handle on the app

Smallest path that gets the changed code to actually execute:

- Changed a flag? Run with that flag.
- Changed a handler? Hit that route with `curl` / `fetch`.
- Changed an error path? Trigger the error condition.
- Changed a UI component? Open the dev server, navigate to the page that renders it.

If the repo has a project-specific verifier setup (a `Makefile` target, a `bun verify` script, a `.ownware/skills/verifier-*` entry), use it — it's the path the project owner already wired. Otherwise cold-start from `README` / `package.json` / `Makefile`. Timebox ~15 min on cold-start; if you can't get the app running, report `BLOCKED` with exactly where it failed.

## Step 4 — Drive the happy path

Run the thing. Type the command. Send the request. Click the button. Capture what came back.

This step alone is **half the job**. If you stop here you've confirmed the claim — that's PASS material — but you've replayed the author's own happy path. The real value is what comes next.

## Step 5 — Probe around the change

The diff told you what's new. Try to break it at the same surface:

- New flag? Pass an empty value, pass it twice, combine with a conflicting flag, typo it (does the error name what was wrong?).
- New handler / route? Wrong HTTP method, malformed body, missing required field, oversized payload.
- Changed error path? The adjacent errors the refactor didn't touch — did they survive?
- Interactive flow / TUI? Ctrl-C mid-op, paste garbage, hammer the key, Esc at the wrong moment.
- State / persistence? Do the action twice. Do it with stale state underneath. Do it from two sessions at once.

These aren't a checklist — pick the probes the diff points at. **At least one probe before you issue PASS.** A Steps list with all ✅ and no 🔍 is a happy-path replay; it's still PASS, but you stopped halfway.

## Step 6 — Capture evidence

Stdout, response bodies, screenshots, pane dumps. Captured output is evidence; your memory isn't. If something was unexpected, capture it BEFORE deciding whether to investigate or move on.

For UI: screenshots go to a file path you can reference; for CLI: paste the output block; for API: paste the response body and status. If captured output mentions something unrelated that looks broken, that's a finding — not noise.

## Step 7 — Report

Use this exact shape:

```
## Verification: <one-line description of the change>

**Verdict:** PASS | FAIL | BLOCKED | SKIP

**Claim:** <what the change is supposed to do — your read of the diff and/or the stated PR claim. Note any mismatch between the two.>

**Method:** <how you got the app running — which command/skill/setup. One or two sentences.>

### Steps

1. ✅/❌/⚠️/🔍 <what you did> → <what you observed>
   <evidence: command output, response body, screenshot path>

2. ...

### Findings

<Things worth flagging. Not just bugs — friction, surprises, anything a first-time user would trip on. Lead with ⚠️ for items worth interrupting the reviewer for. Plain bullets are softer notes.>
```

**Verdicts:**

- **PASS** — you ran the app, the change did what it should at its surface, and you probed around it without breaking anything important.
- **FAIL** — you ran it and it doesn't work, OR it broke something adjacent, OR claim and diff disagree materially.
- **BLOCKED** — you couldn't reach a state where the change is observable. Build broke, env missing a dep, server wouldn't come up. Not a verdict on the change itself — describe exactly where it stopped.
- **SKIP** — no runtime surface exists. Docs-only, types-only, tests-only diff. One-line reason.

No "partial pass." "3 of 4 worked" is FAIL until 4 worked or the 4th is explained away. **When in doubt, FAIL.** A false PASS ships broken work; a false FAIL costs one extra human look.

## Distinct from /review and the verifier helper

- `/review` reads the code and judges correctness, conventions, tests. Static.
- The verifier helper (spawned via `agent_spawn`) is adversarial — runs the test suite, probes edge cases, returns `VERDICT: PASS | FAIL | PARTIAL`. Its evidence is test output and tool runs.
- `/verify` is **the user driving the actual app**. The evidence is observed behavior at the surface a real user touches.

If you're unsure which to invoke: did the user say "review my changes"? → `/review`. "Did the tests pass?" → spawn the verifier helper. "Did this actually work when you tried it?" → `/verify`.
