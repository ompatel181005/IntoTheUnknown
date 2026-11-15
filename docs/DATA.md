# Data sources

Citations and acknowledgements for the README and the submission (moved here from PLAN §10).
Acknowledgement text is copied verbatim from the official page. Never paraphrase it.

## SPHEREx (NASA, via IRSA)
What we use: Level 2 spectral-image cutouts from DR1 (Surveys 1–2) and QR3 (Surveys 3–4). Exposure metadata comes from IRSA SIA/TAP. Live pixel windows use range reads from the public `nasa-irsa-spherex` S3 mirror first, with IRSA's cutout service as fallback. Full frames are not downloaded. The All-Sky Cube (`spherex_dr1_cube`) is excluded from frame queries. Saved snapshots are fixed products of bundled real cutouts; cached catalog fields are previously prepared observations, not fresh archive queries.

DOIs: DR1 Spectral Images **10.26131/IRSA678** · QR3 **10.26131/IRSA662** · DR1 All-Sky Cube **10.26131/IRSA679** (cite only if the cube extra ships).

Acknowledgement, verbatim from https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html (copied 2026-11-14):

> This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.

Papers (lit., confirm before citing): Bock et al. 2026 (mission), Akeson et al. 2026 (pipeline), Korngut et al. 2026 (instrument), Crill et al. 2025 (simulator).

## IRSA
IRSA supplies the exposure metadata, archive fallback cutouts and public S3 mirror. Its [official acknowledgement page](https://irsa.ipac.caltech.edu/ack.html), verified 2026-11-15, asks for the archive statement in addition to individual mission credits and dataset DOIs. Full required wording is available there and in the [IRSA knowledge base](https://irsa.ipac.caltech.edu/docs/knowledgebase/general.html). This supersedes the earlier unsuccessful search for a general IRSA acknowledgement.

## Gaia DR3 (ESA, a 2026 Space Apps Space Agency Partner)
What we use: positions, proper motions, parallaxes, radial velocities and G magnitudes from `gaiadr3.gaia_source`. Runtime queries try the ESA Gaia TAP first, then ARI Heidelberg TAP. Bundled field-star catalogues were captured through CDS VizieR. Gaia predictions feed the visible overlay and alignment checks. Validation's independent reference constants are pinned in `TARGETS.md`; these are separate from the mixed-source metadata supplied with the 47-point home catalog. List Gaia under "Space Agency Partner Data" on the submission form.

Credit: the data are free to use provided credit is given to 'ESA/Gaia/DPAC'.

Cite both, as the DR3 instructions require:
- Gaia Collaboration et al. (2016b), "The Gaia mission" (Prusti et al. 2016, A&A 595, A1 (lit.))
- Gaia Collaboration et al. (2023j), "Gaia DR3: Summary of the contents and survey properties" (Vallenari et al. 2023, A&A 674, A1)

Acknowledgement, verbatim from https://gea.esac.esa.int/archive/documentation/GDR3/Miscellaneous/sec_credit_and_citation_instructions/ (copied 2026-11-14):

> This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement.

Data-access endpoints: [ESA TAP](https://gea.esac.esa.int/tap-server/tap/sync), [ARI Heidelberg TAP](https://gaia.ari.uni-heidelberg.de/tap/sync), and [CDS VizieR](https://vizier.cds.unistra.fr/). MAST appears in the challenge resources but is not this application's Gaia fallback. The acknowledgement above was checked on 2026-11-14; today's ESA credit-page recheck was unavailable (HTTP 451/timeout), so that is not a new verification claim.

## SIMBAD (CDS)
What we use: supplied object names and astrometric/literature metadata for 43 of the 47 entries identify SIMBAD in `frontend/public/catalog/points.json`. Each entry retains its own catalogue/reference attribution. This is a static metadata dependency, not a runtime SIMBAD query. Do not conflate these supplied values with the independent Gaia references used to validate Barnard and epsilon Indi B, or treat every home-catalog value as a verified Gaia DR3 measurement.

Acknowledgement, verbatim from the accessible [official Harvard SIMBAD mirror](https://simbad.harvard.edu/simbad/) (checked 2026-11-15):

> This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France

Cite Wenger et al. (2000), *The SIMBAD astronomical database. The CDS reference database for astronomical objects*, A&AS 143, 9–22, DOI [10.1051/aas:2000332](https://doi.org/10.1051/aas:2000332); [ADS record](https://ui.adsabs.harvard.edu/abs/2000A%26AS..143....9W/abstract). The mirror requests citation of original references and identifies its data licence as ODbL; preserve the per-object references when redistributing the supplied catalog.

## Software
Astropy (2013/2018/2022), astroquery (Ginsburg et al. 2019), reproject, photutils, sep (Barbary 2016), and Aladin Lite if used.
