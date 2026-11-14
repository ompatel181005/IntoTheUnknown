from app.processing import views


def test_dense_saved_capture_drops_thin_tails(monkeypatch):
    monkeypatch.setattr(views.config, "MIN_EPOCH_FRAMES_LIVE", 10)
    groups = [[{}] * n for n in (37, 5, 36, 42, 1)]
    assert [len(g) for g in views.select_epochs(groups, 2, saved=True)] == [37, 36, 42]


def test_sparse_demo_retains_legacy_epochs(monkeypatch):
    monkeypatch.setattr(views.config, "MIN_EPOCH_FRAMES_LIVE", 10)
    groups = [[{}] * n for n in (6, 6, 6)]
    assert [len(g) for g in views.select_epochs(groups, 2, saved=True)] == [6, 6, 6]


def test_live_data_does_not_use_sparse_demo_fallback(monkeypatch):
    monkeypatch.setattr(views.config, "MIN_EPOCH_FRAMES_LIVE", 10)
    assert not views.select_epochs([[{}] * 6, [{}] * 6], 10, saved=False)
