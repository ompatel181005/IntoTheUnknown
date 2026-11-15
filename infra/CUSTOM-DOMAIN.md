# Project address: space.omnp.me

The app, API, images, measurement state and watcher remain on Azure. The existing
Container Apps environment is **Express**, which rejected custom hostnames with
`ExpressCustomDomainsNotSupported`. A tested Sites HTTPS gateway forwards public
requests to the generated Azure app hostname. The owner explicitly approved
publishing this small gateway source/artifact through Sites.

**https://space.omnp.me is live.** The gateway and custom hostname are active,
the certificate validates normally, and Chrome verifies sorting at 1440px and
320px plus the same-origin saved-view API. DNS and ownership records are verified
at Namecheap. The original generated Azure address remains available.

## DNS

Retain the main site's and email records. These records belong only to `space`:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `space` | `custom-domains.chatgpt.site.` |
| TXT | `_openai-site-verification.space` | The value returned by Sites add_custom_domain for this project |
| TXT | `_cf-custom-hostname.space` | The Cloudflare ownership value returned by that same call |

The old Azure `asuid.space` TXT may remain, but the CNAME now targets Sites.
No Namecheap password or account API credential is needed by the gateway.

## Deployment and source

- Sites project: `appgprj_6af9fb1ad7208191b83bdc6841f14c1f`.
- Public gateway URL: https://logica-space-gateway.excellentray16.chatgpt.site
- Published source commit: `d66572c4009d4bdda0534e965d7fcb921dbeac7d`.
- Exact gateway worker source is recorded at [gateway/worker.mjs](gateway/worker.mjs).
- Four transport/privacy tests run with the frontend Node tests.

The fixed upstream is the existing generated Container App hostname. The gateway
streams HTML, scripts, image arrays and public API responses; forwards POST bodies,
conditional and range headers; and rewrites Azure-local redirects to the public
host. It strips incoming session cookies, authorization and platform headers, and
removes response cookies. It does not contain application data, Azure credentials
or storage keys. Watcher administration keeps using the Azure origin.

Normal GitHub CI/CD still updates the Azure app. The gateway forwards the current
application without a second frontend build. To edit the gateway, use the Sites
source workflow for this exact project ID, build a matching archive from pushed
source, and deploy its saved version. Never store short-lived source credentials
in this repository or command arguments.

## Verification gates

1. Authoritative CNAME and both TXT values match the Sites domain response.
2. Sites reports the hostname/certificate active.
3. Normal HTTPS validation succeeds; home and Learn load in Chrome.
4. Prepared images paint and same-origin measurements succeed.
5. The homepage sorting works at desktop and 320px, with no archive request.

## Azure deployment preservation

`deploy_app.py` passes existing ingress custom-domain/certificate bindings through
the ARM template. This prevents their removal on environments which support them;
it cannot enable custom domains on Express. The current Express app has no direct
custom-domain binding. New standard environments require separate provisioning
and review; no environment migration was performed here.

Official references: [Express limitations](https://learn.microsoft.com/en-us/azure/container-apps/express-overview)
and [Azure managed domains](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates).
