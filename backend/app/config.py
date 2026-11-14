"""Settings from the environment (names in the root .env.example)."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repo root
DEMO_DIR = Path(os.environ.get("DEMO_DIR", ROOT / "demo"))  # real cutouts bundled by tools/fetch_demo.py
CACHE_DIR = Path(os.environ.get("CACHE_DIR", ROOT / "backend" / ".cache"))
IRSA_TIMEOUT_S = int(os.environ.get("IRSA_TIMEOUT_S", "120"))
CUTOUT_MAX_WORKERS = int(os.environ.get("CUTOUT_MAX_WORKERS", "10"))
MAX_RENDER_JOBS = int(os.environ.get("MAX_RENDER_JOBS", "2"))
MAX_FRAMES_PER_VIEW = int(os.environ.get("MAX_FRAMES_PER_VIEW", "300"))
# DECISIONS 2026-11-14 13:40 drops epochs under 10 frames. The demo pack holds ~50 cutouts per target over all
# detectors (R Dra: 2 per visit), so the demo path keeps any epoch with 2+ frames until golden capture has full sets.
MIN_EPOCH_FRAMES_LIVE = int(os.environ.get("MIN_EPOCH_FRAMES", "10"))
MIN_EPOCH_FRAMES_DEMO = int(os.environ.get("MIN_EPOCH_FRAMES_DEMO", "2"))
PIPELINE_VERSION = 2  # bump when render output changes, so cached renders rebuild
CORS_ORIGINS = [o for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",") if o]
