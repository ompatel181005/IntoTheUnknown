# Data sources

Citations and acknowledgements for the README and the submission (moved here from PLAN §10).
Acknowledgement text is copied verbatim from the official page. Never paraphrase it.

## SPHEREx (NASA, via IRSA)
What we use: Level 2 spectral-image cutouts from DR1 (Surveys 1–2) and QR3 (Surveys 3–4). Frames are found through IRSA SIA/TAP and fetched through IRSA's cutout service, with the AWS mirror `nasa-irsa-spherex` as the fallback for pixels. The All-Sky Cube (`spherex_dr1_cube`) is excluded from frame queries.

DOIs: DR1 Spectral Images **10.26131/IRSA678** · QR3 **10.26131/IRSA662** · DR1 All-Sky Cube **10.26131/IRSA679** (cite only if the cube extra ships).

Acknowledgement, verbatim from https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html (copied 2026-11-14):

> This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.

Papers (lit., confirm before citing): Bock et al. 2026 (mission), Akeson et al. 2026 (pipeline), Korngut et al. 2026 (instrument), Crill et al. 2025 (simulator).

## IRSA
The SPHEREx DR1 overview asks for the DOIs above plus the SPHEREx acknowledgement, and gives no separate IRSA wording. No general IRSA acknowledgement page was found from the IRSA front page or help desk on 2026-11-14. TODO(team): add one only if IRSA publishes it.

## Gaia DR3 (ESA, a 2026 Space Apps Space Agency Partner)
What we use: positions, proper motions, parallaxes, radial velocities and G magnitudes from `gaiadr3.gaia_source` through the ESA Gaia TAP. They feed the target presets (`TARGETS.md`), the "should be here" overlay and the alignment check. List it under "Space Agency Partner Data" on the submission form.

Credit: the data are free to use provided credit is given to 'ESA/Gaia/DPAC'.

Cite both, as the DR3 instructions require:
- Gaia Collaboration et al. (2016b), "The Gaia mission" (Prusti et al. 2016, A&A 595, A1 (lit.))
- Gaia Collaboration et al. (2023j), "Gaia DR3: Summary of the contents and survey properties" (Vallenari et al. 2023, A&A 674, A1)

Acknowledgement, verbatim from https://gea.esac.esa.int/archive/documentation/GDR3/Miscellaneous/sec_credit_and_citation_instructions/ (copied 2026-11-14):

> This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement.

If the MAST fallback for Gaia ships, TODO(team): add MAST's own acknowledgement.

## SIMBAD (CDS)
What we use: link-outs only. SIMBAD is **not** the source of target coordinates (those are Gaia DR3) and nothing depends on it at runtime. If WISE 0855's position is later replaced with SIMBAD's value, cite Wenger et al. 2000.

Acknowledgement: TODO(team): copy the exact text once CDS is back. It returned 404 on 2026-11-14.

## Software
Astropy (2013/2018/2022), astroquery (Ginsburg et al. 2019), reproject, photutils, sep (Barbary 2016), and Aladin Lite if used.
