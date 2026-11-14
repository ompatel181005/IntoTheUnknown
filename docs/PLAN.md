# Wanderer: SPHEREx blink comparator (hackathon plan)

NASA Space Apps 2026 · "Planet X and SPHEREx" · local "Best Use of Azure"
Written Sat 2026-11-14. **This is the plan only. Nothing is built on `main` yet** (the `initialammar` branch is a side prototype, not this app). Open for team review.
Markers: **✓** = checked today against a live source. **(lit.)** = from literature or memory; confirm before quoting it in the pitch.

---

## 1. Current state (checked 2026-11-14)

| Topic | Brief said | Checked today | Consequence |
|---|---|---|---|
| Releases | dr1, dr1_deep, qr3, qr3_deep; QR2 superseded; DR1 due Nov 2026 | ✓ DR1 is out (Nov 2026). A 5th collection exists: `spherex_dr1_cube` (All-Sky Cube) and must be excluded from frame queries. QR2 can no longer be searched (download only until Feb 2027). QR1 is retired. **DR1 = Surveys 1–2. QR3 = Surveys 3–4**, released weekly since Sep 2026. | Select collections with a regex that drops `_cube`. Query the union of dr1 and qr3. |
| Epochs per patch | 3–4 passes | Survey 4 has only just started, so **most positions have 2–3 epochs now**. Positions near the ecliptic poles have many more (R Dra is at ecliptic latitude β≈+81°). | Design for a minimum of 2 epochs. The UI must handle a position with only 1. |
| Pixels / detectors | ~6″ | ✓ 6.15″/px, 2040×2040, 6 detectors | — |
| Bands | B1–B6 edges | ✓ Same edges. R = 39 / 41 / 41 / 35 / 112 / 128 | — |
| FITS layout | IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE | ✓ FLAGS is an int32 `CompImageHDU`. ZODI is **not** subtracted in Level 2 images (it is subtracted in the cube). EPSF holds 441 rows of 33×33 PSFs at 5× oversampling. WCS-WAVE is accurate to about 1 nm (fine for display). | Subtract ZODI ourselves. |
| Flags | 12 named bits | ✓ There are **22 bits**. Names and descriptions are stored in the FLAGS header as `MSKNnn`/`MSKDnn`, so **parse them at runtime and don't hard-code bit numbers**. SOURCE (bit 21) marks real sources and must **not** be masked. The tutorial's good-pixel rule is flags ∈ {0, SOURCE, OVERFLOW}. | §5 mask policy |
| Query | query_sia + TAP join | ✓ Exact code confirmed (§11). TAP queries took **20–37 s** in the tutorials. The SIA index lags about a day. | Use SIA on the user path. Use TAP for the watcher and as a fallback. |
| Cutouts | URL pattern, 10 workers | ✓ URL `…?center=<ra>,<dec>d&size=<deg>`. Timing confirmed (0.22 vs 2.26 min), **but the parallel run lost 16 of 84 cutouts and the tutorial has no retry logic**. Each cutout also carries the full EPSF table unmodified (about **3.8 MB per cutout**, by our arithmetic). | Add retries and a fallback (§11). Use band presets to keep fetch counts down. |
| **IRSA right now** | — | **SIA and TAP returned HTTP 502 for this whole session.** IRSA's static pages are up. | **Build the golden cache as soon as IRSA responds (§2 "Start here")** |
| CORS | assume none | IRSA could not be tested because of the 502s. The **AWS mirror `nasa-irsa-spherex` (us-east-1) is up**: anonymous access, `Access-Control-Allow-Origin: *`, and **the same path layout as IRSA's `ibe/data/spherex/…`** ✓ (e.g. `dr1/level2/2025W17_4B/l2b-v27-2026-196/1/level2_…_spx_l2b-v27-2026-196.fits`, 65 MB). | The backend still proxies everything. S3 becomes the fallback source for pixels. |
| Target coordinates | from SIMBAD | SIMBAD/CDS returns 404 today, so astrometry came from the **Gaia DR3 TAP, which works** ✓. **J2000 coordinates are arcminutes off for the movers.** Barnard's Star has moved about 4.6′ north since J2000 (1.7′ since Gaia's 2016 epoch). WISE 0855 is about 2′ west of its designation coordinates. | Propagate to the observation epoch. Never centre a view on J2000 coordinates. |
| Expected shift | "a couple of px" | With the ~1-year baseline available today: Barnard's 1.7 px, WISE 0855 1.3 px, ε Ind B 0.76 px. On top of that, a parallax wobble of up to ~2ϖ (0.18 px or less) between 6-month epochs (§5.8). | Use blink, a difference image, and measured centroids. |
| CDN | Front Door vs classic | ✓ Classic Azure CDN (Microsoft) accepts **no new profiles since Aug 15 2025** and retires Sep 30 2027. Front Door classic also accepts no new profiles. **Front Door Standard costs $35/month, billed hourly.** | Serve from Blob directly first. Add Front Door Standard on Sunday only if there's time (§4). |
| Azure for Students | — | ✓ $100 credit for 12 months. Always free: Container Apps 180k vCPU-s + 360k GiB-s + 2M requests per month; Functions 1M requests; Cosmos 1000 RU/s + 25 GB; SWA free; **ACR Standard free for 12 months**. ✓ Flex Consumption is the recommended Functions plan; students get **15 cores per region**; `WEBSITE_TIME_ZONE` is **not supported** (use UTC cron). Region policy: not stated in the docs we read, so check it with the CLI. Azure OpenAI is mentioned, but no free amount is listed and availability is unverified. | §8 runbook |
| Local tools | — | python 3.13, node, gh and uv are installed. **az, func, swa and docker are missing.** | Install them or use Azure Cloud Shell. Build images in GitHub Actions. |
| Not verified | — | The Space Apps challenge and resources tabs render with JavaScript, so we got no content. The submission form fields are unread. WiseView refused connections. The SPHEREx acknowledgement is now captured verbatim in `DATA.md`; the IRSA, Gaia and SIMBAD wordings are not. Cutout `size` units are implied to be degrees by the tutorial. | One person opens these in a browser at H0 (§7). |

---

## 2. The project in plain English

**What we're building.** A website where you type a sky position, or pick one of 5 famous objects, and see that patch of sky as SPHEREx saw it on each of its passes, played like a GIF.
- Things that **move** jump between frames: nearby stars and brown dwarfs.
- Things that **vary** flicker: young stars and pulsating giants.

There's a second axis, wavelength. Each pass contains frames at up to 102 infrared "colours", so you can also scrub through colour and watch, for example, a brown dwarf vanish in a methane band.

**Why it's needed.**
- WISE/NEOWISE, the data behind WiseView and the Backyard Worlds brown-dwarf discoveries, stopped observing in Aug 2024 (lit.).
- SPHEREx is the active infrared all-sky survey now, but its data is 65 MB multi-extension FITS files, queried through Python.
- We know of no tool that lets a non-expert answer "did anything move here?" in one click. This is unchecked against IRSA's own SPHEREx Data Explorer (§3).

**Who uses it.**
- Citizen scientists first.
- Teachers and students, who can see proper motion and parallax in real data.
- Astronomers who want a quick look before downloading anything.

**What we can realistically ship in 30 h.**
- **MVP:** flipbook, per-epoch stacking, difference mode, shareable URL. All 5 targets are served from a pre-computed cache. Arbitrary positions work live whenever IRSA is up.
- **Hook:** the Gaia "should be here" overlay. A mover Gaia can't explain is a candidate.
- **Stretch:** light curves, then brown-dwarf colour mode.

**Planet X geometry (a good science point for the pitch, from our own analysis).** SPHEREx always observes about 90° from the Sun. That means consecutive 6-month visits see the sky from opposite sides of Earth's orbit, so parallax is maximal.
- A Planet X at distance D AU jumps by about **2/D radians** between consecutive surveys: roughly 14′ at 500 AU. That's larger than a typical cutout, so it would show up as an object present in one epoch and missing in the next, not as a smooth mover.
- Comparing epochs **one year apart** (same side of the orbit) cancels the parallax, leaving only orbital motion: about 2′/yr at 500 AU.
- So our blink finds nearby stars and brown dwarfs. A Planet X search needs a "same-side, wide-FOV" mode (stretch). A Planet-Nine-like body is probably below SPHEREx's single-epoch depth anyway, and the pitch should say so honestly.

### Start here (first 3 hours, in this order)
1. **Golden-capture loop (data owner, immediately).** IRSA's query APIs are down. Write `scripts/precache.py --retry-every 10m`. As soon as IRSA answers, it saves the frame lists and cutouts for all 5 targets. While waiting, develop the pipeline against range-read windows from the S3 mirror (`fetch_s3` in `docs/skeletons/fetch.py`), never a full-frame download (`AGENTS.md` §9).
2. **Freeze the contracts (everyone, 45 min).** Write the `manifest.json` schema and endpoint shapes (§4.3) as Pydantic models plus TypeScript types. The frontend then builds against a mock manifest, so 5 people can work in parallel.
3. **Azure preflight (Azure owner).** Install az. Read the allowed-regions policy. Create the resource group, storage, Container Apps environment and SWA. Test whether the tenant allows an app registration for GitHub OIDC. This surfaces policy blockers in hour 1, not hour 11.
4. **Barnard's Star spike (data and science owners, in a notebook).** The riskiest unknown is the data itself: is a stacked epoch clean, is the star's core saturated or flagged, and does the ~1.7 px hop show? Answer that before writing much backend.

---

## 3. Product

**Name ideas:**
- **Wanderer** (recommended; "planet" comes from the Greek for "wanderer")
- BlinkX
- Driftwatch
- SpectraFlip

**One-line pitch:** "Type any spot on the sky and watch it move in 102 infrared colours. Wanderer blinks NASA's newest all-sky survey and predicts where every Gaia star should be, so a mover Gaia can't explain stands out."

**How it beats WiseView.** WiseView itself was unreachable today, so this comparison uses only facts on our side.

| | WiseView (unWISE/NEOWISE) | Wanderer (SPHEREx) | Ships in |
|---|---|---|---|
| Data freshness | Frozen; NEOWISE ended in 2024 (lit.) | Live mission with weekly ingest; **updates itself** | Azure track (watcher) |
| Colours | 2 bands (W1/W2) | 102 channels behind band presets; per-pixel spectrum; methane colour mode | MVP; T2; T3 |
| Explaining motion | — | Gaia DR3 prediction per epoch, **including parallax**, with a "Gaia match / no Gaia match" label | T2, first after the gate |
| Variability | — | Light-curve panel | T2 |
| Sharing | URL | URL; "report candidate" board | MVP; T3 |

**On the MVP alone** Wanderer is a blink comparator with coarser pixels and a shorter baseline than WiseView. Its edge at that point is live SPHEREx data and the band presets. Every motion-explaining row needs Tier 2, which is why the Gaia overlay is the first thing built after the gate.

**Against IRSA's own SPHEREx Data Explorer** (https://irsa.ipac.caltech.edu/applications/spherex): TODO(team). Open it at H0 and write one sentence on what Wanderer does that it doesn't. Judges will ask, and this plan has not checked.

**Where we're weaker:**
- Pixels are 6.15″ vs 2.75″ for unWISE.
- The baseline is ~1 yr, against 14 for WISE.
- SPHEREx is shallower at 4.6 µm.

So we position Wanderer as a complement: every view gets an **"Open in WiseView" link-out**.

---

## 4. Architecture

### 4.1 Diagram
```
                 ┌──────────────────────────── Azure ─────────────────────────────┐
 Browser ──────► │ Static Web Apps (Free): React app + /golden/* baked snapshots  │
   │             │                                                                │
   │ POST/GET    │ Container Apps (Consumption): FastAPI "api"                    │
   └──/api/*───► │   query (SIA→TAP) · fetch cutouts (IRSA→S3 fallback)           │──► IRSA SIA/TAP/cutouts
   │             │   stack · diff · render · Gaia · photometry · jobs             │──► AWS S3 nasa-irsa-spherex
   │             │        │ writes (managed identity)                             │──► Gaia DR3 TAP (ESA; MAST fallback)
   │             │        ▼                                                       │
   └─frames────► │ Blob Storage  frames/ (public read): q/ pointers, r/ renders,  │
     (optional   │               meta/catalog.json   state/ (private): jobs       │
     Front Door  │        ▲                                                       │
     Std edge)   │ Functions (Flex, Python): timer 06:00 UTC + HTTP "run-now"     │──► IRSA list_collections + TAP MAX(t)
                 │   diff catalog → POST api /internal/refresh                    │
                 │ Cosmos DB (free tier): candidate reports                       │
                 │ Application Insights: requests, IRSA dependencies, cache hits  │
                 └────────────────────────────────────────────────────────────────┘
```

### 4.2 Azure resources: each one solves a named problem
The table lives in [`infra/README.md`](../infra/README.md), where `infra/AGENTS.md` requires it. Cut: Durable Functions (a ThreadPool already gives the 10× speedup) and Azure OpenAI (deterministic template captions instead, §5.9).

### 4.3 Backend endpoints

All responses are JSON. Example values are illustrative.

```
GET  /api/health      → {"ok":true,"version":"0.3.0","irsa":"up|degraded|down","catalog_version":"c20261114-4-61350"}
GET  /api/targets     → [{"id":"barnard","name":"Barnard's Star","kind":"motion","ra":269.448503,"dec":4.739420,
                          "ref_epoch":2016.0,"pmra":-801.55,"pmdec":10362.39,"plx":546.98,"fov_arcmin":6,"band":"B1-B2"}]
POST /api/views       ← {"ra":269.4463,"dec":4.7682,"fov_arcmin":6,"band":"auto|B1..B6|B1-B2|B1-B3|all","mode":"stack|frames"}
                      → 200 {"view_id":"<qk>","status":"ready","manifest_url":"<FRAMES_BASE>/r/<rk>/manifest.json"}
                      → 202 {"view_id":"<qk>","status":"queued","status_url":"/api/views/<qk>"}
GET  /api/views/{id}  → {"status":"queued|query|fetch|stack|render|ready|error","progress":{"done":41,"total":96},
                         "manifest_url":"…","error":{"code":"IRSA_DOWN","message":"…"}}
GET  /api/views/{id}/gaia        → {"epochs_mjd":[…],"stars":[{"source_id":…,"g":8.19,"pmra":…,"pmdec":…,"plx":…,
                                     "track_px":[[x,y],…],"matched":[true,true,true]}],"unexplained":[{"x":…,"y":…,"shift_px":1.3}]}   ← "unexplained" is T3 (auto-flag); empty until then
GET  /api/views/{id}/spectrum?x=&y=&epoch=   → {"points":[{"lambda_um":…,"bw_um":…,"flux_mjysr":…,"err":…,"t_mjd":…,"detector":…,"flagged":false}]}
GET  /api/views/{id}/lightcurve?x=&y=&r_px=2 → {"points":[{"t_mjd":…,"lambda_um":…,"flux_ujy":…,"err":…,"flagged":false}],
                                                "comparison":{"n_stars":6,"rms_frac":0.03}}
POST /api/candidates  ← {"view_id","ra","dec","epochs":[0,2],"evidence":["…/e0.png","…/e2.png"],"notes","handle"} → 201 {"id"}
GET  /api/candidates?near=ra,dec&radius_deg=1 → [...]
GET  /api/status      → {"catalog":{"collections":[…],"latest_frame_mjd":…,"checked_at":…}}
POST /internal/refresh  (X-Refresh-Key) ← {"reason":"catalog_change","catalog_version":"…"} → 202 {"queued":7}
```

**Limits.** The API is public and needs no login, so these are part of the contract:
- `POST /api/views`: RA/Dec are range-checked; `fov_arcmin` and `band` are enums (§4.4). At most `MAX_RENDER_JOBS` (start at 2) run at once and 10 wait; beyond that, return 429. At most `MAX_FRAMES_PER_VIEW` (start at 300, then tune) cutouts per view. Both protect IRSA as much as us.
- `POST /api/candidates` (T3): `notes` ≤ 500 characters, `handle` ≤ 32, `evidence` URLs must start with `FRAMES_PUBLIC_BASE`. Store and render them as plain text, never HTML. Rate-limit per IP.
- `POST /internal/refresh`: compare `X-Refresh-Key` in constant time.

**Manifest** (static file in Blob, immutable):
```json
{"schema":1,"render_key":"…","source":"irsa|s3|golden","pipeline_version":1,"created_at":"…",
 "query":{"ra":…,"dec":…,"fov_arcmin":6,"band":"B1-B2"},
 "grid":{"nx":59,"ny":59,"pix_arcsec":6.15,"wcs":{"CTYPE1":"RA---TAN","CRVAL1":…,"CDELT1":-0.001708,"…":"…"}},
 "catalog":{"version":"…","collections":["spherex_dr1","spherex_qr3"]},
 "stretch":{"kind":"asinh","vmin":…,"vmax":…,"beta":…},
 "epochs":[{"i":0,"label":"2025-09","t_start":"…","t_end":"…","t_mean_mjd":…,"n_frames":34,"detectors":[1,2],
            "lambda_um":[0.75,1.62],"channels":30,"flagged_px":{"HOT":3,"PERSIST":12},
            "astrom_resid_px":0.07,"phot_scale":1.00,"image":"e0.f32","mask":"e0.mask.u8","png":"e0.png"}],
 "frames":[{"obs":"level2_2025W36_1B_0012_1D1","t_mjd":…,"detector":1,"lambda_um":0.912,"epoch":0,"collection":"spherex_dr1"}],
 "extras":{"gaia":"gaia.json","lightcurve":null,"cube":null}}
```

- **Images are shipped as raw little-endian float32**, one `.f32` per epoch. A 59×59 image is about 14 KB.
- The **client** does the stretch, blink, difference and flag overlay on a canvas, so the sliders are instant.
- PNGs exist for sharing, previews and GIF export.
- Arrays follow FITS orientation (row 0 = south), so the client flips them vertically. Grid orientation is north up, east left.

### 4.4 Cache keys (two levels)
- **Query key** `qk = sha256("q1|{ra:.4f}|{dec:+.4f}|{fov}|{band}")[:20]`.
  - The `.4f` precision is 0.36″ (0.06 px).
  - FOV must be one of {2, 4, 6, 10, 15}′; band must be one of the enum values.
  - The pointer `frames/q/{qk}.json` holds `{render_key, catalog_version}` with `Cache-Control: max-age=60`.
- **Render key** `rk = sha256(pipeline_version | qk | sorted(frame_ids))[:24]`.
  - The folder `frames/r/{rk}/` is **immutable**: `max-age=31536000, immutable`.
  - The manifest is written last, then the pointer is swapped, so readers never see a half-written render.
- **Effect:**
  - New SPHEREx frames produce a new frame set, hence a new `rk`, a fresh render and a pointer swap.
  - Old renders stay valid, so candidate evidence links never break. `&r=<rk>` in a URL pins an exact render.
- **Stale-while-revalidate:** if the pointer's `catalog_version` is older than `meta/catalog.json`, serve the cached view and queue a refresh.
- **Golden layer:** the same manifests and arrays for the 5 targets are baked into `frontend/public/golden/<id>/`. Presets load from there first, which needs zero backend.

### 4.5 How a new release is picked up with zero code changes
1. **Watcher (daily, 06:00 UTC):**
   - Get `list_collections(servicetype='SIA', filter='spherex')` and keep names matching `^spherex_(dr|qr)\d+(_deep)?$`.
   - Run TAP `SELECT MAX(time_bounds_lower) FROM spherex.plane`.
   - Compare both with `meta/catalog.json`.
2. **If anything changed:** write a new `catalog_version`, then `POST /internal/refresh`.
3. **API:** for the pinned views (the 5 targets plus the top-N most requested), re-query frames. Where the frame set changed, re-render and swap the pointer.
4. **Overlapping releases** (e.g. a future DR2 reprocessing QR3 data): dedupe by frame stem (`level2_<obs>_<det>`). Prefer DR over QR, then the higher number, then the later processing date (this also handles `l2b_retry-*` directories).
5. **UI badge:** "Data: spherex_dr1 + spherex_qr3 · checked 06:00 UTC today."

---

## 5. Image processing

### 5.1 Frame selection
- **Band presets** keep fetch counts down. Each cutout is about 4 MB, and a mid-latitude position has roughly 100–450 frames.
- Defaults:
  - Barnard's Star: `B1-B2`
  - ε Ind B: `B2-B3`
  - WISE 0855: `B6` (4.42–5.0 µm)
  - Variables: per band
- `all` mode is capped at 2 frames per channel per epoch.
- Request cutouts with `size = FOV + 1′` margin so reprojection fills the edges.

### 5.2 Epoch grouping
- Sort frames by `t_mjd`. Start a new epoch when the gap exceeds **20 days**.
- Close an epoch once it spans **40 days** and start the next one (`group_epochs` in the skeleton does exactly this). Polar targets like R Dra are observed almost continuously, so this matters there.
- Label each epoch by its mean date.

### 5.3 Per-frame cleaning
1. `IMAGE − ZODI`.
2. Mask using the `MSKN*` names: **mask everything except** {SOURCE, OVERFLOW, NONLINEAR, FULLSAMPLE, HALO, BLOOM}. HALO and BLOOM are shown in the flag overlay but not masked, because masking them would erase bright stars' wings.
3. Subtract the residual sky: the sigma-clipped median of the unmasked pixels.
4. Record the wavelength at the target pixel with `WCS(hdr, fobj=hdul, key="W")` and `sip=None`. A 60-px cutout spans only about half a channel of the linear variable filter, so each cutout is effectively monochromatic at λ(target).
5. **Tune the mask on the 5 targets.** Check that OUTLIER and TRANSIENT don't eat the movers: the target pixel must be unmasked in more than 50% of frames.

### 5.4 Common grid and alignment
- One TAN grid per view: centred on the query, 6.15″/px, N×N with N odd, north up.
- `reproject_interp` each frame's image and variance, using the frame's full WCS including SIP. Masked pixels are set to NaN first, so any output pixel that touches one is dropped. That is stricter than thresholding a reprojected mask; switch to that if too many pixels are lost. The flag overlay (T2) needs its own nearest-neighbour reprojection of FLAGS.
- **Alignment check:** take centroids of Gaia-matched, non-high-PM field stars in each epoch stack and compare them with predictions.
  - If the mean offset exceeds 0.15 px, re-reproject with corrected CRPIX.
  - Show `astrom_resid_px` in the metadata panel.

### 5.5 Stacking (handles the wavelength-per-pixel issue)
- **Channel-matched stack.**
  - Assign each frame to a channel bin: (detector, k), with k = floor(17·ln(λ/λ_lo)/ln(λ_hi/λ_lo)), log-spaced because R is roughly constant.
  - Within each epoch, take an inverse-variance mean per channel.
  - Average the channels **common to all epochs** with equal weight.
  - Result: every epoch has the **same effective bandpass**, so a blink compares like with like even though the source fell at different wavelengths on each visit.
  - If no channel is common to all epochs, fall back to the union and set `bandpass_matched=false` in the manifest.
- **Photometric scale:** compute `phot_scale` = the median ratio of field-star fluxes relative to epoch 0. Apply it for blink and difference; it should be about 1.00 ± 0.05, otherwise warn. This doesn't hide the target's own variability, because the normalisation uses field stars.
- **Fallback (cut checkpoint H6):** an unmatched inverse-variance mean.

### 5.6 Stretch
- Pool the finite pixels of all epoch stacks.
- sky = sigma-clipped median; σ = MAD × 1.4826.
- vmin = sky − 2σ; vmax = 99.7th percentile; β = 3σ.
- y = asinh((x − vmin)/β) / asinh((vmax − vmin)/β), clipped to [0, 1].
- The **same (vmin, vmax, β) applies to every epoch**. The client sliders move all epochs together ("locked stretch").

### 5.7 Difference mode
- D = S_B − phot_scale · S_A, displayed with a diverging colormap at ±kσ_D.
- A moving star shows up as a **dipole**: negative where it was, positive where it is now. A variable shows a **monopole**.
- Channel matching keeps PSF-mismatch rings small.
- A UI hint explains how to read dipoles and warns about asteroids near the ecliptic.

### 5.8 Gaia proper-motion propagation
- **Query** the Gaia DR3 TAP (ESA, verified working; MAST as fallback):
  `SELECT source_id, ra, dec, pmra, pmdec, parallax, radial_velocity, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT(ra,dec), CIRCLE(ra0,dec0,r)) AND phot_g_mean_mag < 20.5`
  with r = FOV·√2/2 + 2′, so fast movers that wander in are caught. Cache the result per view.
- **For each epoch time t** (the mean MJD of that epoch's frames), with Δt = t − J2016.0 (TCB):
  1. **Space motion:** δ(t) = δ₀ + μ_δ·Δt and α(t) = α₀ + μ_α*·Δt / cos δ₀. In code, use astropy `apply_space_motion`, which also includes perspective acceleration (~0.01 px for Barnard's: negligible, but it costs nothing).
  2. **Parallax:** use Earth's barycentric position (X, Y, Z) in AU from `get_body_barycentric('earth', t)`. SPHEREx's low-orbit offset from Earth is under 5e-5 AU, so ignore it.
     - Δα* = ϖ (X sin α − Y cos α)
     - Δδ  = ϖ (X cos α sin δ + Y sin α sin δ − Z cos δ)
  3. **No aberration or light deflection.** The SPHEREx WCS is tied to Gaia astrometric positions, so these are absorbed. Pitfall: `transform_to(GCRS)` adds about 20″ of aberration, which would put every prediction about 3 px off.
  4. Convert to pixels with `grid_wcs.world_to_pixel`. Draw markers per epoch, plus a motion arrow from the first to the last epoch with a ×N toggle.
- **Edge cases:**
  - Parallax ≤ 0 or missing: use proper motion only.
  - 2-parameter Gaia solutions (no proper motion): treat as static.
- **Why parallax shows up here:** SPHEREx's 90° viewing geometry means 6-month pairs differ by up to 2ϖ (Barnard's: 1.09″ = 0.18 px). One-year pairs cancel it.
- **Gaia match label (T2, part of the overlay):**
  - For the selected source (the preset target or a clicked pixel), measure its centroid in each epoch.
  - Within **1.0 px** of a Gaia track it is a "Gaia match". With no track within 1.0 px it is "no Gaia match".
  - This is all the pitch and the video rely on. It needs no source detection across the field.
- **Auto-flag movers (T3, third in the cut order):** the field-wide version.
  - Detect sources in each epoch stack with `sep` at 5σ.
  - Associate them across epochs with Hungarian matching (the ByteTrack instinct, but with 2–3 epochs nothing learned is needed).
  - **A candidate has no Gaia track, S/N > 10 in every epoch used, and a shift of at least max(0.5 px, 3 × the measured centroid scatter).** Measure the scatter on the Gaia field stars of the same view (`astrom_resid_px`).
  - Why the floor: by our estimate, not yet measured, a 5σ source on 6.15″ pixels has about 0.2 px of centroid noise per epoch, so a bare 0.5 px cut would flag noise.
  - Two epochs also require a difference-image dipole with S/N > 10. Three epochs also require linear motion.
  - Always link out to SIMBAD and IRSA MOST (for asteroids). We never claim a discovery.

### 5.9 Light curve, spectrum, colour mode, captions
- **Light curve (T2):**
  - Forced aperture photometry on **every frame** at the propagated position: r = 2 px, annulus 4–7 px, after zodi subtraction.
  - Convert MJy/sr to µJy using the nominal pixel solid angle. The DR1 `solid_angle_pixel_map` product exists if there's time.
  - Plot flux against time, coloured by λ.
  - The same photometry on 3–6 field stars gives a "calibration floor" band.
  - Points with flagged pixels in the aperture are drawn hollow.
- **Spectrum on click (T2):** read the clicked grid pixel from each reprojected frame in the chosen epoch, giving (λ, flux, error) points. `all` mode, or the cube extra, is needed for full 0.75–5 µm coverage.
- **Brown-dwarf colour mode (T3):**
  - R = 4.42–5.0 µm, G = 3.83–4.41 µm, B = 3.15–3.45 µm (the CH₄ band).
  - Cold T and Y dwarfs (ε Ind B, WISE 0855) should look red. Barnard's (M4) should look neutral. That's a built-in test of the mode itself.
- **Captions:** deterministic templates, e.g. *"Moved 10.2″ (1.66 px) N between 2025-09 and 2026-09 · Gaia predicts 10.4″ · match."* If Azure OpenAI is ever added, every number in its output must appear in the input JSON; otherwise fall back to the template.

---

## 6. Validation targets

Moved to [`TARGETS.md`](TARGETS.md): Gaia DR3 astrometry, expected shifts, centring positions, the pass criteria for each of the 5 targets, and what `scripts/validate.py` must write. **Pitch numbers come only from `validation.md`.**

---

## 7. Timeline (30 h; H0 = kickoff)

The example clock assumes H0 = Sat 12:00, so H30 = Sun 18:00, leaving about 6 h of buffer before the Sun 23:59 deadline. If H0 is later, eat into the buffer, not the MVP gate. On this clock sleep falls at 01:00–07:00 and Tier 2 at 07:00–12:00, so the Gaia overlay is built rested, not at 3 am.

- **The gate is only the three checks in the H12 row.** The Azure owner's watcher and telemetry (H6–9) run in parallel for the Azure award and never block it.
- **Freeze:** this plan freezes at H27 (Sun 15:00 on the example clock). `AGENTS.md` defaults to Sun 20:00. TODO(team): confirm one.

**Five role tracks; assign people later.** Agents read `AGENTS.md`, which points at `docs/`. §4.3 (contracts) and §12 (checks) are the parts every agent session needs.
- **A, Data/science:** query, fetch, stacking, alignment, photometry. Suits your Python, data and CV background.
- **B, Backend:** FastAPI, jobs, Blob cache, golden export, telemetry.
- **C, Frontend:** React flipbook, controls, URL state, overlays, charts.
- **D, Azure/DevOps:** resources, CI/CD, watcher, App Insights, Front Door, Cosmos.
- **E, Science QA and story:** Gaia logic with A, validation, README, citations, video, pitch, submission form.

| Hours | A | B | C | D | E |
|---|---|---|---|---|---|
| H0–1 | Golden-capture retry loop | **Contracts:** Pydantic models + TS types + mock manifest (with C) | Vite + React + TS scaffold against the mock | Install az; region policy; RG, storage, ACR; OIDC test | Open the challenge page, resources tab and submission form in a browser; `targets.json` |
| H1–3 | Notebook spike: Barnard's star from an S3 range-read window → clean → 2 epochs (real data once IRSA answers); benchmark IRSA cutouts against S3 range reads | FastAPI skeleton, `/targets`, job model with a fake renderer, Blob cache class, Dockerfile | Flipbook canvas (nearest-neighbour scaling, play/pause/speed/blink), URL state | Container Apps environment + app, SWA connected to GitHub, App Insights, deploy workflow | Gaia query + propagation module with unit tests (Barnard's) |
| **H3 check** | IRSA still down? Keep developing on S3 range reads; capture loop keeps retrying | | | Policy blocker? Switch region or fall back (§9) | |
| H3–6 | Epoch grouping, channel-matched stack, shared stretch | Wire the real pipeline into jobs; manifest writer; S3 fallback | Metadata panel, FOV selector, target picker, progress UI | First real API deploy via CI; SWA live on the mock | Expected-position table; README skeleton; citations |
| **H6 check** | No clean stack → ship the unmatched mean (§5.5) | | | | |
| H6–9 | Flag mask from `MSKN*`, difference mode, alignment check | Golden export + precache of the 5 targets → Blob and `frontend/public/golden`; `/gaia` | Difference UI, blink A/B, share URL, golden loader | Watcher Function (timer + run-now) deployed; OpenTelemetry in the API | Run validation on targets as they land |
| H9–12 | Integration fixes on Azure | Integration | Error states; the 1-epoch case | min-replicas, CORS, cache headers | QA of all 5 targets on the live URL |
| **H12 MVP gate** | Public URL works; all 5 targets load **with the API stopped** (golden); a live arbitrary position works when IRSA is up. If not: **stop all Tier 2 work** and everyone works on the MVP. | | | | |
| H12–13 | Break; retro; lock the Tier 2 order | | | | |
| H13–19 | **Staggered sleep** (A+C sleep H13–18; B+D+E sleep H14–19). Whoever is awake re-runs precache and the watcher. | | | | |
| H19–24 | **Gaia overlay** (P1) with E; then light-curve photometry (P2) | `/lightcurve`, `/spectrum`; popular-views list | Gaia markers and arrows, "Gaia match / no Gaia match" label; light-curve chart; flag overlay (P3) | Cosmos (if T3 is likely); App Insights workbook; **H22: decide on Front Door** | Validate Gaia matches; draft the pitch and video script |
| **H24 check** | Gaia not done → light curve becomes a table; drop spectrum-click | | | | |
| H24–27 | T3 only if each item fits in about 1 h: brown-dwarf colour mode → Report button → auto-flag | Bug fixes | Polish; mobile layout; "Open in WiseView" link | Front Door (if chosen); min-replicas = 1 | Bug-bash on phone and desktop |
| **H27 feature freeze** | Fixes only | | | | |
| H27–29 | Final precache + validation run | Final deploy | Screenshots | Cost check | Record the 30 s video; README; submission text |
| H29–30 | — | — | — | — | **Submit**, then test every link in an incognito window |

**Cut order, first to go:**
1. Azure OpenAI
2. Durable Functions
3. Auto-flag movers
4. Report button and Cosmos
5. Spectrum on click
6. Front Door
7. Light-curve polish
8. Flag overlay

**Never cut:** the golden snapshots, the 5 targets, the shared URL, and the README citations.

---

## 8. Azure setup runbook

Moved to [`infra/README.md`](../infra/README.md), with the environment-variable list and the cost table. It is a draft: no command in it has been run yet.

---

## 9. Risk register

| # | Risk | L / I | Mitigation | Owner |
|---|---|---|---|---|
| 1 | **IRSA outage or latency.** It's 502 today; TAP takes 20–37 s. | High / High | Golden capture loop from H0. Three layers: golden (SWA) → Blob cache → live. Retries with backoff. Fall back from SIA to TAP. Pixels fall back to S3 (`fsspec` + `.section` range reads). A circuit breaker sets `irsa:"down"` and the UI says "IRSA is down — showing cached data". Serve stale data while revalidating. | A, B |
| 2 | No way to find frames while IRSA is down. S3 has no positional index. | Med / High | Only new positions are affected. The 5 targets come from golden data. Explain in the UI. Check S3 `index.html` for an inventory. | A |
| 3 | CORS | Low / Med | The backend proxies all IRSA traffic. Blob CORS is set. FastAPI `ALLOWED_ORIGINS`. | B, D |
| 4 | Too few epochs (1 epoch, or QR3 not ingested yet) | Med / Med | Detect it and offer the wavelength flipbook instead. Explain "motion needs ≥ 2 epochs". | C |
| 5 | Misaligned frames (WCS/SIP) | Med / High | Reproject with the full WCS. Measure the Gaia field-star residual and correct if it exceeds 0.15 px. Show the residual. | A |
| 6 | Bright-star saturation (Barnard's, R Dra, ε Ind A nearby) | Med / Med | Mask policy keeps OVERFLOW/NONLINEAR. Centroid on the wings. Hollow light-curve points. Prefer longer λ for photometry. | A, E |
| 7 | Centring on J2000 coordinates misses the mover | High / High | Propagate preset positions to the epoch. Default FOV 6′. Unit test on Barnard's. | E |
| 8 | WISE 0855 too faint | Med / Med | B6 stacks. Report honestly in the README. | A, E |
| 9 | False "candidates" (asteroids near the ecliptic, ghosts, cosmic rays) | High / Med | Candidate rule in §5.8: S/N > 10 in every epoch and a shift of at least 3× the measured centroid scatter. Exclude GHOST/STREAK pixels. Link to MOST and SIMBAD. Never use the word "discovery". | A, E |
| 10 | Cutouts are heavy (~4 MB each because of EPSF); "all" mode means 400+ frames | High / Med | Band presets, a frame cap, and the S3 path, which skips EPSF. A global concurrency limit of 10 to stay polite to IRSA. | A, B |
| 11 | Azure region policy or quota | Med / High | Check the policy at H0. Flex not available → Container Apps Job. ACR Tasks blocked → build in GitHub Actions. App registration blocked → GHCR plan B. | D |
| 12 | Cold starts (image ~700 MB; astropy import) | High / Med | Golden presets need no API. min-replicas = 1 on judging days. A slim image. Lazy imports. | B, D |
| 13 | SIMBAD/CDS down (seen today); Aladin Lite is served from CDS | Med / Low | No runtime SIMBAD dependency (Gaia-derived presets). The resolver is optional. Bundle Aladin Lite from npm if used. | C, E |
| 14 | Gaia TAP down | Low / Med | Cache Gaia results per view (golden includes `gaia.json`). MAST as fallback. Hide the overlay gracefully. | B |
| 15 | Budget overrun | Low / Med | Front Door only for the weekend; min-replicas back to 0; cost alert. | D |
| 16 | 5-person merge chaos | Med / Med | Contracts frozen at H1. Mock manifest. Each track owns a folder. Short-lived PRs. | All |
| 17 | Abuse of the open API: render floods that hammer IRSA, spam on the candidate board | Med / Med | Limits in §4.3: job and frame caps, 429s, plain-text fields, per-IP rate limit. | B |

---

## 10. Demo and submission

**30-second video script.** Label any AI-generated media according to Space Apps rules.
- **0–3 s:** Title card: "Wanderer — watch the infrared sky move."
- **3–10 s:** Pick **Barnard's Star** and blink the 2025 and 2026 epochs. The star hops north and the Gaia arrow lands on it. Caption with the measured vs predicted numbers from `validation.md`.
- **10–16 s:** **WISE 0855**, B6 stack. A faint dot moves and is labelled **"no Gaia match"**. Caption: "this is how the coldest known brown dwarf would be found." If WISE 0855 is not detected by the H24 check, use ε Ind B here (0.76 px shift, in Gaia) and drop that caption. Never show a label the data doesn't support.
- **16–22 s:** **R Dra** light-curve panel. The Mira brightens and fades between visits.
- **22–27 s:** Paste any RA/Dec. Frames stream in with a progress bar. Copy the share link.
- **27–30 s:** "Updates itself when SPHEREx releases data · built on Azure", then the URL and a QR code.

**2-minute pitch:**
- **0:00 Hook:** brown dwarfs were found by blinking WISE; WISE is over. SPHEREx maps the whole sky every 6 months in 102 colours, but nobody can just look at it.
- **0:15 Live demo:** Barnard's Star plus the Gaia overlay.
- **0:45 Discovery logic:** WISE 0855 as the mover with no Gaia match (ε Ind B if WISE 0855 isn't detected); R Dra.
- **1:05 Azure slide.**
- **1:30 Science rigour:** channel-matched stacks, parallax-aware Gaia predictions, measured-vs-predicted table, honest limits.
- **1:50 Close:** "Type any coordinates. Watch the sky move."

**Azure slide** ("every service solves a problem"; numbers come from App Insights, never invented):
- **Speed:** Blob render cache (+ Front Door edge). First view N s → cached N ms; hit ratio N%.
- **Freshness:** Functions timer diffs the SPHEREx catalogue and re-renders automatically; "data as of" badge; live "run-now" demo.
- **Resilience:** golden snapshots on SWA, S3 fallback for pixels, managed identity (no storage secrets).
- **Discovery:** Cosmos DB candidate board (only if Tier 3 ships; otherwise drop this line).
- **Observability:** App Insights workbook with p95 latency, IRSA failures and cache hits. KQL: `requests | summarize percentile(duration,95) by name` and `requests | where name has "/api/views" | summarize hit=countif(tostring(customDimensions["cache.hit"])=="true"), n=count()`.

**README outline:**
1. What and why, plus the live URL
2. How to use (URL parameters)
3. The 5 validation targets with measured results (`validation.md`)
4. Method: stacking, stretch, difference, Gaia + parallax
5. Architecture and Azure services
6. Limitations: 6.15″ pixels, ~1-yr baseline, saturation, WISE 0855 depth
7. Run locally and deploy
8. Data citations and acknowledgements
9. AI-tools disclosure (Claude Code, Cursor)
10. Team
11. License

**Citations:** in [`DATA.md`](DATA.md). The SPHEREx acknowledgement there is verbatim from IRSA. The IRSA, Gaia and SIMBAD wordings are still TODO.

**Submission checklist.** Confirm every item on the actual form; the page wasn't readable today.
- [ ] Team registered at the local event, with challenge "Planet X and SPHEREx" selected
- [ ] Title and high-level summary
- [ ] Demo: 30 s video (or the slide limit on the form)
- [ ] Final project link: live URL plus public GitHub repo
- [ ] Detailed description, NASA data used (SPHEREx via IRSA), partner data (ESA Gaia), references
- [ ] AI-use disclosure
- [ ] All links tested in incognito and on a phone; the 5 targets work with the API stopped
- [ ] Submitted before **Sun Nov 15, 23:59 local**

---

## 11. Repo layout and code skeletons

Layout follows `AGENTS.md` §3, which is the authority.

```
/                      README.md · AGENTS.md · CLAUDE.md · STATUS.md
docs/                  IDEA · PLAN · TARGETS · DATA · LINKS · DECISIONS · skeletons/
backend/               FastAPI (Python 3.11) → Container Apps
  Dockerfile  pyproject.toml
  app/main.py          app wiring, CORS, OpenTelemetry (configure_azure_monitor)        ← hotspot
  app/api/             routes (§4.3), jobs, Pydantic models: ViewRequest, ViewStatus, Manifest, Epoch, Frame   ← contract, H1
  app/irsa/            query.py · fetch.py
  app/processing/      flags.py · stack.py · render.py · photometry.py · gaia.py
  app/cache/           blob.py
  app/watch.py         Container Apps Job fallback for the watcher
  tests/               test_keys.py · test_dedupe.py · test_gaia_barnard.py · test_epochs.py
frontend/              Vite + React + TS → Static Web Apps
  src/types.ts (mirror of the Pydantic models) · src/api.ts · src/lib/{stretch,url,golden}.ts
  src/components/{Flipbook,Controls,TargetPicker,MetadataPanel,GaiaOverlay,DiffView,LightCurve}.tsx
  public/golden/<target>/…        staticwebapp.config.json
functions/             Azure Functions (Flex, Python v2): function_app.py · host.json · requirements.txt
infra/                 README.md (resource table + runbook)
scripts/               update_status.py · precache.py (retry loop + golden export) · validate.py · targets.json
.github/workflows/     ci.yml · api.yml (deploy; infra owner) · <swa-generated>.yml
```

- **Backend dependencies** (`backend/pyproject.toml`, a hotspot): fastapi, uvicorn[standard], numpy, scipy, astropy, astroquery, reproject, photutils, sep, pillow, s3fs, fsspec, requests, pydantic, azure-storage-blob, azure-identity, azure-cosmos, azure-monitor-opentelemetry. Dev extras: ruff, pytest.
- **Base image:** `python:3.11-slim`, `CMD uvicorn app.main:app --host 0.0.0.0 --port 8000`.
- **`functions/requirements.txt`:** azure-functions, astroquery, requests, azure-storage-blob, azure-identity.

**Code skeletons** are real files in `docs/skeletons/`, not text in this document, so they can be compiled and copied.
Copy one to its destination when you start that slice and delete the skeleton in the same PR, so there are never two copies.

| Skeleton | Destination | What it is |
|---|---|---|
| `docs/skeletons/query.py` | `backend/app/irsa/query.py` | SIA/TAP frame query, release dedupe |
| `docs/skeletons/fetch.py` | `backend/app/irsa/fetch.py` | Parallel cutout fetcher with retries and S3 range-read fallback |
| `docs/skeletons/stack.py` | `backend/app/processing/stack.py` | Epoch grouping, common grid, channel-matched stack, shared stretch |
| `docs/skeletons/cache.py` | `backend/app/cache/blob.py` | Two-level Blob cache (query key → render key) |
| `docs/skeletons/function_app.py` | `functions/function_app.py` | Timer + run-now watcher (Python v2 model) |
| `docs/skeletons/gaia.py` | `backend/app/processing/gaia.py` | Gaia propagation: space motion + parallax, no aberration |

`docs/skeletons/check.py` runs the offline checks from §12.1 against them; it is the seed for `backend/tests/`.

---

## 12. End-to-end verification

1. **Unit tests** (`cd backend && pytest -q`; seeded by `docs/skeletons/check.py`):
   - Key determinism.
   - Dedupe: DR beats QR, and a `retry` reprocessing beats the original.
   - Epoch grouping on synthetic MJDs.
   - `predict_radec` for Barnard's at 2026.0 reproduces about (269.44627, +4.76820) to within 1″ before parallax, and the parallax term is ≤ 0.55″.
2. **Data spike** (notebook): Barnard's Star from 2 real epochs shows a hop of about 1.7 px that matches the prediction.
3. **`scripts/validate.py`** on all 5 golden manifests writes `validation.md` and passes the `TARGETS.md` criteria (or records an honest miss for WISE 0855).
4. **Live smoke test:**
   - `curl $API/api/health`
   - `POST /api/views` for a new position returns 202; polling reaches `ready`; the second identical POST returns 200 (cache hit).
   - The App Insights query shows `cache.hit=true`.
5. **Resilience:**
   - Scale the API to 0 or stop it, then load `?target=barnard` etc.; all 5 render from `/golden`.
   - Turn on a forced IRSA failure flag (`IRSA_FORCE_DOWN=1`) and check that frames still come from S3.
6. **Freshness:** `POST …/api/run-now?code=<fn-key>` rewrites `meta/catalog.json` (`checked_at` updates) and the UI badge changes.
7. **Browser check** (Playwright): open each of the 5 target URLs plus one shared custom URL on desktop and phone widths; play, blink, toggle difference mode and the Gaia overlay; no console errors.
