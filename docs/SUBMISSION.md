# Submission checklist

Written by the `submit-prep` skill on 2026-11-14 21:30 CST. Deadline: **Sunday Nov 15, 23:59 local**.
Feature freeze: Sunday 20:00 local by default (not yet confirmed by the team).

Status values: **PASS** = checked on the date above. **FAIL** = checked and not met. **TODO** = needs a human.
Re-check the live guides in `docs/LINKS.md` before submitting; the form itself has not been opened.

Live app: https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io
Repo: https://github.com/ompatel181005/IntoTheUnknown

## Official requirements

| Item | Status | Note |
|---|---|---|
| Demo is a video of at most 30 s, or at most 7 slides | TODO | Not recorded. Script below. |
| Demo hosted on an external public link | TODO | Upload unlisted or public, then test in incognito. |
| Video has English subtitles, or slides are in English | TODO | |
| Submission page and linked materials are in English | PASS | README and app are in English. |
| Page shows how NASA or partner agency data was used | PASS | README sections 4 and 8 (SPHEREx via IRSA, ESA Gaia DR3). |
| Every required form field is complete | TODO | Draft text below. |
| Every team member is registered at the same Local Event | TODO | Six members: Diego, Eddie, Himanshu, Om, Ammar, Angelo. |
| Terms and "all work is original" boxes ticked | TODO | |
| Submitted before the deadline | TODO | |

## Our own checks

| Item | Status | Note |
|---|---|---|
| Public URL loads with no login | PASS | `/` 200 in 0.7 s; `/api/health` reports `ok: true`, `irsa: up`. |
| All 5 targets load from the backend | PASS | `POST /api/views` (saved source) returned 202 in under 0.3 s each; all five reached `ready` within about 30 s. |
| Presets served without IRSA | PASS | `/golden/<id>/manifest.json` returns 200 for all five (pipeline version 3, source `golden`). |
| 5 targets render with the API stopped, in a browser | TODO | `validation.md` records a pass at pipeline version 2. Not re-run in a browser today. |
| README complete, no `TODO(team)` | PASS | Follows the PLAN §10 outline. |
| `docs/DATA.md` acknowledgements filled | FAIL | SPHEREx and Gaia are verbatim. Three `TODO(team)` remain: IRSA wording (none published), MAST (not used; the fallback is ARI Heidelberg), SIMBAD (CDS still returns 404). None of the three is used by the app, so the README omits them. |
| Repo is public | PASS | |
| License | PASS | MIT, added with this change. |
| Each Azure resource has a named problem | PASS | Table in `infra/README.md`. The Blob render cache is live (#12, checked 2026-11-14 23:40: a view was written to Blob, loads anonymously with CORS, and a repeat request is instant). The Functions watcher is not integrated yet (#25). App telemetry merged in #62 and still needs live verification. |
| Live view of a new position | PASS | RA 150.0, Dec +2.2, 6′, B1-B2 built in 33 s on the deployed app (70 frames, 3 passes, Gaia overlay). It fails with `IRSA_DOWN` whenever IRSA is not answering, which happened twice during testing. |
| No secrets in git history | PASS | Only `.env.example` files were ever committed; no key, SAS or private-key patterns in any added line. |
| `validation.md` matches the deployed pipeline | FAIL | It records pipeline version 2; the deployed app is version 3 and the ε Indi B demo pack was rebuilt afterwards (160 files). Re-run `scripts/validate_integrated.py` (#27). The Barnard numbers still hold: the version 3 arrays are byte-identical (`docs/DECISIONS.md`, 17:45). |
| Every link tested in incognito and on a phone | TODO | |

## 30-second video shot list

Only show what works today. The Gaia overlay and "no Gaia match" label are not switched on in the app, so the
PLAN §10 shots that depend on them are replaced.

| Time | Shot | Caption |
|---|---|---|
| 0–3 s | Title card | Team name · "Planet X and SPHEREx" · Into The Unknown |
| 3–11 s | Barnard's Star, *Blink* between the first and last pass | "Measured 1.64 px · Gaia predicts 1.67 px" |
| 11–16 s | Same view, *Difference* mode | "A moving star shows as a dark/bright pair" |
| 16–22 s | R Draconis, *Play all*, then open the brightness panel | "Variable stars change between passes" (no numbers; not validated) |
| 22–27 s | Type an RA, Dec; progress bar; press *Share* | "Any position on the sky · the link reopens the same view" |
| 27–30 s | URL and QR code | "Real SPHEREx data · runs on Azure" |

No AI-generated images or video are planned. If any are added, they need a visible watermark.

## Draft form text

**Project name:** Into The Unknown

**High-level summary:** Into The Unknown turns NASA's SPHEREx infrared sky survey into a flip-book. Enter any sky
position and it finds every SPHEREx image of that spot, aligns them and plays them pass by pass, so objects that
move or change brightness stand out. It addresses the challenge by making repeat SPHEREx imaging searchable by
eye, with blink, difference, per-pixel spectrum and light-curve views, and a shareable URL. On Barnard's Star
the measured motion agrees with the Gaia prediction to 0.04 pixel.

**NASA data:** SPHEREx Level 2 spectral images (DR1 and QR3) through the NASA/IPAC Infrared Science Archive.

**Space Agency Partner data and references:** ESA Gaia DR3. Software and other sources are listed in README
section 8.

**Use of AI:** README section 9.
