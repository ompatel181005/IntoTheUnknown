# Links

Do not guess URLs. Fill the placeholders from the official pages.

The initial URL review was on 2026-11-14: it either returned HTTP 200 with a matching page title, or (the six tutorials) is linked from IRSA's SPHEREx DR1 and mission pages. `TODO(team)` means not found or not reachable.

## Space Apps
- Challenge page: https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/ (read in a browser 2026-11-14; scope notes in `DECISIONS.md` 13:20)
- Challenge resources tab: https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/?tab=resources. It links four things for this challenge: the IRSA mission page, the SPHEREx tutorial notebooks, WiseView, and Gaia at MAST (https://archive.stsci.edu/missions-and-data/gaia, "use the latest data release (DR3)"). The rest of the tab is CSA NEOSSat material we don't use.
- Project Submission Guide: https://www.spaceappschallenge.org/resources/project-submission-guide/
- Judging & Awards Guide: https://www.spaceappschallenge.org/resources/judging-awards-guide/

## IRSA SPHEREx
- General IRSA acknowledgement: https://irsa.ipac.caltech.edu/ack.html (located 2026-11-15)
- IRSA acknowledgement knowledge base: https://irsa.ipac.caltech.edu/docs/knowledgebase/general.html
- Mission page: https://irsa.ipac.caltech.edu/Missions/spherex.html
- DR1 overview (citation and acknowledgement text): https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html
- QR overview: https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html
- Tutorial notebooks index: https://caltech-ipac.github.io/irsa-tutorials/
- Tutorial: intro: https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/
- Tutorial: cutouts: https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/
- Tutorial: source discovery: https://caltech-ipac.github.io/irsa-tutorials/spherex-source-discovery-tool-demo/
- Tutorial: HiPS cube: https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/
- Tutorial: mosaic: https://caltech-ipac.github.io/irsa-tutorials/spherex-mosaic/
- Tutorial: PSF: https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/
- irsa-tutorials repo: https://github.com/Caltech-IPAC/irsa-tutorials
- SPHEREx Data Explorer: https://irsa.ipac.caltech.edu/applications/spherex
- Cutout tool docs: https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html
- Archive user guide: https://caltech-ipac.github.io/spherex-archive-documentation/
- Explanatory Supplement: https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf
- Cloud data access (AWS mirror, bucket `nasa-irsa-spherex`, us-east-1): https://irsa.ipac.caltech.edu/cloud_access/#spherex
- Moving Object Search Tool (MOST, asteroid check): https://irsa.ipac.caltech.edu/applications/MOST

## Other data
- Gaia ESA archive: https://gea.esac.esa.int/archive/
- Gaia DR3 TAP, primary (ESA): https://gea.esac.esa.int/tap-server/tap/sync
- Gaia DR3 TAP, fallback (ARI Heidelberg): https://gaia.ari.uni-heidelberg.de/tap/sync
- Gaia credits and acknowledgement: https://www.cosmos.esa.int/web/gaia-users/credits
- Gaia DR3 credit and citation instructions (the acknowledgement text in `DATA.md`): https://gea.esac.esa.int/archive/documentation/GDR3/Miscellaneous/sec_credit_and_citation_instructions/
- Gaia at MAST (linked from the challenge resources tab): https://archive.stsci.edu/missions-and-data/gaia
- SIMBAD official Harvard mirror and acknowledgement: https://simbad.harvard.edu/simbad/ (accessible 2026-11-15)
- Wenger et al. 2000: https://doi.org/10.1051/aas:2000332 (bibliography verified through https://ui.adsabs.harvard.edu/abs/2000A%26AS..143....9W/abstract)
- WiseView: http://byw.tools/wiseview (this exact URL is linked from the challenge resources tab)

## Azure docs
- Static Web Apps: https://learn.microsoft.com/en-us/azure/static-web-apps/overview
- Container Apps: https://learn.microsoft.com/en-us/azure/container-apps/overview
- Blob Storage: https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-introduction
- Front Door: https://learn.microsoft.com/en-us/azure/frontdoor/front-door-overview
- Functions (Python): https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-python
- Cosmos DB: https://learn.microsoft.com/en-us/azure/cosmos-db/overview
- Application Insights: https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview

## Submission recheck, 2026-11-15

The challenge and submission-guide URLs above remain the official links. This
review could not reload them (HTTP502/unexpected fetch status); a human must
recheck the live guides and actual team submission form. A recorded 2026-11-14
review is not proof that current form fields or terms were completed. The ESA
credits recheck returned451/timeout; retain its previously checked attribution.
