"""SPHEREx frame query: SIA first, TAP fallback, release dedupe. From docs/skeletons/query.py."""

import re

import astropy.units as u
from astropy.coordinates import SkyCoord
from astroquery.ipac.irsa import Irsa

from ..telemetry import operation

COLL_RE = re.compile(r"^spherex_(dr|qr)(\d+)(_deep)?$")  # drops spherex_dr1_cube etc.
PROC_RE = re.compile(r"-(\d{4})-(\d{3})\.fits$")  # processing year-doy in filename


def priority(coll: str) -> tuple[int, int]:
    kind, num, _ = COLL_RE.match(coll).groups()
    return (1 if kind == "dr" else 0, int(num))  # DR beats QR, newer beats older


@operation("IRSA", "collections")
def discover_collections() -> list[str]:
    tbl = Irsa.list_collections(servicetype="SIA", filter="spherex")
    names = [str(n) for n in tbl["collection"]]  # confirm column name on first run
    return sorted((n for n in names if COLL_RE.match(n)), key=priority, reverse=True)


def _stem(url: str) -> str:  # level2_<obs>_<n>D<det>
    return url.rsplit("/", 1)[1].split("_spx_")[0]


def dedupe(rows: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for r in rows:
        k = _stem(r["url"])
        rank = (priority(r["collection"]), PROC_RE.search(r["url"]).groups() if PROC_RE.search(r["url"]) else ())
        if k not in best or rank > best[k]["_rank"]:
            best[k] = {**r, "obs": k, "_rank": rank}
    return sorted(best.values(), key=lambda r: r["t_mjd"])


@operation("IRSA", "sia")
def query_frames_sia(ra: float, dec: float, collections: list[str]) -> list[dict]:
    t = Irsa.query_sia(pos=(SkyCoord(ra, dec, unit="deg"), 1 * u.arcsec), collection=collections)
    return dedupe(
        [
            {
                "collection": str(r["obs_collection"]),
                "url": str(r["access_url"]),
                "t_mjd": float(r["t_min"]),
                "band": str(r["energy_bandpassname"]),
            }
            for r in t
        ]
    )


TAP_SQL = """
SELECT 'https://irsa.ipac.caltech.edu/' || a.uri AS url, p.time_bounds_lower AS t_mjd,
       p.energy_bandpassname AS band
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
ORDER BY p.time_bounds_lower"""


@operation("IRSA", "tap")
def query_frames_tap(ra: float, dec: float) -> list[dict]:  # fresher than SIA (no ~1-day lag), slower
    t = Irsa.query_tap(TAP_SQL.format(ra=ra, dec=dec)).to_table()
    rows = [{"url": str(r["url"]), "t_mjd": float(r["t_mjd"]), "band": str(r["band"])} for r in t]
    for r in rows:  # .../ibe/data/spherex/<rel>/level2/...
        r["collection"] = "spherex_" + r["url"].split("/spherex/", 1)[1].split("/", 1)[0]
    return dedupe([r for r in rows if COLL_RE.match(r["collection"])])
