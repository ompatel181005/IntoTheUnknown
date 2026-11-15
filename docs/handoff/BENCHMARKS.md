# Pending GPU benchmarks

Run only when Eddie says the GPU is free. First check the baseline load with `nvidia-smi` (it should be near 0% before starting). Script: `~/scratch/pw/gpuflight.mjs` (headed Chromium on the RTX 3060 via WSL D3D12: `GALLIUM_DRIVER=d3d12`, `LD_LIBRARY_PATH=/usr/lib/wsl/lib`). It opens a browser window.

Targets: idle p95 <= 16.8 ms with zero frames over 33 ms; flights p95 <= 17 ms with at most 1 frame over 25 ms.

| # | What | Compare | Why | State |
|---|---|---|---|---|
| B1 | Starfield balance (10c): broad Milky Way raster plus about 500 visible stars with halos | idle, to target, home: e4ac7b8-era numbers (idle 16.7, to target p95 33 with 4 to 6 frames over 33 ms) vs now | The 2026-11-15 run showed idle 33 ms, but the GPU was 63% busy from Windows, and the slowdown also appeared with 10c stashed, so it is unconfirmed | pending |
| B2 | Design pass (14, b2ac653): glass blur 10 px, no saturate | same | Backdrop-filter changes usually help, but they were never measured on GPU | pending |
| B3 | Continuous flights (13, 660aae6) | to target, search pick, home, plus the continuity check (no velocity jump > 3x the median step) | Motion rebuild | pending. Software runs got slower in Chromium because the orrery now keeps drawing under the dome during flights; check on GPU |
| B4 | Planets as spheres and moving orbits (11) | idle and flights | More drawing per frame | pending (task not run yet) |

Bisect recipe if a regression shows: `git stash push -- <files>`, rerun, `git stash pop`.
