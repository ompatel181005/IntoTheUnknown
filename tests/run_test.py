"""Live path against the mock IRSA archive:  python3 tests/mock_server.py . 8765 &  then  python3 tests/run_test.py OUTDIR [CHROME]"""
import json, math, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
OUT = sys.argv[1]
CHROME = sys.argv[2] if len(sys.argv) > 2 else "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1500, "height": 950})
    pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" and "404" not in m.text else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    url = BASE + "/index.html?ra=269.4520833&dec=4.6933639&pmra=-801.551&pmdec=10362.394&plx=546.976&name=Barnard%27s%20Star&src=live&fov=6&frames=epoch"
    pg.goto(url)
    pg.wait_for_function("document.getElementById('status').textContent.includes('seasons')", timeout=120000)
    pg.wait_for_timeout(500)
    pg.screenshot(path=f"{OUT}/live_mono.png")
    res = pg.evaluate("""() => {
      const half=(S.N-1)/2, out=[];
      for(const e of S.exps){
        const [ra,dec]=propagate(S.target,e.year); const [xi,eta]=tanFwd(ra,dec,S.center[0],S.center[1]);
        const px=half-xi/S.scaleDeg, py=half-eta/S.scaleDeg;
        // centroid in a 7x7 box around prediction
        let sx=0,sy=0,sw=0; const sky=skyLevel(e.data);
        for(let j=Math.round(py)-3;j<=Math.round(py)+3;j++) for(let i=Math.round(px)-3;i<=Math.round(px)+3;i++){ const v=e.data[j*S.N+i]-sky; if(v>0){sx+=v*i;sy+=v*j;sw+=v;} }
        out.push({uri:e.uri, dx:sx/sw-px, dy:sy/sw-py, rel:e.rel});
      }
      const ph=(S.photPts||[]).map(p=>({uri:p.e.uri, lam:p.lam, f:p.f}));
      return {n:S.exps.length, N:S.N, frames:S.frames.length, out, ph, gaia:S.gaia.length};
    }""")
    truth = json.load(urllib.request.urlopen(BASE + "/truth"))
    print("exposures", res["n"], "frames", res["frames"], "grid", res["N"], "gaia", res["gaia"])
    print("releases loaded:", sorted(set(o["rel"] for o in res["out"])))
    offs = [math.hypot(o["dx"], o["dy"]) for o in res["out"]]
    print("target centroid offset px: max %.3f mean %.3f" % (max(offs), sum(offs) / len(offs)))
    dl = [abs(p["lam"] - truth[p["uri"]]["lam"]) for p in res["ph"]]
    print("wavelength error µm: max %.4f" % max(dl))
    fr = [p["f"] / truth[p["uri"]]["flux"] for p in res["ph"] if p["f"] == p["f"]]
    print("flux ratio measured/true: min %.3f max %.3f n=%d" % (min(fr), max(fr), len(fr)))
    # Other display modes
    for mode in ("rgb", "diff"):
        pg.click(f"#dispSeg button[data-v={mode}]"); pg.wait_for_timeout(400)
        pg.screenshot(path=f"{OUT}/live_{mode}.png")
    pg.click("#tabs button[data-t=exp]"); pg.wait_for_timeout(200); pg.screenshot(path=f"{OUT}/live_table.png")
    # Simulated mode, each preset
    pg.click("#advBtn"); pg.wait_for_timeout(300); pg.click("#srcSeg button[data-v=sim]"); pg.click("#advClose"); pg.wait_for_timeout(300); pg.click("#dispSeg button[data-v=gray]")
    for name in ["WISE 0855", "RW Aurigae"]:
        pg.click(f".preset[data-name='{name}']")
        pg.wait_for_function("document.getElementById('status').textContent.includes('Simulated')", timeout=30000)
        pg.click("#tabs button[data-t=spec]"); pg.wait_for_timeout(400)
        pg.screenshot(path=f"{OUT}/sim_{name.replace(' ','_')}.png")
        if name=="WISE 0855":
            pg.click("#dispSeg button[data-v=diff]"); pg.click("#nextBtn"); pg.click("#nextBtn"); pg.wait_for_timeout(300)
            pg.screenshot(path=f"{OUT}/sim_wise_diff.png"); pg.click("#dispSeg button[data-v=gray]")
    pg.click("#tabs button[data-t=lc]"); pg.wait_for_timeout(300); pg.screenshot(path=f"{OUT}/sim_lc.png")
    print("URL:", pg.url)
    # Embed view
    pg.goto(pg.url + "&embed=1"); pg.wait_for_timeout(1500); pg.screenshot(path=f"{OUT}/embed.png")
    # Fallback when no proxy and archive unreachable (file:// style): direct route
    b.close()
print("console errors:", errors or "none")
