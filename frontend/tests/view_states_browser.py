"""Local production-build QA: saved presets offline, mocked errors and sparse data.

Start `npm run preview -- --host 127.0.0.1 --port 5191`, then run with a Python
environment containing playwright. No backend or astronomy archive is required.
"""

import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from playwright.async_api import async_playwright

FRONTEND = Path(__file__).resolve().parents[1]

PAINTED = """() => {
  const c = document.querySelector('canvas[aria-label^="SPHEREx image, epoch"]');
  if (!c || c.dataset.ready !== 'true' || !c.width || !c.height) return false;
  for (let e=c;e;e=e.parentElement) {
    if (Number(getComputedStyle(e).opacity)<0.99 || getComputedStyle(e).visibility==='hidden') return false;
  }
  return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4!==3 && v>0);
}"""


def query(target, manifest, **changes):
    q = manifest["query"]
    return urlencode(
        {
            "target": target,
            "ra": q["ra"],
            "dec": q["dec"],
            "fov": q["fov_arcmin"],
            "band": q["band"],
            "src": "saved",
            **changes,
        }
    )


def json_response(body, status=200):
    async def handle(route):
        await route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    return handle


async def run(base, chrome):
    evidence = []
    screenshots = FRONTEND / "screenshots/view-states"
    screenshots.mkdir(parents=True, exist_ok=True)
    manifests = {p.parent.name: json.loads(p.read_text()) for p in (FRONTEND / "public/golden").glob("*/manifest.json")}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=chrome, headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        await page.add_init_script("localStorage.setItem('spherex-blink.guide-dismissed','1')")
        errors, api_calls = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: api_calls.append(request.url) if "/api/" in request.url else None)

        async def deny_api(route):
            await route.abort()

        await page.route("**/api/**", deny_api)
        for target, manifest in manifests.items():
            api_calls.clear()
            await page.goto(base + "/?" + query(target, manifest))
            await page.wait_for_function(PAINTED)
            assert not api_calls, api_calls
            assert await page.get_by_text("Saved SPHEREx cutouts · Saved snapshot · cached", exact=True).is_visible()
            await page.screenshot(path=str(screenshots / f"saved-{target}.png"))
            evidence.append({"target": target, "api_calls": 0, "painted": True})

        manifest = manifests["barnard"]
        await page.unroute("**/api/**", deny_api)
        for code, status, width in (
            ("QUEUE_FULL", 429, 1440),
            ("IRSA_DOWN", 503, 1440),
            ("QUEUE_FULL", 429, 390),
            ("IRSA_DOWN", 503, 390),
        ):
            await page.set_viewport_size({"width": width, "height": 1000 if width == 1440 else 844})
            error_response = json_response({"error": {"code": code, "message": "Request unavailable."}}, status)
            await page.route("**/api/**", error_response)
            await page.goto(
                base + "/?" + query("barnard", manifest, src="live", fov="10", band="B6", epoch="3", sel="4,5")
            )
            await page.get_by_role("alert").wait_for()
            title = "Render queue full" if code == "QUEUE_FULL" else "Archive unavailable for this request"
            assert await page.get_by_role("heading", name=title).is_visible()
            link = page.get_by_role("link", name="Open saved default: Barnard's Star")
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            await page.screenshot(path=str(screenshots / f"{code}-{width}.png"))
            await page.unroute("**/api/**", error_response)
            await page.route("**/api/**", deny_api)
            api_calls.clear()
            await link.click()
            await page.wait_for_function(PAINTED)
            assert not api_calls
            assert "src=saved" in page.url and "fov=6" in page.url and "sel=" not in page.url
            evidence.append({"error": code, "width": width, "saved_recovery": True, "api_calls_after_recovery": 0})
            await page.unroute("**/api/**", deny_api)

        mismatch = json_response({"error": {"code": "IRSA_DOWN", "message": "Request unavailable."}}, 503)
        await page.set_viewport_size({"width": 1440, "height": 1000})
        await page.route("**/api/**", mismatch)
        await page.goto(base + "/?" + query("barnard", manifest, ra="10", dec="10", src="live"))
        await page.get_by_role("alert").wait_for()
        header_text = await page.locator("header").inner_text()
        assert "Custom position" in header_text and "Barnard" not in header_text, header_text
        assert await page.get_by_role("link", name="Open saved default:", exact=False).count() == 0
        evidence.append({"mismatched_target_id": "Custom position", "no_wrong_field_recovery": True})
        await page.unroute("**/api/**", mismatch)
        api_calls.clear()

        await page.route("**/api/**", deny_api)
        for width in (1440, 390):
            await page.set_viewport_size({"width": width, "height": 1000 if width == 1440 else 844})
            for state in ("single", "empty", "missing-scatter", "single-details"):
                modified = json.loads(json.dumps(manifest))
                if state in ("single", "single-details"):
                    modified["epochs"] = modified["epochs"][:1]
                elif state == "empty":
                    modified["epochs"], modified["frames"] = [], []
                else:
                    modified["epochs"][0]["astrom_resid_px"] = None

                override = json_response(modified)
                await page.route("**/golden/barnard/manifest.json", override)
                await page.goto(
                    base
                    + "/?"
                    + query(
                        "barnard",
                        manifest,
                        panel="pass" if state in ("missing-scatter", "single-details") else "",
                        mode="diff" if state in ("single", "single-details") else "all",
                    )
                )
                if state == "empty":
                    await page.get_by_role("heading", name="No usable passes for this view").wait_for()
                    assert await page.get_by_role("heading", name="No usable passes for this view").is_visible()
                else:
                    await page.wait_for_function(PAINTED)
                    if state in ("single", "single-details"):
                        await page.get_by_text("One pass. Motion needs at least two passes.", exact=True).wait_for()
                        assert await page.get_by_text(
                            "One pass. Motion needs at least two passes.", exact=True
                        ).is_visible()
                        canvas_label = await page.locator('canvas[aria-label^="SPHEREx image, epoch"]').get_attribute(
                            "aria-label"
                        )
                        assert "difference" not in canvas_label
                        if state == "single-details":
                            await page.get_by_text(
                                "One pass. Motion needs at least two passes.", exact=True
                            ).scroll_into_view_if_needed()
                    else:
                        await page.get_by_text("Not measured", exact=True).wait_for()
                        assert await page.get_by_text("Not measured", exact=True).is_visible()
                        assert await page.get_by_text("Start (UTC)", exact=True).is_visible()
                        assert await page.get_by_text("End (UTC)", exact=True).is_visible()
                        await page.get_by_text("Not measured", exact=True).scroll_into_view_if_needed()
                assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                await page.screenshot(path=str(screenshots / f"{state}-{width}.png"))
                await page.unroute("**/golden/barnard/manifest.json", override)
                evidence.append({"state": state, "width": width, "passed": True})
        assert not errors, errors
        assert not api_calls, api_calls
        await browser.close()
    result = {"evidence": evidence, "browser_errors": errors}
    (screenshots / "results.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:5191")
    parser.add_argument("--chrome", default="C:/Program Files/Google/Chrome/Application/chrome.exe")
    args = parser.parse_args()
    assert urlsplit(args.base).hostname in ("localhost", "127.0.0.1"), "QA targets only a local preview"
    asyncio.run(run(args.base, args.chrome))
