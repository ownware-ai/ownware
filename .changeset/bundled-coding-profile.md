---
"@ownware/cortex": minor
---

Add the two core (auto-loaded) builtin profiles to the bundled `profiles/`
dir. `ownware` is the default assistant ("Ari", `openai:gpt-5.5`, scout/
researcher/general helpers, 8 everyday skills). `ownware-code` is a
full-stack coding agent with read/write/edit/search/shell tools, four helper
subagents (explore, planner, verifier, general), and ten skills (plan, review,
commit, create-pr, verify, debug-agent, security-review, simplify, stuck,
init). `profiles/BUILTINS.json` now classifies it as core; the helper profiles
live nested under the parent's `helpers/` folder per the manifest convention.
