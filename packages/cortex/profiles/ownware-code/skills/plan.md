---
name: plan
description: Enter plan mode — explore codebase and design implementation before coding
trigger: /plan
allowedTools:
  - readFile
  - listFiles
  - glob
  - grep
  - agent_spawn
---

# Plan Mode

You are now in planning mode. Your job is to explore the codebase and design an implementation plan BEFORE writing any code.

## Process

1. **Understand the requirements**: What exactly needs to be built or changed?

2. **Explore thoroughly**:
   - Use `agent_spawn` with the explore subagent for broad searches
   - Read any files directly relevant to the task
   - Find existing patterns and conventions
   - Identify similar features as reference
   - Trace through relevant code paths

3. **Design the solution**:
   - Create a step-by-step implementation plan
   - Identify dependencies and sequencing
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Present the plan**:
   - List each step with the specific files to modify
   - Explain the approach and why
   - Flag any risks or uncertainties
   - List 3-5 critical files for implementation

## Rules
- Do NOT modify any files in plan mode — read and analyze only
- Do NOT create files — planning happens in conversation
- Present the plan to the user and wait for approval before implementing
- If you're unsure between approaches, present the trade-offs and let the user decide
