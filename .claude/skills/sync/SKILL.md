---
name: sync
description: Use when your branch is behind main or before shipping. Rebases the current branch on origin/main and runs checks.
disable-model-invocation: true
---

# sync

## Rules for this skill
- Start with `git status`. If the tree has uncommitted changes this skill did not expect, stop and ask.
- Before running each git or gh command, print it with a one-line plain-English explanation.
- If `gh` is missing or not authenticated (`gh auth status`), say so and give the manual fallback instead of failing silently.
- End with a 3-line summary: what happened, current branch, next suggested command.

## Steps
1. If there are uncommitted changes, ask: commit as `wip:` or stash.
2. `git fetch origin`, then `git rebase origin/main` (replays your commits on top of the latest main).
3. On conflict, list conflicted files. If every file is inside this issue's slice and not a hotspot, resolve, show the resolution diff, then `git rebase --continue`. Otherwise run `git rebase --abort`, explain which files and whose slice they likely belong to, and stop.
4. Run checks for touched areas (see AGENTS.md section 4).
5. If the branch was already pushed, run `git push --force-with-lease`. Explain why: a rebase rewrites commits, so a normal push is rejected. `--force-with-lease` only overwrites if nobody else pushed to your branch. Never on someone else's branch.
