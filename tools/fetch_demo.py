#!/usr/bin/env python3
"""
Build the bundled demo pack: real SPHEREx cutouts of the five challenge targets, saved under ./demo
so the viewer can play them instantly, with no archive round-trips.

    pip install numpy astropy              # only needed for this script, not for the app
    python3 tools/fetch_demo.py            # all five targets
    python3 tools/fetch_demo.py --only wise0855 --per 4 --fov 8

Re-run it whenever IRSA ingests a new SPHEREx release: it re-queries the archive, keeps the newest
version of every exposure, and rewrites ./demo. Nothing in index.html needs to change.

What it does per target
  1. Finds every SPHEREx Level-2 spectral image covering the target (IRSA TAP; SIA as a fallback).
  2. Groups exposures into survey seasons and keeps up to --per exposures per detector per season.
  3. Downloads a cutout of each from IRSA's cutout service.
  4. Rewrites each cutout as a small gzipped FITS file: IMAGE minus ZODI (16-bit quantised, well below
     the noise), FLAGS (uncompressed) and the WCS-WAVE table, keeping every WCS keyword, including the
     alternate "A" WCS the viewer needs for per-pixel wavelengths.
  5. Saves Gaia DR3 and AllWISE catalogues of the field for the overlays.
"""
import argparse, csv, gzip, io, json, math, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from astropy.io import fits

IRSA = "https://irsa.ipac.caltech.edu"
VIZIER_TAP = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
UA = "SPHEREx-Blink-demo-builder/1.0"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo")
D2R = math.pi / 180
SEASON_GAP_DAYS = 45
SEASON_MAX_DAYS = 75
SEASON_CHUNK_DAYS = 60

# Keep in sync with PRESETS in index.html (same numbers; slug is the demo folder name).
TARGETS = [
    dict(slug="barnard", name="Barnard's Star", ra=269.4520833, dec=4.6933639, epoch=2000.0, pmra=-801.551, pmdec=10362.394, plx=546.976),
    dict(slug="epsindib", name="ε Indi B", ra=331.0438333, dec=-56.7826944, epoch=2000.0, pmra=3981.977, pmdec=-2466.832, plx=270.658),
    dict(slug="wise0855", name="WISE 0855", ra=133.7951292, dec=-7.2451472, epoch=2010.33, pmra=-8123.7, pmdec=673.2, plx=439.0),
    dict(slug="rwaur", name="RW Aurigae", ra=76.9564167, dec=30.4014083, epoch=2000.0, pmra=3, pmdec=-25, plx=6.4),
    dict(slug="rdra", name="R Draconis", ra=248.1673750, dec=66.7549722, epoch=2000.0, pmra=-1, pmdec=3, plx=1.0),
]


def log(*a):
    print(*a, flush=True)


def get(url, tries=4, timeout=180):
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except Exception as e:  # HTTP 5xx, timeouts: back off and retry
            err = e
            time.sleep(2 * (k + 1))
    raise RuntimeError(f"{url[:120]}… failed: {err}")


# ---- astrometry: same formulas as index.html ----
def earth(year):
    n = (year - 2000.0) * 365.25
    L = (280.460 + 0.9856474 * n) * D2R; g = (357.528 + 0.9856003 * n) * D2R
    lam = L + (1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) * D2R
    eps = (23.439 - 0.0000004 * n) * D2R
    R = 1.00014 - 0.01671 * math.cos(g) - 0.00014 * math.cos(2 * g)
    return -R * math.cos(lam), -R * math.cos(eps) * math.sin(lam), -R * math.sin(eps) * math.sin(lam)


def propagate(s, year):
    dt = year - s["epoch"]; dA = s["pmra"] * dt; dD = s["pmdec"] * dt
    if s["plx"]:
        X, Y, Z = earth(year); a = s["ra"] * D2R; d = s["dec"] * D2R
        dA += s["plx"] * (X * math.sin(a) - Y * math.cos(a))
        dD += s["plx"] * (X * math.cos(a) * math.sin(d) + Y * math.sin(a) * math.sin(d) - Z * math.cos(d))
    dec = s["dec"] + dD / 3.6e6
    return s["ra"] + dA / 3.6e6 / math.cos(dec * D2R), dec


def mjd_to_year(m):
    return 2000.0 + (m - 51544.5) / 365.25


def release_rank(rel):  # newer wins: any DR beats any QR, then by number (matches CONFIG.RELEASE_RANK)
    rel = (rel or "").lower()
    import re
    m = re.match(r"^(dr|qr)(\d*)$", rel)
    if not m:
        return 0
    return (1000 if m.group(1) == "dr" else 0) + int(m.group(2) or 0)


# ---- archive search ----
def search_tap(ra, dec):
    adql = ("SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname FROM spherex.artifact a "
            "JOIN spherex.plane p ON a.planeid = p.planeid "
            f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.6f}, {dec:.6f}), p.poly) ORDER BY p.time_bounds_lower")
    url = f"{IRSA}/TAP/sync?" + urllib.parse.urlencode(dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=adql))
    text = get(url).decode()
    if not text.startswith("uri"):
        raise RuntimeError("TAP returned no table: " + text[:200])
    return [dict(uri=r["uri"], mjd=float(r["time_bounds_lower"]), band=r["energy_bandpassname"]) for r in csv.DictReader(io.StringIO(text))]


def search_sia(ra, dec):
    url = f"{IRSA}/SIA?" + urllib.parse.urlencode(dict(POS=f"circle {ra:.6f} {dec:.6f} 0.001", RESPONSEFORMAT="csv", MAXREC=20000))
    text = get(url).decode()
    rows = [r for r in csv.DictReader(io.StringIO(text)) if "spherex" in (r.get("obs_collection") or "").lower()
            and r.get("dataproduct_type") == "image"]
    out = []
    for r in rows:
        u = r["access_url"]
        if u.startswith(IRSA):
            u = u[len(IRSA):]
        out.append(dict(uri=u, mjd=float(r["t_min"]), band=r["energy_bandpassname"]))
    return out


def normalise(rows):
    import re
    out = []
    for r in rows:
        uri = r["uri"].lstrip("/")
        if not re.search(r"\.fits(\.gz)?$", uri, re.I):
            continue
        m = re.search(r"D(\d)", r["band"] or "")
        det = int(m.group(1)) if m else 0
        if not 1 <= det <= 6:
            continue
        rel = (re.search(r"spherex/([a-z]+\d*)/", uri, re.I) or [None, ""])[1]
        key = (re.search(r"level2_(.+?)_spx", uri, re.I) or [None, uri])[1]
        out.append(dict(uri=uri, mjd=r["mjd"], det=det, rel=rel, key=key))
    best = {}
    for r in out:  # newest release of each exposure
        b = best.get(r["key"])
        if b is None or release_rank(r["rel"]) > release_rank(b["rel"]) or (r["rel"] == b["rel"] and r["uri"] > b["uri"]):
            best[r["key"]] = r
    return sorted(best.values(), key=lambda r: r["mjd"])


def seasons(rows):
    """Same as seasonGroups() in index.html: split at gaps > SEASON_GAP_DAYS, and split seasons longer than
    SEASON_MAX_DAYS (near-continuous coverage at the ecliptic poles, e.g. R Dra) into SEASON_CHUNK_DAYS chunks."""
    groups, last = [], -1e9
    for r in sorted(rows, key=lambda r: r["mjd"]):
        if r["mjd"] - last > SEASON_GAP_DAYS:
            groups.append([])
        groups[-1].append(r); last = r["mjd"]
    out = []
    for g in groups:
        t0 = g[0]["mjd"]
        if g[-1]["mjd"] - t0 <= SEASON_MAX_DAYS:
            out.append(g); continue
        chunks = {}
        for r in g:
            chunks.setdefault(int((r["mjd"] - t0) // SEASON_CHUNK_DAYS), []).append(r)
        out += [chunks[k] for k in sorted(chunks)]
    return out


def pick(rows, per):
    out = []
    for s in seasons(rows):
        for d in range(1, 7):
            rs = [r for r in s if r["det"] == d]
            n = min(per, len(rs))
            out += [rs[int((k + 0.5) * len(rs) / n)] for k in range(n)]
    return sorted(out, key=lambda r: r["mjd"])


# ---- cutout processing ----
def quantise(img):
    """Float image -> integers with BSCALE/BZERO and BLANK for NaNs, at a step of 1/50 of the robust pixel noise
    (adds <0.01% to the noise). Uses int16 when the image's range allows that step, int32 otherwise
    (e.g. a hot pixel or a very bright star)."""
    good = np.isfinite(img)
    v = img[good]
    if v.size == 0:
        return np.full(img.shape, -32768, np.int16), 1.0, 0.0, -32768
    med = np.median(v); sig = 1.4826 * np.median(np.abs(v - med)) or 1e-6
    lo, hi = float(v.min()), float(v.max())
    scale = sig / 50.0
    zero = (hi + lo) / 2
    if (hi - lo) / scale < 65000:
        dtype, lim, blank = np.int16, 32767, -32768
    else:
        dtype, lim, blank = np.int32, 2**31 - 2, -2**31
        scale = max(scale, (hi - lo) / 4.0e9)
    q = np.clip(np.round((img - zero) / scale), -lim, lim)
    q[~good] = blank
    return q.astype(dtype), float(scale), float(zero), blank


def slim_cutout(raw):
    with fits.open(io.BytesIO(raw)) as hl:
        names = [h.name for h in hl]
        im = hl["IMAGE"]
        data = im.data.astype(np.float64)
        if "ZODI" in names and hl["ZODI"].data is not None and hl["ZODI"].data.shape == data.shape:
            data = data - hl["ZODI"].data
        hdr = im.header.copy()
        for k in ("BSCALE", "BZERO", "BLANK"):
            hdr.remove(k, ignore_missing=True)
        q, bs, bz, blank = quantise(data)
        hdr["ZODISUB"] = (True, "ZODI extension already subtracted by fetch_demo.py")
        out = [fits.PrimaryHDU(header=hl[0].header.copy())]
        h = fits.ImageHDU(q, hdr, name="IMAGE")
        h.header["BSCALE"] = bs; h.header["BZERO"] = bz; h.header["BLANK"] = blank
        out.append(h)
        if "FLAGS" in names and hl["FLAGS"].data is not None:
            # keep the FLAGS header: it is where SPHEREx documents what each bit means
            fh = fits.Header([c for c in hl["FLAGS"].header.cards
                              if c.keyword not in ("XTENSION", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "PCOUNT", "GCOUNT", "EXTNAME", "BSCALE", "BZERO")
                              and not c.keyword.startswith("Z")])
            out.append(fits.ImageHDU(hl["FLAGS"].data.astype(np.int32), fh, name="FLAGS"))
        if "WCS-WAVE" in names:
            out.append(hl["WCS-WAVE"].copy())
        bio = io.BytesIO()
        fits.HDUList(out).writeto(bio, output_verify="silentfix")
        return gzip.compress(bio.getvalue(), 9), hl[0].header.get("VERSION", "")


def fetch_catalog(table, cols, ra, dec, r, extra=""):
    q = f'SELECT TOP 4000 {cols} FROM "{table}" WHERE 1=CONTAINS(POINT(\'ICRS\',"RA_ICRS","DE_ICRS"),CIRCLE(\'ICRS\',{ra},{dec},{r})) {extra}'
    if table.startswith("II/328"):  # AllWISE uses RAJ2000/DEJ2000
        q = q.replace('"RA_ICRS"', '"RAJ2000"').replace('"DE_ICRS"', '"DEJ2000"')
    url = VIZIER_TAP + "?" + urllib.parse.urlencode(dict(request="doQuery", lang="ADQL", format="csv", query=q))
    return get(url, tries=3, timeout=90).decode()


def build(t, per, fov_arcmin):
    slug = t["slug"]; d = os.path.join(ROOT, slug); os.makedirs(d, exist_ok=True)
    cra, cdec = propagate(t, 2026.0)  # same grid centre as the viewer
    log(f"\n== {t['name']}  centre {cra:.5f} {cdec:+.5f}")
    try:  # SIA first, TAP as fallback (docs/DECISIONS.md: SIA answers in seconds, TAP takes 20-37 s)
        rows = search_sia(cra, cdec)
    except Exception as e:
        log("   SIA failed, trying TAP:", e)
        rows = search_tap(cra, cdec)
    rows = normalise(rows)
    chosen = pick(rows, per)
    log(f"   {len(rows)} exposures in archive, {len(seasons(rows))} seasons; downloading {len(chosen)}")
    size = fov_arcmin / 60 * 1.25

    def one(r):
        url = f"{IRSA}/{r['uri']}?" + f"center={cra:.6f},{cdec:.6f}&size={size:.4f}"
        try:
            body, ver = slim_cutout(get(url))
        except Exception as e:
            log("   skip", r["uri"][-60:], e); return None
        fn = f"{r['mjd']:.5f}_D{r['det']}.fits.gz"
        with open(os.path.join(d, fn), "wb") as f:
            f.write(body)
        return dict(file=fn, uri=r["uri"], mjd=r["mjd"], det=r["det"], rel=r["rel"], version=ver, bytes=len(body))

    with ThreadPoolExecutor(6) as ex:
        files = [x for x in ex.map(one, chosen) if x]
    for old in os.listdir(d):  # drop cutouts from an earlier run that are no longer selected
        if old.endswith(".fits.gz") and old not in {f["file"] for f in files}:
            os.remove(os.path.join(d, old))
    cats = {}
    r = fov_arcmin / 60 * 0.75 + 0.02
    for name, table, cols, extra in (("gaia", "I/355/gaiadr3", '"RA_ICRS","DE_ICRS","pmRA","pmDE","Plx","Gmag"', 'AND "Gmag"<20.5'),
                                     ("wise", "II/328/allwise", '"RAJ2000","DEJ2000","W1mag","W2mag"', 'AND "W2mag"<16.5')):
        try:
            text = fetch_catalog(table, cols, cra, cdec, r, extra)   # download first: never leave an empty file behind
            with open(os.path.join(d, name + ".csv"), "w") as f:
                f.write(text)
            cats[name] = name + ".csv"
        except Exception as e:
            log(f"   {name} catalogue failed:", e)
            if os.path.exists(os.path.join(d, name + ".csv")):
                cats[name] = name + ".csv"   # keep the copy from an earlier run
    man = dict(name=t["name"], center=[cra, cdec], fov_arcmin=fov_arcmin, generated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               archive_exposures=len(rows), releases=sorted({f["rel"] for f in files}), files=sorted(files, key=lambda f: f["mjd"]), **cats)
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
    mb = sum(f["bytes"] for f in files) / 1e6
    log(f"   saved {len(files)} cutouts ({mb:.1f} MB), releases {man['releases']}")
    return man


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated slugs: " + ",".join(t["slug"] for t in TARGETS))
    ap.add_argument("--per", type=int, default=3, help="exposures per detector per season (default 3)")
    ap.add_argument("--fov", type=float, default=8, help="cutout field of view in arcmin (default 8)")
    ap.add_argument("--missing", action="store_true", help="only fetch targets that have no data yet (resume after archive outages)")
    ap.add_argument("--reindex", action="store_true", help="rebuild demo/index.json from the manifests on disk, without downloading")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    os.makedirs(ROOT, exist_ok=True)
    idx_path = os.path.join(ROOT, "index.json")
    index = json.load(open(idx_path)) if os.path.exists(idx_path) else {"targets": {}}

    def save_index():  # written after every target, so the app can use finished targets while others download
        index["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(idx_path, "w") as f:
            json.dump(index, f, indent=1)

    if a.reindex:
        for t in TARGETS:
            mp = os.path.join(ROOT, t["slug"], "manifest.json")
            if os.path.exists(mp):
                m = json.load(open(mp))
                index["targets"][t["slug"]] = dict(name=t["name"], files=len(m["files"]), generated=m["generated"], releases=m["releases"], fov_arcmin=m["fov_arcmin"])
        save_index(); log(f"Reindexed: {sorted(index['targets'])}"); return
    for t in TARGETS:
        if only and t["slug"] not in only:
            continue
        if a.missing and index["targets"].get(t["slug"], {}).get("files", 0) > 0:
            continue
        try:
            m = build(t, a.per, a.fov)
            index["targets"][t["slug"]] = dict(name=t["name"], files=len(m["files"]), generated=m["generated"], releases=m["releases"], fov_arcmin=a.fov)
            save_index()
        except Exception as e:
            log(f"   FAILED {t['name']}: {e}")
    save_index()
    log(f"\nWrote {idx_path}")


if __name__ == "__main__":
    sys.exit(main())
