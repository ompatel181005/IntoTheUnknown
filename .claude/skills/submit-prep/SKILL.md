---
name: submit-prep
description: Use before submitting to Space Apps. Produces a pass/fail report in chat and writes docs/SUBMISSION.md.
---

# submit-prep

Never mark an item as passing without checking it. Tell the human to re-check the live guides linked in docs/LINKS.md.

## Rules for this skill
- Start with `git status`. If the tree has uncommitted changes this skill did not expect, stop and ask.
- Before running each git or gh command, print it with a one-line plain-English explanation.
- If `gh` is missing or not authenticated (`gh auth status`), say so and give the manual fallback instead of failing silently.
- End with a 3-line summary: what happened, current branch, next suggested command.

## Output
A pass/fail report in chat plus `docs/SUBMISSION.md` (checklist with status).

## Official requirements
- Demo is a video of at most 30 seconds, or a slide deck of at most 7 slides including the title slide.
- Hosted on an external public link (cannot be uploaded to the Space Apps site).
- Video has English subtitles, or slides are in English.
- Submission page and linked materials are in English.
- Page clearly shows how NASA or partner agency data was used.
- Every required field is complete.
- Terms checkbox is checked.
- Submitted before Sunday Nov 15, 11:59 PM local.

## Our own checks
- Public URL loads with no login.
- All 5 targets in docs/TARGETS.md load: curl the backend for each and report status and time.
- Cache serves them if IRSA is slow.
- README complete (no `TODO(team)` left).
- docs/DATA.md acknowledgements filled with official text.
- Repo is public.
- Every Azure resource in infra/README.md has its named problem (Best Use of Azure).
- No secrets in git history: scan `git log -p` for `.env`, `AccountKey=`, `SharedAccessSignature`, `sig=`, `-----BEGIN`, long base64 strings.

## Time remaining
Print time until Sunday 11:59 PM local and until the feature freeze (default Sunday 8:00 PM local, TODO(team) confirm).
