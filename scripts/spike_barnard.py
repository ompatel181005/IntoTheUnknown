"""Barnard's Star data spike (#4): is a stacked epoch clean, and does the ~1.7 px hop show?

Run from scripts/:  .venv/bin/python spike_barnard.py
Uses the skeletons in docs/skeletons as-is. Output goes to scripts/spike_out/ (gitignored).
Fetched cutouts are cached in spike_out/frames.pkl; delete it to refetch.
"""

import json
import pickle
import sys
import time
import urllib.request
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.coordinates import SkyCoord, get_body_barycentric
from astropy.time import Time
from astropy.wcs import WCS
from astroquery.gaia import Gaia
from matplotlib.animation import FuncAnimation, PillowWriter
from photutils.centroids import centroid_2dg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "docs" / "skeletons"))
import fetch  # noqa: E402
import query  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from app.processing import stack  # noqa: E402

OUT = Path(__file__).resolve().parent / "spike_out"
OUT.mkdir(exist_ok=True)
RA, DEC = 269.44627, 4.76820  # TARGETS.md centring position (2026.0)
FOV_ARCMIN = 6.0
SIZE_DEG = (FOV_ARCMIN + 1) / 60
BANDS = {"SPHEREx-D1", "SPHEREx-D2"}  # preset B1-B2
# Gaia DR3 for Barnard's Star (TARGETS.md)
BARNARD = {"ra": 269.448503, "dec": 4.739420, "pmra": -801.6, "pmdec": 10362.4, "plx": 547.0}
REPORT: dict = {}


def say(k, v):
    REPORT[k] = v
    print(f"{k}: {v}")


def predict(ra, dec, pmra, pmdec, plx, mjd):
    """Gaia J2016.0 -> position at mjd. Linear PM plus parallax (PLAN 5.8 formulas), no aberration.
    ponytail: linear PM skips perspective acceleration (~0.01 px for Barnard's); use apply_space_motion if it matters.
    """
    ra0, dec0 = np.radians(ra), np.radians(dec)
    t = Time(mjd, format="mjd", scale="tdb")
    dt = t.jyear - 2016.0
    e = get_body_barycentric("earth", t).xyz.to_value("AU")
    X, Y, Z = e
    plx = np.nan_to_num(np.asarray(plx, float))
    plx = np.where(plx > 0, plx, 0.0)
    da = pmra * dt + plx * (X * np.sin(ra0) - Y * np.cos(ra0))  # mas, alpha*
    dd = pmdec * dt + plx * (X * np.cos(ra0) * np.sin(dec0) + Y * np.sin(ra0) * np.sin(dec0) - Z * np.cos(dec0))
    mas = np.pi / 180 / 3.6e6
    return np.degrees(ra0 + da * mas / np.cos(dec0)), np.degrees(dec0 + dd * mas)


def centroid(img, x, y, half=3):
    xi, yi = int(round(x)), int(round(y))
    box = img[yi - half : yi + half + 1, xi - half : xi + half + 1]
    if box.shape != (2 * half + 1,) * 2 or np.isfinite(box).sum() < 20:
        return np.nan, np.nan
    bad = ~np.isfinite(box)
    cx, cy = centroid_2dg(np.where(bad, 0, box - np.nanmedian(box)), mask=bad)
    return xi - half + cx, yi - half + cy


def get_frames():
    try:
        colls = query.discover_collections()
    except Exception:
        colls = ["spherex_dr1", "spherex_qr3"]  # list_collections is TAP-backed; last seen 2026-11-14
    say("collections", colls)
    for attempt in range(40):  # IRSA query side flaps with 502s; keep trying ~30 min
        t = time.time()
        try:
            rows = query.query_frames_sia(RA, DEC, colls)
            say("query_via", "sia")
            break
        except Exception as e:
            print(f"SIA attempt {attempt} failed: {str(e)[:80]}", flush=True)
        try:
            rows = query.query_frames_tap(RA, DEC)
            say("query_via", "tap")
            break
        except Exception as e:
            print(f"TAP attempt {attempt} failed: {str(e)[:80]}", flush=True)
        time.sleep(45)
    say("query_seconds", round(time.time() - t, 1))
    say("sia_frames_after_dedupe", len(rows))
    rows = [r for r in rows if r["band"] in BANDS]
    say("frames_B1_B2", len(rows))

    # bytes per cutout + IRSA vs S3 timing on one frame
    u = f"{rows[0]['url']}?center={RA},{DEC}d&size={SIZE_DEG}"
    t = time.time()
    nbytes = len(urllib.request.urlopen(u, timeout=120).read())
    say("cutout_bytes", nbytes)
    say("cutout_irsa_seconds", round(time.time() - t, 2))
    t = time.time()
    s3 = fetch.fetch_s3(rows[0], RA, DEC, SIZE_DEG)
    say("cutout_s3_seconds", round(time.time() - t, 2) if s3 else "failed")
    if s3:
        say("cutout_s3_shape", list(s3["image"].shape))

    t = time.time()
    frames = fetch.fetch_all(rows, RA, DEC, SIZE_DEG, workers=10)
    say("fetch_all_seconds", round(time.time() - t, 1))
    say("fetched", f"{len(frames)}/{len(rows)}")
    say("sources", {s: sum(f["source"] == s for f in frames) for s in ("irsa", "s3")})
    say("cutout_shape", list(frames[0]["image"].shape))
    return frames


def mask_check(frames):
    """Target pixel flags per frame, under the PLAN 5.3 policy."""
    n_ok = n_over = n_nonlin = n_src = 0
    eaters: dict[str, int] = {}
    for f in frames:
        ra, dec = predict(**BARNARD, mjd=f["t_mjd"])
        x, y = WCS(f["wcs_header"]).world_to_pixel(SkyCoord(ra, dec, unit="deg"))
        v = int(f["flags"][int(round(float(y))), int(round(float(x)))])
        names = {n for n, b in f["flag_names"].items() if v >> b & 1}
        masked = names - stack.KEEP
        n_ok += not masked
        n_over += "OVERFLOW" in names
        n_nonlin += "NONLINEAR" in names
        n_src += "SOURCE" in names
        for n in masked:
            eaters[n] = eaters.get(n, 0) + 1
    n = len(frames)
    say("target_unmasked_frac", round(n_ok / n, 3))
    say("target_core_overflow_frac", round(n_over / n, 3))
    say("target_core_nonlinear_frac", round(n_nonlin / n, 3))
    say("target_core_source_frac", round(n_src / n, 3))
    say("target_masked_by", eaters)


def field_stars(w, shape):
    r = FOV_ARCMIN * 2**0.5 / 2 / 60 + 2 / 60
    job = Gaia.launch_job_async(
        "SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT(ra,dec), CIRCLE({RA},{DEC},{r})) AND phot_g_mean_mag < 18"
    )
    g = job.get_results()
    return g


def main():
    pkl = OUT / "frames.pkl"
    if pkl.exists():
        frames = pickle.loads(pkl.read_bytes())
        REPORT.update(json.loads((OUT / "fetch_report.json").read_text()))
    else:
        frames = get_frames()
        pkl.write_bytes(pickle.dumps(frames))
        (OUT / "fetch_report.json").write_text(json.dumps(REPORT, indent=1))

    print("-- mask policy as in PLAN 5.3 --")
    mask_check(frames)
    # Finding: a saturated core is flagged TRANSIENT + SUR_ERROR (plus OVERFLOW), so PLAN 5.3 erases it.
    # Proposed policy: don't let TRANSIENT/SUR_ERROR mask a pixel that is also SOURCE.
    for f in frames:
        fn = f["flag_names"]
        relax = (1 << fn["TRANSIENT"]) | (1 << fn["SUR_ERROR"])
        f["flags"] = np.where(f["flags"] >> fn["SOURCE"] & 1, f["flags"] & ~relax, f["flags"])
    print("-- proposed: TRANSIENT/SUR_ERROR ignored on SOURCE pixels --")
    REPORT["plan_policy"] = {k: REPORT.pop(k) for k in list(REPORT) if k.startswith("target_")}
    mask_check(frames)

    all_epochs = stack.group_epochs(frames)
    say("epochs_dropped_lt10_frames", [len(ep) for ep in all_epochs if len(ep) < 10])
    epochs = [ep for ep in all_epochs if len(ep) >= 10]  # tiny epochs break channel matching
    mjds = [float(np.mean([f["t_mjd"] for f in ep])) for ep in epochs]
    say("epochs", [{"mjd": round(m, 1), "date": Time(m, format="mjd").iso[:10], "n": len(ep)} for m, ep in zip(mjds, epochs)])
    w, shape = stack.common_grid(RA, DEC, FOV_ARCMIN)
    stacks, meta = stack.stack_epochs(epochs, w, shape)
    say("stack_meta", {"n_channels": len(meta["channels"]), "bandpass_matched": meta["bandpass_matched"]})
    say("stack_nan_frac", [round(float(np.isnan(s).mean()), 3) for s in stacks])
    np.save(OUT / "stacks.npy", np.array(stacks))

    # Barnard's centroid per epoch vs prediction
    bx = []
    for s, m in zip(stacks, mjds):
        px, py = w.world_to_pixel(SkyCoord(*predict(**BARNARD, mjd=m), unit="deg"))
        cx, cy = centroid(s, float(px), float(py))
        bx.append((float(px), float(py), float(cx), float(cy)))

    # field stars: alignment offset and centroid scatter
    g = field_stars(w, shape)
    say("gaia_sources_G<18", len(g))
    n = shape[0]
    res = []  # [star][epoch] = (dx, dy)
    for row in g:
        if not (10 < row["phot_g_mean_mag"] < 16) or np.hypot(row["pmra"] or 0, row["pmdec"] or 0) > 100:
            continue
        others = np.hypot((g["ra"] - row["ra"]) * np.cos(np.radians(DEC)), g["dec"] - row["dec"]) * 3600 / stack.PIX_ARCSEC
        if ((others < 3) & (g["phot_g_mean_mag"] < row["phot_g_mean_mag"] + 3)).sum() > 1:
            continue  # crowded
        star = []
        for s, m in zip(stacks, mjds):
            px, py = w.world_to_pixel(
                SkyCoord(*predict(row["ra"], row["dec"], row["pmra"] or 0, row["pmdec"] or 0, row["parallax"], m), unit="deg")
            )
            px, py = float(px), float(py)
            if not (6 < px < n - 7 and 6 < py < n - 7):
                star = None
                break
            cx, cy = centroid(s, px, py)
            star.append((cx - px, cy - py))
        if star is not None:
            res.append(star)
    res = np.array(res)  # (nstar, nepoch, 2)
    good = np.isfinite(res).all(axis=(1, 2))
    res = res[good]
    say("field_stars_used", int(len(res)))
    off = np.nanmedian(res, axis=0)  # per-epoch alignment offset (dx, dy)
    say("epoch_alignment_offset_px", np.round(off, 3).tolist())
    rel = res - off
    mad = lambda a: float(1.4826 * np.nanmedian(np.abs(a - np.nanmedian(a))))  # noqa: E731
    say("field_centroid_scatter_px_per_axis", round(mad(rel.ravel()), 3))
    shifts = res[:, -1] - res[:, 0]
    say("field_shift_scatter_first_last_px_per_axis", round(mad(shifts.ravel()), 3))

    # Barnard's measured shift, alignment-corrected
    p0, p1 = np.array(bx[0][:2]), np.array(bx[-1][:2])
    c0 = np.array(bx[0][2:]) - off[0]
    c1 = np.array(bx[-1][2:]) - off[-1]
    pred, meas = (p1 - p0).astype(float), (c1 - c0).astype(float)
    say("barnard_per_epoch_pred_xy_meas_xy", [[round(v, 2) for v in b] for b in bx])
    say("barnard_pred_shift_px", [round(float(v), 3) for v in pred] + [round(float(np.hypot(*pred)), 3)])
    say("barnard_meas_shift_px", [round(float(v), 3) for v in meas] + [round(float(np.hypot(*meas)), 3)])
    say("barnard_shift_error_px", round(float(np.hypot(*(meas - pred))), 3))

    # images: shared stretch, per-epoch PNG, blink GIF
    st = stack.shared_asinh(stacks)
    norm = lambda s: np.clip(np.arcsinh((s - st["vmin"]) / st["beta"]) / np.arcsinh((st["vmax"] - st["vmin"]) / st["beta"]), 0, 1)  # noqa: E731
    fig, ax = plt.subplots(figsize=(5, 5))
    im = ax.imshow(norm(stacks[0]), origin="lower", cmap="gray", vmin=0, vmax=1)
    mk = ax.plot([], [], "r+", ms=14)[0]
    ttl = ax.set_title("")

    def draw(i):
        im.set_data(norm(stacks[i]))
        mk.set_data([bx[i][0]], [bx[i][1]])
        ttl.set_text(f"Barnard's B1-B2 epoch {i} {Time(mjds[i], format='mjd').iso[:10]}  (+ = Gaia prediction)")
        return im, mk, ttl

    for i in range(len(stacks)):
        draw(i)
        fig.savefig(OUT / f"epoch{i}.png", dpi=120)
    FuncAnimation(fig, draw, frames=len(stacks)).save(OUT / "blink.gif", writer=PillowWriter(fps=1.5))
    if len(stacks) > 1:
        d = stacks[-1] - stacks[0]
        k = 5 * mad(d[np.isfinite(d)])
        plt.figure(figsize=(5, 5))
        plt.imshow(d, origin="lower", cmap="RdBu_r", vmin=-k, vmax=k)
        plt.title("last - first (expect N-S dipole)")
        plt.savefig(OUT / "diff.png", dpi=120)

    (OUT / "report.json").write_text(json.dumps(REPORT, indent=1, default=str))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
