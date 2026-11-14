"""Offline checks for recovery safety, conversion and observed centroids."""

import csv
import gzip
import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pack_capture import pack
from retry_capture import cutout_url, recover, validate_cutout
from validate import measure, predict


def raw_cutout(shape=(9, 9)):
    image = np.arange(np.prod(shape), dtype=np.float32).reshape(shape)
    flags = fits.ImageHDU(np.zeros(shape, dtype=np.int32), name="FLAGS")
    flags.header["MSKN0021"] = "SOURCE"
    hdus = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(image, name="IMAGE"),
            flags,
            fits.ImageHDU(np.ones(shape), name="ZODI"),
            fits.ImageHDU(np.ones(shape), name="VARIANCE"),
        ]
    )
    out = io.BytesIO()
    hdus.writeto(out)
    return out.getvalue(), image


def row():
    return {
        "stem": "level2_example_1D1",
        "access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/example.fits",
        "status": "fail",
        "bytes": "0",
        "error": "HTTP 503",
        "t_min": "60900",
        "detector": "D1",
        "collection": "spherex_dr1",
    }


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/x.fits",
        "http://irsa.ipac.caltech.edu/ibe/data/spherex/a.fits",
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/a.fits?size=360",
    ],
)
def test_recovery_rejects_unexpected_urls(url):
    r = row()
    r["access_url"] = url
    with pytest.raises(ValueError):
        cutout_url(r, "barnard")


def test_recovery_refuses_path_traversal():
    r = row()
    r["stem"] = "../secret"
    with pytest.raises(ValueError):
        cutout_url(r, "barnard")


def test_recovery_validates_existing_file_without_network(tmp_path, monkeypatch):
    body, _ = raw_cutout()
    (tmp_path / "level2_example_1D1.fits").write_bytes(body)
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_a, **_k: pytest.fail("unexpected network request"),
    )
    result = recover(row(), "barnard", tmp_path, tries=1)
    assert result["status"] == "ok"
    assert result["error"] == ""
    assert int(result["bytes"]) == len(body)


def test_oversized_image_is_rejected():
    body, _ = raw_cutout((129, 129))
    with pytest.raises(ValueError, match="small cutout"):
        validate_cutout(body)


def test_conversion_subtracts_zodi_and_retains_mask_definitions(tmp_path):
    capture = tmp_path / "capture/barnard"
    capture.mkdir(parents=True)
    body, image = raw_cutout()
    r = row()
    r["status"] = "ok"
    (capture / (r["stem"] + ".fits")).write_bytes(body)
    with (capture / "frames.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(r))
        writer.writeheader()
        writer.writerow(r)
    manifest = pack(tmp_path / "capture", tmp_path / "demo", "barnard")
    path = tmp_path / "demo/barnard" / manifest["files"][0]["file"]
    with fits.open(io.BytesIO(gzip.decompress(path.read_bytes()))) as hdus:
        np.testing.assert_allclose(hdus["IMAGE"].data, image - 1, atol=0.4)
        assert hdus["IMAGE"].header["ZODISUB"]
        assert hdus["FLAGS"].header["MSKN0021"] == "SOURCE"
    assert (
        json.loads((tmp_path / "demo/index.json").read_text())["targets"]["barnard"][
            "files"
        ]
        == 1
    )


def test_centroid_recovers_observed_subpixel_motion():
    yy, xx = np.indices((31, 31))
    centres = [(15.15, 15.3), (15.02, 13.65)]
    measured = []
    for x, y in centres:
        image = 7 + 100 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 0.9**2))
        # Offset predictions must not become the measured answer.
        measured.append(measure(image, [x + 0.2, y - 0.2])["centroid_px"])
    np.testing.assert_allclose(
        np.subtract(measured[1], measured[0]),
        np.subtract(centres[1], centres[0]),
        atol=0.005,
    )


def test_independent_prediction_matches_documented_barnard_motion():
    early, late = np.array(predict(60910)), np.array(predict(61275))
    assert 0.0027 < late[1] - early[1] < 0.0031
    assert abs(late[0] - early[0]) < 0.0004
