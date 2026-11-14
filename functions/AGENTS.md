# functions/

Azure Functions (Python). Holds the timer-trigger "new data watcher" that detects new SPHEREx releases and refreshes the cache.

## Commands
```
ruff check .
func start
```

## Conventions
- Idempotent: running twice with the same input produces the same result and no duplicate work.
- Log to Application Insights (`APPLICATIONINSIGHTS_CONNECTION_STRING`).
- `local.settings.json` is never committed.
- Verify IRSA endpoints in `docs/LINKS.md` before relying on them.

Root AGENTS.md rules still apply.
