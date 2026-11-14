# frontend/

React + Vite + TypeScript single page app, deployed on Azure Static Web Apps. Look and feel: "Lunar Glass" (tokens in `src/styles/theme.css`).

## Commands
```
npm ci
npm run dev        # http://localhost:5173 (real data: start the backend first, /api and /frames proxy to :8000)
                   # http://localhost:5173/dev.html (dev fixture, synthetic data, no backend)
npm run lint
npm run build
```

## Layout
- `src/types.ts`: mirror of the API contract (docs/PLAN.md 4.3). Change only together with the backend models.
- `src/api.ts`, `src/data/source.ts`: the only code that fetches. Presets try `/golden/<id>/` first.
- `src/components/<Name>/`: presentational, typed props, no fetching (App and hooks fetch).
- `src/components/Tour/steps.ts`: the guided tour. Mark new controls with `data-tour="<id>"` and add a step.
- `src/dev/`: dev-only fixture. Never import it from production code.

## Conventions
- The URL is the state: `?ra=&dec=&fov=` plus `target`, `band`, `mode`, `epoch` and `ref` (1-based), `panel`, `sel`, `speed`, `stretch`, `invert`, `gain`, `ov`.
- All data comes from our backend API, never directly from IRSA.
- Display only numbers returned by the backend. Missing data gets a labeled empty state, never a made-up value.
- Colors only from theme tokens. Accent = interactive, mover = moving object, match = Gaia agrees, flag = bad pixels or errors.
- Hotspots: `package.json`, lockfile, `src/App.tsx`. Ask the human first.

Root AGENTS.md rules still apply.
