"""SPHEREx new-data watcher (Azure Functions, Python v2 model, Flex Consumption).

Daily at 06:00 UTC, and on demand through POST /api/run-now, it asks IRSA which
SPHEREx collections exist (TAP) and the newest frame start at a few fixed
positions (SIA), keeps its state in the private state/watcher.json, publishes
frames/meta/catalog.json, and asks the API to refresh cached views until the API
has accepted the current catalog version. It reads IRSA only (no AWS mirror).
See docs/PLAN.md §4.5 and docs/DECISIONS.md.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import logging
import math
import os
import re
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from concurrent.futures import TimeoutError as FutureTimeout
from typing import NamedTuple

import azure.functions as func
import requests
from azure.core import MatchConditions
from azure.core.exceptions import (
    AzureError,
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)
# Propagates to the root handler the Functions worker sends to App Insights.
log = logging.getLogger(__name__)

COLL_RE = re.compile(r"^spherex_(dr|qr)\d+(_deep)?$")  # drops e.g. spherex_dr1_cube

# What the watcher guarantees, which is narrower than "any new SPHEREx data": it
# detects new releases (the collection list) and new frames at these positions.
# SPHEREx observes the ecliptic poles continuously, so their newest frame tracks
# ingest; the five pinned targets make a new frame at any pinned view count.
# Frames elsewhere on the sky are not seen. TAP MAX(time_bounds_lower) over
# spherex.plane would see everything, but it is unindexed and timed out at 300 s
# (docs/DECISIONS.md). The SIA index lags ingest by about a day, which is fine
# for a daily watcher.
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
POSITIONS = {  # (ra, dec) in degrees
    "nep": (270.0, 66.56),
    "sep": (90.0, -66.56),
    "barnard": (269.44630, 4.76815),
    "eps_ind_b": (331.09656, -56.80064),
    "wise0855": (133.75995, -7.24228),
    "rw_aur": (76.95609, 30.40113),
    "r_dra": (248.16723, 66.75502),
}
POSITION_RADIUS_DEG = 0.01
SIA_MAXREC = 2000
SIA_MAX_PAGES = 10
OVERLAP_DAYS = 2.0  # each position's TIME lower bound = its stored newest minus this
FIRST_RUN_LOOKBACK_DAYS = 60.0
MJD_EPOCH = dt.datetime(1858, 11, 17, tzinfo=dt.UTC)

# The private blob is the source of truth; the public one is derived each run.
STATE_CONTAINER, STATE_BLOB = "state", "watcher.json"
PUBLIC_CONTAINER, PUBLIC_BLOB = "frames", "meta/catalog.json"
PUBLIC_FIELDS = ("catalog_version", "collections", "latest_frame_mjd", "checked_at")
CACHE_CONTROL = "public, max-age=60"
STATE_SCHEMA = 1
WRITE_ATTEMPTS = 3  # optimistic-concurrency retries on the private blob

DEFAULT_IRSA_TIMEOUT_S = 120.0
MAX_IRSA_TIMEOUT_S = 150.0
# run-now must answer within the 230 s HTTP limit: the handler gives up at
# RUN_NOW_BUDGET_S, and the stages plan to finish RUN_NOW_MARGIN_S before that.
RUN_NOW_BUDGET_S = 200.0
RUN_NOW_MARGIN_S = 15.0
TIMER_BUDGET_S = 540.0  # under functionTimeout (10 min) in host.json
# (connect, read) caps in seconds, cut further to what is left of the budget.
# Container Apps holds a request while it scales up from zero.
REFRESH_TIMEOUT = (10, 60)


class WatcherError(Exception):
    """An expected failure: reported as JSON, never raised out of a trigger."""

    code = "WATCHER_ERROR"
    http_status = 500


class ConfigError(WatcherError):
    code = "CONFIG_ERROR"


class StorageError(WatcherError):
    code = "STORAGE_ERROR"


class IrsaError(WatcherError):
    code = "IRSA_DOWN"
    http_status = 502


class RefreshError(WatcherError):
    code = "REFRESH_FAILED"
    http_status = 502


class _Conflict(Exception):
    """Someone else wrote the private blob since we read it (HTTP 412/409)."""


class Config(NamedTuple):
    api_base: str
    refresh_key: str
    storage_account_url: str
    irsa_timeout_s: float


class Stored(NamedTuple):
    state: dict
    etag: str | None  # None: the blob doesn't exist yet


# --- Pure core -----------------------------------------------------------------


def mjd(t: dt.datetime) -> float:
    return (t - MJD_EPOCH).total_seconds() / 86400


def _finite(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _positions(state: dict) -> dict:
    positions = state.get("positions")
    return positions if isinstance(positions, dict) else {}


def lower_bounds(old: dict, now_mjd: float) -> dict[str, float]:
    """SIA TIME lower bound per position: its stored newest frame minus 2 days,
    or 60 days back from now when nothing is stored for it."""
    stored = _positions(old)
    bounds = {}
    for label in POSITIONS:
        newest = _finite(stored.get(label))
        if newest is None:
            bounds[label] = now_mjd - FIRST_RUN_LOOKBACK_DAYS
        else:
            bounds[label] = newest - OVERLAP_DAYS
    return bounds


def catalog_version(collections: list[str], positions: dict) -> str:
    """Content address of the catalog: same catalog, same version; any change, new.

    json.dumps writes floats with repr, which round-trips exactly, so frames that
    land later on the same day still change the version.
    """
    payload = json.dumps(
        {"collections": sorted(collections), "positions": positions},
        sort_keys=True,
        separators=(",", ":"),
    )
    return "c" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def decide(
    old: dict, collections: list[str], newest: dict, now: str
) -> tuple[dict, bool]:
    """Return (new_state, should_refresh) from the stored state and IRSA's answer.

    newest maps each position that answered to its newest frame start (MJD), or
    None if SIA had no frames there since the lower bound. A position that is
    missing or None keeps its stored value, and stored values only move forward,
    so a failed position, an empty answer or a race can't move time backwards.

    should_refresh stays True until the API has accepted this exact version
    (notified_version), so a failed POST is retried on later runs. Any content
    change counts, including a collection removed or renamed.
    """
    names = sorted(set(collections))
    stored = _positions(old)
    positions = {}
    for label in sorted(set(POSITIONS) | set(newest)):
        known = [_finite(stored.get(label)), _finite(newest.get(label))]
        known = [v for v in known if v is not None]
        positions[label] = max(known) if known else None
    times = [v for v in positions.values() if v is not None]
    version = catalog_version(names, positions)
    notified = old.get("notified_version")
    new = {
        "schema": STATE_SCHEMA,
        "catalog_version": version,
        "collections": names,
        "latest_frame_mjd": max(times) if times else None,
        "positions": positions,
        "checked_at": now,
        "notified_version": notified,
        "refresh_pending": version != notified,
    }
    return new, new["refresh_pending"]


def mark_notified(state: dict, version: str) -> dict:
    """The API returned 2xx for `version`. If a newer version was written in the
    meantime, it stays pending."""
    if state.get("notified_version") == state.get("catalog_version"):
        return state  # already up to date, maybe by a concurrent run
    return {
        **state,
        "notified_version": version,
        "refresh_pending": state.get("catalog_version") != version,
    }


def public_view(state: dict) -> dict:
    return {name: state.get(name) for name in PUBLIC_FIELDS}


# --- Config --------------------------------------------------------------------


def load_config() -> Config:
    names = ("API_BASE", "REFRESH_KEY", "STORAGE_ACCOUNT_URL")
    values = {n: os.environ.get(n, "").strip() for n in names}
    missing = [n for n in names if not values[n]]
    if missing:
        raise ConfigError("missing app settings: " + ", ".join(missing))
    raw = os.environ.get("IRSA_TIMEOUT_S", "").strip()
    try:
        timeout = float(raw) if raw else DEFAULT_IRSA_TIMEOUT_S
    except ValueError:
        timeout = math.nan
    if not (math.isfinite(timeout) and timeout > 0):
        raise ConfigError("IRSA_TIMEOUT_S must be a positive number of seconds")
    if timeout > MAX_IRSA_TIMEOUT_S:
        log.warning(
            "watcher: IRSA_TIMEOUT_S=%g is over %g s; using %g s so run-now fits "
            "the 230 s HTTP limit",
            timeout,
            MAX_IRSA_TIMEOUT_S,
            MAX_IRSA_TIMEOUT_S,
        )
        timeout = MAX_IRSA_TIMEOUT_S
    return Config(
        values["API_BASE"].rstrip("/"),
        values["REFRESH_KEY"],
        values["STORAGE_ACCOUNT_URL"],
        timeout,
    )


# --- IRSA ----------------------------------------------------------------------


class _TimeoutSession(requests.Session):
    """A Session with a default timeout; pyvo's TAP POST passes none."""

    def __init__(self, timeout: float):
        super().__init__()
        self.default_timeout = timeout

    def request(self, method, url, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = self.default_timeout
        return super().request(method, url, **kwargs)


def _irsa_client(timeout: float):
    """A fresh astroquery IRSA client (own session, so safe to use per thread)."""
    # Lazy: astropy is slow to import and Flex gives app start-up 30 s.
    from astroquery.ipac.irsa import IrsaClass

    client = IrsaClass()
    session = _TimeoutSession(timeout)
    session.headers.update(client._session.headers)  # keep astroquery's User-Agent
    client._session = session  # .tap is built lazily from this session
    return client


def _list_collections(client) -> list[str]:
    table = client.list_collections(servicetype="SIA", filter="spherex")
    return sorted({n for n in map(str, table["collection"]) if COLL_RE.match(n)})


def _sia_t_mins(
    ra: float, dec: float, collections: list[str], since: float, timeout: float
) -> list[float]:
    """One SIA query: the finite t_min values of the rows returned."""
    params = [
        ("POS", f"CIRCLE {ra} {dec} {POSITION_RADIUS_DEG}"),
        ("TIME", f"{float(since)!r} +Inf"),  # SIA v2 TIME is an MJD interval
        *(("COLLECTION", name) for name in collections),
        ("RESPONSEFORMAT", "csv"),
        ("MAXREC", str(SIA_MAXREC)),
    ]
    resp = requests.get(SIA_URL, params=params, timeout=timeout)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    # IRSA's proxy can send an HTML error page; csv would read it as rows.
    if not reader.fieldnames or "t_min" not in reader.fieldnames:
        raise IrsaError("SIA answer is not CSV with a t_min column")
    t_mins = []
    for row in reader:
        try:
            value = float(row["t_min"])
        except (TypeError, ValueError):
            continue
        if math.isfinite(value):
            t_mins.append(value)
    return t_mins


def _position_newest(
    ra: float, dec: float, collections: list[str], since: float, deadline: float
) -> float | None:
    """Newest t_min at one position from `since` on, or None if SIA has none.

    A short page doesn't prove the answer is complete (the server may cap below
    MAXREC), and SIA doesn't sort its answer (checked 2026-11-14). So keep asking
    from the newest t_min seen until a page brings nothing newer.
    """
    newest = None
    for _ in range(SIA_MAX_PAGES):
        left = deadline - time.monotonic()
        if left <= 0:
            raise IrsaError("deadline passed while paging SIA")
        page = max(_sia_t_mins(ra, dec, collections, since, left), default=None)
        if page is None or (newest is not None and page <= newest):
            return newest
        newest = page
        since = max(since, page)
    raise IrsaError(f"SIA still had newer frames after {SIA_MAX_PAGES} pages")


def _describe(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {str(exc)[:300]}"


def _list_phase(pool, client, deadline: float, timeout: float) -> list[str]:
    job = pool.submit(_list_collections, client)
    if wait([job], timeout=max(0.0, deadline - time.monotonic())).not_done:
        raise IrsaError(f"list_collections: no answer within {timeout:g} s")
    try:
        names = job.result()
    except Exception as exc:  # pyvo, astropy and requests all raise their own types
        raise IrsaError(f"list_collections: {_describe(exc)}") from exc
    if not names:
        # More likely a partial outage than SPHEREx withdrawing every release.
        raise IrsaError("IRSA listed no SPHEREx collections")
    return names


def fetch_catalog(timeout: float, bounds: dict[str, float]) -> tuple[list[str], dict]:
    """Ask IRSA for the SPHEREx collections, then for the newest frame start at
    each position from its lower bound on.

    Returns (collections, {position: newest MJD or None}) for the positions that
    answered. The position queries run in parallel; one answer is enough. The
    whole call has one wall-clock deadline of `timeout`, and each HTTP call a
    socket timeout. If list_collections fails, or no position answers, it
    raises IrsaError.
    """
    deadline = time.monotonic() + timeout
    # Built here, not in the pool, so an import error isn't reported as IRSA_DOWN.
    lister = _irsa_client(timeout)
    pool = ThreadPoolExecutor(max_workers=1 + len(POSITIONS), thread_name_prefix="irsa")
    try:
        names = _list_phase(pool, lister, deadline, timeout)
        jobs: dict[str, Future] = {
            label: pool.submit(
                _position_newest, ra, dec, names, bounds[label], deadline
            )
            for label, (ra, dec) in POSITIONS.items()
        }
        wait(jobs.values(), timeout=max(0.0, deadline - time.monotonic()))
    finally:
        # Don't wait: a hung call ends on its own when its socket timeout fires.
        pool.shutdown(wait=False, cancel_futures=True)
    answers, failures = {}, []
    for label, job in jobs.items():
        if not job.done():
            failures.append(f"{label}: no answer within {timeout:g} s")
        elif job.exception() is not None:
            failures.append(f"{label}: {_describe(job.exception())}")
        else:
            answers[label] = job.result()
    if not answers:
        raise IrsaError("no SIA position answered: " + "; ".join(failures))
    if failures:
        log.warning("watcher: SIA position failed: %s", "; ".join(failures))
    log.info(
        "watcher: IRSA answered in %.1f s; newest frame per position: %s",
        timeout - (deadline - time.monotonic()),
        answers,
    )
    return names, answers


# --- Storage -------------------------------------------------------------------


def _blobs(account_url: str) -> tuple[BlobClient, BlobClient]:
    """(private state blob, public catalog blob)."""
    credential = DefaultAzureCredential()

    def client(container: str, name: str) -> BlobClient:
        return BlobClient(
            account_url,
            container,
            name,
            credential=credential,
            connection_timeout=5,
            read_timeout=15,
            retry_total=1,
        )

    return client(STATE_CONTAINER, STATE_BLOB), client(PUBLIC_CONTAINER, PUBLIC_BLOB)


def read_state(blob: BlobClient) -> Stored:
    try:
        download = blob.download_blob()
        raw = download.readall()
    except ResourceNotFoundError:
        return Stored({}, None)  # first run
    except AzureError as exc:
        # Don't fall back to {}: that would overwrite good state on a transient error.
        raise StorageError(
            f"could not read {STATE_BLOB}: {type(exc).__name__}"
        ) from exc
    try:
        state = json.loads(raw)
    except ValueError:
        state = None
    if not isinstance(state, dict):
        # Don't start over: a reset would forget what the API was already told.
        raise StorageError(f"{STATE_BLOB} is not a JSON object; fix or delete it")
    return Stored(state, download.properties.etag)


def write_state(blob: BlobClient, state: dict, etag: str | None) -> str:
    """Write only if the blob is unchanged since it was read (If-Match), or still
    missing on first create (If-None-Match: *). Returns the new ETag."""
    if etag:
        condition = {"etag": etag, "match_condition": MatchConditions.IfNotModified}
    else:
        condition = {"match_condition": MatchConditions.IfMissing}
    try:
        result = blob.upload_blob(
            json.dumps(state, separators=(",", ":")),
            overwrite=True,
            content_settings=ContentSettings(content_type="application/json"),
            **condition,
        )
    except (ResourceModifiedError, ResourceExistsError) as exc:
        raise _Conflict from exc
    except AzureError as exc:
        raise StorageError(
            f"could not write {STATE_BLOB}: {type(exc).__name__}"
        ) from exc
    return result["etag"]


def update_state(
    blob: BlobClient, stored: Stored, change: Callable[[dict], dict]
) -> Stored:
    """Apply change() to the private state with optimistic concurrency. On a
    conflict, re-read and apply change() to the fresh state, a bounded number
    of times. change() merges, so a race can't lose a newer value."""
    for _ in range(WRITE_ATTEMPTS):
        new = change(stored.state)
        if new == stored.state and stored.etag:
            return stored
        try:
            return Stored(new, write_state(blob, new, stored.etag))
        except _Conflict:
            log.warning("watcher: %s changed under us; re-reading", STATE_BLOB)
            stored = read_state(blob)
    raise StorageError(f"{STATE_BLOB} kept changing; gave up after {WRITE_ATTEMPTS}")


def write_public(blob: BlobClient, state: dict) -> None:
    try:
        blob.upload_blob(
            json.dumps(public_view(state), separators=(",", ":")),
            overwrite=True,
            content_settings=ContentSettings(
                content_type="application/json", cache_control=CACHE_CONTROL
            ),
        )
    except AzureError as exc:
        raise StorageError(
            f"could not write {PUBLIC_BLOB}: {type(exc).__name__}"
        ) from exc


# --- API -----------------------------------------------------------------------


def post_refresh(cfg: Config, version: str, deadline: float) -> None:
    """POST /internal/refresh. Anything but a 2xx is a RefreshError."""
    left = deadline - time.monotonic()
    if left < 1:
        raise RefreshError("no time left in the run budget")
    timeout = (min(REFRESH_TIMEOUT[0], left), min(REFRESH_TIMEOUT[1], left))
    try:
        resp = requests.post(
            f"{cfg.api_base}/internal/refresh",
            json={"reason": "catalog_change", "catalog_version": version},
            headers={"X-Refresh-Key": cfg.refresh_key},  # never logged
            timeout=timeout,
            allow_redirects=False,
        )
        resp.raise_for_status()
    except requests.HTTPError as exc:
        raise RefreshError(f"API answered HTTP {exc.response.status_code}") from exc
    except requests.RequestException as exc:
        raise RefreshError(f"API unreachable: {type(exc).__name__}") from exc
    if not 200 <= resp.status_code < 300:  # raise_for_status lets 3xx through
        raise RefreshError(f"API answered HTTP {resp.status_code}")
    log.info(
        "watcher: API accepted refresh for %s (HTTP %s)", version, resp.status_code
    )


def _notify(cfg: Config, blob: BlobClient, stored: Stored, deadline: float) -> Stored:
    version = stored.state["catalog_version"]
    post_refresh(cfg, version, deadline)
    return update_state(blob, stored, lambda s: mark_notified(s, version))


# --- One run -------------------------------------------------------------------


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _body(ok: bool, state: dict | None, **extra) -> dict:
    return {
        "ok": ok,
        **extra,
        "refresh_pending": bool(state and state.get("refresh_pending")),
        "catalog": public_view(state) if state else None,
    }


def check_catalog(
    now: dt.datetime | None = None, budget_s: float = TIMER_BUDGET_S
) -> tuple[int, dict]:
    """One watcher run within budget_s seconds. Returns (http_status, body) and
    never raises.

    1. Read the private state. If a refresh is pending, POST it first, so an API
       outage followed by an IRSA outage still gets the refresh retried.
    2. Ask IRSA. If that fails, write nothing more: checked_at keeps meaning
       "last successful check".
    3. Write the private state (If-Match), then the public projection.
    4. If the API hasn't accepted this version, POST it and record that it did.
    """
    deadline = time.monotonic() + budget_s
    now = now or _utc_now()
    state = None  # private state as it now stands, for the response
    refresh_sent = False
    try:
        cfg = load_config()
        private, public = _blobs(cfg.storage_account_url)
        stored = read_state(private)
        state = stored.state
        early_error = None
        if state.get("refresh_pending") and state.get("catalog_version"):
            try:
                stored = _notify(cfg, private, stored, deadline)
                state, refresh_sent = stored.state, True
            except RefreshError as exc:
                log.warning("watcher: retry of pending refresh failed: %s", exc)
                early_error = exc  # still check IRSA; report this at the end
        irsa_timeout = min(cfg.irsa_timeout_s, deadline - time.monotonic())
        if irsa_timeout <= 0:
            raise IrsaError("no time left in the run budget for IRSA")
        collections, newest = fetch_catalog(irsa_timeout, lower_bounds(state, mjd(now)))
        checked_at = now.isoformat(timespec="seconds")
        before = state.get("catalog_version")
        stored = update_state(
            private, stored, lambda s: decide(s, collections, newest, checked_at)[0]
        )
        state = stored.state
        write_public(public, state)  # the API may read it while refreshing
        changed = state["catalog_version"] != before
        if early_error:
            raise early_error  # don't POST again to an API that just failed
        if state["refresh_pending"]:
            stored = _notify(cfg, private, stored, deadline)
            state, refresh_sent = stored.state, True
    except WatcherError as exc:
        log.error("watcher: %s: %s", exc.code, exc)
        error = {"code": exc.code, "message": str(exc)}
        return exc.http_status, _body(
            False, state, error=error, refresh_sent=refresh_sent
        )
    except Exception:
        log.exception("watcher: unexpected error")
        error = {"code": "INTERNAL", "message": "see logs"}
        return 500, _body(False, state, error=error, refresh_sent=refresh_sent)
    log.info(
        "watcher: version=%s changed=%s refresh_sent=%s",
        state["catalog_version"],
        changed,
        refresh_sent,
    )
    return 200, _body(True, state, changed=changed, refresh_sent=refresh_sent)


# --- Triggers ------------------------------------------------------------------


# Flex has no WEBSITE_TIME_ZONE, so the schedule is UTC. use_monitor keeps the
# schedule in AzureWebJobsStorage, so a run missed during a restart still happens.
@app.timer_trigger(
    schedule="0 0 6 * * *", arg_name="timer", run_on_startup=False, use_monitor=True
)
def new_data_watcher(timer: func.TimerRequest) -> None:
    if timer.past_due:
        log.warning("watcher: timer is past due")
    status, body = check_catalog(budget_s=TIMER_BUDGET_S)
    if status != 200:
        log.error("watcher: timer run failed: %s", json.dumps(body))


def _in_invocation(context, fn, *args):
    # Tie this thread's logs to the invocation in App Insights.
    if context is not None:
        context.thread_local_storage.invocation_id = context.invocation_id
    return fn(*args)


@app.route(route="run-now", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def run_now(req: func.HttpRequest, context: func.Context) -> func.HttpResponse:
    # Runs in a thread so a hang anywhere (credential, Blob, IRSA, API) still
    # gets an answer at RUN_NOW_BUDGET_S. A run cut off here may still finish
    # its writes in the background; they are If-Match guarded.
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="run-now")
    job = pool.submit(
        _in_invocation,
        context,
        check_catalog,
        None,
        RUN_NOW_BUDGET_S - RUN_NOW_MARGIN_S,
    )
    pool.shutdown(wait=False)
    try:
        status, body = job.result(timeout=RUN_NOW_BUDGET_S)
    except FutureTimeout:
        log.error("watcher: run-now passed its %g s budget", RUN_NOW_BUDGET_S)
        status = 504
        error = {
            "code": "BUDGET_EXCEEDED",
            "message": f"no result within {RUN_NOW_BUDGET_S:g} s; see logs",
        }
        body = {"ok": False, "error": error}
    return func.HttpResponse(
        json.dumps(body), status_code=status, mimetype="application/json"
    )
