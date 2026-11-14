# SKELETON from the hackathon plan: not yet run against live IRSA or Azure.
# Destination: backend/app/irsa/fetch.py. Copy it there when you start that slice and delete this file in the same PR.

import concurrent.futures as cf, http.client, time, urllib.error
import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.utils.data import conf
from astropy.wcs import WCS

conf.remote_timeout = 120
RETRYABLE_HTTP = {429, 500, 502, 503, 504}
TRANSIENT = (TimeoutError, ConnectionError, urllib.error.URLError,
             http.client.IncompleteRead, http.client.RemoteDisconnected)
PIX_ARCSEC = 6.15

def _extract(hdul, ra, dec, window=None) -> dict:
    """Pull science arrays + metadata. window=(y0,y1,x0,x1) when reading a full frame from S3."""
    sl = (slice(window[0], window[1]), slice(window[2], window[3])) if window else (slice(None),) * 2
    get = (lambda name: hdul[name].section[sl]) if window else (lambda name: hdul[name].data)
    hdr = hdul["IMAGE"].header
    wcs = WCS(hdr)
    x, y = wcs.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
    swcs = WCS(hdr, fobj=hdul, key="W"); swcs.sip = None            # spectral WCS (lookup table)
    lam, bw = swcs.pixel_to_world(x, y)
    fh = hdul["FLAGS"].header
    out_wcs = wcs.slice(sl) if window else wcs
    return {"image": (get("IMAGE") - get("ZODI")).astype("f4"),     # zodi is NOT pre-subtracted
            "var": np.asarray(get("VARIANCE"), dtype="f4"),
            "flags": np.asarray(get("FLAGS"), dtype="i4"),
            "flag_names": {fh[k]: int(k[4:]) for k in fh["MSKN*"]},  # bit numbers from header, never hard-coded
            "wcs_header": out_wcs.to_header(relax=True), "detector": int(hdr.get("DETECTOR", 0)),
            "lam_um": float(lam.to_value(u.um)), "bw_um": float(bw.to_value(u.um)),
            "version": hdul[0].header.get("VERSION", "")}

def fetch_irsa(frame, ra, dec, size_deg, retries=3):
    url = f"{frame['url']}?center={ra},{dec}d&size={size_deg}"
    for attempt in range(retries):
        try:
            with fits.open(url, cache=False, memmap=False) as hdul:
                return {**frame, **_extract(hdul, ra, dec), "source": "irsa"}
        except urllib.error.HTTPError as e:
            if e.code not in RETRYABLE_HTTP:
                return None
        except TRANSIENT:
            pass
        time.sleep(2 * (attempt + 1))
    return None

def fetch_s3(frame, ra, dec, size_deg):
    """Same file on the AWS mirror (identical path layout, verified); range-reads only the window."""
    key = frame["url"].split("/ibe/data/spherex/", 1)[1]
    try:
        with fits.open(f"s3://nasa-irsa-spherex/{key}", use_fsspec=True,
                       fsspec_kwargs={"anon": True, "default_block_size": 256 * 1024}) as hdul:
            x, y = WCS(hdul["IMAGE"].header).world_to_pixel(SkyCoord(ra, dec, unit="deg"))
            h = int(np.ceil(size_deg * 3600 / PIX_ARCSEC / 2)) + 2
            y0, x0 = max(int(y) - h, 0), max(int(x) - h, 0)
            return {**frame, **_extract(hdul, ra, dec, (y0, int(y) + h + 1, x0, int(x) + h + 1)), "source": "s3"}
    except Exception:
        return None

def fetch_all(frames, ra, dec, size_deg, workers=10, on_progress=None) -> list[dict]:
    def one(f):
        return fetch_irsa(f, ra, dec, size_deg) or fetch_s3(f, ra, dec, size_deg)
    out, done = [], 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for fut in cf.as_completed([ex.submit(one, f) for f in frames]):
            done += 1
            if (r := fut.result()) is not None:
                out.append(r)
            if on_progress:
                on_progress(done, len(frames))
    return sorted(out, key=lambda r: r["t_mjd"])
