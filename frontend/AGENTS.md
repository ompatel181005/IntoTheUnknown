# frontend/

React + Vite + TypeScript single page app, deployed on Azure Static Web Apps.

## Commands
```
npm ci
npm run dev
npm run lint
npm run build
```

## Conventions
- The URL is the state: `?ra=&dec=&fov=`. Any view must be reproducible from its URL.
- All data comes from our backend API, never directly from IRSA.
- Display only numbers returned by the backend.
- Hotspots: `package.json`, lockfile, `src/App.tsx`. Ask the human first.

Root AGENTS.md rules still apply.
