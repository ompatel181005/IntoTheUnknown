"""SPHEREx new-data watcher (Azure Functions, Python v2 model, Flex Consumption).

Daily at 06:00 UTC, and on demand through POST /api/run-now, it asks IRSA which
SPHEREx collections exist and when the latest frame starts, compares that with
frames/meta/catalog.json, and asks the API to refresh cached views until the API
has accepted the current catalog version. It reads IRSA only (no AWS mirror).
See docs/PLAN.md §4.5.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import math
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait
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
MAX_T_QUERY = "SELECT MAX(time_bounds_lower) AS t FROM spherex.plane"
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


def catalog_version(collections: list[str], latest_mjd: float) -> str:
    """Content address of the catalog: same catalog, same version; any change, new.

    json.dumps writes floats with repr, which round-trips exactly, so frames that
    land later on the same day still change the version.
    """
    payload = json.dumps([sorted(collections), latest_mjd], separators=(",", ":"))
    return "c" + hashlib.sha256(payload.encode()).hexdigest()[:12]


def decide(
    old: dict, collections: list[str], latest_mjd: float, now: str
) -> tuple[dict, bool]:
    """Return (new_state, should_refresh) from the stored state and IRSA's answer.

    should_refresh stays True until the API has accepted this exact version
    (notified_version), so a failed POST is retried on the next run. Any content
    change counts, including a collection removed or renamed.
    """
    names = sorted(set(collections))
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
    """A Session with a default timeout. pyvo's sync TAP POST passes none."""

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


def _latest_mjd(client) -> float:
    import numpy as np  # comes with astropy

    column = client.query_tap(MAX_T_QUERY).to_table()["t"]
    if len(column) == 0 or np.ma.is_masked(column[0]):
        raise IrsaError("TAP MAX(time_bounds_lower) returned no value")
    value = float(column[0])
    if not math.isfinite(value):
        raise IrsaError(f"TAP MAX(time_bounds_lower) returned {value}")
    return value


def fetch_catalog(timeout: float) -> tuple[list[str], float]:
    """Ask IRSA for the SPHEREx collections and the latest frame start (MJD).

    Each HTTP call has `timeout` as its socket timeout, and both queries run in
    parallel under one wall-clock deadline of `timeout`, so a slow or hung IRSA
    can't keep run-now past the 230 s HTTP limit. Any failure is an IrsaError.
    """
    # Built here, not in the pool, so an import error isn't reported as IRSA_DOWN.
    lister, tapper = _irsa_client(timeout), _irsa_client(timeout)
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="irsa")
    started = time.monotonic()
    try:
        names_job = pool.submit(_list_collections, lister)
        mjd_job = pool.submit(_latest_mjd, tapper)
        _, pending = wait([names_job, mjd_job], timeout=timeout)
        if pending:
            raise IrsaError(f"IRSA did not answer within {timeout:g} s")
        names, latest = names_job.result(), mjd_job.result()
    except IrsaError:
        raise
    except Exception as exc:  # pyvo, astropy and requests all raise their own types
        raise IrsaError(f"{type(exc).__name__}: {str(exc)[:300]}") from exc
    finally:
        # Don't wait: a hung call ends on its own when its socket timeout fires.
        pool.shutdown(wait=False, cancel_futures=True)
    if not names:
        # More likely a partial outage than SPHEREx withdrawing every release.
        raise IrsaError("IRSA listed no SPHEREx collections")
    log.info("watcher: IRSA answered in %.1f s", time.monotonic() - started)
    return names, latest


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


def _utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def check_catalog(now: str | None = None) -> tuple[int, dict]:
    """One watcher run. Returns (http_status, body) and never raises.

    Order: read state, ask IRSA, write the new state, then POST the refresh, then
    record that the API accepted it. If IRSA fails nothing is written, so
    checked_at keeps meaning "last successful check". If the POST fails, the
    blob already says refresh_pending and the next run retries.
    """
    stored = None  # what meta/catalog.json holds now, for the response
    try:
        cfg = load_config()
        blob = _catalog_blob(cfg.storage_account_url)
        old = stored = read_state(blob)
        collections, latest = fetch_catalog(cfg.irsa_timeout_s)
        state, should_refresh = decide(old, collections, latest, now or _utc_now())
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
