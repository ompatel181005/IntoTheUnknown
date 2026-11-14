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
from azure.core.exceptions import ResourceNotFoundError, ServiceRequestError

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
POS = {"CIRCLE 270.0 66.56 0.01": "NEP", "CIRCLE 90.0 -66.56 0.01": "SEP"}
CSV_HEADER = "s_ra,s_dec,obs_id,t_min,t_max,obs_collection"


def response(url, status, text):
    resp = requests.Response()
    resp.status_code = status
    resp.url = url
    resp.encoding = "utf-8"
    resp._content = text.encode()
    return resp


class FakeBlob:
    def __init__(self):
        self.data = None
        self.uploads = []
        self.read_error = None

    def download_blob(self):
        if self.read_error:
            raise self.read_error
        if self.data is None:
            raise ResourceNotFoundError("BlobNotFound")
        data = self.data
        return SimpleNamespace(readall=lambda: data)

    def upload_blob(self, data, overwrite, content_settings):
        assert overwrite
        self.data = data.encode()
        self.uploads.append(content_settings)

    @property
    def state(self):
        return json.loads(self.data)


class World:
    """IRSA, the API and the blob as one test double."""

    def __init__(self):
        self.collections = list(LISTED)
        # Frame start times (MJD) SIA knows at each pole, all in spherex_qr3.
        self.frames = {"NEP": [61300.5, 61310.25, NEWEST], "SEP": [61301.0, 61315.5]}
        self.list_down = False
        self.sia_down = set()  # sentinels answering HTTP 502
        self.sia_html = set()  # sentinels answering an HTML page with HTTP 200
        self.sia_ignores_time = False
        self.sia_gate = None  # threading.Event: SIA blocks until set
        self.sia_calls = []
        self.api_status = 202
        self.api_exc = None
        self.posts = []
        self.blob = FakeBlob()

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
            sentinel=POS[p["POS"][0]],
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
        if call.sentinel in self.sia_down:
            return response(url, 502, "<html>Proxy Error</html>")
        if call.sentinel in self.sia_html:
            return response(url, 200, "<!DOCTYPE HTML>\n<html>Proxy Error</html>\n")
        t = sorted(self.frames[call.sentinel])
        if not self.sia_ignores_time:
            t = [x for x in t if x >= call.since]
        if "spherex_qr3" not in call.collections:
            t = []
        # Ascending and cut at MAXREC: the cut never holds the newest frame.
        lines = [CSV_HEADER] + [
            f"270,66,obs{i},{x!r},{x + 0.001!r},spherex_qr3"
            for i, x in enumerate(t[: call.maxrec])
        ]
        return response(url, 200, "\n".join(lines) + "\n")

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
    monkeypatch.setattr(fa, "_catalog_blob", lambda url: w.blob)
    monkeypatch.setattr(fa, "_irsa_client", lambda timeout: w)
    monkeypatch.setattr(fa.requests, "get", w.get)
    monkeypatch.setattr(fa.requests, "post", w.post)
    return w


def run_now():
    resp = fa.run_now(func.HttpRequest(method="POST", url="/api/run-now", body=b""))
    assert resp.mimetype == "application/json"
    return resp.status_code, json.loads(resp.get_body())


def test_first_run_asks_both_poles_for_60_days_and_posts_refresh(world):
    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["ok"] and body["changed"] and body["refresh_sent"]
    state = world.blob.state
    assert state["collections"] == KEPT  # the All-Sky Cube is not a frame collection
    assert state["latest_frame_mjd"] == NEWEST
    assert state["checked_at"] == "2026-11-14T06:00:00+00:00"
    assert state["catalog_version"] == fa.catalog_version(KEPT, NEWEST)
    assert state["notified_version"] == state["catalog_version"]
    assert state["refresh_pending"] is False
    assert body["catalog"] == state
    for settings in world.blob.uploads:
        assert settings.content_type == "application/json"
        assert settings.cache_control == "public, max-age=60"

    assert sorted(c.sentinel for c in world.sia_calls) == ["NEP", "SEP"]
    for call in world.sia_calls:
        assert call.since == pytest.approx(NOW_MJD - 60)
        assert call.upper == "+Inf"
        assert call.collections == KEPT
        assert call.format == ["csv"] and call.maxrec == 2000
        assert 0 < call.timeout <= 120

    (post,) = world.posts
    assert post.url == "https://api.example.test/internal/refresh"
    assert post.headers == {"X-Refresh-Key": KEY}
    assert post.json == {
        "reason": "catalog_change",
        "catalog_version": state["catalog_version"],
    }
    assert post.timeout == fa.REFRESH_TIMEOUT
    assert post.allow_redirects is False


def test_next_run_asks_sia_from_stored_latest_minus_two_days(world):
    fa.check_catalog(NOW)
    world.sia_calls.clear()

    fa.check_catalog(LATER)

    assert [c.since for c in world.sia_calls] == [NEWEST - 2] * 2


def test_no_change_keeps_version_and_does_not_post(world):
    fa.check_catalog(NOW)
    first = world.blob.state

    status, body = run_now()

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.blob.state["catalog_version"] == first["catalog_version"]
    assert world.blob.state["refresh_pending"] is False
    assert len(world.posts) == 1


def test_no_new_frames_keeps_stored_latest_and_is_not_an_error(world):
    fa.check_catalog(NOW)
    first = world.blob.state
    world.frames = {"NEP": [], "SEP": []}  # SIA has nothing since stored - 2 d

    status, body = fa.check_catalog(LATER)

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.blob.state["latest_frame_mjd"] == NEWEST
    assert world.blob.state["catalog_version"] == first["catalog_version"]
    assert world.blob.state["checked_at"] == "2026-11-15T06:00:00+00:00"
    assert len(world.posts) == 1


def test_first_run_without_frames_is_not_an_error(world):
    world.frames = {"NEP": [], "SEP": []}

    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["refresh_sent"]
    assert world.blob.state["latest_frame_mjd"] is None
    world.sia_calls.clear()
    fa.check_catalog(LATER)  # still nothing stored, so look back 60 days again
    assert [c.since for c in world.sia_calls] == [NOW_MJD + 1 - 60] * 2


def test_new_collection_gives_new_version_and_posts(world):
    fa.check_catalog(NOW)
    first = world.blob.state["catalog_version"]
    world.collections.append("spherex_dr2")

    status, body = fa.check_catalog(LATER)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.blob.state["catalog_version"] not in (first, None)
    assert "spherex_dr2" in world.blob.state["collections"]
    assert "spherex_dr2" in world.sia_calls[-1].collections
    assert [p.json["catalog_version"] for p in world.posts] == [
        first,
        world.blob.state["catalog_version"],
    ]


def test_same_day_new_frames_give_new_version(world):
    fa.check_catalog(NOW)
    first = world.blob.state["catalog_version"]
    world.frames["SEP"].append(NEWEST + 0.01)  # about 15 minutes later

    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.blob.state["latest_frame_mjd"] == NEWEST + 0.01
    assert world.blob.state["catalog_version"] != first
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
    first = world.blob.state["catalog_version"]
    edit(world.collections)

    status, body = fa.check_catalog(LATER)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.blob.state["catalog_version"] != first
    assert len(world.posts) == 2


def test_one_sentinel_is_enough_and_latest_never_goes_back(world, caplog):
    world.frames["SEP"].append(NEWEST + 0.5)
    fa.check_catalog(NOW)
    world.sia_down = {"SEP"}  # NEP alone would say NEWEST

    with caplog.at_level(logging.WARNING):
        status, body = fa.check_catalog(LATER)

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.blob.state["latest_frame_mjd"] == NEWEST + 0.5
    assert "SEP: HTTPError" in caplog.text


def test_full_sia_page_is_followed_up_from_its_newest_frame(world):
    world.frames["NEP"] = [61300.0 + i * 0.01 for i in range(2500)]

    status, _ = fa.check_catalog(NOW)

    assert status == 200
    nep = [c.since for c in world.sia_calls if c.sentinel == "NEP"]
    assert nep == [pytest.approx(NOW_MJD - 60), world.frames["NEP"][1999]]
    assert world.blob.state["latest_frame_mjd"] == world.frames["NEP"][-1]


def test_full_sia_page_with_nothing_newer_fails_only_that_sentinel(world, caplog):
    world.sia_ignores_time = True
    world.frames["NEP"] = [61290.0] * 2000  # all before the TIME lower bound

    with caplog.at_level(logging.WARNING):
        status, _ = fa.check_catalog(NOW)

    assert status == 200
    assert world.blob.state["latest_frame_mjd"] == 61315.5  # SEP's newest
    assert "nothing newer" in caplog.text


@pytest.mark.parametrize("down", ["list", "sia-502", "sia-html"])
def test_irsa_down_leaves_state_untouched_and_returns_502(world, down):
    fa.check_catalog(NOW)
    before, uploads, posts = world.blob.data, len(world.blob.uploads), len(world.posts)
    if down == "list":
        world.list_down = True
    elif down == "sia-502":
        world.sia_down = {"NEP", "SEP"}
    else:
        world.sia_html = {"NEP", "SEP"}
    world.frames["NEP"].append(NEWEST + 1)  # would be a change, if IRSA answered

    status, body = run_now()

    assert status == 502 and body["ok"] is False
    assert body["error"]["code"] == "IRSA_DOWN"
    assert body["catalog"] == json.loads(before)  # last good state, for the caller
    assert world.blob.data == before and len(world.blob.uploads) == uploads
    assert len(world.posts) == posts


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
    assert "no SIA sentinel answered" in body["error"]["message"]
    assert "no answer within 0.3 s" in body["error"]["message"]
    assert elapsed < 2
    assert world.blob.uploads == [] and world.posts == []


@pytest.mark.parametrize(
    "collections", [[], ["spherex_dr1_cube"]], ids=["none", "only-cube"]
)
def test_no_frame_collections_is_an_error_not_a_change(world, collections):
    world.collections = collections

    status, body = fa.check_catalog(NOW)

    assert status == 502 and body["error"]["code"] == "IRSA_DOWN"
    assert world.sia_calls == [] and world.blob.uploads == [] and world.posts == []


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

    assert status == 502
    assert body["error"]["code"] == "REFRESH_FAILED"
    pending = world.blob.state
    assert pending["refresh_pending"] is True and pending["notified_version"] is None
    assert body["catalog"] == pending

    world.api_status, world.api_exc = 202, None  # API is back; IRSA unchanged
    status, body = fa.check_catalog(LATER)

    assert status == 200 and not body["changed"] and body["refresh_sent"]
    assert [p.json["catalog_version"] for p in world.posts] == [
        pending["catalog_version"]
    ] * 2
    assert world.blob.state["notified_version"] == pending["catalog_version"]
    assert world.blob.state["refresh_pending"] is False

    fa.check_catalog(LATER)
    assert len(world.posts) == 2  # acknowledged, so no more POSTs


def test_unreadable_state_is_an_error_not_a_reset(world):
    fa.check_catalog(NOW)
    before = world.blob.data
    world.blob.read_error = ServiceRequestError("connection reset")

    status, body = fa.check_catalog(LATER)

    assert status == 500 and body["error"]["code"] == "STORAGE_ERROR"
    assert world.blob.data == before and len(world.posts) == 1


def test_corrupt_state_starts_over(world):
    world.blob.data = b"not json"

    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["refresh_sent"]
    assert world.blob.state["catalog_version"] == fa.catalog_version(KEPT, NEWEST)


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
    assert world.blob.uploads == [] and world.posts == []


def test_unexpected_error_is_reported_not_raised(world, monkeypatch):
    def boom(*args):
        raise RuntimeError("bug")

    monkeypatch.setattr(fa, "decide", boom)

    status, body = run_now()

    assert status == 500 and body["error"]["code"] == "INTERNAL"


def test_refresh_key_is_never_logged(world, caplog):
    caplog.set_level(logging.DEBUG)
    fa.check_catalog(NOW)
    world.frames["NEP"].append(NEWEST + 1)
    world.api_status = 500
    fa.check_catalog(LATER)
    world.sia_down = {"NEP", "SEP"}
    fa.check_catalog(LATER)

    assert caplog.records and KEY not in caplog.text


def test_timer_run_does_not_raise(world, caplog):
    world.list_down = True
    caplog.set_level(logging.WARNING)

    assert fa.new_data_watcher(SimpleNamespace(past_due=True)) is None
    assert "past due" in caplog.text and "IRSA_DOWN" in caplog.text


def test_version_is_content_addressed():
    v = fa.catalog_version(KEPT, NEWEST)
    assert v == fa.catalog_version(list(reversed(KEPT)), NEWEST)
    assert v.startswith("c") and len(v) == 13
    assert v != fa.catalog_version(KEPT, NEWEST + 1e-6)
    assert v != fa.catalog_version(KEPT[:-1], NEWEST)
    assert v != fa.catalog_version(KEPT, None)


def test_decide_is_pure_and_latest_only_moves_forward():
    old = {
        "catalog_version": "cold",
        "notified_version": "cold",
        "latest_frame_mjd": 100.0,
    }
    snapshot = dict(old)

    new, should_refresh = fa.decide(old, KEPT[::-1], None, "t1")
    again, _ = fa.decide(old, KEPT, None, "t1")

    assert old == snapshot and new == again
    assert new["latest_frame_mjd"] == 100.0  # no rows: keep the stored value
    assert should_refresh and new["notified_version"] == "cold"
    assert fa.decide(old, KEPT, 99.0, "t1")[0]["latest_frame_mjd"] == 100.0
    assert fa.decide(old, KEPT, 101.0, "t1")[0]["latest_frame_mjd"] == 101.0
    assert fa.decide({}, KEPT, None, "t1")[0]["latest_frame_mjd"] is None
    assert fa.decide(fa.mark_notified(new), KEPT, None, "t2")[1] is False


def test_time_lower_bound_and_mjd():
    assert fa.mjd(dt.datetime(2026, 11, 14, tzinfo=dt.UTC)) == 61358.0
    assert fa.time_lower_bound({"latest_frame_mjd": NEWEST}, NOW_MJD) == NEWEST - 2
    for old in ({}, {"latest_frame_mjd": None}, {"latest_frame_mjd": "61300"}):
        assert fa.time_lower_bound(old, NOW_MJD) == NOW_MJD - 60


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
