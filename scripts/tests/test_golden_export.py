"""Golden exports keep manifest sidecars in sync with the current render."""

import pytest

from validate_integrated import _export_sidecars, _validate_sidecars


def test_export_replaces_stale_sidecar_and_validates_content(tmp_path):
    render = tmp_path / "render"
    golden = tmp_path / "golden"
    render.mkdir()
    golden.mkdir()
    (render / "gaia.json").write_text('{"stars": [1]}')
    (golden / "gaia.json").write_text('{"stars": [0]}')
    manifest = {"extras": {"gaia": "gaia.json", "lightcurve": None}}

    _export_sidecars(manifest, render, golden)

    assert (golden / "gaia.json").read_bytes() == (render / "gaia.json").read_bytes()
    _validate_sidecars(manifest, render, golden)


def test_missing_render_sidecar_prevents_partial_export(tmp_path):
    render = tmp_path / "render"
    golden = tmp_path / "golden"
    render.mkdir()
    golden.mkdir()
    (render / "gaia.json").write_text('{"stars": [1]}')
    (golden / "gaia.json").write_text('{"stars": [0]}')

    with pytest.raises(FileNotFoundError, match="render sidecar is missing"):
        _export_sidecars({"extras": {"gaia": "gaia.json", "cube": "missing.json"}}, render, golden)

    assert (golden / "gaia.json").read_text() == '{"stars": [0]}'


@pytest.mark.parametrize("golden_state", ["stale", "missing"])
def test_validator_rejects_stale_or_missing_golden_sidecar(tmp_path, golden_state):
    render = tmp_path / "render"
    golden = tmp_path / "golden"
    render.mkdir()
    golden.mkdir()
    (render / "gaia.json").write_text('{"stars": [1]}')
    if golden_state == "stale":
        (golden / "gaia.json").write_text('{"stars": [0]}')

    with pytest.raises(AssertionError, match="(Stale|Missing) golden sidecar"):
        _validate_sidecars({"extras": {"gaia": "gaia.json"}}, render, golden)


def test_no_sidecars_is_valid(tmp_path):
    render = tmp_path / "render"
    golden = tmp_path / "golden"
    render.mkdir()
    golden.mkdir()

    _export_sidecars({"extras": {"gaia": None, "cube": None}}, render, golden)
    _validate_sidecars({"extras": {"gaia": None, "cube": None}}, render, golden)


@pytest.mark.parametrize("name", ["../gaia.json", "/tmp/gaia.json", r"..\gaia.json", "C:/gaia.json"])
def test_sidecar_paths_cannot_escape_target_folder(tmp_path, name):
    render = tmp_path / "render"
    golden = tmp_path / "golden"
    render.mkdir()
    golden.mkdir()

    with pytest.raises(ValueError, match="invalid manifest sidecar path"):
        _export_sidecars({"extras": {"gaia": name}}, render, golden)
