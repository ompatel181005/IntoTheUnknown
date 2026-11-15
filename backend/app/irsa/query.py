"""SPHEREx frame query: SIA first, TAP fallback, release dedupe. From docs/skeletons/query.py."""

import concurrent.futures as cf
import contextvars
import re
import threading
import time
from contextlib import contextmanager

import astropy.units as u
from astropy.coordinates import SkyCoord
from astroquery.ipac.irsa import Irsa
from pyvo.dal import SIA2Service, TAPService
from requests import Session

from ..telemetry import operation

COLL_RE = re.compile(r"^spherex_(dr|qr)(\d+)(_deep)?$")  # drops spherex_dr1_cube etc.
PROC_RE = re.compile(r"-(\d{4})-(\d{3})\.fits$")  # processing year-doy in filename
METADATA_TIMEOUT_S = 30
# A timed-out caller cannot kill a thread inside a third-party parser. Never queue
# more work behind it: fixed admission and daemon workers bound that failure mode.
_metadata_slots = threading.BoundedSemaphore(4)
_collection_lock = threading.Lock()


class MetadataSession(Session):
    """PyVO accepts a requests session; its default session supplies no timeout."""

    def __init__(self):
        super().__init__()
        self.responses = []

    def send(self, request, **kwargs):
        kwargs["timeout"] = (5, 20)  # connection and socket read; outer deadline includes parsing
        response = super().send(request, **kwargs)
        self.responses.append(response)
        return response

    def close(self):
        for response in self.responses:
            response.close()
        super().close()


@contextmanager
def metadata_service(kind):
    with MetadataSession() as session:
        yield (
            SIA2Service(Irsa.sia_url, session=session, check_baseurl=False)
            if kind == "sia"
            else TAPService(Irsa.tap_url, session=session)
        )


def bounded_metadata(function):
    """Return or fail within the wall-clock budget, with no executor shutdown wait."""
    import functools

    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        slots = _metadata_slots
        if not slots.acquire(blocking=False):
            raise TimeoutError("Archive metadata workers are busy; retry later")
        result = cf.Future()
        context = contextvars.copy_context()

        def run():
            try:
                result.set_result(context.run(function, *args, **kwargs))
            except BaseException as error:
                result.set_exception(error)
            finally:
                slots.release()

        try:
            threading.Thread(target=run, name="irsa-metadata", daemon=True).start()
        except BaseException:
            slots.release()
            raise
        return result.result(timeout=METADATA_TIMEOUT_S)

    return wrapped


def priority(coll: str) -> tuple[int, int]:
    kind, num, _ = COLL_RE.match(coll).groups()
    return (1 if kind == "dr" else 0, int(num))  # DR beats QR, newer beats older


@operation("IRSA", "collections")
@bounded_metadata
def discover_collections() -> list[str]:
    # Same collection query used by astroquery, with a timeout-aware PyVO session.
    with metadata_service("tap") as service:
        tbl = service.run_sync(
            "SELECT DISTINCT o.collection FROM caom.observation o "
            "JOIN caom.plane p ON o.obsid = p.obsid "
            "WHERE (p.dataproducttype = 'image' OR p.dataproducttype = 'cube') order by collection"
        ).to_table()
    names = [str(n) for n in tbl["collection"]]  # confirm column name on first run
    return sorted((n for n in names if COLL_RE.match(n)), key=priority, reverse=True)


FALLBACK_COLLECTIONS = ["spherex_dr1", "spherex_qr3"]  # list_collections is TAP-backed (DECISIONS 2026-11-14)
_collections = {"at": 0.0, "names": FALLBACK_COLLECTIONS}


def collections(ttl_s: float = 3600) -> list[str]:
    """Stale-while-refresh names: discovery never adds a third wait to SIA/TAP."""
    state = _collections

    def refresh():
        try:
            names = discover_collections() or FALLBACK_COLLECTIONS
        except Exception:
            names = FALLBACK_COLLECTIONS
        with _collection_lock:
            state.update(names=names)

    with _collection_lock:
        if time.monotonic() - state["at"] > ttl_s or not state["at"]:
            state["at"] = time.monotonic()
            threading.Thread(target=contextvars.copy_context().run, args=(refresh,), daemon=True).start()
        return list(state["names"] or FALLBACK_COLLECTIONS)


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
@bounded_metadata
def query_frames_sia(ra: float, dec: float, collections: list[str]) -> list[dict]:
    with metadata_service("sia") as service:
        t = service.search(pos=(SkyCoord(ra, dec, unit="deg"), 1 * u.arcsec), collection=collections).to_table()
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
@bounded_metadata
def query_frames_tap(ra: float, dec: float) -> list[dict]:  # fresher than SIA (no ~1-day lag), slower
    with metadata_service("tap") as service:
        t = service.run_sync(TAP_SQL.format(ra=ra, dec=dec)).to_table()
    rows = [{"url": str(r["url"]), "t_mjd": float(r["t_mjd"]), "band": str(r["band"])} for r in t]
    for r in rows:  # .../ibe/data/spherex/<rel>/level2/...
        r["collection"] = "spherex_" + r["url"].split("/spherex/", 1)[1].split("/", 1)[0]
    return dedupe([r for r in rows if COLL_RE.match(r["collection"])])
