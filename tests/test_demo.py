"""
Checks the bundled demo pack of real SPHEREx cutouts in the browser.

    python3 server.py --port 8811 &
    python3 tests/test_demo.py OUTDIR [--base URL] [--chrome PATH]

For every target in demo/index.json: loads it in Demo mode and checks that
  - every cutout parses, reprojects and is measured (no console errors);
  - every exposure's per-pixel wavelength from WCS-WAVE falls inside its detector's range;
  - blank-sky apertures are unbiased (median within 1σ of zero).
"""
import argparse, json, sys, urllib.request
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("out"); ap.add_argument("--base", default="http://127.0.0.1:8811")
ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
a = ap.parse_args()
idx = json.load(urllib.request.urlopen(a.base + "/demo/index.json"))
targets = {k: v for k, v in idx["targets"].items() if v.get("files", 0) > 0}
if not targets:
    sys.exit("demo pack is empty: run python3 tools/fetch_demo.py")

CHECK = """() => {
  const bad=[], blank=[];
  for(const e of S.exps){ const D=DETS[e.det-1]; if(!(e.lam>=D.lo-0.05 && e.lam<=D.hi+0.05) || e.lamSrc!=="WCS-WAVE") bad.push([e.det,e.lam,e.lamSrc]);
    for(let k=0;k<6;k++){ const c=6+((k*7919)%(S.N-12)), r=6+((k*104729)%(S.N-12)); const f=aperture(e.data,c,r,e.lam,e.psfSig); if(Number.isFinite(f)) blank.push(f); } }
  blank.sort((x,y)=>x-y); const q=f=>blank[Math.floor(f*(blank.length-1))];
  return {n:S.exps.length, seasons:clusterTimes(S.exps,CONFIG.SEASON_GAP_DAYS).length, bad, med:q(0.5), sig:(q(0.84)-q(0.16))/2,
          measured:S.photPts.filter(p=>Number.isFinite(p.f)).length};
}"""
fails, errors = [], []
names = {"barnard": "Barnard's Star", "epsindib": "ε Indi B", "wise0855": "WISE 0855", "rwaur": "RW Aurigae", "rdra": "R Draconis"}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=a.chrome, headless=True)
    pg = b.new_page(viewport={"width": 1500, "height": 1000})
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(a.base + "/index.html?src=demo&ra=269.4520833&dec=4.6933639"); pg.wait_for_timeout(1000)  # a demo target: no live IRSA call
    for slug in targets:
        pg.click(f'.preset[data-name="{names[slug]}"]')
        pg.wait_for_function("document.getElementById('status').textContent.includes('real exposures')", timeout=90000)
        pg.wait_for_timeout(400)
        r = pg.evaluate(CHECK)
        print(f"{names[slug]:15s} exposures={r['n']:3d} seasons={r['seasons']} measured={r['measured']} "
              f"wavelength-out-of-range={len(r['bad'])} blank-sky median={r['med']:.0f}±{r['sig']:.0f} µJy")
        if r["bad"]: fails.append(f"{slug}: wavelengths outside detector range {r['bad'][:3]}")
        if abs(r["med"]) > r["sig"]: fails.append(f"{slug}: blank-sky photometry biased")
        sat = pg.evaluate("()=>S.photSaturated")
        if r["measured"] == 0 and not sat: fails.append(f"{slug}: nothing measured and not explained by saturation")
        if sat: print(f"{'':15s} (saturated: the app explains why it can't be measured)")
        pg.screenshot(path=f"{a.out}/demo_{slug}.png")
    b.close()
print("console errors:", errors or "none")
if fails or errors:
    print("FAIL:", *fails, sep="\n  "); sys.exit(1)
print("PASS")
