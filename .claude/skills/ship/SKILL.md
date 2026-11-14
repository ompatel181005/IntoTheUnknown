---
name: ship
description: Use when work on an issue is ready for review. Runs checks and a secret scan, commits, pushes, opens the PR, and marks STATUS in review.
argument-hint: [issue-number]
disable-model-invocation: true
---

# ship

## Rules for this skill
- Start with `git status`. If the tree has uncommitted changes this skill did not expect, stop and ask.
- Before running each git or gh command, print it with a one-line plain-English explanation.
- If `gh` is missing or not authenticated (`gh auth status`), say so and give the manual fallback instead of failing silently.
- End with a 3-line summary: what happened, current branch, next suggested command.

Default issue number: parse it from the branch name (`feat/<n>-...`).

## Steps
1. Run the `sync` steps first.
2. Run checks for every touched area (backend, frontend, functions). Any failure: stop, show the error, do not commit.
3. Secret scan of the staged diff (`git diff --cached`): `.env` files, `AccountKey=`, `SharedAccessSignature`, `sig=`, `-----BEGIN`, long base64 strings. Any hit: stop.
4. Show `git diff --stat` and a 2-line summary. Commit with a conventional message.
5. `git push -u origin <branch>`, then `gh pr create` using the PR template. Title `<type>: <summary> (#<n>)`. Body includes `Closes #<n>` and How to test.
6. `python scripts/update_status.py --member <name> --state "in review"`.

Manual fallback without gh: push the branch, open the PR on GitHub with the template, edit STATUS.md on main.

## For reviewers
The reviewer must not be the author.
1. `gh pr checkout <pr>` (get the PR branch locally).
2. Run the How to test steps from the PR.
3. Confirm CI is green.
4. `gh pr merge <pr> --squash --delete-branch`.

If main breaks after the merge, open a revert PR first (`git revert <merge-commit>`), then debug.
