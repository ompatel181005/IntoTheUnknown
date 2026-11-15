# Focused loading tests

Run from `frontend/` after `npm ci`:

```powershell
node --experimental-vm-modules --test tests/loading.test.mjs
```

The tests transpile the actual TypeScript source and execute it in Node's VM modules with mocked API calls. They cover paired asset fetches, optional mask failures, abort handling and listener cleanup, poll timing, and old successes/errors completing after the newest result. Hook scheduling is modeled in this focused suite. The PR was additionally checked in a real React/Chrome harness with sources that ignore cancellation. These checks do not call the backend or astronomy services.
