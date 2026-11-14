---
name: start-task
description: Use when beginning work on a GitHub issue. Claims the issue, branches from fresh main, drafts a plan, and updates STATUS.md.
argument-hint: <issue-number>
---

# start-task

## Rules for this skill
- Start with `git status`. If the tree has uncommitted changes this skill did not expect, stop and ask.
- Before running each git or gh command, print it with a one-line plain-English explanation.
- If `gh` is missing or not authenticated (`gh auth status`), say so and give the manual fallback instead of failing silently.
- End with a 3-line summary: what happened, current branch, next suggested command.

## Steps
1. `gh issue view $ARGUMENTS`. If the issue has another assignee, stop and ask.
2. `git fetch origin`, `git switch main`, `git pull --ff-only`.
3. Create `feat/<n>-<slug>` (or `fix/<n>-<slug>` if the issue is labeled bug). Slug from the issue title, max 5 words.
4. `gh issue edit <n> --add-assignee @me`.
5. Read root AGENTS.md, the relevant nested AGENTS.md, and docs/DECISIONS.md. Draft a plan: files to touch, approach in 3-5 lines, which acceptance criteria it covers, and any hotspot files (flag them). Show the plan. After the human approves, post it as an issue comment with `gh issue comment <n> --body-file -`.
6. `python scripts/update_status.py --member <name> --issue <n> --branch <branch> --state building --next "<first step>"`. Ask for the member name once, then read it from `git config user.name`.

Manual fallback without gh: open the issue in the browser, assign yourself, create the branch with `git switch -c`, post the plan as a comment, edit STATUS.md row through the GitHub web editor on main.
