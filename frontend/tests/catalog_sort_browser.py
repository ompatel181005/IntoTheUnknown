"""Production-build sorting QA with real bundled catalog/counts and no archive calls."""

import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright

FRONTEND = Path(__file__).resolve().parents[1]


async def run(base):
    evidence = FRONTEND / "tests/evidence/catalog-sort100"
    evidence.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((FRONTEND / "public/catalog/points.json").read_text())
    metadata = json.loads((FRONTEND / "public/catalog/data-availability.json").read_text())
    expected = sorted(
        catalog["objects"],
        key=lambda row: (
            -metadata["objects"][row["id"]]["frames"],
            -metadata["objects"][row["id"]]["passes"],
            row["name"].lower(),
        ),
    )
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe",
            headless=True,
        )
        for width in (1440, 320):
            page = await browser.new_page(
                viewport={"width": width, "height": 900}, reduced_motion="reduce"
            )
            await page.add_init_script(
                "localStorage.setItem('spherex-blink.guide-dismissed','1');"
                "localStorage.setItem('spherex-blink.home-panel-hidden','0');"
            )
            errors, archive_calls, api_calls = [], [], []
            page.on("pageerror", lambda error: errors.append(str(error)))

            async def remote(route):
                if route.request.url.endswith("/catalog/points.json"):
                    await route.fulfill(json=catalog)
                else:
                    archive_calls.append(route.request.url)
                    await route.abort()

            async def deny_api(route):
                api_calls.append(route.request.url)
                await route.abort()

            await page.route("https://**", remote)
            await page.route("**/api/**", deny_api)
            await page.goto(base)
            rows = page.get_by_role("list", name="Target list").get_by_role("listitem")
            await rows.last.wait_for()
            assert await rows.count() == 47
            sort = page.get_by_role("combobox", name="Sort targets")
            assert await sort.input_value() == "frames"
            actual = await rows.locator("input").evaluate_all(
                "inputs => inputs.map(el => el.id.replace('home-item-', ''))"
            )
            assert actual == [row["id"] for row in expected], actual
            first = expected[0]
            counts = metadata["objects"][first["id"]]
            assert f'{counts["frames"]} frames' in await rows.first.inner_text()
            checkbox = page.locator(f'#home-item-{first["id"]}')
            await checkbox.uncheck()
            await sort.select_option("passes")
            assert not await checkbox.is_checked()
            await sort.select_option("name")
            assert not await checkbox.is_checked()
            # A native labelled select retains keyboard focus and arrow-key support.
            await sort.focus()
            await page.keyboard.press("Home")
            assert await sort.input_value() == "frames"
            assert await sort.evaluate("el => el === document.activeElement")
            search = page.get_by_role("textbox", name="Search targets")
            await search.fill("barnard")
            assert await rows.count() == 1
            assert "Barnard" in await rows.first.inner_text()
            await search.press("Escape")
            assert await rows.count() == 47
            assert await page.locator("body").evaluate("el => el.scrollWidth <= innerWidth")
            assert await sort.evaluate("el => el.getBoundingClientRect().right <= innerWidth")
            await page.screenshot(path=str(evidence / f"most-frames-{width}.png"))
            assert not api_calls, api_calls
            assert not archive_calls, archive_calls
            assert not errors, errors
            results.append({"width": width, "targets": 47, "default_order_verified": True,
                            "selection_preserved": True, "search_and_keyboard": True,
                            "horizontal_overflow": False, "archive_calls": 0, "api_calls": 0,
                            "page_errors": errors})
            # Existing Fly button remains usable after reordering and search.
            await search.fill("barnard")
            await rows.get_by_role("button", name="Fly to Barnard's Star").click()
            await page.wait_for_url(lambda url: "target=barnard" in url or "point=barnard" in url)
            results[-1]["fly_navigation"] = True
            await page.close()
        await browser.close()
    (evidence / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:5198")
    asyncio.run(run(parser.parse_args().base))
