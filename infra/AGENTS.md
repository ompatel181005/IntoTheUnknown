# infra/

Scripts only: `az`, `swa`, `func`. No application code.

## Conventions
- Every Azure resource is listed in `infra/README.md` with the problem it solves. No resource without a named problem (this backs the "Best Use of Azure" case).
- Scripts must be re-runnable and read secrets from the environment, never from files in git.
- Planned resources: Static Web Apps, Container Apps, Blob Storage behind a CDN layer, Functions timer trigger. Add-ons: Cosmos DB, Application Insights.
- Check Azure limits in `docs/LINKS.md` docs before choosing a SKU, and log surprises in `docs/DECISIONS.md`.
- Deploy workflows in `.github/workflows/*` are added by the infra owner (hotspot, ask the human).

Root AGENTS.md rules still apply.
