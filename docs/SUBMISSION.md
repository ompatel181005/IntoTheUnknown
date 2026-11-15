# Submission readiness: Into The Unknown / LOGICA

Documentation review: **2026-11-15**. This is a readiness report, not a submitted
entry. The human completes and submits the actual form. Issues #3 and #28 remain
open for their human-owned requirements.

**PASS** = checked evidence supports the stated scope/date. **FAIL** = a checked
attempt failed. **TODO** = unverified or requires a human. A PASS for delivery is
not a science pass, proof of all form fields, or a physical-phone check.

- Live app: https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io
- Learn: https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io/learn.html
- Public repository: https://github.com/ompatel181005/IntoTheUnknown
- Source credits: [DATA.md](DATA.md); official links: [LINKS.md](LINKS.md).
- Science: [validation.md](../validation.md), pipeline **3**.

## Official and human-only gates

Recheck the **live** [submission guide](https://www.spaceappschallenge.org/resources/project-submission-guide/)
and [challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
before submitting. Their 2026-11-14 review is recorded in DECISIONS; today's
reload failed (guide fetch error / challenge HTTP502). The actual form was not
opened by this documentation task, so its current fields/terms are not certified.

| Requirement | Status | Evidence / remaining action |
|---|---|---|
| Confirmed project/team names | PASS | User-confirmed Into The Unknown / registered team name LOGICA. This does not confirm every member's registration. |
| Team roster | PASS | Issue28 lists Diego, Eddie, Himanshu, Om, Ammar and Angelo. Formal roles are not inferred from commits. |
| All members registered at the same Local Event | TODO | Human confirms participants, event and its time zone. |
| Demo video at most 30 s or deck at most 7 slides including title | TODO | Recorded guide requirement; dflow11 is coordinating media. No completed artifact/link was supplied. Do not duplicate that work. |
| Public external demo link, English slides/subtitles | TODO | Human provides/tests the artifact, duration/slide count, language and public permissions. |
| Final submission page/materials in English | TODO | English README/form draft are ready; actual form and demo are unverified. Learn also offers optional ES/HI content. |
| NASA and partner-data use explained | PASS | README/DATA identify SPHEREx/IRSA, ESA Gaia/DPAC, ARI/VizieR access and supplied SIMBAD/literature metadata. |
| Complete official acknowledgements in final form/materials | TODO | Supplied SPHEREx/Gaia text and exact short SIMBAD credit are in DATA. Human must copy/recheck the complete general IRSA statement from its linked official page, not treat a link as the full wording. |
| Actual required fields, terms/original-work boxes and media consent | TODO | Human reads/completes them; no checkbox or participant/age confirmation is invented here. |
| Submit and verify success before deadline | TODO | Human-owned; no submission success banner has been observed. |
| All links in incognito and on a physical phone | TODO | Fresh-context Chrome receipts are available; desktop/mobile emulation does not establish physical-phone testing. |

The deadline in AGENTS is Sunday **2026-11-15 23:59 local**. Time checkpoint:
2026-11-15 **11:29:28 UTC / 05:29:28 America/Chicago** leaves **18h29m32s** until
23:59 Chicago, and **14h30m32s** until the default 20:00 Chicago freeze. The Local
Event's zone and freeze remain human confirmations; PLAN's H27 example is not a
confirmed freeze. These are recorded countdowns, not a running clock.

## Technical and scientific checks

| Check | Status | Exact scope/evidence |
|---|---|---|
| Public app deploy/no-login saved access | PASS | [Main app run 43708260291](https://github.com/ompatel181005/IntoTheUnknown/actions/runs/43708260291) deployed/verified source 4c181ad. Dated browser receipts below identify their own tested source 67c700e. |
| All five public backend Saved POST/status requests | PASS | [Saved API receipt](validation/saved-api-live.json): all five reached ready/HTTP200 on source 4c181ad, forced source=saved with no archive fallback. Ready times 0.294/0.251/1.514/3.964/1.528 s for Barnard/epsilon/WISE/RW Aur/R Dra; mix of cache and new Saved builds, not a cold/load benchmark. Parent performed this gate; this agent did not duplicate it. |
| Five bundled defaults render with API denied | PASS | [Preset receipt](../infra/preset-live-checks.json), checked 2026-11-15T10:40Z: five painted canvases, no API builds/external requests/page errors. API blocking leaves the web host reachable. |
| Learn EN/ES/HI, sharing and PNG | PASS | Same receipt: nine language/activity combinations at 320 px emulated width; share round-trip; EN/HI PNG downloads. This is not native translation review or physical-device proof. |
| Prepared 47-field catalog delivery | PASS | [Catalog receipt](../infra/catalog-live-checks.json): published 47 objects / 152 passes; exact manifest queries, image/mask sizes/CORS and real Chrome paint checks; no archive calls/builds. This is not science validation of 47 objects. |
| Current pipeline/science report | PASS | Pipeline 3 golden manifests and current report agree. Barnard: 0.0410 px vector error / 0.1704 px max residual; epsilon Indi B: 0.0308 px / 0.1606 px. Only the stated astrometric gates pass. |
| WISE detection / RW Aur and R Dra variability | FAIL | Reported science prerequisites are unmet. No validated WISE detection, calibrated variability result or Planet X discovery is claimed. Failure does not establish physical absence/constancy. |
| Gaia overlay/charts | PASS | Current source includes Gaia markers/arrows and selected-source labels; dated rendered evidence in [Gaia overlay screenshot](../frontend/tests/evidence/gaia-overlay/barnard-field-star.png). A cross-match label is not a detection. |
| Watcher provisioning/indexing/authentication | PASS | [Watcher receipt](../infra/watcher-live-checks.json): Python 3.11, 2048 MB, max 2, zero always-ready; timer and authenticated run-now indexed, rejection checks passed. |
| Automatic main-only watcher deployment | PASS | [OIDC run 43708187059](https://github.com/ompatel181005/IntoTheUnknown/actions/runs/43708187059), source b7653c7, passed Azure login and OneDeploy remote Linux build/deploy. Receipt's pre-merge pending label is historical to that file's check time. |
| Successful watcher metadata refresh | FAIL | Recorded manual run returned IRSA_DOWN/502 from upstream TAP; refresh_sent=false, no new catalog. This is separate from successful deployment. API 202 elsewhere means accepted work, not completed frames. The watcher requests only five pinned Live views, not all 47 catalog renders. |
| Source/reference coverage in docs | PASS | S3-first pixels / IRSA fallback, ESA-to-ARI Gaia access, bundled VizieR fields, 43 SIMBAD-attributed supplied entries and Wenger 2000 DOI are described. Complete final-form credit text remains a separate human gate above. |
| Public repository / licence | PASS | Anonymous GitHub metadata GET returned 200/private=false on 2026-11-15; MIT LICENSE exists. Data-provider terms remain separate. |
| Available local Git-history pattern scan | PASS | 223 commits across local refs: no non-example .env additions or matching storage-key/SAS/private-key patterns. All 196 long-base64 matches were npm sha512 integrity records. This pattern scan is not a guarantee against every possible secret. |
| Azure services have named problems | PASS | infra/README and watcher runbook describe app/registry, identities, Blob, host/package containers, monitoring and watcher plan. No Front Door/Cosmos deployment is claimed. |
| README/current evidence consistency | PASS | Name, team, pipeline 3, two limited astrometry passes, active Gaia/Learn and 47 prepared fields updated. See the bounded documentation checks below. |

The 42 additional catalog fields are not 42 new science validations. The bundled five
snapshots remain fixed. Cached delivery does not prove archive availability or
that a fresh metadata refresh completed.

## Draft form text for the human

**Project name:** Into The Unknown. **Team:** LOGICA.

**High-level summary:** Into The Unknown turns selected NASA SPHEREx observations
into a shared-stretch flipbook for inspecting possible motion and brightness
changes. It combines blink/difference views, Gaia context, source/coverage
metadata and exploratory spectrum/light-curve charts. The Learn page guides
observation in English, Spanish and Hindi using real saved images and shareable
PNG/URL cards. Five default snapshots work without API requests, and 47 prepared
fields are cached publicly. Independent pipeline 3 checks pass the stated
astrometry gates for Barnard's Star and epsilon Indi B. WISE detection and
variable-star photometry remain unvalidated; this is not a discovery claim.

**NASA data:** SPHEREx Level 2 spectral images, DR1 and QR3. IRSA provides exposure
metadata and archive services; pixel windows use its public S3 mirror first with
IRSA cutout fallback. Cite the image-product DOIs and credits in DATA.md.

**Partner/other references:** ESA Gaia DR3 / DPAC for propagated context and pinned
validation references; ESA/ARI TAP and CDS VizieR access; supplied SIMBAD and
per-object literature metadata; CatWISE2020 for the WISE reference position.
Use the acknowledgements and source links in DATA.md, including the full linked
IRSA archive statement when composing the final text.

**Use of AI:** Use README section 9's disclosure. The app does not use AI to infer
astronomical detections; real image measurements and validation are distinct from
supplied catalog metadata. Human checks any final media for additional disclosure
or watermark requirements in the current guide.

## Remaining team decisions

- Formal A-E track assignments, full member registration/event details and the
  actual team-chat channel for hotspot announcements.
- Confirmation of the freeze time and any historically unassigned decision owners.
  DECISIONS now identifies git-blamed recorders without pretending they owned the
  decisions.
- Actual form fields/checks, complete credit text, public video/deck link, physical
  phone/incognito review and submission success. Coordinate media with dflow11.

No scientific frontend numbers were changed here. Preset attribution needs a
separate source review: epsilon's 274.99 mas is attributed to Chen 2022 in supplied
point metadata, but the preset footer generically says Gaia DR3; pinned validation
uses 270.658 mas. RW Aur's 5.4541 mas differs from the pinned 6.406 mas; component/source
identity needs primary verification before replacing a number.

## Documentation validation

This pass reloaded the accessible SIMBAD/IRSA/ADS source pages, read issue #3/#28
comments and current receipts, counted catalog/source entries and golden pipeline
metadata, checked local Markdown targets and scanned available history. This
documentation agent initiated no archive downloads, cloud changes or duplicate
backend builds. The parent supplied the separate Saved-only API gate. Unrelated
full test suites were not rerun for documentation changes. Refresh the public
form/guide and human checks immediately before actual submission.
