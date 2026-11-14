"""SPHEREx new-data watcher (Azure Functions, Python v2 model, Flex Consumption).

Daily at 06:00 UTC, and on demand through POST /api/run-now, it asks IRSA which
SPHEREx collections exist (TAP) and the newest frame start at two sentinel
positions (SIA), compares that with frames/meta/catalog.json, and asks the API to
refresh cached views until the API has accepted the current catalog version. It
reads IRSA only (no AWS mirror). See docs/PLAN.md §4.5 and docs/DECISIONS.md.
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
from concurrent.futures import Future, ThreadPoolExecutor, wait
from typing import NamedTuple

import azure.functions as func
import requests
from azure.core.exceptions import AzureError, ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)
# Propagates to the root handler the Functions worker sends to App Insights.
log = logging.getLogger(__name__)

COLL_RE = re.compile(r"^spherex_(dr|qr)\d+(_deep)?$")  # drops e.g. spherex_dr1_cube
# Newest frame = max(t_min) from SIA at the ecliptic poles, which SPHEREx observes
# continuously, so their newest frame tracks ingest. TAP MAX(time_bounds_lower) on
# spherex.plane is unindexed and timed out at 300 s (docs/DECISIONS.md). The SIA
# index lags ingest by about a day, which is fine for a daily watcher.
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
SENTINELS = {"NEP": (270.0, 66.56), "SEP": (90.0, -66.56)}  # (ra, dec) degrees
SENTINEL_RADIUS_DEG = 0.01
SIA_MAXREC = 2000
SIA_MAX_PAGES = 10
OVERLAP_DAYS = 2.0  # TIME lower bound = stored latest_frame_mjd minus this
FIRST_RUN_LOOKBACK_DAYS = 60.0
MJD_EPOCH = dt.datetime(1858, 11, 17, tzinfo=dt.UTC)
CONTAINER = "frames"
STATE_BLOB = "meta/catalog.json"
CACHE_CONTROL = "public, max-age=60"
STATE_SCHEMA = 1
DEFAULT_IRSA_TIMEOUT_S = 120.0
# (connect, read) seconds. Container Apps holds a request while it scales up from
# zero. IRSA (<= IRSA_TIMEOUT_S) plus this stays under the 230 s HTTP limit.
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


class Config(NamedTuple):
    api_base: str
    refresh_key: str
    storage_account_url: str
    irsa_timeout_s: float


# --- Pure core -----------------------------------------------------------------


def mjd(t: dt.datetime) -> float:
    return (t - MJD_EPOCH).total_seconds() / 86400


def _stored_latest(old: dict) -> float | None:
    value = old.get("latest_frame_mjd")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def time_lower_bound(old: dict, now_mjd: float) -> float:
    """SIA TIME lower bound: the stored latest frame minus a 2-day overlap.

    With no stored value (first run), look back 60 days from now.
    """
    stored = _stored_latest(old)
    if stored is None:
        return now_mjd - FIRST_RUN_LOOKBACK_DAYS
    return stored - OVERLAP_DAYS


def catalog_version(collections: list[str], latest_mjd: float | None) -> str:
    """Content address of the catalog: same catalog, same version; any change, new.

    json.dumps writes floats with repr, which round-trips exactly, so frames that
    land later on the same day still change the version.
    """
    payload = json.dumps([sorted(collections), latest_mjd], separators=(",", ":"))
    return "c" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def decide(
    old: dict, collections: list[str], newest_mjd: float | None, now: str
) -> tuple[dict, bool]:
    """Return (new_state, should_refresh) from the stored state and IRSA's answer.

    newest_mjd is the newest frame start SIA returned this run, or None if it
    returned no frames. SIA is only asked about frames since just before the
    stored value, so latest_frame_mjd only moves forward: no rows means no new
    frames, not an error.

    should_refresh stays True until the API has accepted this exact version
    (notified_version), so a failed POST is retried on the next run. Any content
    change counts, including a collection removed or renamed.
    """
    names = sorted(set(collections))
    known = [v for v in (_stored_latest(old), newest_mjd) if v is not None]
    latest_mjd = max(known) if known else None
    version = catalog_version(names, latest_mjd)
    notified = old.get("notified_version")
    new = {
        "schema": STATE_SCHEMA,
        "catalog_version": version,
        "collections": names,
        "latest_frame_mjd": latest_mjd,
        "checked_at": now,
        "notified_version": notified,
        "refresh_pending": version != notified,
    }
    return new, new["refresh_pending"]


def mark_notified(state: dict) -> dict:
    """The API returned 2xx for state's version."""
    return {
        **state,
        "notified_version": state["catalog_version"],
        "refresh_pending": False,
    }


# --- I/O -----------------------------------------------------------------------


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
    return Config(
        values["API_BASE"].rstrip("/"),
        values["REFRESH_KEY"],
        values["STORAGE_ACCOUNT_URL"],
        timeout,
    )


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
) -> tuple[int, list[float]]:
    """One SIA query: (rows returned, their finite t_min values)."""
    params = [
        ("POS", f"CIRCLE {ra} {dec} {SENTINEL_RADIUS_DEG}"),
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
    rows, t_mins = 0, []
    for row in reader:
        rows += 1
        try:
            value = float(row["t_min"])
        except (TypeError, ValueError):
            continue
        if math.isfinite(value):
            t_mins.append(value)
    return rows, t_mins


def _sentinel_newest(
    ra: float, dec: float, collections: list[str], since: float, deadline: float
) -> float | None:
    """Newest t_min at one sentinel from `since` on, or None if SIA has none.

    SIA doesn't sort its answer (checked 2026-11-14), so a page cut off at MAXREC
    may miss the newest frame. Query again from that page's newest t_min until a
    page comes back short; only then is the max known.
    """
    newest = None
    for _ in range(SIA_MAX_PAGES):
        left = deadline - time.monotonic()
        if left <= 0:
            raise IrsaError("deadline passed while paging SIA")
        rows, t_mins = _sia_t_mins(ra, dec, collections, since, left)
        page_newest = max(t_mins, default=None)
        if page_newest is not None and (newest is None or page_newest > newest):
            newest = page_newest
        if rows < SIA_MAXREC:
            return newest
        if page_newest is None or page_newest <= since:
            raise IrsaError("SIA returned a full page with nothing newer")
        since = page_newest
    raise IrsaError(f"SIA answer still full after {SIA_MAX_PAGES} pages")


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


def fetch_catalog(timeout: float, since: float) -> tuple[list[str], float | None]:
    """Ask IRSA for the SPHEREx collections, then the newest frame start (MJD)
    at the sentinels from `since` on (None if there are no frames since then).

    Each HTTP call has a socket timeout, and the whole run has one wall-clock
    deadline of `timeout`, so a slow or hung IRSA can't keep run-now past the
    230 s HTTP limit. The sentinels run in parallel; one answer is enough. If
    list_collections fails, or no sentinel answers, it raises IrsaError.
    """
    deadline = time.monotonic() + timeout
    # Built here, not in the pool, so an import error isn't reported as IRSA_DOWN.
    lister = _irsa_client(timeout)
    pool = ThreadPoolExecutor(max_workers=1 + len(SENTINELS), thread_name_prefix="irsa")
    try:
        names = _list_phase(pool, lister, deadline, timeout)
        jobs: dict[str, Future] = {
            label: pool.submit(_sentinel_newest, ra, dec, names, since, deadline)
            for label, (ra, dec) in SENTINELS.items()
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
        raise IrsaError("no SIA sentinel answered: " + "; ".join(failures))
    if failures:
        log.warning("watcher: SIA sentinel failed: %s", "; ".join(failures))
    newest = max((v for v in answers.values() if v is not None), default=None)
    log.info(
        "watcher: IRSA answered in %.1f s; newest frame since %.3f: %s",
        timeout - (deadline - time.monotonic()),
        since,
        answers,
    )
    return names, newest


def _catalog_blob(account_url: str) -> BlobClient:
    return BlobClient(
        account_url,
        CONTAINER,
        STATE_BLOB,
        credential=DefaultAzureCredential(),
        connection_timeout=10,
        read_timeout=30,
        retry_total=2,
    )


def read_state(blob: BlobClient) -> dict:
    try:
        raw = blob.download_blob().readall()
    except ResourceNotFoundError:
        return {}  # first run
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
        log.warning("watcher: %s is not a JSON object; starting over", STATE_BLOB)
        return {}
    return state


def write_state(blob: BlobClient, state: dict) -> None:
    try:
        blob.upload_blob(
            json.dumps(state, separators=(",", ":")),
            overwrite=True,
            content_settings=ContentSettings(
                content_type="application/json", cache_control=CACHE_CONTROL
            ),
        )
    except AzureError as exc:
        raise StorageError(
            f"could not write {STATE_BLOB}: {type(exc).__name__}"
        ) from exc


def post_refresh(cfg: Config, version: str) -> None:
    """POST /internal/refresh. Anything but a 2xx is a RefreshError."""
    try:
        resp = requests.post(
            f"{cfg.api_base}/internal/refresh",
            json={"reason": "catalog_change", "catalog_version": version},
            headers={"X-Refresh-Key": cfg.refresh_key},  # never logged
            timeout=REFRESH_TIMEOUT,
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


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def check_catalog(now: dt.datetime | None = None) -> tuple[int, dict]:
    """One watcher run. Returns (http_status, body) and never raises.

    Order: read state, ask IRSA, write the new state, then POST the refresh, then
    record that the API accepted it. If IRSA fails nothing is written, so
    checked_at keeps meaning "last successful check". If the POST fails, the
    blob already says refresh_pending and the next run retries.
    """
    stored = None  # what meta/catalog.json holds now, for the response
    now = now or _utc_now()
    try:
        cfg = load_config()
        blob = _catalog_blob(cfg.storage_account_url)
        old = stored = read_state(blob)
        since = time_lower_bound(old, mjd(now))
        collections, newest = fetch_catalog(cfg.irsa_timeout_s, since)
        checked_at = now.isoformat(timespec="seconds")
        state, should_refresh = decide(old, collections, newest, checked_at)
        changed = state["catalog_version"] != old.get("catalog_version")
        write_state(blob, state)
        stored = state
        if should_refresh:
            post_refresh(cfg, state["catalog_version"])
            state = mark_notified(state)
            write_state(blob, state)
            stored = state
    except WatcherError as exc:
        log.error("watcher: %s: %s", exc.code, exc)
        body = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
        return exc.http_status, {**body, "catalog": stored}
    except Exception:
        log.exception("watcher: unexpected error")
        body = {"ok": False, "error": {"code": "INTERNAL", "message": "see logs"}}
        return 500, {**body, "catalog": stored}
    log.info(
        "watcher: version=%s changed=%s refresh_sent=%s",
        state["catalog_version"],
        changed,
        should_refresh,
    )
    return 200, {
        "ok": True,
        "changed": changed,
        "refresh_sent": should_refresh,
        "catalog": state,
    }


# --- Triggers ------------------------------------------------------------------


# Flex has no WEBSITE_TIME_ZONE, so the schedule is UTC. use_monitor keeps the
# schedule in AzureWebJobsStorage, so a run missed during a restart still happens.
@app.timer_trigger(
    schedule="0 0 6 * * *", arg_name="timer", run_on_startup=False, use_monitor=True
)
def new_data_watcher(timer: func.TimerRequest) -> None:
    if timer.past_due:
        log.warning("watcher: timer is past due")
    status, body = check_catalog()
    if status != 200:
        log.error("watcher: timer run failed: %s", json.dumps(body))


@app.route(route="run-now", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def run_now(req: func.HttpRequest) -> func.HttpResponse:
    status, body = check_catalog()
    return func.HttpResponse(
        json.dumps(body), status_code=status, mimetype="application/json"
    )
