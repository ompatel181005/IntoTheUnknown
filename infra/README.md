# Azure resources

Every resource must name the problem it solves. Remove any resource without one.

| Resource | Problem it solves | Status |
|---|---|---|
| Azure Static Web Apps | Hosts the React frontend globally with no server to manage. | TODO(team) |
| Azure Container Apps | Runs the FastAPI backend, scales to zero between visitors. | TODO(team) |
| Azure Blob Storage (+ CDN layer) | Caches processed cutouts so repeat views are fast and survive slow IRSA. | TODO(team) |
| Azure Functions (timer trigger) | Watches for new SPHEREx data and refreshes the cache. | TODO(team) |
| Cosmos DB (add-on) | TODO(team): name the problem or drop it. | TODO(team) |
| Application Insights (add-on) | Shows latency and failures of IRSA calls and the watcher. | TODO(team) |
