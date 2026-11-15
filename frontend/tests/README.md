# Focused loading tests

Run from `frontend/` after `npm ci`:

```powershell
node --experimental-vm-modules --test tests/loading.test.mjs
```

The tests transpile the actual TypeScript source and execute it in Node's VM modules with mocked API calls. They cover paired asset fetches, optional mask failures, abort handling and listener cleanup, poll timing, and old successes/errors completing after the newest result. Hook scheduling is modeled in this focused suite. The PR was additionally checked in a real React/Chrome harness with sources that ignore cancellation. These checks do not call the backend or astronomy services.

Issue #83 also covers pre-submission debounce, cancellation of obsolete polling,
and another viewer completing a shared job after the first viewer leaves. Run
`node --experimental-vm-modules --test tests/loading.test.mjs tests/view-states.test.mjs`
for loading copy and recovery behavior. After building, start
`npm run preview -- --host 127.0.0.1 --port 5193` and run
`python tests/loading_browser.py` with a Python environment containing Playwright.
It captures prepared, queued, query and fetch/recovery states at desktop and
320 px widths, checks rapid FOV changes submit only the latest request, and
writes mocked-API evidence to `tests/evidence/loading83/`. It does not establish
real archive availability or production latency.
