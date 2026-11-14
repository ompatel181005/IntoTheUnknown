# AGENTS.md

Canonical agent instructions. Claude Code reads this through `CLAUDE.md` (`@AGENTS.md`). Other agents read it directly.

## 1. Project
- Public, no-login web tool for NASA Space Apps 2026 (challenge: "Planet X and SPHEREx", also targeting "Best Use of Azure").
- User enters RA/Dec and sees a SPHEREx time series of that patch as a flipbook to spot motion and variability.
- Full idea and scope: `docs/IDEA.md`.

## 2. Verify before you build
SPHEREx releases, IRSA endpoints, and Azure limits change. Before writing code that depends on them, check the official link in `docs/LINKS.md` and record anything surprising in `docs/DECISIONS.md`.

## 3. Repo map
- `frontend/`: React + Vite + TypeScript app. Talks only to our backend.
- `backend/`: Python 3.11 + FastAPI. `app/irsa` (query, cutout fetch, demo reader), `app/processing` (stacking, views), `app/cache`. In production it also serves `frontend/dist`.
- `demo/`: real SPHEREx cutouts of the 5 targets; the backend builds presets from it, so they work with IRSA down. Rebuilt by `tools/fetch_demo.py`.
- `Dockerfile`: one container (API + built web app) for Azure Container Apps.
- `functions/`: Azure Functions (Python), timer-trigger new data watcher.
- `infra/`: Azure scripts (`az`, `swa`, `func`) and `infra/README.md`.
- `docs/`: IDEA, PLAN, TARGETS, DATA, LINKS, DECISIONS, SUBMISSION.
- `scripts/`: `update_status.py` (writes STATUS.md on main via the GitHub API), `spike_barnard.py`.
- `.claude/skills/`: playbooks (see section 10).
- `.github/`: PR template, issue template, CI.
- `STATUS.md`: one row per person, snapshot for agents.

## 4. Commands
Backend (`backend/`):
```
python -m venv .venv
pip install -e ".[dev]"
ruff check .
ruff format --check .
pytest -q
uvicorn app.main:app --reload --port 8000
```

Frontend (`frontend/`):
```
npm ci
npm run dev        # http://localhost:5173, proxies /api and /frames to :8000
npm run lint
npm run build
```

Container (repo root):
```
docker build -t spherex-blink . && docker run -p 8000:8000 spherex-blink
```

Functions (`functions/`):
```
ruff check .
func start
```

## 5. Definition of done
Checks pass for every touched area, PR merged, issue closed, STATUS.md row updated. Never report done without running the checks.

## 6. Ownership and shared hotspots
- Work is split by feature slice, one owner per GitHub issue. Only edit files inside your issue's slice.
- Shared hotspots: `backend/pyproject.toml`, `frontend/package.json` and lockfile, `backend/app/main.py`, `backend/app/models.py` + `frontend/src/types.ts` (the API contract), `frontend/src/App.tsx`, `Dockerfile`, `.github/workflows/*`, root `README.md`, `AGENTS.md`.
- Before editing a hotspot, the human posts in team chat: TODO(team) channel.
- Agents must ask the human before touching a hotspot.

## 7. Git rules
- Branches: `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `chore/<slug>`, `docs/<slug>`.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `wip:`. Small commits.
- Short-lived branches and PRs. The author merges their own PR once CI is green; no second reviewer is required. Squash merge, delete branch. `main` must always run.
- Never commit to main (one exception: STATUS.md via `scripts/update_status.py`).
- Never `git push --force`. After a rebase use `--force-with-lease` on your own branch only.
- Never rebase someone else's branch.
- Before any git command that rewrites history, print it and explain it in one line.
- Parallel agents are allowed through git worktrees: one issue per worktree, one agent per worktree.

## 8. Secrets
Never commit `.env`, keys, connection strings, or SAS tokens. `.env.example` holds names only. Azure secrets live in GitHub Actions secrets or Container Apps secrets.

## 9. Data rules
- Never pull full SPHEREx frames, only cutouts.
- All IRSA traffic goes through our backend.
- Every number shown to users comes from our code, never from an LLM.

## 10. Skills
Playbooks in `.claude/skills/<name>/SKILL.md`. Non-Claude agents: read the file and follow it as a playbook.

| Skill | Path | Purpose |
|---|---|---|
| start-task | `.claude/skills/start-task/SKILL.md` | Claim an issue, branch from fresh main, plan, update STATUS. |
| sync | `.claude/skills/sync/SKILL.md` | Rebase your branch on origin/main, resolve safe conflicts, run checks. |
| ship | `.claude/skills/ship/SKILL.md` | Checks, secret scan, commit, push, open PR, mark in review. |
| handoff | `.claude/skills/handoff/SKILL.md` | Save WIP, post a resume-cold comment, set STATUS to away or blocked. |
| worktree | `.claude/skills/worktree/SKILL.md` | Add, list, remove worktrees for parallel agents. |
| submit-prep | `.claude/skills/submit-prep/SKILL.md` | Pass/fail submission report and `docs/SUBMISSION.md`. |

## 11. If main breaks
The next action is `git revert` of the breaking merge commit via a PR, then debug.

## Deadlines
Submission closes Sunday Nov 15, 2026, 11:59 PM local. Feature freeze default: Sunday 8:00 PM local, TODO(team) confirm.
