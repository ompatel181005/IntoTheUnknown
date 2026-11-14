"""Watcher tests. No network: IRSA, Blob and requests.post are faked."""

import json
import logging
import threading
import time
from types import SimpleNamespace

import azure.functions as func
import numpy as np
import pytest
import requests
from azure.core.exceptions import ResourceNotFoundError, ServiceRequestError

import function_app as fa

NOW = "2026-11-14T06:00:00+00:00"
LATER = "2026-11-15T06:00:00+00:00"
# What IRSA listed for servicetype=SIA, filter=spherex on 2026-11-14.
LISTED = [
    "spherex_dr1",
    "spherex_dr1_cube",
    "spherex_dr1_deep",
    "spherex_qr3",
    "spherex_qr3_deep",
]
KEPT = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
MJD = 61350.123456789
KEY = "test-refresh-key-123"


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
        self.latest = MJD
        self.column = None  # overrides [latest] as the TAP result column
        self.irsa_down = set()  # "list" and/or "tap"
        self.tap_gate = None  # threading.Event: query_tap blocks until set
        self.api_status = 202
        self.api_exc = None
        self.posts = []
        self.blob = FakeBlob()

    # astroquery IrsaClass stand-in
    def list_collections(self, servicetype, filter):
        assert (servicetype, filter) == ("SIA", "spherex")
        if "list" in self.irsa_down:
            raise requests.HTTPError("502 Server Error: Proxy Error")
        return {"collection": list(self.collections)}

    def query_tap(self, query):
        assert query == fa.MAX_T_QUERY
        if self.tap_gate:
            self.tap_gate.wait(5)
        if "tap" in self.irsa_down:
            raise requests.ReadTimeout("Read timed out. (read timeout=120)")
        column = [self.latest] if self.column is None else self.column
        return SimpleNamespace(to_table=lambda: {"t": column})

    # requests.post stand-in
    def post(self, url, **kwargs):
        self.posts.append(SimpleNamespace(url=url, **kwargs))
        if self.api_exc:
            raise self.api_exc
        resp = requests.Response()
        resp.status_code = self.api_status
        resp.url = url
        resp._content = b'{"queued":5}'
        return resp


@pytest.fixture
def world(monkeypatch):
    w = World()
    monkeypatch.setenv("API_BASE", "https://api.example.test/")
    monkeypatch.setenv("REFRESH_KEY", KEY)
    monkeypatch.setenv("STORAGE_ACCOUNT_URL", "https://st.example.test")
    monkeypatch.delenv("IRSA_TIMEOUT_S", raising=False)
    monkeypatch.setattr(fa, "_catalog_blob", lambda url: w.blob)
    monkeypatch.setattr(fa, "_irsa_client", lambda timeout: w)
    monkeypatch.setattr(fa.requests, "post", w.post)
    return w


def run_now():
    resp = fa.run_now(func.HttpRequest(method="POST", url="/api/run-now", body=b""))
    assert resp.mimetype == "application/json"
    return resp.status_code, json.loads(resp.get_body())


def test_first_run_writes_state_and_posts_refresh(world):
    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["ok"] and body["changed"] and body["refresh_sent"]
    state = world.blob.state
    assert state["collections"] == KEPT  # the All-Sky Cube is not a frame collection
    assert state["latest_frame_mjd"] == MJD
    assert state["checked_at"] == NOW
    assert state["catalog_version"] == fa.catalog_version(KEPT, MJD)
    assert state["notified_version"] == state["catalog_version"]
    assert state["refresh_pending"] is False
    assert body["catalog"] == state
    for settings in world.blob.uploads:
        assert settings.content_type == "application/json"
        assert settings.cache_control == "public, max-age=60"

    (post,) = world.posts
    assert post.url == "https://api.example.test/internal/refresh"
    assert post.headers == {"X-Refresh-Key": KEY}
    assert post.json == {
        "reason": "catalog_change",
        "catalog_version": state["catalog_version"],
    }
    assert post.timeout == fa.REFRESH_TIMEOUT
    assert post.allow_redirects is False


def test_no_change_keeps_version_and_does_not_post(world):
    fa.check_catalog(NOW)
    first = world.blob.state

    status, body = run_now()

    assert status == 200 and not body["changed"] and not body["refresh_sent"]
    assert world.blob.state["catalog_version"] == first["catalog_version"]
    assert world.blob.state["refresh_pending"] is False
    assert len(world.posts) == 1


def test_new_collection_gives_new_version_and_posts(world):
    fa.check_catalog(NOW)
    first = world.blob.state["catalog_version"]
    world.collections.append("spherex_dr2")

    status, body = fa.check_catalog(LATER)

    assert status == 200 and body["changed"] and body["refresh_sent"]
    assert world.blob.state["catalog_version"] not in (first, None)
    assert "spherex_dr2" in world.blob.state["collections"]
    assert [p.json["catalog_version"] for p in world.posts] == [
        first,
        world.blob.state["catalog_version"],
    ]


def test_same_day_new_frames_give_new_version(world):
    fa.check_catalog(NOW)
    first = world.blob.state["catalog_version"]
    world.latest = MJD + 0.01  # about 15 minutes later, same UTC day

    status, body = fa.check_catalog(NOW)

    assert status == 200 and body["changed"] and body["refresh_sent"]
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


@pytest.mark.parametrize("down", ["list", "tap", "both"])
def test_irsa_down_leaves_state_untouched_and_returns_502(world, down):
    fa.check_catalog(NOW)
    before, uploads, posts = world.blob.data, len(world.blob.uploads), len(world.posts)
    world.irsa_down = {"list", "tap"} if down == "both" else {down}
    world.latest = MJD + 1  # would be a change, if IRSA answered

    status, body = run_now()

    assert status == 502 and body["ok"] is False
    assert body["error"]["code"] == "IRSA_DOWN"
    assert body["catalog"] == json.loads(before)  # last good state, for the caller
    assert world.blob.data == before and len(world.blob.uploads) == uploads
    assert len(world.posts) == posts


def test_irsa_hang_is_cut_off_at_the_deadline(world, monkeypatch):
    monkeypatch.setenv("IRSA_TIMEOUT_S", "0.3")
    world.tap_gate = threading.Event()
    try:
        started = time.monotonic()
        status, body = run_now()
        elapsed = time.monotonic() - started
    finally:
        world.tap_gate.set()

    assert status == 502 and body["error"]["code"] == "IRSA_DOWN"
    assert "did not answer within 0.3 s" in body["error"]["message"]
    assert elapsed < 2
    assert world.blob.uploads == [] and world.posts == []


@pytest.mark.parametrize(
    "setup",
    [
        lambda w: setattr(w, "collections", []),
        lambda w: setattr(w, "collections", ["spherex_dr1_cube"]),
        lambda w: setattr(w, "column", np.ma.masked_array([0.0], mask=[True])),
        lambda w: setattr(w, "column", [float("nan")]),
        lambda w: setattr(w, "column", []),
    ],
    ids=["no-collections", "only-cube", "max-null", "max-nan", "max-empty"],
)
def test_implausible_irsa_answer_is_an_error_not_a_change(world, setup):
    setup(world)

    status, body = fa.check_catalog(NOW)

    assert status == 502 and body["error"]["code"] == "IRSA_DOWN"
    assert world.blob.uploads == [] and world.posts == []


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
    assert world.blob.state["catalog_version"] == fa.catalog_version(KEPT, MJD)


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
    world.irsa_down = {"list", "tap"}  # would show up as IRSA_DOWN if IRSA were called

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
    world.latest += 1
    world.api_status = 500
    fa.check_catalog(LATER)
    world.irsa_down = {"tap"}
    fa.check_catalog(LATER)

    assert caplog.records and KEY not in caplog.text


def test_timer_run_does_not_raise(world, caplog):
    world.irsa_down = {"list"}
    caplog.set_level(logging.WARNING)

    assert fa.new_data_watcher(SimpleNamespace(past_due=True)) is None
    assert "past due" in caplog.text and "IRSA_DOWN" in caplog.text


def test_version_is_content_addressed():
    v = fa.catalog_version(KEPT, MJD)
    assert v == fa.catalog_version(list(reversed(KEPT)), MJD)
    assert v.startswith("c") and len(v) == 13
    assert v != fa.catalog_version(KEPT, MJD + 1e-6)
    assert v != fa.catalog_version(KEPT[:-1], MJD)


def test_decide_is_pure():
    old = {"catalog_version": "cold", "notified_version": "cold"}
    snapshot = dict(old)

    new, should_refresh = fa.decide(old, KEPT[::-1], MJD, NOW)
    again, _ = fa.decide(old, KEPT, MJD, NOW)

    assert old == snapshot and new == again
    assert should_refresh and new["notified_version"] == "cold"
    assert fa.decide(fa.mark_notified(new), KEPT, MJD, LATER)[1] is False


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
