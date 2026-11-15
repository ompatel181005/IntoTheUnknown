#!/usr/bin/env python3
"""Prewarm SPHEREx view renders for the target point catalog in Azure Blob.

What this script does:
    1. Loads the target point catalog (default: frontend/public/catalog/points.json).
    2. For each object, propagates RA/Dec from ref_epoch to the target epoch (--epoch,
       defaulting to current decimal year) using its proper motion (pmra already includes cos dec).
    3. Sends a ViewRequest (POST /api/views) to the deployed SPHEREx view API on Azure Container Apps.
       Cached renders return immediately with manifest_url. Uncached renders are queued and
       processed on the server, which renders them and uploads results to Azure Blob storage.
    4. Polls the view status endpoint with backoff (starting at 3 s) until 'ready' or 'error' (or timeout).
    5. On 'ready', fetches the manifest JSON from Azure Blob to determine the number of coverage passes (epochs).
    6. Attaches the view block:
           {"manifest_url": ..., "query": ..., "built_at": ..., "passes": n}
       to the object. If rendering fails or times out, 'view' is left absent and the failure reason is recorded.
    7. Writes the updated catalog to --out with source pointing to Azure Blob storage.
    8. Prints a summary table (id, status, seconds, passes).

Idempotency and rerun safety:
    The script is fully idempotent. If a position has already been rendered to Azure Blob,
    the API returns HTTP 200 with status 'ready' instantly (< 0.5s), avoiding duplicate
    expensive pipeline computations. Output is written atomically.

Integration:
    The daily data watcher (#25 / Azure Functions timer trigger) can call this script whenever
    new SPHEREx data releases or point catalog updates are published, ensuring all catalog points
    remain prewarmed in Azure Blob storage for zero-latency client rendering.

How to run:
    /home/eddie/IntoTheUnknown/backend/.venv/bin/python /home/eddie/IntoTheUnknown/tools/prewarm_points.py \\
        --out /home/eddie/scratch/t20/points.json \\
        --concurrency 2
"""

import argparse
import concurrent.futures
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime

DEFAULT_API = "https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io"
DEFAULT_CATALOG = "frontend/public/catalog/points.json"
AZURE_BLOB_CATALOG_URI = (
    "https://stplanetxitu7q4.blob.core.windows.net/frames/catalog/points.json"
)
USER_AGENT = "spherex-prewarm/1.0"


def current_decimal_year() -> float:
    """Compute the current UTC date as a decimal year."""
    now = datetime.now(UTC)
    start_year = datetime(now.year, 1, 1, tzinfo=UTC)
    next_year = datetime(now.year + 1, 1, 1, tzinfo=UTC)
    fraction = (now - start_year).total_seconds() / (
        next_year - start_year
    ).total_seconds()
    return round(now.year + fraction, 6)


def propagate_coordinates(
    ra_deg: float,
    dec_deg: float,
    ref_epoch: float | None,
    pmra_mas_yr: float | None,
    pmdec_mas_yr: float | None,
    target_epoch: float,
) -> tuple[float, float]:
    """Propagate RA/Dec from ref_epoch to target_epoch using proper motion.

    pmra_mas_yr already includes cos(dec).
    Skip propagation when pmra, pmdec, or ref_epoch is None or non-finite.
    """
    if (
        ref_epoch is None
        or pmra_mas_yr is None
        or pmdec_mas_yr is None
        or not math.isfinite(pmra_mas_yr)
        or not math.isfinite(pmdec_mas_yr)
    ):
        return ra_deg, dec_deg

    dt = target_epoch - ref_epoch
    cos_dec = math.cos(math.radians(dec_deg))
    if abs(cos_dec) > 1e-9:
        delta_ra = (pmra_mas_yr * dt / 3.6e6) / cos_dec
    else:
        delta_ra = 0.0
    delta_dec = pmdec_mas_yr * dt / 3.6e6

    new_ra = (ra_deg + delta_ra) % 360.0
    new_dec = max(-90.0, min(90.0, dec_deg + delta_dec))
    return round(new_ra, 6), round(new_dec, 6)


def http_post_json(url: str, payload: dict, timeout: float = 30.0) -> dict:
    """Send an HTTP POST request with JSON body and parse JSON response."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {e.code}: {body}") from e


def http_get_json(url: str, timeout: float = 30.0) -> dict:
    """Send an HTTP GET request and parse JSON response."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {e.code}: {body}") from e


def process_object(
    obj: dict,
    api_url: str,
    fov: int,
    target_epoch: float,
    timeout_s: float,
) -> dict:
    """Prewarm a single catalog object and return processing status and view data."""
    obj_id = obj.get("id", "unknown")
    start_time = time.time()

    # 1. Propagate coordinates
    orig_ra = float(obj["ra_deg"])
    orig_dec = float(obj["dec_deg"])
    ref_epoch = obj.get("ref_epoch")
    pmra = obj.get("pmra_mas_yr")
    pmdec = obj.get("pmdec_mas_yr")

    prop_ra, prop_dec = propagate_coordinates(
        orig_ra, orig_dec, ref_epoch, pmra, pmdec, target_epoch
    )

    query = {
        "ra": prop_ra,
        "dec": prop_dec,
        "fov_arcmin": fov,
        "band": "auto",
        "mode": "stack",
        "source": "auto",
    }

    post_url = f"{api_url.rstrip('/')}/api/views"
    try:
        post_resp = http_post_json(post_url, query, timeout=30.0)
    except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as e:
        elapsed = round(time.time() - start_time, 2)
        return {
            "id": obj_id,
            "status": "error",
            "seconds": elapsed,
            "passes": None,
            "view": None,
            "error": f"POST failed: {e}",
        }

    status = post_resp.get("status")
    manifest_url = post_resp.get("manifest_url")
    status_url = post_resp.get("status_url")

    # If already ready from cached render
    if status == "ready" and manifest_url:
        try:
            manifest = http_get_json(manifest_url, timeout=30.0)
            passes = len(manifest.get("epochs", []))
            built_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            elapsed = round(time.time() - start_time, 2)
            return {
                "id": obj_id,
                "status": "ready",
                "seconds": elapsed,
                "passes": passes,
                "view": {
                    "manifest_url": manifest_url,
                    "query": query,
                    "built_at": built_at,
                    "passes": passes,
                },
                "error": None,
            }
        except (
            urllib.error.URLError,
            TimeoutError,
            json.JSONDecodeError,
            OSError,
            RuntimeError,
        ) as e:
            elapsed = round(time.time() - start_time, 2)
            return {
                "id": obj_id,
                "status": "error",
                "seconds": elapsed,
                "passes": None,
                "view": None,
                "error": f"Failed fetching manifest: {e}",
            }

    if not status_url:
        err = post_resp.get("error")
        err_msg = (
            err.get("message")
            if isinstance(err, dict)
            else str(err or "No status_url returned")
        )
        elapsed = round(time.time() - start_time, 2)
        return {
            "id": obj_id,
            "status": "error",
            "seconds": elapsed,
            "passes": None,
            "view": None,
            "error": err_msg,
        }

    full_status_url = urllib.parse.urljoin(api_url, status_url)

    # 2. Poll every 3 s with backoff
    poll_interval = 3.0
    while True:
        if (time.time() - start_time) > timeout_s:
            elapsed = round(time.time() - start_time, 2)
            return {
                "id": obj_id,
                "status": "timeout",
                "seconds": elapsed,
                "passes": None,
                "view": None,
                "error": f"Timeout after {elapsed}s",
            }

        time.sleep(poll_interval)
        poll_interval = min(poll_interval * 1.3, 10.0)

        try:
            poll_resp = http_get_json(full_status_url, timeout=30.0)
        except (
            urllib.error.URLError,
            TimeoutError,
            json.JSONDecodeError,
            OSError,
            RuntimeError,
        ) as e:
            if (time.time() - start_time) > timeout_s:
                elapsed = round(time.time() - start_time, 2)
                return {
                    "id": obj_id,
                    "status": "error",
                    "seconds": elapsed,
                    "passes": None,
                    "view": None,
                    "error": f"Poll failed: {e}",
                }
            continue

        poll_status = poll_resp.get("status")
        if poll_status == "ready":
            manifest_url = poll_resp.get("manifest_url")
            if not manifest_url:
                elapsed = round(time.time() - start_time, 2)
                return {
                    "id": obj_id,
                    "status": "error",
                    "seconds": elapsed,
                    "passes": None,
                    "view": None,
                    "error": "Ready status without manifest_url",
                }
            try:
                manifest = http_get_json(manifest_url, timeout=30.0)
                passes = len(manifest.get("epochs", []))
                built_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
                elapsed = round(time.time() - start_time, 2)
                return {
                    "id": obj_id,
                    "status": "ready",
                    "seconds": elapsed,
                    "passes": passes,
                    "view": {
                        "manifest_url": manifest_url,
                        "query": query,
                        "built_at": built_at,
                        "passes": passes,
                    },
                    "error": None,
                }
            except (
                urllib.error.URLError,
                TimeoutError,
                json.JSONDecodeError,
                OSError,
                RuntimeError,
            ) as e:
                elapsed = round(time.time() - start_time, 2)
                return {
                    "id": obj_id,
                    "status": "error",
                    "seconds": elapsed,
                    "passes": None,
                    "view": None,
                    "error": f"Failed fetching manifest: {e}",
                }
        elif poll_status == "error":
            err = poll_resp.get("error")
            err_msg = (
                err.get("message")
                if isinstance(err, dict)
                else str(err or "Unknown error")
            )
            elapsed = round(time.time() - start_time, 2)
            return {
                "id": obj_id,
                "status": "error",
                "seconds": elapsed,
                "passes": None,
                "view": None,
                "error": err_msg,
            }


def write_catalog(
    out_path: str, base_catalog: dict, results_by_id: dict[str, dict]
) -> None:
    """Write the output catalog JSON atomically."""
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    out_objects = []
    for orig_obj in base_catalog.get("objects", []):
        obj_copy = dict(orig_obj)
        res = results_by_id.get(orig_obj["id"])
        if res and res.get("view"):
            obj_copy["view"] = res["view"]
        elif "view" in obj_copy and (not res or not res.get("view")):
            # If error or no view, leave view absent
            del obj_copy["view"]
        out_objects.append(obj_copy)

    out_catalog = {
        "version": base_catalog.get("version", "2026-11-15.r1"),
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "kind": "azure_blob",
            "uri": AZURE_BLOB_CATALOG_URI,
        },
        "objects": out_objects,
    }

    tmp_path = f"{out_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(out_catalog, f, indent=1)
        f.write("\n")
    os.replace(tmp_path, out_path)


def write_markdown_report(
    report_path: str, results: list[dict], total_seconds: float
) -> None:
    """Write markdown summary report."""
    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
    ready_count = sum(1 for r in results if r["status"] == "ready")
    error_count = sum(1 for r in results if r["status"] != "ready")

    lines = [
        "# Prewarm Points Report",
        "",
        "## Summary",
        f"- **Total Objects**: {len(results)}",
        f"- **Ready (Prewarmed)**: {ready_count}",
        f"- **Failures**: {error_count}",
        f"- **Total Wall Time**: {total_seconds:.2f} s ({total_seconds / 60:.2f} min)",
        f"- **Timestamp**: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}",
        "",
        "## Results Table",
        "",
        "| id | status | seconds | passes |",
        "| :--- | :--- | ---: | ---: |",
    ]

    for r in results:
        passes_str = str(r["passes"]) if r["passes"] is not None else "-"
        lines.append(
            f"| `{r['id']}` | {r['status']} | {r['seconds']:.2f} | {passes_str} |"
        )

    lines.append("")
    lines.append("## Failures and Reasons")
    failures = [r for r in results if r["status"] != "ready"]
    if failures:
        lines.append("")
        for r in failures:
            lines.append(f"- **`{r['id']}`** ({r['status']}): {r['error']}")
    else:
        lines.append("")
        lines.append(
            "No failures. All points successfully prewarmed and ready in Azure Blob."
        )

    lines.append("")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prewarm SPHEREx view renders for target points in Azure Blob."
    )
    parser.add_argument(
        "--catalog",
        default=DEFAULT_CATALOG,
        help=f"Path to input catalog points.json (default: {DEFAULT_CATALOG})",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Path to output points.json (required)",
    )
    parser.add_argument(
        "--api",
        default=DEFAULT_API,
        help=f"Base URL of SPHEREx view API (default: {DEFAULT_API})",
    )
    parser.add_argument(
        "--fov",
        type=int,
        default=6,
        help="Field of view in arcminutes (default: 6)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help="Number of concurrent view prewarm requests (default: 2)",
    )
    parser.add_argument(
        "--timeout-s",
        type=float,
        default=240.0,
        help="Timeout in seconds per view request (default: 240)",
    )
    parser.add_argument(
        "--epoch",
        type=float,
        default=None,
        help="Decimal year to propagate positions to (default: now)",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Optional path to write markdown summary report (e.g. /home/eddie/scratch/t20/report.md)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # Resolve catalog path if needed
    catalog_path = args.catalog
    if not os.path.exists(catalog_path):
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        alt_path = os.path.join(repo_root, catalog_path)
        if os.path.exists(alt_path):
            catalog_path = alt_path

    # Determine epoch
    target_epoch = args.epoch if args.epoch is not None else current_decimal_year()
    print(f"Target epoch for proper motion propagation: {target_epoch:.4f}")
    print(f"Connecting to API: {args.api}")
    print(f"Reading catalog from: {catalog_path}")
    print(f"Output destination: {args.out}")

    with open(catalog_path, "r", encoding="utf-8") as f:
        catalog_data = json.load(f)

    objects = catalog_data.get("objects", [])
    total_objects = len(objects)
    print(f"Loaded {total_objects} objects from catalog.")

    overall_start = time.time()
    results_by_id: dict[str, dict] = {}

    # Map object id to index for ordered output
    id_order = [o["id"] for o in objects]

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency
    ) as executor:
        future_to_obj = {
            executor.submit(
                process_object, obj, args.api, args.fov, target_epoch, args.timeout_s
            ): obj
            for obj in objects
        }

        for idx, future in enumerate(
            concurrent.futures.as_completed(future_to_obj), start=1
        ):
            obj = future_to_obj[future]
            obj_id = obj.get("id", "unknown")
            try:
                res = future.result()
            except (
                urllib.error.URLError,
                TimeoutError,
                json.JSONDecodeError,
                OSError,
                RuntimeError,
            ) as e:
                res = {
                    "id": obj_id,
                    "status": "error",
                    "seconds": 0.0,
                    "passes": None,
                    "view": None,
                    "error": f"Unhandled worker exception: {e}",
                }
            results_by_id[obj_id] = res
            passes_info = (
                f"passes: {res['passes']}"
                if res["passes"] is not None
                else f"error: {res.get('error')}"
            )
            print(
                f"[{idx:>2}/{total_objects}] {obj_id:<20} {res['status']:<8} "
                f"in {res['seconds']:>6.2f}s ({passes_info})",
                flush=True,
            )
            # Write progressive catalog so far
            write_catalog(args.out, catalog_data, results_by_id)

    # Order results matching catalog
    ordered_results = [results_by_id[oid] for oid in id_order if oid in results_by_id]
    total_elapsed = time.time() - overall_start

    # Final write of catalog
    write_catalog(args.out, catalog_data, results_by_id)
    print(f"\nWrote finished catalog to {args.out}")

    # Print summary table
    print("\n" + "=" * 60)
    print(f"{'id':<20} {'status':<10} {'seconds':>10} {'passes':>10}")
    print("-" * 60)
    for res in ordered_results:
        sec_str = f"{res['seconds']:.2f}"
        passes_str = str(res["passes"]) if res["passes"] is not None else "-"
        print(f"{res['id']:<20} {res['status']:<10} {sec_str:>10} {passes_str:>10}")
    print("=" * 60)

    ready_count = sum(1 for r in ordered_results if r["status"] == "ready")
    error_count = sum(1 for r in ordered_results if r["status"] != "ready")
    print(
        f"Total: {total_objects} | Ready: {ready_count} | Failed: {error_count} | Wall time: {total_elapsed:.2f}s"
    )

    failures = [r for r in ordered_results if r["status"] != "ready"]
    if failures:
        print(f"\nFailures ({len(failures)}):")
        for r in failures:
            print(f"  - {r['id']} ({r['status']}): {r['error']}")

    report_path = args.report or os.path.join(
        os.path.dirname(os.path.abspath(args.out)), "report.md"
    )
    write_markdown_report(report_path, ordered_results, total_elapsed)
    print(f"Wrote markdown report to {report_path}")


if __name__ == "__main__":
    main()
