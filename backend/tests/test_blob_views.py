"""The view pipeline on the Blob cache, with a fake container (no network, demo-pack data)."""

from azure.core.exceptions import ServiceRequestError
from test_keys import FakeContainer

from app import config
from app.cache import blob
from app.models import ViewRequest
from app.processing import views

REQ = ViewRequest(ra=269.44627, dec=4.7682, fov_arcmin=6, band="B1-B2", mode="stack", source="saved")
BASE = "https://sa.blob.core.windows.net"


def build(monkeypatch, container):
    cache = blob.BlobCache(BASE, "frames", container_client=container)
    monkeypatch.setattr(views, "get_cache", lambda: cache)
    monkeypatch.setattr(views, "JOBS", {})
    job = views.Job(qk=views.query_key(REQ), req=REQ)
    views.build(job)
    return job


def test_view_is_written_to_blob_and_found_again_after_a_restart(monkeypatch):
    container = FakeContainer()
    job = build(monkeypatch, container)
    prefix = f"r/{job.rk}/"
    assert job.manifest_url == f"{BASE}/frames/{prefix}manifest.json"
    assert {prefix + "e0.f32", prefix + "e0.mask.u8", prefix + "gaia.json"} <= set(container.store)
    assert container.order[-2:] == [prefix + "manifest.json", f"q/{job.qk}.json"]  # manifest, then the pointer
    assert views.gaia_overlay(job)["stars"]  # /gaia reads the render back through the cache

    monkeypatch.setattr(views, "JOBS", {})  # a restart: nothing in memory, only the pointer in Blob
    again = views.create(REQ)
    assert again.status == "ready" and again.from_cache and again.manifest_url == job.manifest_url


def test_blob_write_failure_keeps_the_view_on_local_disk(monkeypatch, tmp_path):
    class Down(FakeContainer):
        def upload_blob(self, *args, **kwargs):
            raise ServiceRequestError("network down")

    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    job = build(monkeypatch, Down())
    assert job.status == "ready" and job.manifest_url == f"/frames/r/{job.rk}/manifest.json"
    assert (tmp_path / "r" / job.rk / "manifest.json").is_file()
    assert views.gaia_overlay(job)["stars"]
