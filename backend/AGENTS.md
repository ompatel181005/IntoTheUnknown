# backend/

FastAPI service (Python 3.11). The only component that talks to IRSA, the cache, and Cosmos DB.

## Layout
- `app/api`: HTTP routes and request/response models.
- `app/irsa`: SIA/TAP queries, cutout fetch.
- `app/processing`: stacking, stretch, differencing, Gaia propagation.
- `app/cache`: Azure Blob cache.

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
