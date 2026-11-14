# Decisions

Append-only log, newest at bottom. Format: `## YYYY-MM-DD HH:MM - <title>` then Decision / Why / Owner.

## 2026-11-14 00:00 - Stack choice
Decision: Backend Python 3.11 + FastAPI in `backend/`. Frontend React + Vite + TypeScript in `frontend/`. Data watcher on Azure Functions (Python) in `functions/`. Infra scripts in `infra/`.
Why: TODO(team)
Owner: TODO(team)

## 2026-11-14 00:00 - Azure architecture
Decision: Azure Static Web Apps (frontend), Azure Container Apps (backend), Azure Blob Storage cache behind a CDN layer, Azure Functions timer trigger. Add-ons: Cosmos DB, Application Insights.
Why: TODO(team)
Owner: TODO(team)

## 2026-11-14 00:00 - MVP, tier, and cut scope
Decision: Scope split into MVP, Tier 2, Tier 3, and Cut as listed in `docs/IDEA.md`.
Why: TODO(team)
Owner: TODO(team)

## 2026-11-14 00:00 - Git workflow
Decision: Short-lived branches and PRs, any teammate other than the author reviews and merges, squash merge and delete branch, `main` must always run. Work split by feature slice, one owner per issue. GitHub Issues are the source of truth, STATUS.md is a snapshot. Parallel agents via worktrees.
Why: TODO(team)
Owner: TODO(team)
