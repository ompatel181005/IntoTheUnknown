"""Two-level cache (docs/PLAN.md 4.4): key determinism and put/lookup round trips. No network."""

import hashlib
import json

import pytest
from azure.core.exceptions import ResourceNotFoundError, ServiceRequestError

from app import config
from app.cache import blob
from app.cache.blob import IMMUTABLE, SHORT, BlobCache, query_key, render_key
from app.cache.local import LocalCache

# ---------------------------------------------------------------- keys (ported from docs/skeletons/check.py)


def test_query_key_is_deterministic_and_position_sensitive():
    qk = query_key(269.4463, 4.7682, 6, "B1-B2")
    assert len(qk) == 20
    assert qk == query_key(269.44630001, 4.76820001, 6.0, "B1-B2")  # below the .4f grid
    assert qk != query_key(269.4464, 4.7682, 6, "B1-B2")  # one step in RA
    assert qk != query_key(269.4463, 4.7683, 6, "B1-B2")  # one step in Dec
    assert qk != query_key(269.4463, 4.7682, 10, "B1-B2")
    assert qk != query_key(269.4463, 4.7682, 6, "B1")


def test_query_key_source_suffix_only_when_forced():
    auto = query_key(269.4463, 4.7682, 6, "B1-B2")
    assert auto == query_key(269.4463, 4.7682, 6, "B1-B2", "auto")
    assert (
        len({auto, query_key(269.4463, 4.7682, 6, "B1-B2", "saved"), query_key(269.4463, 4.7682, 6, "B1-B2", "live")})
        == 3
    )


def test_keys_match_merged_production_rules():
    # infra/BLOB-HANDOFF.md: keep the merged q2 + pipeline-version key, not the old skeleton's q1.
    pv = config.PIPELINE_VERSION
    want_qk = hashlib.sha256(f"q2|{pv}|269.4463|+4.7682|6|B1-B2".encode()).hexdigest()[:20]
    assert query_key(269.4463, 4.7682, 6, "B1-B2") == want_qk
    want_rk = hashlib.sha256(f"{pv}|{want_qk}|a,b".encode()).hexdigest()[:24]
    assert render_key(pv, want_qk, ["b", "a"]) == want_rk
    assert query_key(269.4463, 4.7682, 6, "B1-B2", pipeline_version=pv + 1) != want_qk  # a bump drops old pointers


def test_render_key_ignores_frame_order_and_tracks_pipeline_version():
    qk = query_key(269.4463, 4.7682, 6, "B1-B2")
    rk = render_key(1, qk, ["b", "a"])
    assert len(rk) == 24
    assert rk == render_key(1, qk, ["a", "b"])
    assert rk != render_key(2, qk, ["a", "b"])
    assert rk != render_key(1, qk, ["a", "b", "c"])  # a new frame means a new render folder


# ---------------------------------------------------------------- local backend

MANIFEST = {"schema": 1, "render_key": "rk1", "epochs": [{"i": 0, "image": "e0.f32"}]}
FILES = {
    "e0.f32": (b"\x00\x00\x80\x3f", "application/octet-stream"),
    "e0.mask.u8": (b"\x01", "application/octet-stream"),
}


def test_local_put_lookup_round_trip(tmp_path):
    c = LocalCache(tmp_path)
    assert c.lookup("qk1") is None and not c.has_render("rk1")

    c.put_render("rk1", MANIFEST, FILES)
    assert c.has_render("rk1")
    assert c.lookup("qk1") is None  # no pointer until point()

    c.point("qk1", "rk1", "spherex_dr1+spherex_qr3")
    assert c.lookup("qk1") == {"render_key": "rk1", "catalog_version": "spherex_dr1+spherex_qr3"}
    assert json.loads((tmp_path / "r" / "rk1" / "manifest.json").read_text()) == MANIFEST
    assert (tmp_path / "r" / "rk1" / "e0.f32").read_bytes() == FILES["e0.f32"][0]
    assert c.manifest_url("rk1") == "/frames/r/rk1/manifest.json"
    assert not list(tmp_path.rglob("*.tmp"))


def test_local_pointer_swap_keeps_old_render(tmp_path):
    c = LocalCache(tmp_path)
    c.put_render("rk1", MANIFEST, FILES)
    c.point("qk1", "rk1", "v1")
    c.put_render("rk2", {**MANIFEST, "render_key": "rk2"}, FILES)
    c.point("qk1", "rk2", "v2")
    assert c.lookup("qk1")["render_key"] == "rk2"
    assert c.has_render("rk1")  # old evidence links stay valid


@pytest.mark.parametrize("name", ["", "../x", "a/b", ".hidden", "manifest.json"])
def test_render_file_names_are_flat(tmp_path, name):
    with pytest.raises(ValueError):
        LocalCache(tmp_path).put_render("rk1", MANIFEST, {name: (b"", "application/octet-stream")})


# ---------------------------------------------------------------- blob backend (fake container, no network)


class FakeBlob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def readall(self):
        return self.store[self.name][0]

    def exists(self):
        return self.name in self.store


class FakeContainer:
    def __init__(self):
        self.store: dict[str, tuple[bytes, object]] = {}
        self.order: list[str] = []
        self.fail = False

    def upload_blob(self, name, data, overwrite, content_settings):
        assert overwrite is True
        self.store[name] = (data, content_settings)
        self.order.append(name)

    def download_blob(self, name):
        if self.fail:
            raise ServiceRequestError("network down")
        if name not in self.store:
            raise ResourceNotFoundError("missing")
        return FakeBlob(self.store, name)

    def get_blob_client(self, name):
        return FakeBlob(self.store, name)


def test_blob_put_lookup_round_trip_and_headers():
    fake = FakeContainer()
    c = BlobCache("https://sa.blob.core.windows.net", "frames", container_client=fake)
    assert c.lookup("qk1") is None and not c.has_render("rk1")

    c.put_render("rk1", MANIFEST, FILES)
    c.point("qk1", "rk1", "spherex_dr1")

    assert fake.order[-2:] == ["r/rk1/manifest.json", "q/qk1.json"]  # manifest last, then the pointer
    assert set(fake.order[:-2]) == {"r/rk1/e0.f32", "r/rk1/e0.mask.u8"}
    for name, (_, cs) in fake.store.items():
        assert cs.cache_control == (SHORT if name.startswith("q/") else IMMUTABLE), name
    assert fake.store["r/rk1/manifest.json"][1].content_type == "application/json"
    assert fake.store["r/rk1/e0.f32"][1].content_type == "application/octet-stream"

    assert c.has_render("rk1")
    assert c.lookup("qk1") == {"render_key": "rk1", "catalog_version": "spherex_dr1"}
    assert c.manifest_url("rk1") == "https://sa.blob.core.windows.net/frames/r/rk1/manifest.json"


def test_blob_public_base_override_and_unreadable_pointer():
    fake = FakeContainer()
    c = BlobCache("https://sa.blob.core.windows.net", "frames", "https://edge.example/frames/", container_client=fake)
    assert c.manifest_url("rk1") == "https://edge.example/frames/r/rk1/manifest.json"
    c.point("qk1", "rk1", "v1")
    fake.fail = True
    assert c.lookup("qk1") is None  # an outage is a cache miss, not a 500


# ---------------------------------------------------------------- backend choice


def test_get_cache_falls_back_to_local_without_storage_url(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "STORAGE_ACCOUNT_URL", "")
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(blob, "_cache", None)
    c = blob.get_cache()
    assert isinstance(c, LocalCache) and c.root == tmp_path
    assert blob.get_cache() is c
