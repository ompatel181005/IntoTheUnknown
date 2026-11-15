# Live Blob Storage handoff

Verified on 2026-11-14 against the Azure for Students project in `westus`.

```dotenv
STORAGE_ACCOUNT_URL=https://stplanetxitu7q4.blob.core.windows.net
FRAMES_CONTAINER=frames
STATE_CONTAINER=state
FRAMES_PUBLIC_BASE=https://stplanetxitu7q4.blob.core.windows.net/frames
```

Resource group: `rg-planetx`. Account: `stplanetxitu7q4`, StorageV2, Standard_LRS, HTTPS only, minimum TLS 1.2. The names and URLs above are public configuration, not credentials.

## Access for cache development

Use `BlobServiceClient(account_url, credential=DefaultAzureCredential())`. Locally, sign in with Azure CLI using an identity that has **Storage Blob Data Contributor** scoped to this storage account. In Container Apps, use the app's managed identity with the same scoped role. No account key, SAS or connection string is required; shared-key authorization is disabled on this account.

The signed-in provisioning user has that role and passed the live write tests. Himanshu's confirmed UIC identity has account-scoped **Storage Blob Data Contributor** and **Reader**. His initially supplied personal email had no tenant match; no guest invitation was made. Public reads are available without sign-in.

The deployed app uses the dedicated user-assigned identity `id-planetx-api`. It has Blob Data Contributor on this account and AcrPull on the project registry only. The app's `AZURE_CLIENT_ID` selects that identity. A live test inside the deployed container acquired a managed-identity token and successfully wrote, read and deleted a temporary private-state blob; no token was printed or stored.

| Container | Access | Intended contents |
|---|---|---|
| `frames` | Anonymous read of known blob URLs; authenticated writes; anonymous container listing disabled | Public render arrays, manifests and query pointers |
| `state` | Authenticated access only | Job and watcher state; private metadata |

Blob CORS allows browser GET/HEAD/OPTIONS, exposes response headers and caches preflight results for 3600 seconds. CORS does not grant write access. Store no secrets or private user data in `frames`.

## Verified live

- Entra-authenticated upload and deletion in both containers.
- Anonymous `frames` download returned HTTP 200 and the exact uploaded bytes.
- The test frame retained `Cache-Control: public, max-age=31536000, immutable`.
- Anonymous access to the existing test blob in `state` returned HTTP 404.
- Browser GET preflight returned HTTP 200 with an allow-origin header.

Only fixed, non-sensitive test text was uploaded. This does not establish that the backend cache implementation is wired to Blob, or that the web app is deployed.

## Cache integration contract

Keep the currently merged query/render key rules, including the pipeline version; the old skeleton's q1 key is not the current production key. Upload each render's arrays first, then its manifest, then swap the query pointer. Use immutable one-year headers for `r/` and `public, max-age=60` for `q/`. Preserve the local fallback when `STORAGE_ACCOUNT_URL` is unset. Himanshu owns this integration under #12; this handoff changes no cache code.

The root `.env.example` still lists legacy connection-string settings. For this account use the URL settings above and Entra authentication. A future Function deployment must also use identity-based storage configuration; default shared-key connection strings will not work.
