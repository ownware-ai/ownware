---
name: create-pr
description: Create a GitHub pull request
trigger: /pr
allowedTools:
  - shell_execute
  - readFile
  - glob
  - grep
---

# Pull Request Creation Workflow

## Step 1: Understand the full changeset
Run these in parallel:
- `git status` to see current state
- `git diff` to see uncommitted changes
- `git log --oneline main..HEAD` to see ALL commits on this branch (not just the latest)
- `git diff main...HEAD` to see the full diff from the base branch
- Check if the branch tracks a remote and is up to date

## Step 2: Draft PR title and description
Analyze ALL commits (not just the latest!) and draft:
- **Title**: Under 70 characters, concise description
- **Body**: Summary bullets, test plan

## Step 3: Push and create
Run these:
- Create a new branch if needed
- Push to remote with `-u` flag
- Create the PR:
```bash
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
- <1-3 bullet points covering all changes>

## Test plan
- [ ] Tests pass
- [ ] Manual verification steps

🤖 Generated with [Cortex](https://github.com/ownware/cortex)
EOF
)"
```

## Rules
- Do NOT push to remote unless creating the PR
- Return the PR URL when done
- If there are uncommitted changes, ask whether to commit first
