"""
End-to-end check of the whole app in a real browser: every button, view, tab and interaction.

    python3 server.py --port 8811 &
    python3 tests/test_ui.py OUTDIR [--base URL] [--chrome PATH] [--live]

Prints one PASS/FAIL line per check and exits non-zero if anything fails. --live also tries the
live IRSA archive (reported as SKIP rather than FAIL if IRSA itself is down).
"""
import argparse, json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("out"); ap.add_argument("--base", default="http://127.0.0.1:8811")
ap.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
ap.add_argument("--live", action="store_true")
a = ap.parse_args()
B = a.base
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — '+str(detail)) if detail else ''}", flush=True)
def skip(name, detail): print(f"SKIP  {name}  — {detail}", flush=True)

idx = json.load(urllib.request.urlopen(B + "/demo/index.json"))
demo = {k for k, v in idx["targets"].items() if v.get("files", 0) > 0}
NAMES = {"barnard": "Barnard's Star", "epsindib": "ε Indi B", "wise0855": "WISE 0855", "rwaur": "RW Aurigae", "rdra": "R Draconis"}
LOADED = "$('status').textContent.includes('exposures')"
DOME_LIT = """()=>{ const c=$('img'), x=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let lit=0; for(let i=0;i<x.length;i+=40) if(x[i]+x[i+1]+x[i+2]>60) lit++; return lit; }"""

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=a.chrome, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = br.new_page(viewport={"width": 1440, "height": 900}); errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and not any(s in m.text for s in ("502", "404", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "Failed to fetch")) else None)

    # 1. first visit: tour
    pg.goto(B + "/index.html"); pg.wait_for_function(LOADED, timeout=90000); pg.wait_for_timeout(1500)
    check("first visit opens the guided tour", pg.is_visible("#tourCard"))
    steps = 0
    while pg.is_visible("#tourCard") and steps < 10:
        pg.click("#tourNext"); pg.wait_for_timeout(500); steps += 1
    check("tour walks through all steps and closes", steps == 6 and not pg.is_visible("#tourCard"), f"{steps} steps")
    pg.screenshot(path=f"{a.out}/ui_home.png")

    # 2. every target in the saved pack: loads, has frames, plays
    for slug in ["barnard", "epsindib", "wise0855", "rwaur", "rdra"]:
        name = NAMES[slug]
        if slug not in demo: skip(f"{name}: saved real data", "not in the demo pack yet"); continue
        pg.click(f'.preset[data-name="{name}"]'); pg.wait_for_function(LOADED, timeout=90000); pg.wait_for_timeout(600)
        st = pg.evaluate("()=>({n:S.exps.length, frames:S.frames.length, badge:$('modeBadge').textContent, lit:0})")
        check(f"{name}: real images load", st["n"] > 0 and "REAL" in st["badge"], f"{st['n']} images, {st['frames']} visits")
        check(f"{name}: dome shows the sky", pg.evaluate(DOME_LIT) > 50)
        if st["frames"] >= 2:
            pg.click("#playBtn"); seen = set()
            for _ in range(8): seen.add(pg.evaluate("()=>S.cur")); pg.wait_for_timeout(250)
            pg.click("#playBtn")
            check(f"{name}: Play steps through visits", len(seen) >= 2, f"saw frames {sorted(seen)}")
        else:
            check(f"{name}: has at least 2 visits to play", False, st)

    # 3. the three views
    pg.click('.preset[data-name="Barnard\'s Star"]') if "barnard" in demo else None
    pg.wait_for_function(LOADED, timeout=90000)
    for v, label in (("gray", "Picture"), ("rgb", "Colours"), ("diff", "What changed")):
        pg.click(f"#dispSeg button[data-v={v}]"); pg.evaluate("()=>{ S.cur=1; S.refIdx=0; S.ref='first'; render(); }"); pg.wait_for_timeout(300)  # visit 2 vs visit 1
        check(f"view '{label}' renders", pg.evaluate("()=>S.disp") == v and pg.evaluate(DOME_LIT) > 20)
        pg.screenshot(path=f"{a.out}/ui_view_{v}.png")
    pg.click("#dispSeg button[data-v=gray]")

    # 4. zoom, pan, hover, click-to-measure, overlay alignment
    pg.evaluate("()=>window.scrollTo(0,0)"); pg.wait_for_timeout(200)
    box = pg.locator("#ov").bounding_box(); cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] * 0.45
    pg.mouse.move(cx, cy); pg.mouse.wheel(0, -600); pg.wait_for_timeout(300)
    z = pg.evaluate("()=>S.view.z"); check("scroll wheel zooms in", z > 1.5, f"{z:.2f}×")
    v0 = pg.evaluate("()=>[S.view.x,S.view.y]")
    pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 120, cy + 60, steps=6); pg.mouse.up(); pg.wait_for_timeout(200)
    v1 = pg.evaluate("()=>[S.view.x,S.view.y]"); check("drag pans the view", abs(v1[0] - v0[0]) > 1, f"{v0} -> {v1}")
    tx = pg.evaluate("()=>{ const f=S.frames[S.cur], r=$('ov').getBoundingClientRect(); const [gx,gy]=skyToGrid(...propagate(S.target,f.year)); const [x,y]=gridToDisp(gx,gy,r.width); return [x+r.left,y+r.top]; }")
    pg.mouse.move(tx[0] + 2, tx[1] + 2); pg.wait_for_timeout(250)
    check("hovering the target shows its name", pg.is_visible("#tip") and "★" in pg.inner_text("#tip"), pg.inner_text("#tip") if pg.is_visible("#tip") else "")
    pg.mouse.click(tx[0], tx[1]); pg.wait_for_timeout(500)
    err = pg.evaluate("()=>{ const f=S.frames[S.cur]; const [ra,dec]=propagate(S.target,f.year); return Math.hypot((S.phot.ra-ra)*Math.cos(dec*Math.PI/180), S.phot.dec-dec)*3600; }")
    check("click measures exactly where you clicked (zoomed)", err < 3.0, f"{err:.2f}″ from the target")
    check("click fills the spectrum", pg.evaluate("()=>S.photPts.filter(p=>Number.isFinite(p.f)).length") > 5)
    pg.screenshot(path=f"{a.out}/ui_zoom_measure.png")
    pg.click("#zoomIn"); z2 = pg.evaluate("()=>S.view.z"); pg.click("#zoomReset"); z3 = pg.evaluate("()=>S.view.z")
    check("zoom buttons work", z2 > z and z3 == 1, f"{z:.2f} -> {z2:.2f} -> {z3}")
    pg.evaluate("()=>window.scrollTo(0,0)"); pg.wait_for_timeout(200); b2 = pg.locator("#ov").bounding_box()
    sy0 = pg.evaluate("()=>scrollY"); pg.mouse.move(b2["x"] + b2["width"] / 2, b2["y"] + b2["height"] * 0.45); pg.mouse.wheel(0, 400); pg.wait_for_timeout(500)
    check("at 1x, scrolling down over the dome scrolls the page", pg.evaluate("()=>scrollY") > sy0 and pg.evaluate("()=>S.view.z") == 1)
    pg.evaluate("()=>window.scrollTo(0,0)")

    # 5. keyboard
    pg.mouse.move(5, 5); pg.keyboard.press("ArrowRight"); c1 = pg.evaluate("()=>S.cur"); pg.keyboard.press("ArrowLeft"); c0 = pg.evaluate("()=>S.cur")
    check("arrow keys step frames", c1 != c0)
    pg.keyboard.press("d"); d = pg.evaluate("()=>S.disp"); pg.keyboard.press("c"); c = pg.evaluate("()=>S.disp"); pg.keyboard.press("m"); m = pg.evaluate("()=>S.disp")
    check("D / C / M switch views", (d, c, m) == ("diff", "rgb", "gray"))
    pg.keyboard.press("+"); zk = pg.evaluate("()=>S.view.z"); pg.keyboard.press("0")
    check("+ / 0 zoom from the keyboard", zk > 1 and pg.evaluate("()=>S.view.z") == 1)
    pg.keyboard.press(" "); pg.wait_for_timeout(700); pl = pg.evaluate("()=>S.playing"); pg.keyboard.press(" ")
    check("space bar plays and pauses", pl and not pg.evaluate("()=>S.playing"))

    # 6. measurement tabs
    pg.evaluate("()=>{ $('specTrack').checked=true; updatePhot(); }")   # back to measuring the target (option lives in Advanced)
    for t, test in (("spec", "()=>S.photPts.filter(p=>Number.isFinite(p.f)).length>5"),
                    ("lc", "()=>$('lcLegend').children.length>0"),
                    ("exp", "()=>$('expTable').querySelectorAll('tbody tr').length===S.exps.length")):
        pg.click(f"#tabs button[data-t={t}]"); pg.wait_for_timeout(300)
        check(f"tab '{pg.inner_text(f'#tabs button[data-t={t}]')}' works", pg.evaluate(test))
    pg.click("#tabs button[data-t=ctx]"); ok = False
    for _ in range(30):
        ok = pg.evaluate("()=>!!S.aladin && document.querySelectorAll('#aladin canvas').length>0")
        if ok: break
        pg.wait_for_timeout(500)
    check("tab 'Whole-sky map' opens Aladin on the SPHEREx all-sky map", ok and "SPHEREx" in pg.inner_text("#hips option:checked"))
    pg.evaluate("()=>{ $('cubeSlice').value=92; $('cubeSlice').dispatchEvent(new Event('input')); }"); pg.wait_for_timeout(1500)
    check("SPHEREx colour slider changes the map's band", pg.evaluate("()=>S.aladin.getBaseImageLayer().slice") == 92)
    pg.wait_for_timeout(4000); pg.screenshot(path=f"{a.out}/ui_skymap.png")

    # 7. advanced drawer + simulated sky + back
    pg.click("#advBtn"); pg.wait_for_timeout(400); check("Advanced drawer opens", pg.evaluate("()=>$('adv').classList.contains('open')"))
    pg.screenshot(path=f"{a.out}/ui_advanced.png")
    pg.click("#srcSeg button[data-v=sim]"); pg.wait_for_function("$('status').textContent.startsWith('Simulated')", timeout=60000)
    check("switching to the simulated sky works", "SIMULATED" in pg.inner_text("#modeBadge"))
    pg.click("#srcSeg button[data-v=demo]"); pg.wait_for_function(LOADED + " && !$('status').textContent.startsWith('Simulated')", timeout=90000)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check("Esc closes the drawer", not pg.evaluate("()=>$('adv').classList.contains('open')"))
    # custom coordinates
    pg.click(".preset.custom"); pg.wait_for_timeout(400)
    pg.fill("#name", ""); pg.fill("#ra", "17:57:48.5"); pg.fill("#dec", "+04:41:36"); pg.fill("#pmra", "-801.551"); pg.fill("#pmdec", "10362.394"); pg.fill("#plx", "546.976"); pg.fill("#epoch", "2000")
    pg.click("#goBtn"); pg.wait_for_function(LOADED + " || $('banner').textContent.length>0", timeout=120000); pg.wait_for_timeout(500)
    tgt = pg.evaluate("()=>S.target && [S.target.ra, S.target.dec]")
    check("typed sexagesimal coordinates are understood", tgt and abs(tgt[0] - 269.4521) < 0.001 and abs(tgt[1] - 4.6933) < 0.001, tgt)

    # 8. share link + embed
    if "wise0855" in demo:
        pg.click('.preset[data-name="WISE 0855"]'); pg.wait_for_function(LOADED, timeout=90000)
    url = pg.url
    check("the URL carries the coordinates", "ra=" in url and "dec=" in url, url[len(B):][:90])
    q = br.new_page(viewport={"width": 1000, "height": 800}); q.goto(url); q.wait_for_function(LOADED, timeout=90000)
    check("opening a shared link restores the same target", abs(q.evaluate("()=>S.target.ra") - pg.evaluate("()=>S.target.ra")) < 1e-6)
    q.goto(url + "&embed=1"); q.wait_for_function(LOADED, timeout=90000); q.wait_for_timeout(500)
    check("&embed=1 shows just the dome and player", not q.is_visible("header") and q.is_visible("#stage") and q.is_visible("#player"))
    q.screenshot(path=f"{a.out}/ui_embed.png"); q.close()

    # 9. phone
    m = br.new_page(viewport={"width": 390, "height": 844}); m.goto(url); m.wait_for_function(LOADED, timeout=90000); m.wait_for_timeout(500)
    check("phone: no sideways scrolling", not m.evaluate("()=>document.documentElement.scrollWidth>innerWidth"))
    m.screenshot(path=f"{a.out}/ui_phone.png"); m.close()

    # 10. live archive (optional)
    if a.live:
        pg.click("#advBtn"); pg.click("#srcSeg button[data-v=live]"); pg.keyboard.press("Escape")
        pg.click('.preset[data-name="Barnard\'s Star"]'); t0 = time.time()
        pg.wait_for_function("$('status').textContent.includes('real exposures') || $('modeBadge').textContent.includes('SIMULATED')", timeout=420000)
        if "SIMULATED" in pg.inner_text("#modeBadge"): skip("live IRSA archive", "IRSA unavailable: " + pg.inner_text("#banner")[:120])
        else: check("live IRSA archive loads real images", True, f"{pg.evaluate('()=>S.exps.length')} images in {time.time()-t0:.0f}s")

    check("no JavaScript errors anywhere", not errors, errors[:3])
    br.close()

bad = [n for n, ok in results if not ok]
print(f"\n{len(results)-len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
