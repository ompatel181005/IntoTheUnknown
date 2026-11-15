"""Watcher tests. No network: IRSA (TAP and SIA), Blob and the API are faked."""

import datetime as dt
import json
import logging
import threading
import time
from types import SimpleNamespace

import azure.functions as func
import pytest
import requests
from azure.core import MatchConditions
from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
    ServiceRequestError,
)

import function_app as fa

NOW = dt.datetime(2026, 11, 14, 6, 0, tzinfo=dt.UTC)
LATER = NOW + dt.timedelta(days=1)
NOW_MJD = 61358.25
# What IRSA listed for servicetype=SIA, filter=spherex on 2026-11-14.
LISTED = [
    "spherex_dr1",
    "spherex_dr1_cube",
    "spherex_dr1_deep",
    "spherex_qr3",
    "spherex_qr3_deep",
]
KEPT = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
NEWEST = 61317.97
KEY = "test-refresh-key-123"
POS = {f"CIRCLE {ra} {dec} 0.01": label for label, (ra, dec) in fa.POSITIONS.items()}
CSV_HEADER = "s_ra,s_dec,obs_id,t_min,t_max,obs_collection"
CONTEXT = SimpleNamespace(invocation_id="test", thread_local_storage=SimpleNamespace())


def response(url, status, text):
    resp = requests.Response()
    resp.status_code = status
    resp.url = url
    resp.encoding = "utf-8"
    resp._content = text.encode()
    return resp


def initial_frames():
    frames = {label: [] for label in fa.POSITIONS}
    frames["nep"] = [61300.5, 61310.25, NEWEST]
    frames["sep"] = [61301.0, 61315.5]
    frames["barnard"] = [61305.0]
    return frames


class FakeBlob:
    """A blob with ETags that enforces If-Match / If-None-Match: *."""

    def __init__(self):
        self.data = None
        self.version = 0
        self.uploads = []
        self.read_error = None
        self.read_gate = None
        self.before_upload = []  # callables run (once each) before an upload

    def _etag(self):
        return f'"{self.version}"'

    def download_blob(self):
        if self.read_gate:
            self.read_gate.wait(5)
        if self.read_error:
            raise self.read_error
        if self.data is None:
            raise ResourceNotFoundError("BlobNotFound")
        data, etag = self.data, self._etag()
        return SimpleNamespace(
            readall=lambda: data, properties=SimpleNamespace(etag=etag)
        )

    def upload_blob(
        self, data, overwrite, content_settings, etag=None, match_condition=None
    ):
        assert overwrite
        if self.before_upload:
            self.before_upload.pop(0)(self)
        if match_condition == MatchConditions.IfNotModified and etag != self._etag():
            raise ResourceModifiedError("ConditionNotMet (412)")
        if match_condition == MatchConditions.IfMissing and self.data is not None:
            raise ResourceExistsError("BlobAlreadyExists (409)")
        self.force(data)
        self.uploads.append(
            SimpleNamespace(settings=content_settings, cond=match_condition)
        )
        return {"etag": self._etag()}

    def force(self, data):
        self.data = data.encode() if isinstance(data, str) else data
        self.version += 1

    @property
    def state(self):
        return json.loads(self.data)


class World:
    """IRSA, the API and both blobs as one test double."""

    def __init__(self):
        self.collections = list(LISTED)
        self.frames = initial_frames()  # frame start times (MJD), all spherex_qr3
        self.list_down = False
        self.sia_down = set()  # positions answering HTTP 502
        self.sia_html = set()  # positions answering an HTML page with HTTP 200
        self.sia_cap = None  # server-side row cap, below MAXREC
        self.sia_gate = None  # threading.Event: SIA blocks until set
        self.sia_calls = []
        self.api_status = 202
        self.api_exc = None
        self.posts = []
        self.private = FakeBlob()
        self.public = FakeBlob()

    @property
    def state(self):
        return self.private.state

    # astroquery IrsaClass stand-in (TAP list_collections)
    def list_collections(self, servicetype, filter):
        assert (servicetype, filter) == ("SIA", "spherex")
        if self.list_down:
            raise requests.HTTPError("502 Server Error: Proxy Error")
        return {"collection": list(self.collections)}

    # requests.get stand-in (SIA)
    def get(self, url, params, timeout):
        assert url == fa.SIA_URL
        p = {}
        for name, value in params:
            p.setdefault(name, []).append(value)
        since, upper = p["TIME"][0].split()
        call = SimpleNamespace(
            position=POS[p["POS"][0]],
            since=float(since),
            upper=upper,
            collections=p.get("COLLECTION", []),
            format=p["RESPONSEFORMAT"],
            maxrec=int(p["MAXREC"][0]),
            timeout=timeout,
        )
        self.sia_calls.append(call)
        if self.sia_gate:
            self.sia_gate.wait(5)
        if call.position in self.sia_down:
            return response(url, 502, "<html>Proxy Error</html>")
        if call.position in self.sia_html:
            return response(url, 200, "<!DOCTYPE HTML>\n<html>Proxy Error</html>\n")
        t = sorted(x for x in self.frames[call.position] if x >= call.since)
        if "spherex_qr3" not in call.collections:
            t = []
        # Ascending and cut off: the cut never holds the newest frame.
        cut = min(call.maxrec, self.sia_cap or call.maxrec)
        lines = [CSV_HEADER] + [
            f"0,0,obs{i},{x!r},{x + 0.001!r},spherex_qr3" for i, x in enumerate(t[:cut])
        ]
        return response(url, 200, "\n".join(lines) + "\n")

    def calls_at(self, position):
        return [c for c in self.sia_calls if c.position == position]

    # requests.post stand-in (the API)
    def post(self, url, **kwargs):
        self.posts.append(SimpleNamespace(url=url, **kwargs))
        if self.api_exc:
            raise self.api_exc
        return response(url, self.api_status, '{"queued":5}')


@pytest.fixture
def world(monkeypatch):
    w = World()
    monkeypatch.setenv("API_BASE", "https://api.example.test/")
    monkeypatch.setenv("REFRESH_KEY", KEY)
    monkeypatch.setenv("STORAGE_ACCOUNT_URL", "https://st.example.test")
    monkeypatch.delenv("IRSA_TIMEOUT_S", raising=False)
    monkeypatch.setattr(fa, "_utc_now", lambda: NOW)
    monkeypatch.setattr(fa, "_blobs", lambda url: (w.private, w.public))
    monkeypatch.setattr(fa, "_irsa_client", lambda timeout: w)
    monkeypatch.setattr(fa.requests, "get", w.get)
    monkeypatch.setattr(fa.requests, "post", w.post)
    return w


def run_now():
    req = func.HttpRequest(method="POST", url="/api/run-now", body=b"")
    resp = fa.run_now(req, CONTEXT)
    assert resp.mimetype == "application/json"
    return resp.status_code, json.loads(resp.get_body())


def expected_positions():
    return {
        label: (max(times) if times else None)
        for label, times in sorted(initial_frames().items())
    }


# --- Normal runs ---------------------------------------------------------------


def test_first_run_writes_private_state_public_view_and_posts(world):
    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["ok"] and body["changed"] and body["refresh_sent"]
    state = world.state
    assert state["collections"] == KEPT  # the All-Sky Cube is not a frame collection
    assert state["positions"] == expected_positions()
    assert state["latest_frame_mjd"] == NEWEST
    assert state["checked_at"] == "2026-11-14T06:00:00+00:00"
    assert state["catalog_version"] == fa.catalog_version(KEPT, expected_positions())
    assert state["notified_version"] == state["catalog_version"]
    assert state["refresh_pending"] is False
    assert world.private.uploads[0].cond == MatchConditions.IfMissing

    public = world.public.state
    assert public == {
        "catalog_version": state["catalog_version"],
        "collections": KEPT,
        "latest_frame_mjd": NEWEST,
        "checked_at": "2026-11-14T06:00:00+00:00",
    }
    assert body["catalog"] == public and body["refresh_pending"] is False
    for upload in world.public.uploads:
        assert upload.settings.content_type == "application/json"
        assert upload.settings.cache_control == "public, max-age=60"

    assert {c.position for c in world.sia_calls} == set(fa.POSITIONS)
    for call in world.sia_calls:
        assert call.since >= NOW_MJD - 60
        assert call.upper == "+Inf"
        assert call.collections == KEPT
        assert call.format == ["csv"] and call.maxrec == 2000
        assert 0 < call.timeout <= 120
    assert [c.since for c in world.calls_at("rw_aur")] == [NOW_MJD - 60]

    (post,) = world.posts
    assert post.url == "https://api.example.test/internal/refresh"
    assert post.headers == {"X-Refresh-Key": KEY}
    assert post.json == {
        "reason": "catalog_change",
        "catalog_version": state["catalog_version"],
    }
    assert post.timeout == fa.REFRESH_TIMEOUT
    assert post.allow_redirects is False


def test_lower_bound_per_position_comes_from_state(world):
    fa.check_catalog(NOW)
    world.sia_calls.clear()

    fa.check_catalog(LATER)

    firsts = {label: world.calls_at(label)[0].since for label in fa.POSITIONS}
    assert firsts["nep"] == NEWEST - 2
    assert firsts["sep"] == 61315.5 - 2
    assert firsts["barnard"] == 61305.0 - 2
    assert firsts["r_dra"] == NOW_MJD + 1 - 60  # nothing stored there yet


def test_no_change_keeps_version_and_does_not_post(world):
    fa.check_catalog(NOW)
    first = world.state

    status, body = run_now()

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.state["catalog_version"] == first["catalog_version"]
    assert world.state["refresh_pending"] is False
    assert len(world.posts) == 1


def test_no_new_frames_keeps_stored_times_and_is_not_an_error(world):
    fa.check_catalog(NOW)
    first = world.state
    world.frames = {label: [] for label in fa.POSITIONS}

    status, body = fa.check_catalog(LATER)

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.state["positions"] == first["positions"]
    assert world.state["catalog_version"] == first["catalog_version"]
    assert world.public.state["checked_at"] == "2026-11-15T06:00:00+00:00"
    assert len(world.posts) == 1


def test_first_run_without_frames_is_not_an_error(world):
    world.frames = {label: [] for label in fa.POSITIONS}

    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["refresh_sent"]
    assert world.state["latest_frame_mjd"] is None
    assert set(world.state["positions"].values()) == {None}


def test_new_frame_at_a_pinned_target_triggers_refresh(world):
    fa.check_catalog(NOW)
    first = world.state
    world.frames["wise0855"].append(61320.0)  # nothing new at the poles

    status, body = fa.check_catalog(LATER)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.state["positions"]["wise0855"] == 61320.0
    assert world.state["catalog_version"] != first["catalog_version"]
    assert len(world.posts) == 2


def test_new_collection_gives_new_version_and_posts(world):
    fa.check_catalog(NOW)
    first = world.state["catalog_version"]
    world.collections.append("spherex_dr2")

    status, body = fa.check_catalog(LATER)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert "spherex_dr2" in world.public.state["collections"]
    assert "spherex_dr2" in world.sia_calls[-1].collections
    assert [p.json["catalog_version"] for p in world.posts] == [
        first,
        world.state["catalog_version"],
    ]


def test_same_day_new_frames_give_new_version(world):
    fa.check_catalog(NOW)
    first = world.state["catalog_version"]
    world.frames["sep"].append(NEWEST + 0.01)  # about 15 minutes later

    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.public.state["latest_frame_mjd"] == NEWEST + 0.01
    assert world.state["catalog_version"] != first
    assert len(world.posts) == 2


@pytest.mark.parametrize(
    "edit",
    [
        lambda c: c.remove("spherex_qr3_deep"),  # shrinks
        lambda c: c.__setitem__(c.index("spherex_qr3"), "spherex_qr4"),  # renamed
    ],
    ids=["shrink", "rename"],
)
def test_shrink_or_rename_counts_as_change(world, edit):
    fa.check_catalog(NOW)
    first = world.state["catalog_version"]
    edit(world.collections)

    status, body = fa.check_catalog(LATER)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.state["catalog_version"] != first
    assert len(world.posts) == 2


def test_one_position_is_enough_and_times_never_go_back(world, caplog):
    world.frames["sep"].append(NEWEST + 0.5)
    fa.check_catalog(NOW)
    world.sia_down = set(fa.POSITIONS) - {"nep"}

    with caplog.at_level(logging.WARNING):
        status, body = fa.check_catalog(LATER)

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.state["positions"]["sep"] == NEWEST + 0.5
    assert world.public.state["latest_frame_mjd"] == NEWEST + 0.5
    assert "sep: HTTPError" in caplog.text


# --- SIA truncation ------------------------------------------------------------


@pytest.mark.parametrize("cap", [None, 500], ids=["maxrec", "server-cap-500"])
def test_truncated_sia_answers_are_followed_up(world, cap):
    world.sia_cap = cap
    world.frames["nep"] = [61300.0 + i * 0.01 for i in range(2500)]

    status, _ = fa.check_catalog(NOW)

    assert status == 200
    assert world.state["positions"]["nep"] == world.frames["nep"][-1]
    sinces = [c.since for c in world.calls_at("nep")]
    assert sinces == sorted(sinces) and len(sinces) >= 3  # ends on "nothing newer"


def test_sia_paging_is_bounded(world, monkeypatch, caplog):
    monkeypatch.setattr(fa, "SIA_MAX_PAGES", 2)
    world.sia_cap = 10
    world.frames["nep"] = [61300.0 + i * 0.01 for i in range(100)]

    with caplog.at_level(logging.WARNING):
        status, _ = fa.check_catalog(NOW)

    assert status == 200  # the other positions answered
    assert world.state["positions"]["nep"] is None
    assert "newer frames after 2 pages" in caplog.text


# --- Failures ------------------------------------------------------------------


@pytest.mark.parametrize("down", ["list", "sia-502", "sia-html"])
def test_irsa_down_leaves_both_blobs_untouched_and_returns_502(world, down):
    fa.check_catalog(NOW)
    private, public = world.private.data, world.public.data
    if down == "list":
        world.list_down = True
    elif down == "sia-502":
        world.sia_down = set(fa.POSITIONS)
    else:
        world.sia_html = set(fa.POSITIONS)
    world.frames["nep"].append(NEWEST + 1)  # would be a change, if IRSA answered

    status, body = run_now()

    assert status == 502 and body["ok"] is False
    assert body["error"]["code"] == "IRSA_DOWN"
    assert body["catalog"] == json.loads(public)  # last good state, for the caller
    assert world.private.data == private and world.public.data == public
    assert len(world.posts) == 1


def test_irsa_hang_is_cut_off_at_the_deadline(world, monkeypatch):
    monkeypatch.setenv("IRSA_TIMEOUT_S", "0.3")
    world.sia_gate = threading.Event()
    try:
        started = time.monotonic()
        status, body = run_now()
        elapsed = time.monotonic() - started
    finally:
        world.sia_gate.set()

    assert status == 502 and body["error"]["code"] == "IRSA_DOWN"
    assert "no SIA position answered" in body["error"]["message"]
    assert "no answer within 0.3 s" in body["error"]["message"]
    assert elapsed < 2
    assert world.private.uploads == [] and world.posts == []


@pytest.mark.parametrize(
    "collections", [[], ["spherex_dr1_cube"]], ids=["none", "only-cube"]
)
def test_no_frame_collections_is_an_error_not_a_change(world, collections):
    world.collections = collections

    status, body = fa.check_catalog(NOW)

    assert status == 502 and body["error"]["code"] == "IRSA_DOWN"
    assert world.sia_calls == [] and world.private.uploads == []


@pytest.mark.parametrize(
    "fail",
    [
        {"api_status": 503},
        {"api_status": 401},
        {"api_status": 302},  # a redirect is not an acknowledgement
        {"api_exc": requests.ConnectTimeout("connect timed out")},
    ],
    ids=["503", "401", "302", "timeout"],
)
def test_failed_post_leaves_refresh_pending_and_next_run_retries(world, fail):
    for name, value in fail.items():
        setattr(world, name, value)

    status, body = run_now()

    assert status == 502 and body["error"]["code"] == "REFRESH_FAILED"
    pending = world.state
    assert pending["refresh_pending"] is True and pending["notified_version"] is None
    assert body["refresh_pending"] is True
    assert "refresh_pending" not in world.public.state  # private fields stay private

    world.api_status, world.api_exc = 202, None  # API is back; IRSA unchanged
    status, body = fa.check_catalog(LATER)

    assert status == 200 and not body["changed"] and body["refresh_sent"]
    assert [p.json["catalog_version"] for p in world.posts] == [
        pending["catalog_version"]
    ] * 2
    assert world.state["notified_version"] == pending["catalog_version"]
    assert world.state["refresh_pending"] is False

    fa.check_catalog(LATER)
    assert len(world.posts) == 2  # acknowledged, so no more POSTs


def test_pending_refresh_is_retried_even_while_irsa_is_down(world):
    world.api_status = 503
    fa.check_catalog(NOW)  # API down: refresh left pending
    pending = world.state["catalog_version"]
    world.api_status = 202
    world.list_down = True  # now IRSA is down instead

    status, body = fa.check_catalog(LATER)

    assert status == 502 and body["error"]["code"] == "IRSA_DOWN"
    assert body["refresh_sent"] is True and body["refresh_pending"] is False
    assert [p.json["catalog_version"] for p in world.posts] == [pending] * 2
    assert world.state["notified_version"] == pending
    assert world.state["refresh_pending"] is False


def test_failed_pending_retry_still_checks_irsa_and_posts_once(world):
    world.api_status = 503
    fa.check_catalog(NOW)
    world.frames["nep"].append(NEWEST + 1)  # and a new frame arrives

    status, body = fa.check_catalog(LATER)

    assert status == 502 and body["error"]["code"] == "REFRESH_FAILED"
    assert len(world.posts) == 2  # the retry only, not a second POST
    assert world.state["positions"]["nep"] == NEWEST + 1  # IRSA was still read
    assert world.state["refresh_pending"] is True


# --- Concurrency (ETag) --------------------------------------------------------


def test_concurrent_write_412_is_merged_and_times_stay_monotonic(world, caplog):
    fa.check_catalog(NOW)
    racer = {**world.state, "positions": {**world.state["positions"]}}
    racer["positions"]["nep"] = NEWEST + 1  # another run saw a newer frame
    racer["catalog_version"] = "c-racer"
    world.private.before_upload = [lambda blob: blob.force(json.dumps(racer))]

    with caplog.at_level(logging.WARNING):
        status, _ = fa.check_catalog(LATER)  # this run saw only NEWEST at nep

    assert status == 200 and "changed under us" in caplog.text
    assert world.state["positions"]["nep"] == NEWEST + 1
    expected = fa.catalog_version(KEPT, world.state["positions"])
    assert world.state["catalog_version"] == expected
    assert world.public.state["latest_frame_mjd"] == NEWEST + 1
    assert world.posts[-1].json["catalog_version"] == expected
    assert world.state["notified_version"] == expected


def test_concurrent_first_create_409_is_retried(world):
    world.private.before_upload = [lambda blob: blob.force(json.dumps({"schema": 1}))]

    status, _ = fa.check_catalog(NOW)

    assert status == 200
    assert world.state["positions"] == expected_positions()


def test_endless_conflicts_give_up_with_storage_error(world):
    fa.check_catalog(NOW)
    world.private.before_upload = [
        lambda blob: blob.force(blob.data) for _ in range(fa.WRITE_ATTEMPTS)
    ]

    status, body = fa.check_catalog(LATER)

    assert status == 500 and body["error"]["code"] == "STORAGE_ERROR"


# --- State and config ----------------------------------------------------------


def test_unreadable_state_is_an_error_not_a_reset(world):
    fa.check_catalog(NOW)
    before = world.private.data
    world.private.read_error = ServiceRequestError("connection reset")

    status, body = fa.check_catalog(LATER)

    assert status == 500 and body["error"]["code"] == "STORAGE_ERROR"
    assert world.private.data == before and len(world.posts) == 1


@pytest.mark.parametrize("raw", [b"not json", b"[1, 2]"], ids=["invalid", "not-object"])
def test_malformed_state_is_an_error_not_a_reset(world, caplog, raw):
    world.private.force(raw)

    status, body = fa.check_catalog(NOW)

    assert status == 500 and body["error"]["code"] == "STORAGE_ERROR"
    assert world.private.data == raw and world.private.uploads == []
    assert world.public.data is None and world.sia_calls == [] and world.posts == []
    assert "watcher.json is not a JSON object" in caplog.text


@pytest.mark.parametrize(
    "env",
    [
        {"REFRESH_KEY": None},
        {"API_BASE": "  "},
        {"IRSA_TIMEOUT_S": "soon"},
        {"IRSA_TIMEOUT_S": "0"},
    ],
)
def test_bad_config_fails_before_any_io(world, monkeypatch, env):
    for name, value in env.items():
        if value is None:
            monkeypatch.delenv(name)
        else:
            monkeypatch.setenv(name, value)
    world.list_down = True  # would show up as IRSA_DOWN if IRSA were called

    status, body = run_now()

    assert status == 500 and body["error"]["code"] == "CONFIG_ERROR"
    assert world.private.uploads == [] and world.posts == []


def test_irsa_timeout_is_clamped_to_150_s(world, monkeypatch, caplog):
    monkeypatch.setenv("IRSA_TIMEOUT_S", "500")

    with caplog.at_level(logging.WARNING):
        cfg = fa.load_config()

    assert cfg.irsa_timeout_s == 150
    assert "IRSA_TIMEOUT_S=500" in caplog.text


# --- Budget --------------------------------------------------------------------


def test_stages_share_the_run_budget(world):
    status, _ = fa.check_catalog(NOW, budget_s=5)

    assert status == 200
    assert all(0 < c.timeout <= 5 for c in world.sia_calls)
    (post,) = world.posts
    assert all(0 < t <= 5 for t in post.timeout)


def test_run_now_answers_within_its_budget_whatever_hangs(world, monkeypatch):
    monkeypatch.setattr(fa, "RUN_NOW_BUDGET_S", 0.5)
    monkeypatch.setattr(fa, "RUN_NOW_MARGIN_S", 0.1)
    world.private.read_gate = threading.Event()  # Blob hangs, not IRSA
    try:
        started = time.monotonic()
        status, body = run_now()
        elapsed = time.monotonic() - started
    finally:
        world.private.read_gate.set()

    assert status == 504 and body["error"]["code"] == "BUDGET_EXCEEDED"
    assert elapsed < 2


def test_run_now_logs_under_the_invocation(world):
    context = SimpleNamespace(
        invocation_id="inv-42", thread_local_storage=SimpleNamespace()
    )
    req = func.HttpRequest(method="POST", url="/api/run-now", body=b"")

    assert fa.run_now(req, context).status_code == 200
    assert context.thread_local_storage.invocation_id == "inv-42"


# --- Misc ----------------------------------------------------------------------


def test_unexpected_error_is_reported_not_raised(world, monkeypatch):
    def boom(*args):
        raise RuntimeError("bug")

    monkeypatch.setattr(fa, "decide", boom)

    status, body = run_now()

    assert status == 500 and body["error"]["code"] == "INTERNAL"


def test_refresh_key_is_never_logged(world, caplog):
    caplog.set_level(logging.DEBUG)
    fa.check_catalog(NOW)
    world.frames["nep"].append(NEWEST + 1)
    world.api_status = 500
    fa.check_catalog(LATER)
    world.sia_down = set(fa.POSITIONS)
    fa.check_catalog(LATER)

    assert caplog.records and KEY not in caplog.text


def test_timer_run_does_not_raise(world, caplog):
    world.list_down = True
    caplog.set_level(logging.WARNING)

    assert fa.new_data_watcher(SimpleNamespace(past_due=True)) is None
    assert "past due" in caplog.text and "IRSA_DOWN" in caplog.text


# --- Pure core -----------------------------------------------------------------


def test_version_is_content_addressed():
    positions = expected_positions()
    v = fa.catalog_version(KEPT, positions)
    assert v == fa.catalog_version(
        list(reversed(KEPT)), dict(reversed(positions.items()))
    )
    assert v.startswith("c") and len(v) == 13
    assert v != fa.catalog_version(KEPT, {**positions, "nep": NEWEST + 1e-6})
    assert v != fa.catalog_version(KEPT, {**positions, "r_dra": 61000.0})
    assert v != fa.catalog_version(KEPT[:-1], positions)


def test_decide_is_pure_and_times_only_move_forward():
    old = {
        "catalog_version": "cold",
        "notified_version": "cold",
        "positions": {"nep": 100.0, "sep": 90.0},
    }
    snapshot = json.loads(json.dumps(old))

    new, should_refresh = fa.decide(old, KEPT[::-1], {"nep": None, "sep": 95.0}, "t1")
    again, _ = fa.decide(old, KEPT, {"sep": 95.0, "nep": None}, "t1")

    assert old == snapshot and new == again
    assert new["positions"]["nep"] == 100.0  # no rows: keep the stored value
    assert new["positions"]["sep"] == 95.0
    assert new["positions"]["r_dra"] is None
    assert new["latest_frame_mjd"] == 100.0
    assert should_refresh and new["notified_version"] == "cold"
    assert fa.decide(old, KEPT, {"nep": 99.0}, "t1")[0]["positions"]["nep"] == 100.0
    notified = fa.mark_notified(new, new["catalog_version"])
    assert fa.decide(notified, KEPT, {}, "t2")[1] is False


def test_mark_notified_keeps_a_newer_version_pending():
    state = {"catalog_version": "c2", "notified_version": None, "refresh_pending": True}
    assert fa.mark_notified(state, "c1") == {**state, "notified_version": "c1"}
    assert fa.mark_notified(state, "c2")["refresh_pending"] is False


def test_lower_bounds_and_mjd():
    assert fa.mjd(dt.datetime(2026, 11, 14, tzinfo=dt.UTC)) == 61358.0
    bounds = fa.lower_bounds({"positions": {"nep": NEWEST, "sep": "x"}}, NOW_MJD)
    assert bounds["nep"] == NEWEST - 2
    assert bounds["sep"] == bounds["barnard"] == NOW_MJD - 60
    assert set(bounds) == set(fa.POSITIONS)


def test_timeout_session_sets_a_default_timeout(monkeypatch):
    seen = []
    monkeypatch.setattr(
        requests.Session, "request", lambda self, m, u, **kw: seen.append(kw)
    )
    session = fa._TimeoutSession(7)

    session.post("https://irsa.example.test/TAP/sync", data={})  # what pyvo does
    session.get("https://irsa.example.test/x", timeout=3)

    assert [kw["timeout"] for kw in seen] == [7, 3]


def test_irsa_client_routes_tap_through_the_timeout_session():
    # Guards the astroquery/pyvo internals the timeout relies on. No network.
    client = fa._irsa_client(5)

    assert isinstance(client._session, fa._TimeoutSession)
    assert client._session.default_timeout == 5
    assert client.tap._session is client._session
    assert "astroquery" in client._session.headers["User-Agent"]


def test_triggers_are_registered():
    triggers = {
        f.get_function_name(): f.get_trigger().get_dict_repr()
        for f in fa.app.get_functions()
    }

    assert set(triggers) == {"new_data_watcher", "run_now"}
    assert triggers["new_data_watcher"]["schedule"] == "0 0 6 * * *"
    assert triggers["new_data_watcher"]["runOnStartup"] is False
    assert triggers["run_now"]["route"] == "run-now"
    assert triggers["run_now"]["authLevel"] == func.AuthLevel.FUNCTION
    assert [m.value for m in triggers["run_now"]["methods"]] == ["POST"]
