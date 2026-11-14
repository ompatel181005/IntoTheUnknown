# AGENTS.md

Canonical agent instructions. Claude Code reads this through `CLAUDE.md` (`@AGENTS.md`). Other agents read it directly.

## 1. Project
- Public, no-login web tool for NASA Space Apps 2026 (challenge: "Planet X and SPHEREx", also targeting "Best Use of Azure").
- User enters RA/Dec and sees a SPHEREx time series of that patch as a flipbook to spot motion and variability.
- Full idea and scope: `docs/IDEA.md`.

## 2. Verify before you build
SPHEREx releases, IRSA endpoints, and Azure limits change. Before writing code that depends on them, check the official link in `docs/LINKS.md` and record anything surprising in `docs/DECISIONS.md`.

## 3. Repo map
- `index.html`: the whole app (HTML, CSS, JS; no build step). `CONFIG` at the top of the script holds endpoints and tunables.
- `server.py`: Python stdlib server. Serves the page and `demo/`, proxies IRSA/VizieR/CDS, caches cutouts, rejects full-frame downloads.
- `demo/`: real SPHEREx cutouts of the 5 targets (the golden snapshots). Rebuilt by `tools/fetch_demo.py`.
- `tests/`: Playwright UI/sim/demo tests, mock IRSA, `test_server.py`.
- `Dockerfile`: one container for page + proxy (Azure Container Apps).
- `functions/`: Azure Functions (Python), timer-trigger new data watcher.
- `infra/`: Azure scripts (`az`, `swa`, `func`) and `infra/README.md`.
- `backend/`, `frontend/`: from the original React/FastAPI plan; only agent notes, no code (`docs/DECISIONS.md`).
- `docs/`: IDEA, TARGETS, DATA, LINKS, DECISIONS, SUBMISSION. `docs/PLAN.md` §4–5 describe the superseded server-side pipeline.
- `scripts/`: `update_status.py` (writes STATUS.md on main via the GitHub API), `spike_barnard.py`.
- `.claude/skills/`: playbooks (see section 10).
- `.github/`: PR template, issue template, CI.
- `STATUS.md`: one row per person, snapshot for agents.

## 4. Commands
App (repo root):
```
python3 server.py                     # http://localhost:8000
python3 tests/test_server.py
pip install playwright numpy astropy && python -m playwright install chromium
python3 server.py --port 8811 &
python3 tests/test_ui.py /tmp/shots --base http://127.0.0.1:8811 --live
python3 tests/test_sim.py /tmp/shots --base http://127.0.0.1:8811
python3 tests/test_demo.py /tmp/shots --base http://127.0.0.1:8811
python3 tools/fetch_demo.py           # rebuild demo/ (needs numpy, astropy)
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
- Shared hotspots: `server.py`, `Dockerfile`, `.github/workflows/*`, root `README.md`, `AGENTS.md`.
- `index.html` is the whole app in one file, so everyone edits it: keep PRs small and run the sync skill often.
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
