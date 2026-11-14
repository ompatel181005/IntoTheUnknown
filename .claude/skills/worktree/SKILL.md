---
name: worktree
description: Use to run several agents in parallel on separate issues. Adds, lists, or removes git worktrees.
argument-hint: add <issue-number> | list | remove <branch>
disable-model-invocation: true
---

# worktree

Rule: one issue per worktree, one agent per worktree.

## Rules for this skill
- Start with `git status`. If the tree has uncommitted changes this skill did not expect, stop and ask.
- Before running each git or gh command, print it with a one-line plain-English explanation.
- If `gh` is missing or not authenticated (`gh auth status`), say so and give the manual fallback instead of failing silently.
- End with a 3-line summary: what happened, current branch, next suggested command.

## add <issue-number>
1. `git fetch origin`.
2. `git worktree add ../<repo>-<branch> -b <branch> origin/main` (a second checkout of the repo in a sibling folder, on a new branch from main).
3. Copy `.env` into it if present.
4. Print next steps: install dependencies in that folder, run one agent there, use a unique backend port (8000 + worktree index).

## list
`git worktree list`, plus the issue for each branch (`gh issue view <n>`).

## remove <branch>
1. Refuse if the branch has unmerged commits: show them with `git log origin/main..<branch>`.
2. Otherwise `git worktree remove <path>` and `git branch -d <branch>`.
