"""Chrome evidence for real loading UI with mocked archive stages; no archive traffic.

After npm run build and npm run preview -- --host 127.0.0.1 --port 5193:
  python tests/loading_browser.py --base http://127.0.0.1:5193
"""

import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from playwright.async_api import async_playwright

FRONTEND = Path(__file__).resolve().parents[1]
EVIDENCE = FRONTEND / "tests/evidence/loading83"


async def run(base, chrome):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(
        (FRONTEND / "public/golden/barnard/manifest.json").read_text()
    )
    query = manifest["query"]
    url = (
        base
        + "/?"
        + urlencode(
            {
                "ra": query["ra"],
                "dec": query["dec"],
                "target": "barnard",
                "fov": query["fov_arcmin"],
                "band": query["band"],
                "src": "live",
            }
        )
    )
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=chrome, headless=True
        )
        page = await browser.new_page(
            viewport={"width": 1440, "height": 1000}, reduced_motion="reduce"
        )
        await page.add_init_script(
            "localStorage.setItem('spherex-blink.guide-dismissed','1');localStorage.setItem('spherex-blink.customize-hidden','1')"
        )
        await page.clock.install()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.route(
            "https://**", lambda route: route.fulfill(status=404, body="offline QA")
        )
        state = {"status": "queued"}
        posts = []

        async def api(route):
            if route.request.method == "POST":
                posts.append(route.request.post_data_json)
                body = {
                    "status": "queued",
                    "view_id": "shared",
                    "status_url": "/api/views/shared/status",
                }
                status = 202
            elif route.request.url.endswith("/status"):
                body = dict(state)
                status = 200
            else:
                body = {
                    "ok": True,
                    "version": "QA",
                    "irsa": "down",
                    "catalog_version": "QA",
                }
                status = 200
            await route.fulfill(
                status=status, content_type="application/json", body=json.dumps(body)
            )

        await page.route("**/api/**", api)
        await page.goto(url, wait_until="domcontentloaded")
        await (
            page.get_by_role("status")
            .filter(has_text="Waiting for a render slot")
            .wait_for()
        )
        await page.clock.fast_forward(300)
        await page.wait_for_timeout(50)
        await page.screenshot(path=str(EVIDENCE / "queued-1440.png"))
        assert len(posts) == 1, posts  # includes React StrictMode cleanup before POST
        results.append({"stage": "queued", "width": 1440, "posts": len(posts)})

        state["status"] = "query"
        await page.clock.fast_forward(2000)
        await (
            page.get_by_role("status")
            .filter(has_text="Asking the SPHEREx archive")
            .wait_for()
        )
        await page.set_viewport_size({"width": 320, "height": 740})
        await page.screenshot(path=str(EVIDENCE / "query-320.png"))
        results.append({"stage": "query", "width": 320})

        state.update(status="fetch", progress={"done": 2, "total": 8})
        await page.clock.fast_forward(35000)
        await page.get_by_text(
            "Reading cutouts; the counter includes unsuccessful attempts. 2 / 8 completed.",
            exact=True,
        ).wait_for()
        recovery = page.get_by_role("link", name="Open saved default: Barnard's Star")
        await recovery.scroll_into_view_if_needed()
        assert await recovery.is_visible()
        assert "src=saved" in await recovery.get_attribute("href")
        assert await page.get_by_text("Still waiting.", exact=False).is_visible()
        assert await page.locator("body").evaluate(
            "el => el.scrollWidth <= window.innerWidth"
        )
        await page.screenshot(path=str(EVIDENCE / "fetch-recovery-320.png"))
        results.append(
            {
                "stage": "fetch",
                "width": 320,
                "done": 2,
                "total": 8,
                "elapsed_recovery": True,
                "horizontal_overflow": False,
            }
        )

        # Exercise two real control changes within the submission debounce.
        await page.set_viewport_size({"width": 1440, "height": 1000})
        await page.get_by_role("button", name="Customize", exact=True).first.click()
        group = page.get_by_role("radiogroup", name="Field of view in arcminutes")
        before = len(posts)
        await group.evaluate(
            "el => {el.querySelectorAll('button')[0].click(); setTimeout(() => el.querySelectorAll('button')[1].click(), 50)}"
        )
        await page.clock.fast_forward(60)
        await page.wait_for_timeout(50)
        await page.clock.fast_forward(300)
        await page.wait_for_timeout(50)
        assert len(posts) == before + 1, posts[before:]
        assert posts[-1]["fov_arcmin"] == 4
        results.append(
            {"rapid_fov_changes": [2, 4], "new_posts": 1, "submitted_fov": 4}
        )

        # Prepared files have distinct copy and load with no POST. Hold only the
        # bundled manifest long enough to inspect the real React loading state.
        release = asyncio.Event()

        async def prepared(route):
            await release.wait()
            await route.fulfill(
                status=200, content_type="application/json", body=json.dumps(manifest)
            )

        await page.route("**/golden/barnard/manifest.json", prepared)
        before = len(posts)
        await page.goto(
            url.replace("src=live", "src=saved"), wait_until="domcontentloaded"
        )
        await (
            page.get_by_role("status")
            .filter(has_text="Loading prepared images")
            .wait_for()
        )
        await page.screenshot(path=str(EVIDENCE / "prepared-1440.png"))
        assert len(posts) == before
        release.set()
        results.append({"stage": "prepared", "width": 1440, "new_posts": 0})
        assert not errors, errors
        await browser.close()
    (EVIDENCE / "results.json").write_text(
        json.dumps(
            {"mocked_api": True, "results": results, "page_errors": errors}, indent=2
        )
        + "\n"
    )
    print(json.dumps(results))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:5193")
    parser.add_argument(
        "--chrome", default="C:/Program Files/Google/Chrome/Application/chrome.exe"
    )
    args = parser.parse_args()
    assert urlsplit(args.base).hostname in ("localhost", "127.0.0.1"), (
        "QA targets only a local preview"
    )
    asyncio.run(run(args.base, args.chrome))
