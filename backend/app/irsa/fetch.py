"""Cutout fetch and FITS extraction. From docs/skeletons/fetch.py, plus the demo-pack reader."""

import concurrent.futures as cf
import contextvars
import http.client
import io
import logging
import time
import urllib.error
import urllib.request
import warnings

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

from ..config import IRSA_TIMEOUT_S
from ..telemetry import operation

# Cutouts are a few MB including the PSF extensions. Refuse a full-frame response.
MAX_CUTOUT_BYTES = 8 * 1024 * 1024
RETRYABLE_HTTP = {429, 500, 502, 503, 504}
TRANSIENT = (
    TimeoutError,
    ConnectionError,
    urllib.error.URLError,
    http.client.IncompleteRead,
    http.client.RemoteDisconnected,
)
PIX_ARCSEC = 6.15

# SPHEREx headers carry SIP terms without a -SIP CTYPE; astropy applies them and warns on every file.
logging.getLogger("astropy").setLevel(logging.ERROR)
warnings.filterwarnings("ignore", module="astropy.stats.sigma_clipping")


def _extract(hdul, ra, dec, window=None) -> dict:
    """Pull science arrays + metadata. window=(y0,y1,x0,x1) when reading a full frame from S3."""
    sl = (slice(window[0], window[1]), slice(window[2], window[3])) if window else (slice(None),) * 2
    get = (lambda name: hdul[name].section[sl]) if window else (lambda name: hdul[name].data)
    hdr = hdul["IMAGE"].header
    wcs = WCS(hdr)
    x, y = wcs.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
    swcs = WCS(hdr, fobj=hdul, key="W")
    swcs.sip = None  # spectral WCS (lookup table)
    lam, bw = swcs.pixel_to_world(x, y)
    fh = hdul["FLAGS"].header
    out_wcs = wcs.slice(sl) if window else wcs
    names = {h.name for h in hdul}
    image = np.asarray(get("IMAGE"), dtype="f4")
    if "ZODI" in names and not hdr.get("ZODISUB"):
        image = image - np.asarray(get("ZODI"), dtype="f4")  # zodi is NOT pre-subtracted in IRSA Level 2
    var = np.asarray(get("VARIANCE"), dtype="f4") if "VARIANCE" in names else None
    return {
        "image": image,
        "var": var,
        "flags": np.asarray(get("FLAGS"), dtype="i4"),
        "flag_names": {fh[k]: int(k[4:]) for k in fh["MSKN*"]},  # bit numbers from header, never hard-coded
        "wcs_header": out_wcs.to_header(relax=True),
        "detector": int(hdr.get("DETECTOR", 0)),
        "lam_um": float(lam.to_value(u.um)),
        "bw_um": float(bw.to_value(u.um)),
        "version": hdul[0].header.get("VERSION", ""),
    }


@operation("IRSA", "cutout", none_is_failure=True)
def fetch_irsa(frame, ra, dec, size_deg, retries=3):
    url = f"{frame['url']}?center={ra},{dec}d&size={size_deg}"
    for attempt in range(retries):
        try:
            # fits.open(URL, cache=False) retains its temporary download until process exit.
            # A long-running API must instead own and close each bounded response buffer.
            with urllib.request.urlopen(url, timeout=IRSA_TIMEOUT_S) as response:
                body = response.read(MAX_CUTOUT_BYTES + 1)
                length = response.headers.get("Content-Length")
                expected = int(length) if length and length.isdecimal() else None
                if len(body) > MAX_CUTOUT_BYTES or (expected is not None and expected > MAX_CUTOUT_BYTES):
                    logging.getLogger(__name__).warning("IRSA cutout exceeded the %d-byte limit", MAX_CUTOUT_BYTES)
                    return None
                if expected is not None and len(body) < expected:
                    # A bounded HTTPResponse.read can silently return short on premature EOF.
                    raise http.client.IncompleteRead(body, expected - len(body))
            with io.BytesIO(body) as buffer, fits.open(buffer, memmap=False) as hdul:
                return {**frame, **_extract(hdul, ra, dec), "source": "irsa"}
        except urllib.error.HTTPError as e:
            if e.code not in RETRYABLE_HTTP:
                return None
        except TRANSIENT:
            pass
        time.sleep(2 * (attempt + 1))
    return None


@operation("S3", "cutout", none_is_failure=True)
def fetch_s3(frame, ra, dec, size_deg):
    """Same file on the AWS mirror (identical path layout, verified); range-reads only the window."""
    try:
        key = frame["url"].split("/ibe/data/spherex/", 1)[1]  # inside the try: an odd URL must fall back to IRSA
        with fits.open(
            f"s3://nasa-irsa-spherex/{key}",
            use_fsspec=True,
            fsspec_kwargs={"anon": True, "default_block_size": 256 * 1024},
        ) as hdul:
            x, y = WCS(hdul["IMAGE"].header).world_to_pixel(SkyCoord(ra, dec, unit="deg"))
            h = int(np.ceil(size_deg * 3600 / PIX_ARCSEC / 2)) + 2
            y0, x0 = max(int(y) - h, 0), max(int(x) - h, 0)
            return {**frame, **_extract(hdul, ra, dec, (y0, int(y) + h + 1, x0, int(x) + h + 1)), "source": "s3"}
    except Exception:
        return None


def fetch_all(frames, ra, dec, size_deg, workers=10, on_progress=None) -> list[dict]:
    def one(f):
        # S3 first: a range read of the window is several times faster than IRSA's cutout service,
        # which ships a ~4 MB PSF table with every cutout (DECISIONS 2026-11-14).
        return fetch_s3(f, ra, dec, size_deg) or fetch_irsa(f, ra, dec, size_deg)

    out, done = [], 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for fut in cf.as_completed([ex.submit(contextvars.copy_context().run, one, f) for f in frames]):
            done += 1
            if (r := fut.result()) is not None:
                out.append(r)
            if on_progress:
                on_progress(done, len(frames))
    return sorted(out, key=lambda r: r["t_mjd"])


def load_demo(path, ra, dec, meta: dict) -> dict | None:
    """One cutout from the demo pack (tools/fetch_demo.py): IMAGE minus ZODI, FLAGS, WCS-WAVE."""
    try:
        with fits.open(path, memmap=False) as hdul:
            out = _extract(hdul, ra, dec)
    except Exception:
        return None
    rel = meta.get("rel", "")
    return {
        **out,
        "url": meta.get("uri", ""),
        "obs": str(meta.get("uri", "")).rsplit("/", 1)[-1].split("_spx_")[0] or meta["file"],
        "t_mjd": float(meta["mjd"]),
        "collection": f"spherex_{rel}" if rel else "spherex",
        "detector": int(meta.get("det", out["detector"])),
        "source": "demo",
    }
