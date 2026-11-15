"""Build offline snapshots through the real FastAPI pipeline and validate Barnard astrometry.

python scripts/validate_integrated.py --chrome '<Chrome executable>' --export-golden
"""

import argparse
import hashlib
import json
import os
import shutil
import socket
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit

import numpy as np
from astropy.wcs import WCS
from validate import measure, predict

ROOT = Path(__file__).resolve().parents[1]


def _sidecar_names(manifest: dict) -> list[str]:
    """Return safe sidecar basenames referenced by manifest extras."""
    extras = manifest.get("extras") or {}
    if not isinstance(extras, dict):
        raise ValueError("manifest extras must be an object")
    names = []
    for name in extras.values():
        if name is None:
            continue
        if (
            not isinstance(name, str)
            or name in ("", ".", "..")
            or "/" in name
            or "\\" in name
            or ":" in name
            or "\x00" in name
        ):
            raise ValueError(f"invalid manifest sidecar path: {name!r}")
        names.append(name)
    return names


def _sidecar_pairs(manifest: dict, source_dir: Path, golden_dir: Path) -> list[tuple[Path, Path]]:
    """Resolve and preflight every referenced sidecar before copying or publishing a manifest."""
    pairs = []
    for name in _sidecar_names(manifest):
        source = source_dir / name
        golden = golden_dir / name
        if not source.is_file():
            raise FileNotFoundError(f"referenced render sidecar is missing: {source}")
        pairs.append((source, golden))
    return pairs


def _export_sidecars(manifest: dict, source_dir: Path, golden_dir: Path) -> None:
    """Copy referenced sidecars, replacing old files, and verify their contents."""
    pairs = _sidecar_pairs(manifest, source_dir, golden_dir)
    for source, golden in pairs:
        golden.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, golden)
        if source.read_bytes() != golden.read_bytes():
            raise AssertionError(f"Exported sidecar differs from render: {source.name}")


def _validate_sidecars(manifest: dict, source_dir: Path, golden_dir: Path) -> None:
    """Require every referenced static sidecar to exist and match this render."""
    for source, golden in _sidecar_pairs(manifest, source_dir, golden_dir):
        if not golden.is_file():
            raise AssertionError(f"Missing golden sidecar: {golden}")
        if source.read_bytes() != golden.read_bytes():
            raise AssertionError(f"Stale golden sidecar: {golden}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--export-golden", action="store_true")
    parser.add_argument(
        "--out", type=Path, default=ROOT / "scripts/spike_out/integrated"
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    # Set the cache before app imports: both its static mount and cache module bind this path.
    os.environ["CACHE_DIR"] = str((args.out / "cache").resolve())
    sys.path.insert(0, str(ROOT / "backend"))
    from app import config
    from app import main as api
    from app.models import ViewRequest
    from app.processing import views
    from app.targets import TARGETS

    reports = {}
    manifests = {}
    with patch(
        "urllib.request.urlopen",
        side_effect=AssertionError("archive traffic forbidden"),
    ):
        for target in TARGETS:
            req = ViewRequest(
                ra=target.ra,
                dec=target.dec,
                fov_arcmin=target.fov_arcmin,
                band=target.band,
                source="saved",
            )
            job = views.Job(qk=views.query_key(req), req=req)
            views.build(job)
            path = config.CACHE_DIR / job.manifest_url.removeprefix("/frames/")
            manifest = json.loads(path.read_text())
            wcs = WCS(manifest["grid"]["wcs"])
            epochs = []
            for epoch in manifest["epochs"]:
                image = np.fromfile(path.parent / epoch["image"], dtype="<f4").reshape(
                    manifest["grid"]["ny"], manifest["grid"]["nx"]
                )
                entry = {
                    "mjd": epoch["t_mean_mjd"],
                    "n_frames": epoch["n_frames"],
                    "finite_fraction": float(np.isfinite(image).mean()),
                }
                if target.id == "barnard":
                    expected = wcs.all_world2pix([predict(entry["mjd"])], 0)[0]
                    entry.update(measure(image, expected), predicted_px=list(expected))
                epochs.append(entry)
            report = {
                "epochs": epochs,
                "bandpass_matched": manifest["bandpass_matched"],
                "frames": len(manifest["frames"]),
                "science_status": "not validated",
            }
            if target.id == "barnard":
                actual = np.subtract(
                    epochs[-1]["centroid_px"], epochs[0]["centroid_px"]
                )
                expected = np.subtract(
                    epochs[-1]["predicted_px"], epochs[0]["predicted_px"]
                )
                report.update(
                    measured_shift_px=float(np.linalg.norm(actual)),
                    predicted_shift_px=float(np.linalg.norm(expected)),
                    vector_error_px=float(np.linalg.norm(actual - expected)),
                )
                report["science_status"] = (
                    "PASS"
                    if len(epochs) >= 2
                    and report["vector_error_px"] <= 0.2
                    and max(e["residual_px"] for e in epochs) < 0.3
                    and manifest["bandpass_matched"]
                    else "FAIL"
                )
            if args.export_golden:
                dest = ROOT / "frontend/public/golden" / target.id
                dest.mkdir(parents=True, exist_ok=True)
                # Preflight and export sidecars before publishing a manifest that references them.
                _export_sidecars(manifest, path.parent, dest)
                # Arrays are replaced before the manifest, so a first load never sees missing files.
                for epoch in manifest["epochs"]:
                    for key in ("image", "mask"):
                        shutil.copyfile(path.parent / epoch[key], dest / epoch[key])
                part = dest / "manifest.json.part"
                part.write_text(
                    json.dumps(manifest, indent=2, allow_nan=False) + "\n",
                    encoding="utf8",
                )
                os.replace(part, dest / "manifest.json")
                report["golden_bytes"] = sum(
                    p.stat().st_size for p in dest.iterdir() if p.is_file()
                )
            golden = ROOT / "frontend/public/golden" / target.id
            static = json.loads((golden / "manifest.json").read_text())
            for key in ("render_key", "grid", "epochs", "stretch", "bandpass_matched", "extras"):
                assert static[key] == manifest[key], f"Stale golden {target.id}: {key}"
            _validate_sidecars(manifest, path.parent, golden)
            hashes = {}
            for epoch in manifest["epochs"]:
                for key in ("image", "mask"):
                    name = epoch[key]
                    actual = (path.parent / name).read_bytes()
                    assert actual == (golden / name).read_bytes(), (
                        f"Stale golden {target.id}: {name}"
                    )
                    hashes[name] = hashlib.sha256(actual).hexdigest()
            report["array_sha256"] = hashes
            report["golden_arrays_match"] = True
            reports[target.id] = report
            manifests[target.id] = manifest
            print(
                target.id,
                report["science_status"],
                "epochs",
                len(epochs),
                "frames",
                report["frames"],
                flush=True,
            )

    errors, attempted = [], []
    if args.chrome:
        import uvicorn
        from playwright.sync_api import sync_playwright

        for asset in (ROOT / "frontend/public/golden").rglob("*"):
            if asset.is_file():
                built = (
                    ROOT
                    / "frontend/dist/golden"
                    / asset.relative_to(ROOT / "frontend/public/golden")
                )
                assert built.read_bytes() == asset.read_bytes(), (
                    f"Rebuild frontend: stale {built}"
                )
        # Cache the forced-down health result too, so the UI can run with zero archive calls.
        api._irsa.update(t=time.time() + 3600, state="down")
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        server = uvicorn.Server(
            uvicorn.Config(api.app, log_level="error", lifespan="off")
        )
        thread = threading.Thread(
            target=server.run, kwargs={"sockets": [sock]}, daemon=True
        )
        thread.start()
        for _ in range(200):
            if server.started:
                break
            time.sleep(0.05)
        base = f"http://127.0.0.1:{sock.getsockname()[1]}"
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=str(args.chrome), headless=True
                )
                page = browser.new_page(
                    viewport={"width": 1440, "height": 1000}, reduced_motion="reduce"
                )
                page.on("pageerror", lambda e: errors.append(str(e)))
                block_api = False

                def route_request(route):
                    url = route.request.url
                    if urlsplit(url).hostname not in ("127.0.0.1", "localhost"):
                        attempted.append(url)
                        route.abort()
                    elif block_api and "/api/" in url:
                        # Golden presets must render when the entire API is unavailable.
                        route.fulfill(
                            status=503,
                            content_type="application/json",
                            body='{"error":{"code":"OFFLINE"}}',
                        )
                    else:
                        route.continue_()

                page.route("**/*", route_request)
                target = next(t for t in TARGETS if t.id == "barnard")
                for panel, endpoint in (
                    ("colours", "spectrum"),
                    ("brightness", "lightcurve"),
                ):
                    query = urlencode(
                        {
                            "ra": target.ra,
                            "dec": target.dec,
                            "target": target.id,
                            "fov": target.fov_arcmin,
                            "band": target.band,
                            "src": "saved",
                            "mode": "inspect",
                            "panel": panel,
                            "sel": "29,29",
                        }
                    )
                    with page.expect_response(
                        lambda r, name=endpoint: f"/{name}?" in r.url,
                        timeout=120000,
                    ) as response:
                        page.goto(base + "/?" + query)
                    result = response.value
                    assert result.status == 200, (
                        endpoint,
                        result.status,
                        result.text(),
                    )
                    points = result.json()["points"]
                    assert points, f"No {endpoint} measurements returned"
                    reports["barnard"][f"react_{endpoint}_points"] = len(points)
                block_api = True
                for target in TARGETS:
                    query = urlencode(
                        {
                            "ra": target.ra,
                            "dec": target.dec,
                            "target": target.id,
                            "fov": target.fov_arcmin,
                            "band": target.band,
                            "src": "saved",
                        }
                    )
                    page.goto(base + "/?" + query)
                    page.wait_for_selector(
                        'canvas[aria-label^="SPHEREx image, epoch"]',
                        state="visible",
                        timeout=30000,
                    )
                    page.screenshot(path=str(args.out / f"react-{target.id}.png"))
                    reports[target.id]["react_api_offline"] = True
                browser.close()
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            sock.close()
    evidence = {
        "pipeline": "React + FastAPI channel-matched stacks",
        "pipeline_version": config.PIPELINE_VERSION,
        "stack_sha256": hashlib.sha256(
            (ROOT / "backend/app/processing/stack.py").read_bytes()
        ).hexdigest(),
        "views_sha256": hashlib.sha256(
            (ROOT / "backend/app/processing/views.py").read_bytes()
        ).hexdigest(),
        "reports": reports,
        "browser_errors": errors,
        "external_requests": attempted,
    }
    (args.out / "results.json").write_text(
        json.dumps(evidence, indent=2, allow_nan=False) + "\n", encoding="utf8"
    )
    print(json.dumps(reports["barnard"], indent=2), flush=True)
    return int(
        reports["barnard"]["science_status"] != "PASS"
        or bool(errors)
        or bool(attempted)
    )


if __name__ == "__main__":
    raise SystemExit(main())
