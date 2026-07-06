---
name: commit
description: Create a git commit with proper workflow
trigger: /commit
allowedTools:
  - shell_execute
  - readFile
  - glob
  - grep
---

# Git Commit Workflow

Follow these steps carefully to create a commit:

## Step 1: Understand the changes
Run these in parallel:
- `git status` to see all modified and untracked files (never use -uall flag)
- `git diff` to see staged and unstaged changes
- `git log --oneline -5` to see recent commit messages and match the style

## Step 2: Draft commit message
Analyze ALL changes (staged + unstaged) and draft a message:
- Summarize the nature of the changes (new feature, bug fix, refactoring, docs, etc.)
- Use the correct verb: "add" for new features, "update" for enhancements, "fix" for bugs
- Keep it to 1-2 concise sentences focusing on the "why" not the "what"
- Do NOT commit files that likely contain secrets (.env, credentials.json, etc.)

## Step 3: Stage and commit
- Stage relevant files by specific name (prefer `git add file1 file2` over `git add -A`)
- Create the commit using a HEREDOC for the message:
```bash
git commit -m "$(cat <<'EOF'
Your commit message here.

Co-Authored-By: Cortex <noreply@ownware.dev>
EOF
)"
```
- Run `git status` after the commit to verify success

## Git Safety Rules
- NEVER amend an existing commit unless explicitly asked — create a NEW commit
- NEVER skip hooks (--no-verify) unless explicitly asked
- NEVER force push unless explicitly asked
- If a pre-commit hook fails, fix the issue and create a NEW commit
- Do NOT push to remote unless explicitly asked
- If there are no changes to commit, say so — don't create an empty commit
