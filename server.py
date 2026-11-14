#!/usr/bin/env python3
"""
SPHEREx Blink - local server and archive proxy (Python standard library only).

    python3 server.py            # then open http://localhost:8000
    python3 server.py --port 9000

Serves index.html and forwards a small allow-list of archive requests so the browser
never runs into cross-origin (CORS) limits:

    /proxy/irsa/...    -> https://irsa.ipac.caltech.edu/...         (TAP queries, SPHEREx cutouts)
    /proxy/vizier/...  -> https://tapvizier.cds.unistra.fr/...      (Gaia DR3 overlay)
    /proxy/cds/...     -> https://cds.unistra.fr/...                (Sesame name resolver)

Cutouts are cached on disk (./cache) so replaying a target is instant and kind to IRSA.
"""
import argparse, hashlib, os, sys, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

UPSTREAMS = {
    "/proxy/irsa/": "https://irsa.ipac.caltech.edu/",
    "/proxy/vizier/": "https://tapvizier.cds.unistra.fr/",
    "/proxy/cds/": "https://cds.unistra.fr/",
}
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "cache")
UA = "SPHEREx-Blink/1.0 (NASA Space Apps demo)"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # Never let the browser keep a stale copy of the app or the demo pack (local development server).
        if not self.path.startswith("/proxy/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + (fmt % args) + "\n")

    def do_GET(self):
        if self.path == "/proxy/health":
            return self._send(200, b"spherex-blink proxy ok", "text/plain")
        for prefix, upstream in UPSTREAMS.items():
            if self.path.startswith(prefix):
                return self._proxy(upstream + self.path[len(prefix):])
        return super().do_GET()

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, url):
        # Only FITS file downloads are cached; queries always go upstream so new data appears.
        cacheable = "/ibe/data/spherex/" in url
        key = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest() + ".fits")
        if cacheable and os.path.exists(key):
            with open(key, "rb") as f:
                return self._send(200, f.read(), "application/fits", {"X-Cache": "hit"})
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
                ctype = r.headers.get("Content-Type", "application/octet-stream")
                if r.headers.get("Content-Encoding") == "gzip":
                    import gzip
                    body = gzip.decompress(body)
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read() or str(e).encode(), "text/plain")
        except Exception as e:  # network errors, timeouts
            return self._send(502, f"upstream error: {e}".encode(), "text/plain")
        if cacheable:
            os.makedirs(CACHE, exist_ok=True)
            with open(key, "wb") as f:
                f.write(body)
        self._send(200, body, ctype)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    print(f"SPHEREx Blink running at http://{a.host}:{a.port}  (Ctrl+C to stop)")
    ThreadingHTTPServer.request_queue_size = 128  # default 5 resets parallel cutout loads
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
