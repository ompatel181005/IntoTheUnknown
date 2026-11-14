"""
Known-answer check of the simulated sky and the analysis chain, for all five challenge targets.

    python3 server.py --port 8770 &          # in the repo root
    python3 tests/test_sim.py OUTDIR [--chrome PATH]

For every exposure it compares what the app *measures* with what the simulation *put in*:
  - target centroid vs predicted position (proper motion + parallax)  -> must agree to < 0.25 px
  - photometry (with aperture correction) vs input flux               -> median ratio within 3 %
  - every exposure date lies between survey start (2025-05-01) and today
  - the six detectors of an exposure share one timestamp
Screenshots of each target go to OUTDIR.
"""
import argparse, json, statistics, sys
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("out"); ap.add_argument("--base", default="http://127.0.0.1:8770")
ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
a = ap.parse_args()

CHECK = """() => {
  const half=(S.N-1)/2, res=[];
  for(const e of S.exps){
    const [ra,dec]=propagate(S.target,e.year); const [xi,eta]=tanFwd(ra,dec,S.center[0],S.center[1]);
    const px=half-xi/S.scaleDeg, py=half-eta/S.scaleDeg;
    let sx=0,sy=0,sw=0; const sky=skyLevel(e.data);
    for(let j=Math.round(py)-2;j<=Math.round(py)+2;j++) for(let i=Math.round(px)-2;i<=Math.round(px)+2;i++){
      if(i<0||j<0||i>=S.N||j>=S.N) continue; const v=e.data[j*S.N+i]-sky; if(v>0&&Number.isFinite(v)){sx+=v*i;sy+=v*j;sw+=v;} }
    const truth=modelFlux(S.target.kind,e.lam)*Math.pow(10,-0.4*variability(S.target,e.year,e.lam));
    const p=S.photPts.find(q=>q.e===e);
    res.push({det:e.det, year:e.year, lam:e.lam, dx:sx/sw-px, dy:sy/sw-py, ratio:p&&Number.isFinite(p.f)? p.f/truth : null, truth});
  }
  return {n:S.exps.length, frames:S.frames.length, gaia:S.gaia.length, wise:S.wise.length, now:nowYear(), start:CONFIG.SURVEY_START, res,
          status:document.getElementById('status').textContent};
}"""

fails, errors = [], []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=a.chrome, headless=True)
    pg = b.new_page(viewport={"width": 1500, "height": 1000})
    # a 404 for demo/index.json is expected before tools/fetch_demo.py has been run
    pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" and "404" not in m.text else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.goto(a.base + "/index.html?src=sim&ra=0&dec=0")   # start in simulated mode
    pg.wait_for_timeout(800)
    for name in ["Barnard's Star", "ε Indi B", "WISE 0855", "RW Aurigae", "R Draconis"]:
        pg.click(f".preset[data-name=\"{name}\"]")
        pg.wait_for_function("document.getElementById('status').textContent.startsWith('Simulated')", timeout=30000)
        pg.wait_for_timeout(300)
        r = pg.evaluate(CHECK)
        res = r["res"]
        # bright-enough exposures only for centroid/flux checks (S/N matters for WISE 0855 at short λ)
        strong = [x for x in res if x["truth"] > 50]
        # centroids only where S/N is high: a positive-pixel centroid is biased by noise on faint detections
        bright = [x for x in res if x["truth"] > 2000] or strong
        off = [((x["dx"] ** 2 + x["dy"] ** 2) ** 0.5) for x in bright]
        ratios = [x["ratio"] for x in strong if x["ratio"]]
        med = statistics.median(ratios) if ratios else float("nan")
        years = [x["year"] for x in res]
        times = {}
        for x in res: times.setdefault(round(x["year"], 9), set()).add(x["det"])
        simultaneous = all(len(v) == 6 for v in times.values())
        line = (f"{name:15s} exps={r['n']:3d} frames={r['frames']:2d} gaia={r['gaia']:3d} wise={r['wise']:3d} "
                f"span={min(years):.3f}–{max(years):.3f} centroid max={max(off):.3f}px "
                f"flux ratio median={med:.3f} (n={len(ratios)}) 6-det simultaneous={simultaneous}")
        print(line)
        if max(off) > (0.25 if bright is not strong else 0.8): fails.append(f"{name}: centroid offset {max(off):.3f} px")
        if not abs(med - 1) < 0.03: fails.append(f"{name}: flux ratio {med:.3f}")
        if min(years) < r["start"] - 1e-6 or max(years) > r["now"]: fails.append(f"{name}: dates outside survey span")
        if not simultaneous: fails.append(f"{name}: detectors not simultaneous")
        slug = name.split()[0].strip("'’").replace("ε", "eps")
        pg.screenshot(path=f"{a.out}/sim_{slug}.png")
    # display modes and tabs on the last target
    for mode in ("rgb", "diff"):
        pg.click(f"#dispSeg button[data-v={mode}]"); pg.wait_for_timeout(300); pg.screenshot(path=f"{a.out}/mode_{mode}.png")
    pg.click("#dispSeg button[data-v=gray]")
    pg.click("#tabs button[data-t=lc]"); pg.wait_for_timeout(300); pg.screenshot(path=f"{a.out}/lightcurve.png")
    pg.click("header nav button[data-about=project]"); pg.wait_for_timeout(300); pg.screenshot(path=f"{a.out}/about.png")
    b.close()

print("console errors:", errors or "none")
if fails or errors:
    print("FAIL:", *fails, sep="\n  "); sys.exit(1)
print("PASS")
