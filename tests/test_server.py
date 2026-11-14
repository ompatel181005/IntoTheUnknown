"""python3 tests/test_server.py  -- checks the proxy's cutout-size guard (AGENTS 9: no full frames)."""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from server import cutout_ok  # noqa: E402

F = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/x/level2_x_spx_l2b.fits"
assert cutout_ok(F + "?center=1,2&size=0.1250")
assert not cutout_ok(F)  # full frame
assert not cutout_ok(F + "?center=1,2&size=360")
assert not cutout_ok(F + "?center=1,2&size=6arcmin")
assert cutout_ok("https://irsa.ipac.caltech.edu/SIA?POS=circle%201%202%200.001")
print("PASS")
