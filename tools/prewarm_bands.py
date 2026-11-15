#!/usr/bin/env python3
"""Prewarm every infrared band so switching bands is a cache hit (#96).

The band is part of a view's query key and each band reads different detectors, so a
band nobody has rendered yet costs a full build (a render slot for presets, a live IRSA
render for the other home-screen points). This script asks the live API for every
band of the views the UI opens by default, exactly as the frontend would request them:

    presets  -> the preset's RA, Dec and FOV from GET /api/targets, source "auto"
    points   -> the RA, Dec and FOV in each point's view.query (points.json), source "auto"

Ready views return at once; the rest queue on the server and land in Blob. Blob pointers
outlive restarts, so this only needs rerunning after a pipeline version change. Nothing
is written locally except the optional report.

How to run (presets only, about 45 quick demo-pack renders):
    python tools/prewarm_bands.py

Add the 47 home-screen points (live renders, several hours at concurrency 2):
    python tools/prewarm_bands.py --points
"""

import argparse
import concurrent.futures
import importlib.util
import json
import time
import urllib.request
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "prewarm_points", Path(__file__).with_name("prewarm_points.py")
)
prewarm = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prewarm)

# frontend/src/types.ts BAND_OPTIONS
BANDS = ("auto", "B1", "B2", "B3", "B4", "B5", "B6", "B1-B2", "B1-B3", "all")
POINTS_URL = prewarm.AZURE_BLOB_CATALOG_URI


def preset_jobs(targets: list[dict], bands: tuple[str, ...]) -> list[dict]:
    """One job per preset and band, at the preset's own position and FOV."""
    return [
        {
            "id": f"{t['id']}:{band}",
            "obj": {"id": t["id"], "ra_deg": t["ra"], "dec_deg": t["dec"]},
            "fov": t["fov_arcmin"],
            "band": band,
        }
        for t in targets
        for band in bands
    ]


def point_jobs(
    catalog: dict, bands: tuple[str, ...], preset_ids: set[str]
) -> list[dict]:
    """One job per point and band at the point's rendered position (lib/catalog.ts pointPosition).

    Points that open a preset are covered by preset_jobs; points never rendered have no
    position the UI would ask for yet, so they are skipped.
    """
    jobs = []
    for o in catalog.get("objects", []):
        query = (o.get("view") or {}).get("query")
        if o.get("preset_id") in preset_ids or not query:
            continue
        for band in bands:
            jobs.append(
                {
                    "id": f"{o['id']}:{band}",
                    "obj": {"id": o["id"], "ra_deg": query["ra"], "dec_deg": query["dec"]},
                    "fov": query.get("fov_arcmin", 6),
                    "band": band,
                }
            )
    return jobs


def run_job(job: dict, api: str, timeout_s: float, retries: int = 2) -> dict:
    """Render one view; a full queue (or any failure) is retried after a pause."""
    for attempt in range(retries + 1):
        # No proper motion in obj, so process_object sends the position unchanged.
        res = prewarm.process_object(
            job["obj"], api, job["fov"], 0.0, timeout_s, band=job["band"]
        )
        if res["status"] == "ready" or attempt == retries:
            return {**res, "id": job["id"]}
        time.sleep(30)
    raise AssertionError("unreachable")


def load_json(source: str) -> object:
    if source.startswith("http"):
        req = urllib.request.Request(source, headers={"User-Agent": prewarm.USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    return json.loads(Path(source).read_text(encoding="utf-8"))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Prewarm every band of the default views.")
    p.add_argument("--api", default=prewarm.DEFAULT_API)
    p.add_argument("--points", action="store_true", help="Also prewarm the home-screen points (live renders)")
    p.add_argument("--catalog", default=POINTS_URL, help="points.json URL or path (default: Blob copy)")
    p.add_argument("--bands", default=",".join(BANDS), help="Comma-separated bands (default: all options)")
    p.add_argument("--concurrency", type=int, default=2, help="Parallel requests (server runs 2 at a time)")
    p.add_argument("--timeout-s", type=float, default=300.0)
    p.add_argument("--report", default=None, help="Optional markdown report path")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    bands = tuple(b.strip() for b in args.bands.split(",") if b.strip())
    unknown = set(bands) - set(BANDS)
    if unknown:
        raise SystemExit(f"Unknown band(s): {', '.join(sorted(unknown))}")

    targets = load_json(f"{args.api.rstrip('/')}/api/targets")
    jobs = preset_jobs(targets, bands)
    if args.points:
        jobs += point_jobs(load_json(args.catalog), bands, {t["id"] for t in targets})
    print(f"{len(jobs)} views to prewarm against {args.api}")

    start = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run_job, j, args.api, args.timeout_s) for j in jobs]
        for n, fut in enumerate(concurrent.futures.as_completed(futures), start=1):
            res = fut.result()
            results.append(res)
            detail = f"passes: {res['passes']}" if res["passes"] is not None else res.get("error")
            print(f"[{n:>3}/{len(jobs)}] {res['id']:<28} {res['status']:<8} {res['seconds']:>7.1f}s ({detail})", flush=True)

    ready = sum(r["status"] == "ready" for r in results)
    print(f"\nReady {ready}/{len(results)} in {time.time() - start:.0f}s")
    if args.report:
        prewarm.write_markdown_report(args.report, sorted(results, key=lambda r: r["id"]), time.time() - start)
        print(f"Wrote {args.report}")
    if ready < len(results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
