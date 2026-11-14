---
name: handoff
description: Use before sleeping, switching tasks, or switching to a different AI tool. Saves work, posts a resume-cold comment, and updates STATUS.
disable-model-invocation: true
---

# handoff

## Rules for this skill
- Start with `git status`. If the tree has uncommitted changes this skill did not expect, stop and ask.
- Before running each git or gh command, print it with a one-line plain-English explanation.
- If `gh` is missing or not authenticated (`gh auth status`), say so and give the manual fallback instead of failing silently.
- End with a 3-line summary: what happened, current branch, next suggested command.

Note: uncommitted changes are expected here (they are the work in progress).

## Steps
1. Commit work in progress as `wip: <what>` and `git push` the branch.
2. Post an issue comment with: **Done**, **Next** (a concrete first step), **Blocked**, **How to run what exists**, **Gotchas**. Write it so a different agent or teammate can resume cold.
3. `python scripts/update_status.py --member <name> --state away` (or `blocked`) with `--next` and `--blocked` filled.

Manual fallback without gh: post the comment on the issue in the browser, edit STATUS.md on main.
