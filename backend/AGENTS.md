# backend/

FastAPI service (Python 3.11). The only component that talks to IRSA, the cache, and Cosmos DB.

## Layout
- `app/main.py`: HTTP routes (docs/PLAN.md 4.3). `app/models.py`: the contract, mirrored by `frontend/src/types.ts`.
- `app/irsa`: SIA/TAP queries, cutout fetch, demo-pack reader.
- `app/processing`: epoch grouping, stacking, stretch (`stack.py`); view jobs, spectrum, light curve (`views.py`).
- `app/cache`: render cache. Local files today (`backend/.cache/`); Azure Blob replaces it behind the same functions.

## Data sources
- The five targets build from the real cutouts in `demo/` (from `tools/fetch_demo.py`), so they work while IRSA is down.
- Any other position queries IRSA live (SIA, TAP fallback) and reports `IRSA_DOWN` when both fail.

## Commands
```
python -m venv .venv
pip install -e ".[dev]"
ruff check .
ruff format --check .
pytest -q
uvicorn app.main:app --reload --port 8000
```

## Conventions
- Handle IRSA timeouts and network errors explicitly (timeout from `IRSA_TIMEOUT_S`). Return clear errors, never hang.
- Cutout fetches are parallel and bounded (`CUTOUT_MAX_WORKERS`).
- Cutouts only, never full frames.
- Numbers returned to the frontend are computed here, not by an LLM.
- Hotspots: `pyproject.toml`, `app/main.py`. Ask the human first.

Root AGENTS.md rules still apply.
