# A short project address on omnp.me

Proposed address: **https://space.omnp.me**. This is pending the owner's DNS
records and managed-certificate binding. Do not advertise it as live until the
checks below pass. The existing generated Azure hostname remains available.

The domain uses `dns1.registrar-servers.com` / `dns2.registrar-servers.com`.
The owner adds the following in Namecheap's Domain List > Manage > Advanced DNS,
with Automatic TTL, retaining existing records for the main site and email:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `space` | `ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io` |
| TXT | `asuid.space` | Copy `properties.customDomainVerificationId` from the current Container App; this is a public DNS verification value, not a secret. |

Obtain that value using the existing Student-scoped helpers:

```bash
source infra/env.sh
require_az
azs containerapp show -g "$RG" -n "$API" --query properties.customDomainVerificationId -o tsv
```

After both records resolve, configure the domain and Azure-managed HTTPS:

```bash
azs containerapp hostname add -g "$RG" -n "$API" --hostname space.omnp.me
azs containerapp hostname bind -g "$RG" -n "$API" --hostname space.omnp.me --environment "$CAE" --validation-method CNAME
```

Azure's managed certificate is free and renews automatically while its
requirements remain satisfied. The CNAME must point directly to the generated
app hostname. If CAA restrictions exist, permit DigiCert for this subdomain.
The public DNS check on 2026-11-15 found no root CAA records; no CAA change is
needed for that observed state. Reference:
[official Azure instructions](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates).

Validation gates:

- DNS CNAME and ownership TXT match the current app.
- Azure reports a secured hostname with an issued managed certificate.
- HTTPS certificate validates normally; the home page and `/learn.html` load.
- A prepared image paints; same-origin `/api/views` and measurements succeed.
- A subsequent normal image deployment retains the hostname and certificate ID.

`deploy_app.py` reads existing ingress bindings and passes them to the ARM
template's `customDomains` array. New apps default to an empty array. This
preserves every configured hostname, including a pending disabled binding,
without placing a certificate/private key in GitHub. Repeated image deployments
must use the updated helper; manually deploying the template with its default
empty array would remove existing bindings.

Domain activation does not require a new host, a frontend rebuild or a CORS
change: the site uses relative same-origin API URLs and Blob permits public
image reads from the custom origin. Shortening the address does not change
archive latency.
