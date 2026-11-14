"""Mock IRSA/VizieR server producing SPHEREx-like MEF cutouts with known truth, for testing the viewer."""
import io, json, math, sys, urllib.parse, os
import numpy as np
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from astropy.io import fits
from astropy.wcs import WCS

APP = sys.argv[1]
PORT = int(sys.argv[2])
# Barnard's star (same numbers as the app preset)
T = dict(ra=269.4520833, dec=4.6933639, epoch=2000.0, pmra=-801.551, pmdec=10362.394, plx=546.976)
DETS = [(0.75, 1.09), (1.10, 1.62), (1.63, 2.41), (2.42, 3.82), (3.83, 4.41), (4.42, 5.00)]
PIX = 6.15 / 3600
D2R = math.pi / 180


def earth(year):
    n = (year - 2000.0) * 365.25
    L = (280.460 + 0.9856474 * n) * D2R; g = (357.528 + 0.9856003 * n) * D2R
    lam = L + (1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) * D2R
    eps = (23.439 - 0.0000004 * n) * D2R
    R = 1.00014 - 0.01671 * math.cos(g) - 0.00014 * math.cos(2 * g)
    return -R * math.cos(lam), -R * math.cos(eps) * math.sin(lam), -R * math.sin(eps) * math.sin(lam)


def propagate(s, year):
    dt = year - s["epoch"]; dA = s["pmra"] * dt; dD = s["pmdec"] * dt
    X, Y, Z = earth(year); a = s["ra"] * D2R; d = s["dec"] * D2R
    dA += s["plx"] * (X * math.sin(a) - Y * math.cos(a))
    dD += s["plx"] * (X * math.cos(a) * math.sin(d) + Y * math.sin(a) * math.sin(d) - Z * math.cos(d))
    dec = s["dec"] + dD / 3.6e6
    return s["ra"] + dA / 3.6e6 / math.cos(dec * D2R), dec


def mjd(year): return 51544.5 + (year - 2000) * 365.25


ROWS = []
for si, y0 in enumerate([2025.45, 2025.95, 2026.45]):
    for d in range(1, 7):
        for e in range(4):
            yr = y0 + (d * 0.5 + e * 0.9) / 365.25
            name = f"2025W{20+si*26}_{d}C_{e:04d}_1D{d}"
            for rel, ver in (("dr1", "l2b-v27"), ("qr2", "l2b-v20")):
                if rel == "qr2" and e % 2: continue
                uri = f"ibe/data/spherex/{rel}/level2/x/{ver}/{d}/level2_{name}_spx_{ver}.fits"
                ROWS.append((uri, mjd(yr), f"SPHEREx-D{d}", yr, d, e))
FIELD = [(269.40, 4.82, 30.0), (269.47, 4.80, 12.0), (269.43, 4.75, 20.0), (269.38, 4.77, 8.0)]


def target_flux(lam):  # µJy-ish arbitrary
    return 200.0 / lam


def make_fits(uri, cra, cdec, size):
    row = next(r for r in ROWS if r[0] == uri)
    _, _, _, yr, d, e = row
    n = int(round(size / PIX)); theta = (yr * 97.0 + d * 13) % 360 * D2R
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"]
    w.wcs.crval = [cra + 0.003, cdec - 0.002]; w.wcs.crpix = [n / 2 + 1.3, n / 2 - 0.7]
    w.wcs.cd = PIX * np.array([[-math.cos(theta), math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    from astropy.wcs import Sip
    a = np.zeros((3, 3)); b = np.zeros((3, 3)); a[2, 0] = 2e-5; b[0, 2] = -1.5e-5; a[1, 1] = 1e-5
    w.sip = Sip(a, b, None, None, w.wcs.crpix)
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    det_x0, det_y0 = 400 + 50 * e, 300 + 60 * d  # cutout origin on the detector (zero-based)
    lo, hi = DETS[d - 1]
    lam_of_y = lambda ydet1: lo + (hi - lo) * (ydet1 - 1) / 2039.0
    img = np.random.default_rng(int(yr * 1e5) % 2**31).normal(0, 0.01, (n, n)) + 0.5
    pix_sr = (PIX * D2R) ** 2
    sig = 0.9

    def add(ra, dec, flux_uJy):
        x, y = w.all_world2pix([[ra, dec]], 0)[0]
        img[:] += flux_uJy / 1e12 / pix_sr / (2 * math.pi * sig ** 2) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sig ** 2))
        return x, y
    for ra, dec, f in FIELD: add(ra, dec, f)
    tra, tdec = propagate(T, yr)
    tx, ty = w.all_world2pix([[tra, tdec]], 0)[0]
    lam_t = lam_of_y(det_y0 + ty + 1)
    add(tra, tdec, target_flux(lam_t))
    hdr = w.to_header(relax=True)
    hdr["CRPIX1A"] = 1.0; hdr["CRPIX2A"] = 1.0; hdr["CRVAL1A"] = float(det_x0); hdr["CRVAL2A"] = float(det_y0)
    hdr["CDELT1A"] = 1.0; hdr["CDELT2A"] = 1.0; hdr["CTYPE1A"] = "DETX"; hdr["CTYPE2A"] = "DETY"
    hdr["WCSNAMEA"] = "zero-based detector pixel"
    grid = np.array([1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040], float)
    vals = np.zeros((2, 9, 9))
    for j in range(9): vals[0, j, :] = lam_of_y(grid[j]); vals[1, j, :] = 0.02
    prim = fits.PrimaryHDU(); prim.header["VERSION"] = uri.split("_spx_")[1][:7]
    hd = [prim,
          fits.ImageHDU((img).astype(">f4"), hdr, name="IMAGE"),
          fits.CompImageHDU(np.zeros((n, n), np.int32), name="FLAGS"),
          fits.ImageHDU(np.full((n, n), 0.01, ">f4"), name="VARIANCE"),
          fits.ImageHDU(np.full((n, n), 0.5, ">f4"), hdr, name="ZODI"),
          fits.BinTableHDU.from_columns([fits.Column(name="X", format="9E", array=grid[None, :]),
                                         fits.Column(name="Y", format="9E", array=grid[None, :]),
                                         fits.Column(name="VALUES", format="162E", dim="(9,9,2)", array=vals.reshape(1, 162))], name="WCS-WAVE")]
    bio = io.BytesIO(); fits.HDUList(hd).writeto(bio)
    TRUTH[uri] = dict(year=yr, det=d, lam=lam_t, ra=tra, dec=tdec, flux=target_flux(lam_t))
    return bio.getvalue()


TRUTH = {}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=APP, **k)
    def log_message(self, *a): pass

    def send(self, body, ct):
        self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(p.query)
        if p.path == "/proxy/health": return self.send(b"spherex-blink proxy ok", "text/plain")
        if p.path == "/truth": return self.send(json.dumps(TRUTH).encode(), "application/json")
        if p.path.startswith("/proxy/irsa/TAP/sync"):
            out = "uri,time_bounds_lower,energy_bandpassname\n" + "\n".join(f"/{u},{m:.6f},{b}" for u, m, b, *_ in ROWS)
            return self.send(out.encode(), "text/csv")
        if p.path.startswith("/proxy/irsa/ibe/"):
            ra, dec = q["center"][0].rstrip("d").split(",")
            return self.send(make_fits(p.path[len("/proxy/irsa/"):], float(ra), float(dec), float(q["size"][0])), "application/fits")
        if p.path.startswith("/proxy/vizier/"):
            out = '"RA_ICRS","DE_ICRS","pmRA","pmDE","Plx","Gmag"\n' + "\n".join(f"{r},{d},0,0,0,{14-math.log10(f)}" for r, d, f in FIELD)
            return self.send(out.encode(), "text/csv")
        return super().do_GET()


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
