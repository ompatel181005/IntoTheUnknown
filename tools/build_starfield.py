#!/usr/bin/env python3
"""Build starfield data from the Yale Bright Star Catalogue (BSC5).

Source:
    Yale Bright Star Catalogue, 5th Revised Edition
    Hoffleit, D. and Warren, W. H. Jr. (1991)
    Astronomical Data Center, NSSDC/ADC.
    VizieR catalog identifier: V/50 (table V/50/catalog).
    Landing page: https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50

Licence:
    Public Domain.
    Citation:
        Hoffleit, D. and Warren, W. H. Jr., "The Bright Star Catalogue,
        5th Revised Ed. (Preliminary Version)", Astronomical Data Center,
        NSSDC/ADC (1991), VizieR catalog V/50.

Description:
    This script downloads the V/50/catalog data from the CDS VizieR service
    (with automatic fallback to Harvard CFA and other international mirrors),
    parses coordinates and magnitudes, filters for stars with Vmag <= 6.5,
    fills missing B-V colors with 0.6, and outputs a compact, columnar JSON
    file sorted by visual magnitude (brightest first).

How to rerun:
    /home/eddie/IntoTheUnknown/backend/.venv/bin/python /home/eddie/IntoTheUnknown/tools/build_starfield.py
    or:
    python3 /home/eddie/IntoTheUnknown/tools/build_starfield.py

Output:
    frontend/public/sky/bsc5.json
"""

import csv
import json
import os
import sys
import urllib.error
import urllib.request

VIZIER_QUERY = (
    "asu-tsv?-source=V/50/catalog"
    "&-out=RAJ2000&-out=DEJ2000&-out=Vmag&-out=B-V"
    "&-out.max=unlimited&-oc.form=dec"
)

# VizieR endpoints (Harvard CFA tested responsive; Strasbourg included as primary per specification)
VIZIER_MIRRORS = [
    f"https://vizier.cfa.harvard.edu/viz-bin/{VIZIER_QUERY}",
    f"https://vizier.cds.unistra.fr/viz-bin/{VIZIER_QUERY}",
    f"https://vizier.idia.ac.za/viz-bin/{VIZIER_QUERY}",
    f"http://vizier.nao.ac.jp/viz-bin/{VIZIER_QUERY}",
]


def download_catalog(mirrors=VIZIER_MIRRORS, timeout=60):
    """Download TSV catalog data, trying mirror endpoints sequentially."""
    headers = {"User-Agent": "IntoTheUnknown-StarfieldBuilder/1.0"}
    last_err = None
    for url in mirrors:
        try:
            print(f"Fetching catalog from: {url}")
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    content = resp.read().decode("utf-8")
                    print(f"Successfully downloaded {len(content)} bytes.")
                    return content
                else:
                    print(f"HTTP {resp.status} from {url}")
        except Exception as e:
            print(f"Failed to fetch from {url}: {e}")
            last_err = e
            continue
    raise RuntimeError(f"Could not download catalog from any mirror. Last error: {last_err}")


def parse_ra(val: str) -> float:
    """Parse RA string in sexagesimal hours (HH MM SS.s) or decimal degrees to degrees [0, 360)."""
    val = val.strip()
    if " " in val:
        parts = val.split()
        deg = (float(parts[0]) + float(parts[1]) / 60.0 + float(parts[2]) / 3600.0) * 15.0
    elif ":" in val:
        parts = val.split(":")
        deg = (float(parts[0]) + float(parts[1]) / 60.0 + float(parts[2]) / 3600.0) * 15.0
    else:
        deg = float(val)
    return deg % 360.0


def parse_dec(val: str) -> float:
    """Parse Dec string in sexagesimal degrees (+/-DD MM SS.s) or decimal degrees to degrees [-90, 90]."""
    val = val.strip()
    sign = -1.0 if val.startswith("-") else 1.0
    clean = val.lstrip("+-").strip()
    if " " in clean:
        parts = clean.split()
        deg = sign * (float(parts[0]) + float(parts[1]) / 60.0 + float(parts[2]) / 3600.0)
    elif ":" in clean:
        parts = clean.split(":")
        deg = sign * (float(parts[0]) + float(parts[1]) / 60.0 + float(parts[2]) / 3600.0)
    else:
        deg = float(val)
    return max(-90.0, min(90.0, deg))


def build_starfield(raw_tsv: str, max_vmag: float = 6.5, default_bv: float = 0.6):
    """Parse VizieR TSV output and produce structured starfield data."""
    lines = raw_tsv.splitlines()
    stars = []
    skipped_header = 0
    skipped_missing = 0
    skipped_faint = 0

    reader = csv.reader(lines, delimiter="\t")
    for row in reader:
        if not row:
            continue
        first_col = row[0].strip()
        # Skip comment lines, table metadata, units, and column separators
        if (
            first_col.startswith("#")
            or "RAJ2000" in first_col
            or "---" in first_col
            or "h:m:s" in first_col
            or "deg" in first_col
        ):
            skipped_header += 1
            continue

        if len(row) < 3:
            skipped_missing += 1
            continue

        ra_str = row[0].strip()
        dec_str = row[1].strip()
        vmag_str = row[2].strip()

        if not ra_str or not dec_str or not vmag_str:
            skipped_missing += 1
            continue

        try:
            ra = parse_ra(ra_str)
            dec = parse_dec(dec_str)
            vmag = float(vmag_str)
        except (ValueError, IndexError):
            skipped_missing += 1
            continue

        if vmag > max_vmag:
            skipped_faint += 1
            continue

        bv_str = row[3].strip() if len(row) > 3 else ""
        if bv_str:
            try:
                bv = float(bv_str)
            except ValueError:
                bv = default_bv
        else:
            bv = default_bv

        stars.append({
            "ra": round(ra, 3),
            "dec": round(dec, 3),
            "vmag": round(vmag, 2),
            "bv": round(bv, 2),
        })

    # Sort by vmag ascending (brightest first)
    stars.sort(key=lambda s: s["vmag"])

    output_data = {
        "source": "Yale Bright Star Catalogue 5th ed. (Hoffleit and Warren 1991), VizieR V/50",
        "ref": "https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50",
        "epoch": 2000,
        "count": len(stars),
        "ra": [s["ra"] for s in stars],
        "dec": [s["dec"] for s in stars],
        "vmag": [s["vmag"] for s in stars],
        "bv": [s["bv"] for s in stars],
    }

    print(
        f"Parsed {len(stars)} stars (Vmag <= {max_vmag}). "
        f"Skipped: {skipped_faint} faint stars, {skipped_missing} missing data rows, "
        f"{skipped_header} header/comment lines."
    )
    return output_data


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    default_output = os.path.join(base_dir, "frontend", "public", "sky", "bsc5.json")
    output_path = sys.argv[1] if len(sys.argv) > 1 else default_output

    tsv_content = download_catalog()
    star_data = build_starfield(tsv_content)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(star_data, f, separators=(",", ":"))

    file_size = os.path.getsize(output_path)
    print(f"Wrote {star_data['count']} stars to {output_path} ({file_size} bytes, {file_size / 1024:.2f} KB)")


if __name__ == "__main__":
    main()
