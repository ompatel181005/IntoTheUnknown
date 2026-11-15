"""Deterministic job lifecycle/concurrency checks with a real executor and fake renders."""

import concurrent.futures as cf
import queue
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.models import ViewRequest
from app.processing import views


def request(ra=10):
    return ViewRequest(ra=ra, dec=10, fov_arcmin=6, band="B1", source="saved")


@pytest.fixture
def harness(monkeypatch):
    pools, gates = [], []

    def configure(*, workers=2, renderer=None, lookup=None):
        pool = cf.ThreadPoolExecutor(max_workers=workers)
        pools.append(pool)
        gate = threading.Event()
        gates.append(gate)
        started = queue.Queue()
        futures = []

        def fake_build(job):
            job.status = "fetch"
            started.put(job.qk)
            assert gate.wait(5), "test renderer was not released"
            job.status, job.manifest_url = "ready", f"/frames/r/{job.qk}/manifest.json"

        def submit(*args):
            future = pool.submit(*args)
            futures.append(future)
            return future

        capacity = workers + config.MAX_QUEUED_JOBS
        admission = threading.BoundedSemaphore(capacity)
        monkeypatch.setattr(views, "JOBS", {})
        monkeypatch.setattr(views, "POOL", SimpleNamespace(submit=submit))
        monkeypatch.setattr(views, "ADMISSION", admission)
        monkeypatch.setattr(views, "build", renderer or fake_build)
        cache = SimpleNamespace(
            lookup=lookup or (lambda _: None), manifest_url=lambda rk: f"/frames/r/{rk}/manifest.json"
        )
        monkeypatch.setattr(views, "get_cache", lambda: cache)
        return SimpleNamespace(
            pool=pool, gate=gate, started=started, futures=futures, capacity=capacity, admission=admission, cache=cache
        )

    yield configure
    for gate in gates:
        gate.set()
    for pool in pools:
        pool.shutdown(wait=True)


def assert_capacity_released(h):
    permits = 0
    try:
        while h.admission.acquire(blocking=False):
            permits += 1
        assert permits == h.capacity
    finally:
        for _ in range(permits):
            h.admission.release()


def test_two_running_ten_waiting_then_429_without_orphan(harness):
    h = harness()
    client = TestClient(app)
    accepted = []
    for ra in range(h.capacity):
        response = client.post("/api/views", json=request(ra).model_dump())
        assert response.status_code == 202
        accepted.append(response.json())
    # Both workers are held; all ten additional jobs are still waiting.
    h.started.get(timeout=2)
    h.started.get(timeout=2)
    assert h.started.empty()
    assert sum(j.status == "queued" for j in views.JOBS.values()) == 10
    rejected = client.post("/api/views", json=request(99).model_dump())
    assert rejected.status_code == 429
    assert rejected.headers["Retry-After"] == "2"
    assert rejected.json()["error"]["code"] == "QUEUE_FULL"
    assert views.query_key(request(99)) not in views.JOBS
    duplicate = client.post("/api/views", json=request(0).model_dump())
    assert duplicate.status_code == 202 and duplicate.json()["view_id"] == accepted[0]["view_id"]
    assert len(h.futures) == h.capacity
    assert client.get(accepted[0]["status_url"]).json()["status"] == "fetch"
    assert client.post("/api/views", json={**request(99).model_dump(), "fov_arcmin": 7}).status_code == 422
    h.gate.set()
    for future in h.futures:
        future.result(timeout=3)
    assert_capacity_released(h)
    assert all(job.status == "ready" for job in views.JOBS.values())
    assert client.post("/api/views", json=request(0).model_dump()).status_code == 200


def test_ready_memory_and_persistent_hits_bypass_full_queue(harness):
    h = harness(workers=1)
    for ra in range(h.capacity):
        views.create(request(ra))
    memory_req = request(98)
    memory = views.Job(
        qk=views.query_key(memory_req), req=memory_req, status="ready", manifest_url="/frames/ready.json"
    )
    views.JOBS[memory.qk] = memory
    h.cache.lookup = lambda _: {"render_key": "persisted"}
    client = TestClient(app)
    assert client.post("/api/views", json=memory_req.model_dump()).status_code == 200
    hit = client.post("/api/views", json=request(99).model_dump())
    assert hit.status_code == 200
    assert hit.json()["manifest_url"] == "/frames/r/persisted/manifest.json"
    assert len(h.futures) == h.capacity


def test_concurrent_identical_cache_misses_submit_only_one_job(harness):
    callers = 8
    lookup_barrier = threading.Barrier(callers)

    def lookup(_):
        lookup_barrier.wait(timeout=3)

    h = harness(lookup=lookup)
    with cf.ThreadPoolExecutor(max_workers=callers) as clients:
        futures = [clients.submit(views.create, request()) for _ in range(callers)]
        jobs = [future.result(timeout=4) for future in futures]
    assert all(job is jobs[0] for job in jobs)
    assert len(views.JOBS) == len(h.futures) == 1
    h.gate.set()
    h.futures[0].result(timeout=2)
    assert_capacity_released(h)


def test_slow_lookup_does_not_block_unrelated_admission_or_memory_hits(harness):
    entered, release = threading.Event(), threading.Event()
    slow = request(10)

    def lookup(qk):
        if qk == views.query_key(slow):
            entered.set()
            assert release.wait(4)

    h = harness(lookup=lookup)
    ready_req = request(11)
    ready = views.Job(qk=views.query_key(ready_req), req=ready_req, status="ready")
    views.JOBS[ready.qk] = ready
    with cf.ThreadPoolExecutor(max_workers=3) as clients:
        blocked = clients.submit(views.create, slow)
        try:
            assert entered.wait(2)
            assert clients.submit(views.create, ready_req).result(timeout=1) is ready
            unrelated = clients.submit(views.create, request(12)).result(timeout=1)
            assert unrelated.qk != ready.qk
        finally:
            release.set()
        assert blocked.result(timeout=2).qk == views.query_key(slow)
    assert len(h.futures) == 2


@pytest.mark.parametrize(
    "failure", [views.ViewError("IRSA_DOWN", "archive unavailable"), RuntimeError("broken renderer")]
)
def test_renderer_failures_are_terminal_and_release_all_capacity(harness, failure):
    def broken(_):
        raise failure

    h = harness(renderer=broken)
    job = views.create(request())
    h.futures[0].result(timeout=2)
    assert job.status == "error"
    assert job.error[0] == ("IRSA_DOWN" if isinstance(failure, views.ViewError) else "PIPELINE_ERROR")
    assert_capacity_released(h)
    retry = views.create(request())
    h.futures[-1].result(timeout=2)
    assert retry is not job
    assert_capacity_released(h)


def test_submit_failure_returns_503_terminal_record_and_allows_retry(harness, monkeypatch):
    h = harness()
    original = views.POOL.submit

    def rejected(*args):
        raise RuntimeError("executor shut down")

    monkeypatch.setattr(views.POOL, "submit", rejected)
    client = TestClient(app)
    response = client.post("/api/views", json=request().model_dump())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PIPELINE_ERROR"
    qk = views.query_key(request())
    assert client.get(f"/api/views/{qk}").json()["status"] == "error"
    assert_capacity_released(h)
    monkeypatch.setattr(views.POOL, "submit", original)
    assert client.post("/api/views", json=request().model_dump()).status_code == 202
    assert len(h.futures) == 1


def test_renderer_return_without_terminal_state_does_not_orphan_job(harness):
    h = harness(renderer=lambda _: None)
    job = views.create(request())
    h.futures[0].result(timeout=2)
    assert job.status == "error" and job.error[0] == "PIPELINE_ERROR"
    assert_capacity_released(h)


def test_duplicate_that_arrives_during_submit_failure_observes_terminal_error(harness, monkeypatch):
    h = harness()
    entered, release = threading.Event(), threading.Event()

    def rejected(*args):
        entered.set()
        assert release.wait(3)
        raise RuntimeError("executor shut down")

    monkeypatch.setattr(views.POOL, "submit", rejected)
    with cf.ThreadPoolExecutor(max_workers=1) as callers:
        first = callers.submit(views.create, request())
        try:
            assert entered.wait(2)
            duplicate = views.create(request())
            assert duplicate.status == "queued"
        finally:
            release.set()
        with pytest.raises(views.ViewError, match="could not be queued"):
            first.result(timeout=2)
    assert duplicate.status == "error" and duplicate.error[0] == "PIPELINE_ERROR"
    assert views.JOBS[duplicate.qk] is duplicate
    assert_capacity_released(h)
