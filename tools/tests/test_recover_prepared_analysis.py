"""No network/pixels: fail-closed source discovery and exact recovery gates."""

import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

SPEC = importlib.util.spec_from_file_location(
    "recover_prepared_analysis",
    Path(__file__).resolve().parents[1] / "recover_prepared_analysis.py",
)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
OBS = "level2_2025W22_1B_0147_2D4"
FRAME = {"obs": OBS, "collection": "spherex_dr1", "detector": 4, "t_mjd": 60821.85288}
PREFIX = "dr1/level2/2025W22_1B/"
VERSION = "l2b-v27-2026-199"
KEY = f"{PREFIX}{VERSION}/4/{OBS}_spx_{VERSION}.fits"


def xml(folders=(), keys=(), truncated=False):
    body = "".join(
        f"<CommonPrefixes><Prefix>{p}</Prefix></CommonPrefixes>" for p in folders
    )
    body += "".join(f"<Contents><Key>{k}</Key></Contents>" for k in keys)
    return (
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        f"<IsTruncated>{str(truncated).lower()}</IsTruncated>{body}</ListBucketResult>"
    ).encode()


def test_known_observation_resolves_without_guessing_processing_version():
    calls = []
    responses = iter([xml(folders=[PREFIX + VERSION + "/"]), xml(keys=[KEY])])

    def reader(url, limit):
        calls.append((url, limit))
        return next(responses)

    resolver = recovery.Resolver(reader=reader)
    row = resolver.resolve(FRAME)
    assert row["url"].endswith("/ibe/data/spherex/" + KEY)
    assert row["obs"] == OBS and row["t_mjd"] == FRAME["t_mjd"]
    assert resolver.requests == 2
    assert all(limit == 64 * 1024 for _, limit in calls)
    assert "delimiter=%2F" in calls[0][0]


def test_multiple_processing_versions_fail_closed():
    version2 = "l2b-v28-2026-200"
    key2 = KEY.replace(VERSION, version2)
    responses = iter(
        [
            xml(folders=[PREFIX + VERSION + "/", PREFIX + version2 + "/"]),
            xml(keys=[KEY]),
            xml(keys=[key2]),
        ]
    )
    resolver = recovery.Resolver(reader=lambda *args: next(responses))
    with pytest.raises(recovery.RecoveryError, match="unique"):
        resolver.resolve(FRAME)


@pytest.mark.parametrize(
    "change", [{"detector": 3}, {"collection": "spherex_qr2"}, {"obs": "../bad"}]
)
def test_invalid_identity_fails_before_listing(change):
    resolver = recovery.Resolver(reader=lambda *args: pytest.fail("unexpected network"))
    with pytest.raises(recovery.RecoveryError):
        resolver.resolve({**FRAME, **change})


def test_truncated_listing_and_request_budget_abort():
    resolver = recovery.Resolver(reader=lambda *args: xml(truncated=True))
    with pytest.raises(recovery.RecoveryError, match="truncated"):
        resolver.resolve(FRAME)
    resolver = recovery.Resolver(
        max_requests=0, reader=lambda *args: pytest.fail("network")
    )
    with pytest.raises(recovery.RecoveryError, match="budget"):
        resolver.resolve(FRAME)


def test_bounded_s3_open_keeps_native_range_configuration(monkeypatch):
    seen = {}

    def opener(url, **kwargs):
        seen.update(url=url, **kwargs)
        return "handle"

    monkeypatch.setattr(recovery.fetch.fits, "open", opener)
    assert recovery.bounded_s3_open(KEY) == "handle"
    assert seen["use_fsspec"] is True
    assert seen["fsspec_kwargs"]["anon"] is True
    assert seen["fsspec_kwargs"]["default_block_size"] == 256 * 1024
    assert seen["fsspec_kwargs"]["config_kwargs"]["read_timeout"] == 20


def test_native_science_extraction_uses_sections_not_full_data():
    class Hdu:
        name = "IMAGE"

        @property
        def data(self):
            pytest.fail("full frame data access forbidden")

        @property
        def section(self):
            return np.ones((10, 10))

    class Hdus(list):
        def __getitem__(self, key):
            return Hdu()

    arrays = recovery.fetch._read_arrays(
        Hdus([Hdu()]), (slice(1, 3), slice(2, 5)), True
    )
    assert arrays["image"].shape == (2, 3)


@pytest.fixture
def rebuild_fixture(monkeypatch):
    req = recovery.ViewRequest(ra=1, dec=-37, fov_arcmin=6)
    frames = [
        {**FRAME, "epoch": 0},
        {**FRAME, "obs": OBS.replace("0147", "0148"), "t_mjd": 61000.0, "epoch": 1},
    ]
    rk = recovery.render_key(
        3, recovery.views.query_key(req), [f["obs"] for f in frames]
    )
    manifest = {
        "schema": 1,
        "render_key": rk,
        "source": "irsa",
        "pipeline_version": 3,
        "query": {
            key: getattr(req, key) for key in ("ra", "dec", "fov_arcmin", "band")
        },
        "frames": frames,
        "epochs": [
            {"n_frames": 1, "image": "e0.f32"},
            {"n_frames": 1, "image": "e1.f32"},
        ],
        "grid": {},
        "catalog": {"collections": ["spherex_dr1"], "version": "spherex_dr1"},
        "origin": {},
        "stretch": {},
        "bandpass_matched": True,
    }
    files = {
        "e0.f32": (b"first", "application/octet-stream"),
        "e1.f32": (b"second", "application/octet-stream"),
    }
    native = [{**f, "image": np.ones((2, 2))} for f in frames]
    monkeypatch.setattr(recovery.config, "MIN_EPOCH_FRAMES_LIVE", 1)
    monkeypatch.setattr(
        recovery.fetch,
        "fetch_s3",
        lambda row, *args: next(f for f in native if f["obs"] == row["obs"]),
    )
    monkeypatch.setattr(
        recovery.stack, "to_grid", lambda *args: (np.ones((2, 2)), np.ones((2, 2)))
    )
    monkeypatch.setattr(
        recovery.views, "_render", lambda *args: (copy.deepcopy(manifest), files)
    )
    encoded = []
    monkeypatch.setattr(
        recovery.analysis_cache, "encode", lambda *args: encoded.append(args) or b"npz"
    )
    monkeypatch.setattr(recovery.analysis_cache, "decode", lambda *args: None)

    def read(key, name):
        return (
            json.dumps(manifest).encode() if name == "manifest.json" else files[name][0]
        )

    cache = SimpleNamespace(read=read)
    return req, manifest, frames, files, rk, cache, encoded


def test_exact_images_pass_before_npz_is_encoded(rebuild_fixture):
    req, manifest, rows, _, rk, cache, encoded = rebuild_fixture
    assert recovery.rebuild(manifest, req, rows, cache, rk) == b"npz"
    assert len(encoded) == 1
    assert [f["obs"] for ep in encoded[0][1] for f in ep] == [f["obs"] for f in rows]


def test_second_image_mismatch_aborts_before_npz_or_upload(rebuild_fixture):
    req, manifest, rows, _, rk, cache, encoded = rebuild_fixture
    original_read = cache.read
    cache.read = lambda key, name: (
        b"DIFFERENT" if name == "e1.f32" else original_read(key, name)
    )
    with pytest.raises(recovery.views.ViewError, match="differs"):
        recovery.rebuild(manifest, req, rows, cache, rk)
    assert encoded == []


def test_original_science_gate_is_not_relaxed(monkeypatch, rebuild_fixture):
    req, manifest, rows, _, rk, cache, encoded = rebuild_fixture
    monkeypatch.setattr(recovery.config, "MIN_EPOCH_FRAMES_LIVE", 10)
    with pytest.raises(recovery.RecoveryError, match="science gates"):
        recovery.rebuild(manifest, req, rows, cache, rk)
    assert not encoded


def test_reordered_original_frames_are_rejected(rebuild_fixture):
    req, manifest, rows, _, rk, cache, encoded = rebuild_fixture
    with pytest.raises(recovery.RecoveryError, match="order"):
        recovery.rebuild(manifest, req, rows[::-1], cache, rk)
    assert not encoded


def test_private_upload_never_overwrites_or_uses_public_client():
    calls = []
    cache = recovery.BlobCache(
        "https://example.blob.core.windows.net",
        "frames",
        container_client=object(),
        analysis_client=SimpleNamespace(
            upload_blob=lambda *a, **kw: calls.append((a, kw))
        ),
    )
    recovery.write_private(cache, "a" * 24, b"npz")
    assert calls[0][0] == (f"analysis/v1/{'a' * 24}.npz", b"npz")
    assert calls[0][1]["overwrite"] is False
    assert calls[0][1]["content_settings"].cache_control == "private, no-store"


def test_public_adapter_rejects_pointer_or_write_destinations():
    client = recovery.PublicContainer("https://example.blob.core.windows.net/frames")
    with pytest.raises(recovery.RecoveryError):
        client.download_blob("q/anything.json")


def test_known_frame_count_validation(rebuild_fixture):
    req, manifest, _, _, rk, _, _ = rebuild_fixture
    target = {"view": {"query": req.model_dump()}}
    assert recovery.validate_manifest(manifest, target, rk) == req
    manifest["epochs"][0]["n_frames"] = 10
    with pytest.raises(recovery.RecoveryError, match="pass counts"):
        recovery.validate_manifest(manifest, target, rk)


def test_existing_sidecar_skips_discovery_pixels_and_writes(
    monkeypatch, tmp_path, rebuild_fixture
):
    req, manifest, _, _, rk, _, _ = rebuild_fixture
    url = f"https://example.blob.core.windows.net/frames/r/{rk}/manifest.json"
    catalog = tmp_path / "catalog.json"
    catalog.write_text(
        json.dumps(
            {
                "objects": [
                    {
                        "id": "test",
                        "view": {"query": req.model_dump(), "manifest_url": url},
                    }
                ]
            }
        )
    )
    monkeypatch.setattr(
        recovery, "read_public", lambda *args: json.dumps(manifest).encode()
    )
    monkeypatch.setattr(
        recovery,
        "private_cache",
        lambda *args: SimpleNamespace(read_analysis=lambda key: b"existing"),
    )
    monkeypatch.setattr(
        recovery.Resolver, "resolve", lambda *args: pytest.fail("must not discover")
    )
    monkeypatch.setattr(
        recovery, "rebuild", lambda *args: pytest.fail("must not fetch pixels")
    )
    monkeypatch.setattr(
        recovery, "write_private", lambda *args: pytest.fail("must not overwrite")
    )
    monkeypatch.setattr(
        "sys.argv",
        [
            "tool",
            "--catalog",
            str(catalog),
            "--target",
            "test",
            "--apply",
            "--subscription",
            "student",
            "--tenant",
            "tenant",
            "--resource-group",
            "group",
        ],
    )
    recovery.main()


def test_apply_destination_guard_runs_before_blob_credentials(monkeypatch):
    import azure.identity

    import infra.azure_arm

    calls = []

    class Arm:
        def __init__(self, subscription, tenant):
            calls.append((subscription, tenant))

        def resource(self, *args):
            return "/student/storage"

        def request(self, *args):
            return {
                "properties": {
                    "primaryEndpoints": {"blob": "https://other.blob.core.windows.net/"}
                }
            }

    monkeypatch.setattr(infra.azure_arm, "Arm", Arm)
    monkeypatch.setattr(
        azure.identity,
        "AzureCliCredential",
        lambda **kwargs: pytest.fail("must fail before credential creation"),
    )
    args = SimpleNamespace(
        subscription="student", tenant="tenant", resource_group="group"
    )
    with pytest.raises(recovery.RecoveryError, match="Student subscription"):
        recovery.private_cache(args, "https://example.blob.core.windows.net/frames")
    assert calls == [("student", "tenant")]
