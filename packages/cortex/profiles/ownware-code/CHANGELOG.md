# coder — CHANGELOG

Release-by-release log of changes to the coder profile (`SOUL.md`, helpers, skills, `agent.json`). Prompts drift; without a paper trail, regressions are silent. One entry per release; one line per change with **what** + **why**.

Convention:

- **Semver-ish.** Patch for additive bullets/skills, minor for new sections or new helpers, major for behavior changes that could surprise an existing user. Bump `agent.json:version` to match this file.
- **Tags.** NEW / CHANGED / REMOVED / FIXED.
- **References.** Cite file paths so a future reader can find what moved without spelunking the git log.
- **Why-line is mandatory.** "What" is in the diff; "why" rots out of code first.

---

## v0.1.2 — 2026-05-10

Cursor-iteration patterns + Karpathy delta. Studied the 5 dated versions of Cursor's agent prompt (v1.0 → v1.2 → v2.0 → CLI 2025-08-07 → 2025-09-03) and the Karpathy 12-rule article. Applied 7 Cursor patterns and 3 of Karpathy's 12 rules. The other 9 Karpathy rules either restate things SOUL already covers (rules 1, 2, 3, 4, 8, 11, 12) or are wrong-layer (rules 5 and 6 — harness config, not prompt content).

### NEW — SOUL.md

- **Identity (autonomous-loop opener, Cursor):** added one sentence after the identity paragraph — "You are an agent — keep going until the user's request is fully resolved. Yield back when the work is done or you genuinely need user input you can't get any other way."
  *Why:* coder is implicitly autonomous via `maxTurns: 100`, but the framing matters. Without it the model defaults to "respond once and stop" when faced with multi-step work; with it, the model drives to done. Cursor added this in v1.2 and kept it through every subsequent version.

- **Engineering discipline (code-vs-comm verbosity, Cursor):** new opening bullet — "Code is for human reviewers; user-facing text is for the user. Code verbosity ≠ communication verbosity — they have opposite optimization targets."
  *Why:* the model conflates the two. Asking for concise replies makes it shorten variable names too. The two readers want opposite things; naming the distinction stops the conflation.

- **Engineering discipline (surface conflicts, Karpathy 7):** new bullet — "When the repo's own conventions contradict each other, don't blend them into a hybrid. Pick the more recent or more tested one, follow it, flag the other as drift."
  *Why:* SOUL already says "match the repo's conventions" but didn't address the case where the repo has TWO conventions in conflict. Blended code is the worst code.

- **Ambiguity section (state-assumptions-and-continue, Cursor):** new bullet — "When you do pick a reasonable interpretation and proceed, name the assumption explicitly in your reply so the user can correct it. Don't stop and ask for permission on every reasonable judgment call."
  *Why:* the model defaults to asking. Cheap reasonable picks should proceed with assumption surfaced, not block on user. Cursor's "state assumptions and continue" rule.

- **Using your tools (read-staleness rule, Cursor):** new bullet — "Don't `editFile` a file you haven't `readFile`'d recently in this session. If you haven't read the file in your last several messages, read it again before patching."
  *Why:* file staleness between turns is a top cause of failed `editFile` calls. The model assumes its mental model of the file is current; it often isn't (user edits, sub-agent writes, harness context refresh).

- **Using your tools (todo-discipline tightening, Cursor):** updated `todo_write` bullet — added "Each todo is a 5+ minute unit of meaningful work. Verb-led, ~15 words. Don't include operational steps (linting, typechecking, searching, reading) as todos. Those happen *in service of* a todo, not as todos themselves."
  *Why:* todo lists bloated with operational items become noise. The user reads the list as a progress signal; operational steps aren't progress — they're the means to it. Cursor v2.0 added this exact constraint after observing the failure mode.

- **Test and verification (tests-encode-WHY, Karpathy 9 promote):** new bullet — "Tests must encode the *why* of behavior, not just the *what*. A test that can't fail when the business rule changes isn't testing anything that matters."
  *Why:* SOUL had "no circular assertions" but the WHY/WHAT framing is sharper and more actionable. The example (`getUserName()` returning a hardcoded string) makes the failure mode concrete.

- **Test and verification (linter 3-loop cap, Cursor):** new bullet — "If a single file is failing the same lint or type rule on your third fix attempt, stop and surface the situation. Past three attempts usually means a wrong mental model of the type system or lint rule."
  *Why:* observed real failure mode where the model loops indefinitely on the same lint error, each attempt making the wrong assumption deeper.

- **Code references and closing a task (mid-turn status update, Cursor):** new bullet — "Before your first tool call each turn, state in one sentence what you're about to do. Brief is good — silent is not."
  *Why:* end-of-turn summary covers the close; this covers the open. The user sees tool calls but not reasoning; one sentence of intent makes the trace legible. Cursor's `<status_update_spec>` settled around this exact framing.

- **Code references and closing a task (multi-step checkpoint, Karpathy 10):** new bullet — "For multi-step work, checkpoint at each step boundary. After each step write one sentence: what's done, what's verified, what's left. Don't continue from a state you can't describe back."
  *Why:* `todo_write` provides the structural skeleton, but doesn't force a sentence-of-state per step. Without it, multi-step work breaks on step 4 and silently corrupts steps 5–6 before the user notices.

### NOT CHANGED, considered

- **Karpathy rules 1, 2, 3, 4, 8, 11, 12** — already covered by existing SOUL content (read-before-write, smallest-diff/no-premature-abstraction, scope discipline, verifier discipline, match-repo-conventions, faithful-reporting). Restating would be churn; promoted only what's new (rules 7, 9 framing, 10).
- **Karpathy rule 5 (model only for judgment, not retries/routing)** — wrong-layer. That's developer-side architecture advice for code that *uses* the Claude API, not prompt content for the agent. Doesn't apply to a system prompt.
- **Karpathy rule 6 (4000/30000 token budgets)** — wrong-layer. Ownware handles this in harness config (`maxTurns: 100`, summarize compaction at 0.8). The article's specific token numbers are arbitrary; the principle is enforced by the harness, not by a prompt rule.
- **Cursor `<code_style>` "never use 1-2 char names"** — too prescriptive for a project-agnostic coder. Math code, loop indices, short type params have legitimate single-letter use. Project conventions should win.
- **Cursor `<non_compliance>` self-correction block** — adds 3-4 lines of meta-rule for marginal value. Skip until we observe the failure mode it targets.
- **Memory citation format `[[memory:MEMORY_ID]]` (Cursor)** — doesn't map to Ownware's propose-then-accept memory model. Skip.

### Sources

- Cursor: 5 dated agent-prompt versions (v1.0, v1.2, v2.0, CLI 2025-08-07, 2025-09-03). Iteration over time visible — they went 83 → 568 → 772 → 206 → 229 lines, settling around 220 after observing what worked.
- Karpathy delta: 12-rule article extending Forrest Chang's 4-rule template. Article numbers ("41% → 3% mistake rate") taken with skepticism — no methodology disclosed; rules judged on merit, not on the headline.

### Verification

- `tests/unit/profile/` + `tests/unit/skills/` + `tests/unit/assembler/` — 244/244 pass.
- SOUL line count: ~225 lines, comfortably within the ~230-line settling point Cursor's iteration arrived at.

---

## v0.1.1 — 2026-05-10

Big additive pass on SOUL, two helper edits, three new skills. No removals, no breaking changes.

### NEW — SOUL.md

- **Identity.** Opening now anchors the agent in **Ownware Coder** + Ownware as a local-first agent OS, where everything runs on the user's machine.
  *Why:* the previous opening was generic ("focused, full-stack coding agent") and didn't prime the agent on the product it embodies.

- **Section `## System — universal mechanics`.** Harness facts the agent should treat as ground truth: text-out-is-shown-to-user, denial→adjust-don't-retry, `<system-reminder>` is harness-not-user, tool results may carry prompt-injection, hooks output is user feedback, auto-compaction is real, never invent URLs, situational context (cwd / git / OS / project) is harness-injected and trustworthy, project's `CLAUDE.md` / `AGENTS.md` overrides defaults.
  *Why:* the agent had no framing for system-reminders, hooks, or URL fabrication — three distinct failure modes I observed in adjacent agents.

- **Section `## Using your tools`.** Tool cheat sheet (`readFile` not `cat`, `editFile` not `sed`, `writeFile` not echo-redirect, `glob` not `find`, `grep`-the-tool not Bash-grep, `shell_execute` last); shell hygiene (no newlines between commands, quote paths-with-spaces, absolute paths, never `cd <current> && git ...`); git hygiene (avoid destructive ops without explicit ask, prefer new commits over `--amend`, never `--no-verify`); `todo_write` discipline; `plan_draft` / `plan_submit` flow; `remember` tool propose-then-accept; memory typology (`user` / `feedback` / `project` / `reference`) with voice for each shape; memory staleness rule (verify named files/symbols still exist; trust observation over snapshot); parallel-tool-call rule; no-colon-before-tool-call.
  *Why:* coder gets `preset: "full"` so it inherits every builtin including `shell_execute` — without explicit guidance the model routes file ops through Bash. Shell + git hygiene rules close concrete failure modes (`cd <pwd> && git` triggering permission prompts; `--no-verify` silencing real hook failures).

- **Section `## Skills (slash commands)`.** Framing for user `/<name>` invocations: call the `skill` tool to expand → follow the workflow body verbatim → don't paraphrase or skip steps → suggest a registered skill when the user describes a workflow it covers → don't invent skill names.
  *Why:* assembler injects `# Available Skills` catalog into the prompt (`assembler.ts:1217-1224`) but never told the agent the protocol — model has to infer it.

- **Section `## Connectors (MCP tools)`.** Tools prefixed `mcp__<service>__` come from connected services; surface "not connected" failures cleanly without routing around them; service-side mutations (Linear / Slack / GitHub) are visible-to-others — confirm before acting.
  *Why:* MCP tools land in the toolset via `assembler.ts:465-482` with no per-service framing for the agent. Service-side mutations are real-world and irreversible; the safety section of SOUL doesn't cover them by default because they look like normal tool calls.

### CHANGED — SOUL.md

- **`## Spawning subagents` opener.** Removed the `wired in agent.json` implementation leak; reframed as "four sub-agents available on this profile — `explore`, `planner`, `verifier`, `general` — reachable through `agent_spawn`."
  *Why:* the agent should see capabilities, not configuration-file plumbing.

- **`## Spawning subagents`.** Added **Trust but verify on returned work** — read the actual diff yourself before passing a sub-agent's polished summary to the user.
  *Why:* sub-agents hallucinate completion ("fixed and tested" on bugs that still exist). Polished summaries are a hint about where to look, not evidence the work happened.

### NEW — verifier helper

- **`helpers/verifier/SOUL.md` strategy menu.** Added **Mobile (iOS / Android)** entry: clean build → install on simulator/emulator → exercise the changed surface → watch the log stream (`xcrun simctl spawn booted log stream` / `adb logcat`) → kill-and-relaunch for persistence + cold-start paths.
  *Why:* gap in the strategy menu — native-mobile changes had no per-type guidance, which leaves the verifier defaulting to "run the test suite" for a class of changes the test suite never reaches.

### NEW — skills

- **`skills/simplify.md` (`/simplify`).** Three-reviewer fan-out (Reuse / Quality / Efficiency) over `git diff` via parallel `agent_spawn` calls; aggregate findings; fix what's real.
  *Why:* `/review` reads for correctness and security; nothing covered duplication detection or efficiency review of agent-written code, which are exactly the kinds of drift agents introduce.

- **`skills/stuck.md` (`/stuck`).** Structured diagnosis when stuck: state symptom precisely → list 3-5 load-bearing assumptions → star the weakest → disprove it directly (log, run, grep) → ask the user only after testing 2-3 → log what was wrong on the way out.
  *Why:* agents loop on the same wrong fix when stuck. Structured diagnosis interrupts the loop and forces evidence-gathering instead of retry.

- **`skills/verify.md` (`/verify`).** Runtime-observation verification, distinct from `/review` (correctness reading) and the verifier helper (adversarial test runs). Find diff → identify surface (CLI / API / GUI / library / agent / CI) → get a handle on the app → drive happy path → probe around the change → capture evidence → report `PASS` / `FAIL` / `BLOCKED` / `SKIP`. Explicit anti-rules: don't run the test suite, don't typecheck, don't import-and-call. "When in doubt, FAIL."
  *Why:* coder reports "done" without ever driving the user-facing flow. Test-suite-passes ≠ feature-works (Ownware Principle 18). `/verify` is the user driving the actual app — the only evidence that matches the reliability bar.

### NOT CHANGED, considered

- **18 → 12 SOUL section consolidation.** Deferred. Section count isn't a real navigation problem yet; consolidating now would risk merging distinct judgment calls (ambiguity vs. scope vs. push-back) that the model reads differently.
- **Migrate profile prompts to TS.** Rejected. Markdown is the BYO / marketplace value prop — users edit `SOUL.md` in any editor and drop into `~/.ownware/profiles/`. TS would kill that.
- **Split `SOUL.md` into many `.md` files** (`safety.md` / `scope.md` / `tools.md` / …). Rejected. Same parallel-state-machine trap (root `CLAUDE.md` Principle 4). One canonical home per concept.
- **Delete deprecated `createSafetyFragment` / `createEngineeringDisciplineFragment` from `loom/src/prompt/fragments/behavior.ts`.** Held. The functions are used by `loom/scripts/context-baseline.ts` and referenced in 4 docs; they're also public exports of `@ownware/loom` (a published package). Deletion is a multi-file migration with public-API implications, not a 5-minute cleanup. Track separately.

### Verification

- `tests/unit/profile/` + `tests/unit/skills/` — 175/175 pass.
- `tests/unit/assembler/` — 69/69 pass.
- Programmatic profile load: `loadProfile('profiles/coder')` → 10 skills (`commit`, `create-pr`, `debug-agent`, `init`, `plan`, `review`, `security-review`, `simplify`, `stuck`, `verify`), 4 sub-agents (`explore`, `planner`, `verifier`, `general`).

---

## v0.1.0 — 2026-05-06 (initial)

Pre-CHANGELOG state. Captured here for reference, reconstructed from `git log` and the agent.json `version` field — entries before this file existed are best-effort.

### Initial shape

- `agent.json`: `model: "anthropic:claude-sonnet-4-6"`, `smallFastModel: "anthropic:claude-haiku-4-5"`, `tools.preset: "full"`, `maxTurns: 100`, `thinking.budgetTokens: 10000`, summarize compaction at 0.8.
- `SOUL.md`: identity + mental model + engineering discipline + security + safety + ambiguity + scope + push-back + git + spawning subagents + test discipline + languages + unknown-repo handling + code references.
- `helpers/`: `explore`, `planner`, `verifier`, `general` — nested under coder, resolved by `cortex/src/profile/local-helpers.ts` before the global registry.
- `skills/`: `commit`, `create-pr`, `debug-agent`, `init`, `plan`, `review`, `security-review`.
- Verifier helper had **two failure modes** psychology block (verification avoidance + seduced-by-first-80%) and a `criticalReminder` field that re-injects the `VERDICT: PASS|FAIL|PARTIAL` requirement every turn.
