# Same-host fork design

This fork runs Artifact Server in upstream external-storage mode on Kubernetes 1.33 or later, on one application host. The pods are stateless. Metadata lives in a dedicated Postgres database, and bytes live in a bucket such as `artifact-server` on an S3-compatible gateway (tested with Versity `versitygw` 1.4.1, `posix` backend, plain HTTP, path-style). Artifacts are served from the application host at readable paths. Viewers never log in, and publishers use one API key. The base is upstream `v0.1.2` (`5af28ac`).

Real deployment values belong in each operator's own configuration, not in this repository. This document uses `artifacts.example.internal` for the application host and `http://s3.example.internal:7070` for the S3 gateway.

This is revision 2 of a proposal. It replaces compact mode with external storage. Compact mode gets the same path mode and no-login mode at no extra cost. Nothing below is implemented.

## 1. How upstream routes content

### Version origins

Every saved version gets a random content token, `randomHex(18)`, which is 36 lowercase hex characters (`src/core/system.ts:32`). The token is a DNS label under `ARTIFACT_SERVER_CONTENT_DOMAIN`. Four builders in `src/http/artifact-http-links.ts` make every content URL:

- `versionBrowserUrl` builds `https://<token>.<contentDomain>/` (`:27`).
- `versionFileBrowserUrl` appends a manifest path (`:41`).
- `contentBootstrapBrowserUrl` adds `?__artifact_bootstrap=<one-time token>` for private content (`:55`).
- `previewLeaseBrowserUrl` builds the Review lease host `review-<56 hex>` (`:75`, label made at `src/application/content-access.ts:311`).

The stable link is `/artifacts/:artifactId` on the application host (`artifactBrowserUrl`, `src/http/artifact-http-links.ts:2`). Its handler redirects (302) to the origin of the current version of a public-link artifact (`src/http/create-http-app.ts:2435`). Responses return it as `links.artifact` and the version origin as `links.version`.

### Request to bytes

A middleware that runs before every application route reads the `Host` header (`src/http/create-http-app.ts:693`). `tokenFromContentHost` strips `.<contentDomain>` and validates the label (`:3989`, schema at `:204`). A request to any other host falls through to the application routes. The label picks one branch:

1. `review-…` goes to `servePreviewLeaseContent`. The lease token in the host name is the credential.
2. A `__artifact_bootstrap` query goes to `exchangeContentBootstrap` (`:3863`). It sets the HttpOnly, `SameSite=Strict` cookie `__Host-artifact_content` on that host (`:3937`).
3. Any other label goes to `serveVersionContent` (`:3422`).

`serveVersionContent` turns the URL path into a manifest path (`manifestPathFromUrl`, `src/manifest/create-manifest.ts:73`) and calls `ContentAccessService.authorizeVersionContent` (`src/application/content-access.ts:357`). The repository maps (token, path) to one manifest entry. The service allows the read if the artifact is `public_link` and the version is current (`:367`). Otherwise it needs a content-session cookie bound to that token (`:373`). `serveStoredVersionContent` streams the blob (`src/http/create-http-app.ts:3501`). Content responses carry no CSP. The separate origin is the only isolation.

### Where the content domain is used

- Both server parsers require `ARTIFACT_SERVER_CONTENT_DOMAIN`, compact at `src/lifecycle/runtime-configuration.ts:230` and external storage at `:282`. The external parser also serves `maintenance cleanup-staging` (`src/cli/lifecycle-commands.ts:123`).
- Both parsers then call `assertBrowserIsolation` (`:835`). After the HTTPS checks, it compares the tldts `getDomain()` result for the application host and for the content domain (`:866`). Equal or unknown registrable domains fail with `invalid_origin` (`:873`).
- The value passes unchanged through the runtime configs (`src/local/create-local-runtime.ts:89`, `src/external-storage/create-external-storage-runtime.ts:76`) into `HttpAppDependencies.contentDomain` (`src/http/create-http-app.ts:478`, 18 uses) and the MCP server (`src/mcp/artifact-mcp-server.ts:379`, 12 uses). Almost every use is an argument to one of the four builders.
- The Review frame CSP allows scripts, styles, and `connect-src` only from `*.<contentDomain>` (`reviewFrameContentSecurityPolicy`, `src/http/create-http-app.ts:4011`).
- The upstream chart routes a wildcard host with its own TLS secret (`packaging/helm/artifact-server/templates/ingress.yaml:22`, `:36`).
- The ledger encodes it in CNT-003, CNT-004, CNT-005, AUTH-010 to AUTH-014, CMT-013, DEP-014, and DEP-016 (`project/spec/conformance.yml:847` onward).

## 2. Storage on Versity

Gateway compatibility is the riskiest assumption, so it is proved first, in commit 2, before any feature work.

### What the adapter uses

The S3 adapter is `src/storage/s3-object-storage.ts`. Clients upload through the application (`PUT /api/v1/uploads/:uploadId/files/:storageToken`, `src/http/create-http-app.ts:2192`), and delivery streams through it too, so only the pods reach the gateway. `createS3ClientConfig` passes only `forcePathStyle`, `region`, static credentials, and `endpoint` (`src/storage/s3-object-storage.ts:90`). The runtime accepts an `http://` endpoint (`src/lifecycle/runtime-configuration.ts:791`).

| Feature | Where | Why the product needs it |
| --- | --- | --- |
| HeadBucket | `src/storage/s3-object-storage.ts:124` | Startup and `/ready` readiness, with a 3 s abort (`src/external-storage/create-external-storage-runtime.ts:131`). |
| PutObject, 8 MiB or less | `:297` (`@aws-sdk/lib-storage` `Upload`) | Every staging write and blob write. It sends `Content-Type: application/octet-stream` and the user metadata `x-amz-meta-artifact-sha256` and `x-amz-meta-artifact-kind` (`:304`, `:306`). |
| CreateMultipartUpload, UploadPart, CompleteMultipartUpload | same call, 8 MiB parts, 2 in flight (`:37`, `:311`) | Files over 8 MiB. |
| AbortMultipartUpload | `:300` (`leavePartsOnError: false`) | A digest, size, or abort failure leaves no parts behind (DEP-011-F). |
| HeadObject | `:199` | Runs after every put to check the size, so it needs read-after-write consistency (`:320`). It also serves HEAD delivery. The metadata must come back. |
| GetObject | `:224` | Delivery, archives, the integrity check, and staging reads at commit (`src/application/staged-upload.ts:318`). |
| GetObject with `Range` | `:259` | 206 delivery. The response `Content-Range` must match `bytes a-b/total` exactly (`:335`). |
| DeleteObject | `:217` | Staging cleanup only. A missing key must not be an error (`tests/integration/s3-object-storage.test.ts:107`). |
| Same-key overwrite | `src/application/publish-artifact.ts:190` | Every publish re-PUTs every blob with identical bytes, and concurrently on one key (`tests/integration/s3-object-storage.test.ts:184`). |
| SDK default checksums | not set in `:90` | `@aws-sdk/client-s3` 3.1109.0 defaults to `WHEN_SUPPORTED`. PutObject and UploadPart send `x-amz-sdk-checksum-algorithm: CRC32` and `x-amz-checksum-crc32` in headers, not trailers, because lib-storage sends Buffers. CreateMultipartUpload asks for CRC32, and CompleteMultipartUpload echoes per-part checksums. GetObject sends `x-amz-checksum-mode: ENABLED` and fails the stream on a whole-object checksum mismatch, with no exception for ranges. Bodies of 2 MiB or more send `Expect: 100-continue`. (Read from the SDK 3.1109.0 source, not observed on the wire.) |

The adapter uses no conditional writes (`If-None-Match`, `If-Match`), no CopyObject or UploadPartCopy, no ListObjectsV2, no DeleteObjects, no presigned URLs, no Content-MD5, and no tagging, storage class, encryption, versioning, or object lock. Only the tests list objects (`tests/integration/s3-object-storage.test.ts:137`).

### Versity 1.4.1 verdicts

The verdicts come from reading the `versitygw` source at tag `v1.4.1` (commit `7e4779e`) and the GitHub issues. Nothing was run. Paths are in that repository.

| Feature the adapter uses | Verdict | Evidence |
| --- | --- | --- |
| HeadBucket | Supported | `s3api/controllers/bucket-head.go`. It returns `x-amz-bucket-region`. |
| PutObject with `x-amz-checksum-crc32` in a header | Supported | The header is verified while the body streams, and a mismatch is `BadDigest` (`s3api/utils/csum-reader.go:118`). |
| Multipart with CRC32 set at create and composite part checksums | Supported | All multipart routes exist (`s3api/router.go`), and part checksums are validated (`backend/posix/posix.go:2183`). Parts other than the last must be at least 5 MiB. The adapter's parts are 8 MiB. |
| AbortMultipartUpload | Supported | `backend/posix/posix.go:2474`. |
| User metadata on HeadObject and GetObject | Supported, with a filesystem condition | `x-amz-meta-*` is lowercased and stored as one JSON extended attribute, up to 2048 bytes (`backend/posix/posix.go:2275`). The gateway's directory needs `user.` extended attributes, or the gateway must run with `--sidecar`. `--nometa` would break every read. |
| GetObject with checksum validation | Supported | The stored checksum comes back only with `x-amz-checksum-mode: ENABLED` on a full read. It is the CRC32 the SDK sent, so validation passes. A multipart object has a composite value, which the SDK skips. |
| GetObject with `Range` | Supported | `bytes=a-b` returns 206 with a correct `Content-Range` (`backend/common.go:98`, fixed in 1.4.1). A ranged read carries no checksum, so the SDK does not validate it. |
| DeleteObject | Supported | Commit 2 checks the missing-key case, which the source does not answer. |
| Same-key overwrite with identical bytes | Supported | Each object is published atomically by `linkat` or `rename` from a temporary file (`backend/posix/with_otmpfile.go:196`). The last writer wins. The adapter needs no more, because the bytes are identical. |
| Plain HTTP and path-style | Supported | Both are the gateway defaults (`cmd/versitygw/main.go:203`). |
| Region | Must match | The signing region must equal the gateway's `--region`, which defaults to `us-east-1`. Any other value fails with `AuthorizationHeaderMalformed` (`s3api/middlewares/authentication.go:82`). "Any region string" does not hold. |
| `Expect: 100-continue` on bodies of 2 MiB or more | Unknown | The source does not answer it. Commit 2's 9 MiB multipart case exercises it. |

Three gaps remain:

1. **Region.** `configuration.s3.region` must equal the gateway's region.
2. **Large files on ext4.** CompleteMultipartUpload stores one extended attribute that lists every part (`backend/posix/posix.go:2154`). Open issue versity/versitygw#2424 reports 507 `InsufficientStorage` near 1,418 parts on ext4 (seen on 1.7.0, and the code path is the same in 1.4.1). With 8 MiB parts, that caps one file near 11 GiB. XFS is not reported.
3. **Gateway filesystem.** The directory behind the posix backend must support `user.` extended attributes. If the filesystem lacks them, as some network filesystems do, the gateway needs `--sidecar`. Section 7 depends on this too.

The worst gaps in Versity 1.4.1 do not touch this adapter. Its `If-None-Match: *` create is not atomic (fixed in 1.8.0), and it stores `Content-Encoding: aws-chunked` from streaming uploads (versity/versitygw#2398, fixed in 1.9.0). The adapter never writes conditionally, and lib-storage sends Buffers, never `aws-chunked` bodies.

### Proof

`pnpm test:storage-s3` produced `project/evidence/s3-minio.json`. It runs `scripts/run-minio-integration.sh`, which starts a digest-pinned MinIO fork (`docker.io/pgsty/silo`, `:5`) and runs `vitest run --coverage --config tests/configs/vitest.integration.config.ts`. The S3 cases are in `tests/integration/s3-object-storage.test.ts`: DEP-011-B and DEP-022-B (`:64`), DEP-011-F (`:116`), aborted multipart (`:144`), concurrent same-key writes and installation isolation (`:184`), corrupt metadata (`:208`), and restart (`:237`).

The test reads its target from six variables (`readIntegrationEnvironment`, `:295`): `ARTIFACT_SERVER_S3_ENDPOINT`, `ARTIFACT_SERVER_S3_ACCESS_KEY`, `ARTIFACT_SERVER_S3_SECRET_KEY`, and three `ARTIFACT_SERVER_MINIO_*` names for the container, image, and volume. The bucket `artifact-server-integration`, the region `us-east-1`, and path-style are fixed (`:28`, `:29`, `:69`), and `beforeAll` creates the bucket (`:49`). Only the restart case is MinIO-specific, because it reruns the container as `server /data` (`:403`).

Commit 2 adds `scripts/run-versity-integration.sh`. It starts a digest-pinned `versitygw` 1.4.1 container with the posix backend and region `us-east-1`, sets the six variables, and runs the same test file without the restart case (`vitest -t` with a pattern that excludes it). It adds one fork case, FRK-000, for two risks the upstream cases miss. One is a ranged read of a small single-PUT object under the default checksums, and the other is metadata on a ranged GET. `fork-ci.yml` runs the script on every pull request. The operator then runs the same test once against the real gateway with a throwaway bucket, because the gateway's filesystem can differ from the container's.

If a case fails, commit 3 fixes it before any feature work. The likely fix sets `requestChecksumCalculation` and `responseChecksumValidation` to `WHEN_REQUIRED` in `createS3ClientConfig`. The application already verifies size and SHA-256 itself (`src/storage/verified-file.ts:21`), so S3 checksums add no integrity. The SDK also honors `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` and `AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED` in the environment, but the chart has no field for extra variables, so the code change is smaller.

## 3. Same-host URL shape

### Two path forms

When no content domain is configured, content lives on the application origin in two forms:

| URL | Serves | Credential |
| --- | --- | --- |
| `/<folder>/<path>` | The current version of a public-link artifact | None |
| `/v/<token>/<path>` | What `https://<token>.<contentDomain>/<path>` serves upstream | As upstream |

`/v/<token>` re-encodes the upstream content host as a path prefix. Exact versions, Review leases, and live sources keep their upstream code. The folder is the readable link people share.

### Folder name

The folder is `<name-slug>-<uuid>`:

- `<uuid>` is the artifact ID without its `art_` prefix (`src/core/system.ts:18`).
- `<name-slug>` is the artifact name folded to lowercase ASCII (NFKD, combining marks removed). Each run of other characters becomes one `-`, and the result is trimmed to 60 characters. An empty slug leaves the bare UUID.

An artifact named `Q3 cost report (SG)` is served at `https://artifacts.example.internal/q3-cost-report-sg-3fa85f64-5717-4562-b3fc-2c963f66afa6/index.html`. The file part is the manifest path, which is already readable.

Publish does not pick or store the folder. The folder is a pure function of the name and the ID, which are both fixed at creation. Upstream has no artifact rename. A new version keeps the folder, and two artifacts with the same name get different UUIDs. No field, column, migration, or collision rule is added, in Postgres or SQLite. The UUID keeps links unguessable, as upstream public links already are.

### Routing rule

The content router reads only the first path segment:

1. If the segment is `v`, the next segment is the token and the rest is the manifest path. The four branches of section 1 run unchanged.
2. If the segment matches `^([a-z0-9]+(-[a-z0-9]+)*-)?<uuid>$`, it is the folder of artifact `art_<uuid>`. `resolvePublicArtifact` (`src/application/content-access.ts:409`) finds the current version, and `serveVersionContent` serves it. `/<folder>` redirects (308) to `/<folder>/`, so relative URLs resolve inside the folder. A folder with a stale or wrong name part redirects (308) to the canonical folder.
3. Anything else goes to the application routes.

These application prefixes stay reserved: `/`, `/api`, `/auth`, `/mcp`, `/health`, `/ready`, `/.well-known`, `/assets`, `/review`, `/review-frame`, `/workbench`, `/projects`, `/administration`, and `/artifacts`. No application segment is `v` or ends in a UUID, so the code needs no reserved list. A test walks the Hono route table and fails if a registered first segment matches rule 1 or rule 2. A colliding upstream route then fails CI instead of hiding content.

Path mode keeps no per-pod state. Leases and versions live in Postgres, so any replica serves any content request.

### Links

In path mode:

- `links.artifact` is `/<folder>/`. `artifactBrowserUrl` takes the artifact record instead of its ID. That changes 10 call sites, 5 in `src/http/create-http-app.ts` and 5 in `src/mcp/artifact-mcp-server.ts`.
- `/artifacts/:artifactId` redirects (302) to `/<folder>/` instead of the version origin.
- `links.version` is `/v/<token>/`, and the Review lease base is `/v/review-<56 hex>/`.

All links stay absolute URLs on the application origin, as the clients expect (`tests/release/helm-chart.test.ts:56` parses them with `z.string().url()`).

### Mode selection

`ARTIFACT_SERVER_CONTENT_DOMAIN` becomes optional in both server parsers. When it is unset, the parser sets `contentDomain` to `null`, still runs the HTTPS origin checks of `assertBrowserIsolation`, and the server runs in path mode. When it is set, the registrable-domain check runs and the server keeps content hosts, as upstream does.

The field becomes `string | null` in these types, and call sites keep passing it through:

- `CompactRuntimeConfiguration`, `ExternalStorageRuntimeConfiguration`, and `RuntimeConfigurationSummary` (`src/lifecycle/runtime-configuration.ts:89`, `:109`, `:137`).
- `LocalRuntimeConfig` (`src/local/create-local-runtime.ts:89`) and `ExternalStorageRuntimeConfig` (`src/external-storage/create-external-storage-runtime.ts:76`).
- `HttpAppDependencies` (`src/http/create-http-app.ts:478`).
- `McpHttpAdapterDependencies` (`src/mcp/create-mcp-http-adapter.ts:62`), `ArtifactMcpServerDependencies` (`src/mcp/artifact-mcp-server.ts:379`), and its three link helpers (`:2426`, `:2460`, `:2559`).

Local mode keeps `localhost` content hosts (`src/cli/main.ts:136`). The Cloudflare worker keeps its own string (`deploy/cloudflare/src/worker.ts:76`), which still type-checks.

The variable is optional rather than removed because Compose, Pulumi, the Cloudflare contract, the upstream chart tests, and 15 test files set it (`grep -rlE '\.localhost|contentDomain|CONTENT_DOMAIN|tokenFromContentHost|versionBrowserUrl' tests`). They all keep passing in host mode, so no upstream test moves for the content domain. `tests/cli/lifecycle-cli.test.ts:143` still expects `invalid_origin` for a same-domain value. The fork adds path-mode tests.

## 4. Isolation on one origin

### Headers

Artifact HTML is untrusted agent output, and in path mode it shares the application's origin, cookies, and API. Every response from the content router carries two headers. That covers both path forms and every status, including 206, 304, 404, HEAD, and the SPA entry fallback:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads
Access-Control-Allow-Origin: *
```

The router adds them once, after the branch returns, so no branch can skip them. Upstream already sends a CSP sandbox for media on the application origin (`src/http/create-http-app.ts:3789`).

Without `allow-same-origin`, the browser gives the artifact document an opaque origin. That origin never equals `https://artifacts.example.internal`, although the URL does.

- `allow-popups-to-escape-sandbox` opens `target=_blank` links as normal pages. Without it, external sites open sandboxed and lose their own storage and cookies. An escaped popup is a normal cross-origin page with no access to the application.
- `allow-modals` makes `window.print()`, `alert()`, and `confirm()` work. Reports often have a print button.

`Access-Control-Allow-Origin: *` is required because module scripts, `fetch`, and web fonts are CORS requests, even from an opaque document to its own folder. Upstream sends the same header on Review lease responses for the same reason (`src/http/create-http-app.ts:3514`). It never comes with `Access-Control-Allow-Credentials`, so no cookie-bearing response becomes readable.

### The CSRF cookie and the session

`setApplicationSessionCookies` sets the session cookie HttpOnly and the CSRF cookie with `httpOnly: false` (`src/http/create-http-app.ts:2539`, `:2556`). Both use `SameSite=Lax`, `Path=/`, and the `__Host-` prefix (`:452`). On one host, the browser sends both cookies with content requests, and the content handlers ignore them. Artifact code still cannot use them:

- In an opaque-origin document, `document.cookie` throws `SecurityError`. CMT-014 proves this for the Review sandbox (`tests/browser/review-sandbox.spec.ts:51`).
- The application shell sends `frame-ancestors 'none'` (`src/http/create-http-app.ts:4049`), so artifact code cannot frame it. A popup that it opens is cross-origin to it.
- `fetch("/api/...", {credentials: "include"})` from an opaque origin is cross-site, so the browser drops the `SameSite=Lax` cookies. The API sends no CORS headers (AUTH-012), so the script cannot read the 401 either.
- A form POST sends `Origin: null` without the Lax cookies. `requireBrowserMutationSecurity` also requires the application Origin, `Sec-Fetch-Site: same-origin`, and the CSRF header (`src/http/create-http-app.ts:2645`).
- Service worker registration fails for an opaque origin, so artifact code cannot intercept application pages. This is spec behavior. The Phase 2 browser probe asserts it.
- Until a person signs in with an API key (section 5), the browser holds no session or CSRF cookie at all.

### Review frame

Review renders artifact HTML in an opaque `srcdoc` iframe with `sandbox="allow-scripts"` (CMT-014). In path mode, its CSP content source becomes the path-scoped `https://artifacts.example.internal/v/`. Artifact code inside Review can fetch its leased files but still cannot connect to `/api`. CSP ignores the path after a redirect, and no `/v/` response redirects outside `/v/`.

### What breaks for artifacts

| Breaks | Why | Matters? |
| --- | --- | --- |
| `localStorage`, `sessionStorage`, IndexedDB, Cache API, cookies | They throw `SecurityError` in an opaque origin. Upstream gives each version its own origin and storage. | Not for reports and charts. Yes for generated apps that keep state. Code that calls them without `try` stops. |
| Root-absolute URLs such as `/assets/index.js` | They resolve against the host root, where the application lives. | Yes for built single-page apps. Build with relative URLs, for example `vite build --base ./`. |
| Client-side routers | `routingMode: spa` still serves the entry for unknown paths in the folder. A router that assumes `/` as its base picks the wrong route. | SPAs only. |
| Canvas readback of same-folder images without `crossorigin` | The image is cross-origin to the opaque document, so the canvas is tainted. | Rarely. |
| Workers from a script URL | An opaque origin cannot create one. A `blob:` worker is untested. | Rarely. |
| A private (`account_required`) version opened in its own tab | An opaque document's subresource requests never carry the content-session cookie, so the bootstrap flow cannot work. Path mode answers it with `CapabilityUnavailable`. Review still shows private versions, because lease URLs carry the credential. | Only for private versions, which need an API-key session. |
| A page loaded during a publish | The folder serves the current version. A publish between the HTML load and a subresource load can mix two versions. A publish between resolving the folder and serving it can answer 401 once. Upstream redirects to an immutable origin instead. | A reload fixes it. |

### Residual risk

Upstream isolates top-level content twice, with a separate registrable domain and with a per-version origin. Path mode has one layer, the CSP sandbox. If a browser bug let artifact code escape it while a viewer is signed in with an API key, that code could act as the viewer. A viewer who has not signed in has no credential to take. Current Chromium, Firefox, and WebKit implement CSP `sandbox` (inferred, not tested here). The Phase 2 browser test runs in Chromium only, because `playwright.config.ts` defines no other project.

## 5. No-login mode

### Behavior

- Both private-team server modes report the browser login kind `none` and start without any browser login provider. `/auth/context` reports `none`. The routes `/auth/login` and `/auth/callback` do not exist. The only other login kind is `local_owner`, for the loopback local server.
- Viewing needs no login for the current version of a public-link artifact (`src/application/content-access.ts:367`).
- `/api/*` and `/mcp` accept a managed API key as a bearer token (`src/http/create-http-app.ts:800`). No other token type is accepted.
- Browsers sign in by posting a managed API key (see API-key sign-in below). AUTH-025 pins the contract (`project/spec/conformance.yml:1569`).

### Change

1. The browser login kind `none` in `BrowserAccess` (`src/core/browser-access.ts:21`) is the only private-team kind. Both server modes use `{mode: "private_team", loginKind: "none"}`. `/auth/context` reports `none`.
2. The Review sign-in gate (`apps/web/src/review/review-app.tsx:458`) shows the API-key sign-in form (see below) instead of a dead **Sign in** button. The client schema at `apps/web/src/api/client.ts:83` accepts `none`.
3. With login kind `none`, `GET /review?artifact=<id>…` redirects to `/artifacts/<id>`, which redirects to the folder. MCP tells agents to hand users the Review URL (`src/mcp/artifact-mcp-server.ts:1244`, `:2334`). Without this redirect, every link an agent shares would end at a sign-in page.
4. With login kind `none`, new artifacts default to `public_link`. One function, `defaultAccessSetting(browserAccess)` in `src/core/browser-access.ts`, owns the rule. It returns `public_link` for `none` and `account_required` for `local_owner`.
   - HTTP: the commit schema (`src/http/create-http-app.ts:192`) makes `accessSetting` optional, and the commit route (`:2224`) fills in the default.
   - MCP: `McpHttpAdapterDependencies` and `ArtifactMcpServerDependencies` gain `defaultAccessSetting`, which `createHttpApp` sets. The commit tool schema (`src/mcp/artifact-mcp-server.ts:1250`) defaults to it.
   - CLI: `publish` sends `accessSetting` only with `--public` (`src/cli/publish-command.ts:162`, `:167`), and `FilePublicationTarget.accessSetting` becomes optional (`src/client/file-publication-client.ts:189`). The server then applies its own default. Against a local-owner server, the result is `account_required`.
   - The publish input digest includes the resolved setting (`src/application/publish-artifact.ts:232`), so retries on one server stay idempotent.

Review and comments work on a private-team server after API-key sign-in. A publisher can still set `account_required` on a version. Review previews work through `/v/review-…` leases with no extra code. Opening a private version in its own tab does not work (section 4).

### The API key in external storage

The key comes from the runtime Secret as `ARTIFACT_SERVER_API_TOKEN_FILE` (`packaging/helm/artifact-server/templates/_helpers.tpl:142`). Its format is `as_key_key_<hex id>_<base64url secret>` (`src/core/installation-identity.ts:8`). Every serving start and every cleanup run calls `ensureBootstrapManagedApiKey` (`src/external-storage/create-external-storage-runtime.ts:154`). The first start registers the key with all capabilities. Later startups require the same key. A different key ID fails once any member or key exists (`src/storage/postgres-identity-repository.ts:412`), and a different secret under the same ID fails the digest check (`src/application/bootstrap-managed-api-key.ts:61`). Editing the Secret after the first start therefore crashes every pod and every cleanup run.

Admitting members and issuing, rotating, or revoking keys needs a direct human administrator session (`src/application/installation-access.ts:797`). An API-key session acts as the key's principal, which is never a direct human administrator. Without OIDC sign-in a private-team server has no member sign-in, so all publishers share this one key unless an operator seeds an administrator session. With OIDC sign-in, an administrator member who signs in through the provider gets a direct human administrator session.

`ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL` stays required in external storage (`src/lifecycle/runtime-configuration.ts:304`).

### API-key sign-in

On a private-team server, Review shows a form that posts `{"apiKey": "..."}` to `POST /auth/api-key`. The route exists only for login kind `none` and answers 404 on a local-owner server.

- A session has one subject, a member or an API key (`ApplicationSessionSubject` in `src/core/installation-identity.ts`). Key sessions live in their own table, `api_key_sessions`, in SQLite (schema 14) and Postgres (migration 13).
- The key is checked exactly as a bearer key is. The session principal comes from the same `apiKeyPrincipal` function, so it equals the bearer principal. The session ends at the earlier of the normal session lifetime and the key's expiry.
- A key session is valid only while both the session and its key are live. Revoking or rotating the key revokes its sessions in the same transaction and clears the in-process caches.
- The request needs `Origin` equal to the application origin and `Sec-Fetch-Site: same-origin`. No CSRF token exists before sign-in.
- Five failed attempts per client address in 60 seconds return 429 `RATE_LIMITED` with `Retry-After`, checked before the key. An attempt is charged before it runs, so a burst of concurrent requests cannot all pass the check, and it is refunded only when this server fails on its own, such as a database error. The count lives in one process. On a TLS-ingress deployment with `ARTIFACT_SERVER_ORIGIN` set, a request whose forwarded host and protocol match the origin keys on the last `X-Forwarded-For` entry, the one the proxy itself appended; without that match the key stays the socket address, which behind one ingress is the proxy pod's.
- Sign-out is the existing `POST /api/v1/session/logout`.
- A key session is a cookie on the application origin, so artifact code is the risk. Same-host content keeps the CSP sandbox without `allow-same-origin` (section 4), so artifact script runs in an opaque origin and its requests carry neither the right `Origin` nor the CSRF token.

### OIDC sign-in

A **Sign in with SSO** button on the same Review gate starts the OpenID Connect authorization code flow. `GET /auth/oidc/start?returnTo=<path>` redirects to the provider, and the provider redirects back to `GET /auth/oidc/callback`. Both routes exist only when `ARTIFACT_SERVER_OIDC_ISSUER` is set and answer 404 otherwise. `GET /auth/context` reports `login.oidc: true` so Review shows the button.

- The data shape is `OidcSignIn` in `src/core/oidc-sign-in.ts`: an `OidcProvider` port (`authorize`, `redeem`) and the `reject` or `admit` policy for unknown users. It lives on the private-team `BrowserAccess`, so a local-owner server cannot have it. Every reason a sign-in can end without a session is one row of `oidcFailureReports`, which says whether the log line is `rejected` or `failed` and whether the browser hears `failed` or `unavailable`.
- The adapter (`src/identity/oidc-provider.ts`, on `jose`) reads the discovery document once per process and keeps it after the first success. The document's `issuer` must equal the configured issuer, ignoring a trailing slash, and every endpoint must be https. Each provider request has a 5-second timeout and does not follow redirects, so the code, the verifier, and the client secret never reach another host.
- Start makes a fresh `state`, `nonce`, and PKCE verifier of 32 random bytes each and sends the S256 challenge. The browser keeps them, with the return path and a 10-minute expiry, in a pending cookie: `__Host-artifact_oidc` on an https origin, HttpOnly, SameSite=Lax, Max-Age 600. The `__Host-` prefix forces `Path=/`, and it stops a sibling subdomain from planting its own pending sign-in, which is a login CSRF. The cookie is not signed. It holds only this browser's own secrets, so a browser that edits it can only break its own sign-in. The return path is checked again when the cookie is read, and an expiry later than start would set is refused.
- The callback clears the cookie, then refuses, in order: a client past its callback limit, a provider `error`, a callback with no code or state, no readable pending cookie, a state that differs from the cookie's (compared in constant time), and an expired pending sign-in. Only then does it send the code with `client_secret_basic` and the verifier. A replayed cookie and callback reach the provider, whose single-use codes refuse the second redemption; a process-local record of spent states could not cover other replicas.
- The ID token is verified with `jwtVerify` against the JWKS, fetched for each redemption so a rotated key needs no cache logic. Only asymmetric algorithms are allowed, so `none` and HMAC never verify. `iss` must equal the discovery issuer, `aud` must hold the client ID, `azp` must equal it when present and must be present when `aud` names several audiences, `exp` is required, `iat` must be in the last 10 minutes and not in the future (30 seconds of skew), and `nonce` must equal the cookie's.
- Only the ID token's `email` claim names a member. No userinfo call is made. A token whose `email_verified` is not the boolean `true`, or that has no `email_verified`, is refused. An email with any non-ASCII character names no member, because lowercasing folds some non-ASCII letters onto ASCII ones (U+212A KELVIN SIGN becomes `k`). `InstallationAccessService.loginWithVerifiedEmail` matches the active member with that email, without case, and issues a member session. With no member, `reject` refuses and `admit` creates one with role `member`. A deactivated member's email stays refused, because `admitMember` conflicts and the second lookup finds no active member.
- The return path must be `/review` or a path under it. Anything else, such as a scheme, a host, a backslash, a control character, or another path on this origin, falls back to `/review`. Without a content domain, artifacts are served on the application origin, and an artifact page could send a person who just signed in somewhere else.
- Every refusal is a 303 to `/review?sso=failed`, or `/review?sso=unavailable` when the provider cannot be reached or this server fails on its own, such as a database error. The gate shows a fixed message and removes the parameter. No session cookie is set. One log line per attempt, `auth.oidc_sign_in.succeeded`, `.rejected`, or `.failed`, carries the reason, a detail, the client address, and on success the member ID and the email. It never holds a code, a token, or the client secret.
- Each callback is charged to its client address before it runs, and a success returns the charge. Twenty in a minute are allowed. Nothing is guessed here, but an unsigned cookie is easy to write by hand, so without the limit anyone could make this server send token requests carrying the client secret as fast as they like.
- `jose` has no dependencies, and the fork's earlier OIDC login used it, so this adapter reuses that code's shape. `openid-client` would add `oauth4webapi` and its own configuration surface for a flow of about 200 lines.

The trust boundary is the provider. It decides who a person is, and the email claim decides which member they become. Anyone who can get an ID token for this client with a given email can sign in as that member, an administrator included. With a provider that federates a directory, that is anyone who can edit their own email attribute in the directory, or anyone who can use a sign-in source that does not verify emails. Allow only sign-in sources whose emails administrators control.

## 6. Helm chart

### Patch the upstream chart

The fork patches `packaging/helm/artifact-server` (1,240 lines) instead of adding a chart. The patch touches about 40 chart lines plus about 25 README lines (counted from the files). A new chart would copy most of the 1,240 lines and then delete the same content-domain and provider paths.

The content domain becomes optional. Values that set it render exactly as upstream, so the upstream render and kind tests keep passing.

| File | Change |
| --- | --- |
| `Chart.yaml:7` | `kubeVersion` becomes `">=1.33.0-0 <1.37.0-0"`. The templates use only `apps/v1`, `batch/v1`, `networking.k8s.io/v1`, `policy/v1`, and `v1`, which 1.33 serves. |
| `values.schema.json:75` | `configuration.contentDomain` accepts `""`, in the same `oneOf` form that `s3.endpoint` uses (`:88`). |
| `values.schema.json:234` | No change. `ingress.contentTlsSecretName` is already a plain string that accepts `""`. |
| `templates/_helpers.tpl:111` | Require `ingress.contentTlsSecretName` only when `configuration.contentDomain` is set. |
| `templates/_helpers.tpl:146` | Emit `ARTIFACT_SERVER_CONTENT_DOMAIN` only when it is set. The runtime treats an empty value as missing (`src/lifecycle/runtime-configuration.ts:655`). |
| `templates/ingress.yaml:22`, `:36` | Render the wildcard TLS entry and the wildcard rule only when `configuration.contentDomain` is set. The application rule already routes `path: /` with `pathType: Prefix` (`:26`), so path-mode content needs nothing more. |
| `templates/NOTES.txt:15` | Print the content line only when a content domain is set. |
| `templates/cleanup-cronjob.yaml:25` | Add `enableServiceLinks: false`. The CronJob passes no `--port` (`:38`), and a Service named `artifact-server` injects `ARTIFACT_SERVER_PORT=tcp://…`, which `portOption` reads (`src/cli/lifecycle-commands.ts:570`) and `parsePort` rejects. This is a latent upstream bug (inferred, not run). The Deployment already passes `--port 8787` (`deployment.yaml:77`). |
| `README.md` | Kubernetes 1.33 to 1.36, one host with one TLS secret, `s3.endpoint` and `s3.forcePathStyle`, egress to the S3 port, and the ingress annotations for uploads. |

These need no change:
- `s3.endpoint` accepts `http://` in both the schema (`values.schema.json:88`) and the runtime (`src/lifecycle/runtime-configuration.ts:791`). The runtime accepts any region string (`:471`), but the gateway does not (section 2). MinIO over plain HTTP with path-style is already proved (`tests/release/helm-chart.test.ts:590`).
- `templates/migration-job.yaml` needs only the database URL and the installation ID.
- `templates/deployment.yaml`, `networkpolicy.yaml`, and `tests/ready.yaml` need no change either. Egress rules come from values.

Outside the chart:
- `project/spec/decisions/0013-kubernetes-helm-release.md:12` to `:17` and `:83` add 1.33 to the window, and `:39` makes the wildcard host optional. The ADR asks for the window to move deliberately, and this is that change.
- `scripts/verify-helm-chart.sh:24` adds `1.33.0` to the render loop. It adds a render case with no content domain, which asserts one ingress host and no `ARTIFACT_SERVER_CONTENT_DOMAIN`.
- `scripts/check-release-version.mjs:8` and `:99` pin `values.yaml` to `ghcr.io/plannotator/artifact-server`. The fork leaves `values.yaml` alone, and the release workflow writes the fork image into the packaged chart (section 8).

### Values a deployment sets

- `configuration.applicationOrigin` (`https://artifacts.example.internal`), `installationId`, `bootstrapAdministratorEmail`. Leave `contentDomain` empty.
- `configuration.s3`: `bucket: artifact-server`, `endpoint: http://s3.example.internal:7070`, `forcePathStyle: true`, and `region` equal to the gateway's `--region` (`us-east-1` unless the gateway sets another). Set `secret.keys.s3AccessKeyId` and `s3SecretAccessKey`, because a gateway such as Versity needs static keys.
- `ingress.applicationTlsSecretName` is a TLS secret that covers the application host. Leave `contentTlsSecretName` empty. Set `ingress.annotations` to `nginx.ingress.kubernetes.io/proxy-body-size: "0"` and `proxy-request-buffering: "off"`, because upload `PUT`s have no application size limit and ingress-nginx defaults to 1 MiB.
- Postgres connection budget. The chart checks `postgresConnectionBudget` (default 22) against 2 replicas × `postgresPoolSize` 10 plus the migration and cleanup jobs (`templates/_helpers.tpl:87`). A rolling update with `maxSurge: 1` (`templates/deployment.yaml:17`) briefly runs a third pod. Give the Postgres role a connection limit of at least 32.

## 7. Backup

Backup is the operator's job. The fork ships no backup job.

### Is "database first, then bucket" safe?

Yes for committed data, under three conditions. The evidence:

- Blobs are content-addressed. The key is `installations/<sha256(installationId)>/blobs/<2 hex>/<sha256>` (`src/storage/cloud-object-storage.ts:63`), and a key never changes meaning.
- Every blob is written before the row that references it. `publishPreparedNew` stores every file (`src/application/publish-artifact.ts:253`) before `commitNewArtifact` opens the Postgres transaction (`:257`, `src/storage/postgres-artifact-repository.ts:1241`). New versions follow the same order (`publish-artifact.ts:313`, `:317`). Nothing writes to the bucket after a commit. ADR 0006 states the rule: "A database failure may leave an unreferenced immutable blob, but it cannot leave a committed version pointing at missing bytes." (`project/spec/decisions/0006-postgres-external-storage-runtime.md:32`).
- Nothing deletes a committed blob. `BlobStore` has no delete method (`src/core/ports.ts:68`), artifact deletion is a tombstone (`postgres-artifact-repository.ts:1505`), and ADR 0006 keeps blob deletion disabled (`:33`).
- The only deletion is expired, uncommitted staging cleanup (`src/application/expired-staging-cleanup.ts:81`). A staging object of an upload that expires during the copy can vanish. That upload is already expired in the dump, so it can never commit after restore.

The three conditions:

1. The database copy is one snapshot. `pg_dump` takes one by default, and so does a CloudNativePG backup.
2. The bucket copy keeps object metadata and covers the whole `installations/<namespace>/` prefix. Every read checks the `artifact-sha256` and `artifact-kind` metadata (`src/storage/cloud-object-storage.ts:87`). A copy that drops metadata breaks every read. The Versity posix backend stores metadata, the ETag, and checksums in `user.` extended attributes, or in sidecar files with `--sidecar` (section 2). A filesystem-level copy must keep them, for example `rsync -aX` or `tar --xattrs`. An S3-level copy keeps them through the gateway.
3. The restore uses the same `ARTIFACT_SERVER_INSTALLATION_ID`, because the key namespace is its hash (`cloud-object-storage.ts:59`). Run `integrity check --mode external-storage` on the restored pair before serving (`src/lifecycle/integrity-check.ts:147`). It re-hashes every referenced blob.

Copying the bucket first is unsafe, because a row committed during the copy could reference a blob the copy missed.

"No downtime" is a new claim. Every upstream procedure stops the application first (`packaging/compose/README.md:303`, ADR 0012), and the restore qualification scales to zero before its snapshot (`scripts/run-aws-coordinated-restore-qualification.sh:245`). Each operator should run one online restore drill before relying on it. Its pass criterion is a healthy `integrity check` on the restored pair.

## 8. CI

`.github/workflows/fork-release.yml` is a new file, so it never conflicts with upstream. A tag `v<upstream version>-fork.<n>`, for example `v0.1.2-fork.1`, triggers it:

1. The `image` job builds `packaging/oci/Dockerfile` with `docker/build-push-action` for `linux/amd64` and pushes `ghcr.io/duyet/artifact-server:0.1.2-fork.1`. The job keeps the digest from the action output.
2. The `chart` job writes `image.repository` and `image.digest` into the chart's `values.yaml`, runs `helm lint`, and runs `helm package --version 0.1.2-fork.1`. `appVersion` stays the upstream version, which `scripts/check-release-version.mjs:94` requires. It then runs `helm push` to `oci://ghcr.io/duyet/charts`, which publishes `ghcr.io/duyet/charts/artifact-server`, and keeps the printed digest.
3. The job summary prints both references.

The deployment pins the chart by digest: `oci://ghcr.io/duyet/charts/artifact-server@sha256:…` ([Helm registries](https://helm.sh/docs/topics/registries/)). The chart's default `image.digest` comes from the same run, so one pin fixes both. The workflow follows the repository rules that `zizmor` enforces in `.github/workflows/security.yml`: SHA-pinned actions, `persist-credentials: false`, top-level `permissions: contents: read`, and `packages: write` only on the push jobs.

`.github/workflows/fork-ci.yml` runs on pull requests. It runs the Versity contract test (section 2) and `pnpm verify:helm-static`, which now renders 1.33. The upstream `ci.yml` keeps running the unit, conformance, and browser tests on fork pull requests.

## 9. Commits

Branch `feat/k8s-compact-same-host`. Each commit passes its check before the next one starts. Every new test name carries a fork requirement ID (`FRK-001-B` and similar). `scripts/check-conformance-test-ids.rb` rejects unknown IDs, so each commit adds its requirement to the end of `project/spec/conformance.yml`. Locally, the checks run only as single test files, after a one-time `pnpm install`. Docker-backed checks run in CI.

| # | Commit | Check |
| --- | --- | --- |
| 1 | `docs(fork): add same-host design` | This file. |
| 2 | `test(storage): prove the S3 contract against Versity 1.4.1` | `scripts/run-versity-integration.sh` in `fork-ci.yml` runs DEP-011-B, DEP-011-F, DEP-022-B, the abort, concurrency, and metadata cases, and FRK-000 against the container. A failure names the gap. |
| 3 | `fix(storage): send S3 checksums only when required` | Commit 2's script passes, and `pnpm test:storage-s3` still passes against MinIO. Skip this commit if commit 2 passes unchanged. |
| 4 | `feat(http): build content links on the application host` | `tests/http/artifact-http-links.test.ts` covers all four builders for a content domain and for `null`, and `pnpm typecheck` passes. |
| 5 | `feat(http): serve /v/<token> content in path mode` | FRK-001 test against a real server with temporary storage: public current version, nested file, SPA fallback, Review lease, unknown token 404, bootstrap `CapabilityUnavailable`, application routes unchanged. |
| 6 | `feat(http): sandbox path-mode content responses` | FRK-002 test asserts both headers on 200, 206, 304, 404, 401, HEAD, and the SPA fallback. CI browser test `tests/browser/frk-002-same-host-sandbox.spec.ts` opens a hostile artifact at top level and expects every probe to fail: cookie, storage, credentialed `fetch` to `/api/v1/session`, form POST, service worker. |
| 7 | `feat(http): serve artifact folders` | FRK-003 test: folder names (ASCII, Vietnamese diacritics, CJK only, long names), current version served, a new version moves the folder, `account_required` gets 401, 308 for the trailing slash and for a wrong name part. The route-table collision test. |
| 8 | `feat(http): scope the review frame CSP to /v/` | The CSP string test, and the CI browser run of the existing Review sandbox and preview specs in path mode. |
| 9 | `feat(config): make the content domain optional` | In `tests/cli/lifecycle-cli.test.ts`, compact and external-storage `config check` pass without the variable, and a same-domain value still fails. `tests/integration/external-storage-runtime.test.ts` gains a path-mode publish and read (CI, Docker). |
| 10 | `feat(auth): report login kind none` | FRK-004 test for both modes: `/auth/context` reports `none`, `/auth/login` returns 404, `/review?artifact=` redirects, and bearer publish works. Update the AUTH-025 tests. `pnpm --filter @artifact-server/web typecheck`. |
| 11 | `feat(publish): default to public links without login` | FRK-005 test: with login `none`, HTTP, MCP, and CLI publishes without a setting produce `public_link`. Against a local-owner server, they produce `account_required`. `--public` still works against both. |
| 12 | `feat(helm): install on Kubernetes 1.33 without a content domain` | `pnpm verify:helm-static` with 1.33 and the new no-domain case. The upstream kind test (`pnpm test:helm`, CI) still passes with its content domain values. |
| 13 | `ci(fork): publish the image and chart on fork tags` | `zizmor` and `actionlint` on the workflow, then the first tag `v0.1.2-fork.1`: both digests in the summary, and `helm template` of the pulled chart shows the image digest. |
| 14 | `docs(fork): add the operator runbook` | It holds the operator steps below and the values of section 6. Every command matches the chart. |

As built, three things differ from this table. Commit 3 was not needed, because the Versity contract test passed in CI. The Review frame CSP of commit 8 landed in commit 5, because widening the content domain type forces it. The Versity commit landed after commit 4 in history.

The fork deviates from these ledger entries in path mode: CNT-004 and CNT-005 (per-version origins), DEP-014-F and DEP-016-B (path-only content as the isolation boundary), and AUTH-025 (API-key sign-in instead of a provider). The ledger entries for commits 5 to 12 say so. DEP-006 (stateless Kubernetes replicas) holds again.

## 10. Operator steps

The runbook lists these steps. Each one is a setting outside the repository:

1. In the fork's Actions settings, disable upstream `release.yml`. It fires on `v*` tags and pushes to `ghcr.io/plannotator`, which fails on the fork.
2. After the first release, make the `artifact-server` image and chart packages on GHCR public, or give the cluster an image pull secret. The first push to GHCR is private.
3. Create the bucket `artifact-server` on the gateway and an access key limited to it.
4. Create the Postgres database and role, with a connection limit of at least 32.
5. Generate the API key once, for example `printf 'as_key_key_%s_%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)"` (`packaging/compose/README.md:201`), and store it in the runtime Secret. Never change it after the first start.
6. Pick a stable `installationId`. It names the bucket prefix forever.
7. Allow egress from the pods to the gateway port and to Postgres.
8. Confirm the gateway's `--region` and set `configuration.s3.region` to it.
9. Confirm that the gateway's posix directory supports `user.` extended attributes, or that the gateway runs with `--sidecar`. Note whether it is ext4, because one file then caps near 11 GiB (section 2).
10. Run commit 2's contract test once against the real gateway, with a key that may create the throwaway bucket `artifact-server-integration`. Delete that bucket afterward.

## 11. Readable artifact paths

This section was the design for revision 3. Citations are against `b644213`. Branch `feat/artifact-paths` implements it. As built, one test differs: FRK-002-B probed `/not-a-route` as an application route, but that URL is now a path request that carries the sandbox headers, so the probe moved to `/not-a-route.txt`.

An operator migrating existing static reports wants readable dated URLs, for example `https://artifacts.example.internal/2026/10/release-checklist/` with an asset at `/2026/10/release-checklist/shots/a.jpg`. An artifact may therefore claim one optional path when it is created. A path is guessable, unlike a folder URL. If the server is reachable only on a private network, an operator may accept guessable paths. On a wider network, publish without a path and share the folder URL.

### Data shape

The path is a nullable column on the artifact row, not a separate table. Every reader that builds `links.artifact` already loads that row, so a column needs no join.

- `ArtifactRecord` (`src/core/model.ts:72`) gains `path: string | null`. `CommitNewArtifact` (`src/core/ports.ts:104`) gains the same field.
- A new version never writes the artifact row's name or tags (`CommitArtifactVersion`, `src/core/ports.ts:121`). It keeps the path the same way, with no new code.
- The value is a plain string. The codebase has no branded types (no `Brand` anywhere in `src`), and one brand here would be the only one. Instead, `parseArtifactPath` is the only way a path enters the server (see "Validation and reserved segments").

Paths are prefix-free within an installation. No live path equals another, and no live path is a prefix of another at a `/` boundary. `2026/10/release-checklist` and `2026/10/release-checklist-v2` can both exist, but `2026/10` and `2026/10/release-checklist` cannot. With nesting, the longer path would hide the shorter artifact's files under that subfolder, and nobody would notice until a reader got the wrong page. A prefix-free rule fails at publish time instead, and every request matches at most one artifact.

The rule covers live artifacts only. Deletion is a one-way tombstone (`src/storage/postgres-artifact-repository.ts:1505`), and nothing undeletes an artifact, so a deleted artifact frees its path. There is no rename, so to move content to a path, delete the artifact and publish it again.

| Backend | Schema change | Claim under concurrent publishes |
| --- | --- | --- |
| SQLite | `requiredSqliteSchemaVersion` goes from 12 to 13 (`src/storage/sqlite-schema.ts:9`). A new `#addArtifactPathIfMissing` runs after `#addGitHistoryMirrorTablesIfMissing` (`src/storage/sqlite-artifact-repository.ts:4903`). It checks for the column first, as `#addSourceBindingColumnsIfMissing` does (`:5033`), then adds `path TEXT` and `CREATE UNIQUE INDEX IF NOT EXISTS artifacts_live_path ON artifacts (path) WHERE path IS NOT NULL AND deleted_at IS NULL`. The index is not gated on `user_version`, because `SqliteIdentityRepository` also stamps that value (`src/storage/sqlite-identity-repository.ts:748`). | `#applyNewArtifactCommit` (`:1302`) already runs inside `BEGIN IMMEDIATE` (`#transaction`, `:5691`). One writer holds the database while it checks and inserts. |
| Postgres | Migration `0012_artifact_path` runs `ALTER TABLE artifacts ADD COLUMN path TEXT COLLATE "C"` and `CREATE UNIQUE INDEX artifacts_live_path ON artifacts (installation_id, path) WHERE path IS NOT NULL AND deleted_at IS NULL`. It is registered in `Migrator.fromRecord` (`src/storage/postgres-migrations.ts:658`), `requiredPostgresSchemaVersion` becomes 12 (`:673`), and `expectedHistory` gains `{migration_id: 12, name: "artifact_path"}` (`:760`). Without that entry, startup reports a divergent history. | `commitNewArtifact` runs at READ COMMITTED and locks only the idempotency key (`src/storage/postgres-artifact-repository.ts:1242`). After the replay check, a create that has a path takes `pg_advisory_xact_lock(hashtextextended('<installation>:artifact-paths', 0))`, in the same form as `lockIdempotency` (`:4835`). It then checks and inserts. A create without a path never takes the lock. |
| D1 | None. The Cloudflare worker always sets a content domain (`deploy/cloudflare/src/worker.ts:76`), so the HTTP boundary refuses a path before D1 sees one. | `commitNewArtifact` (`deploy/cloudflare/src/d1-artifact-repository.ts:2196`) throws `CapabilityUnavailable` for a non-null path. Its projections return `path: null`, and its path lookup returns `null`. |

The claim check is one query in both SQL backends. It looks for a live row whose path is the new path or one of its ancestors (`path IN (...)`, at most 6 values), or a descendant (`path >= '<p>/' AND path < '<p>0'`). The character `0` comes right after `/` in byte order. Both `COLLATE "C"` and the SQLite default `BINARY` compare bytes, so the range is exact for ASCII paths. A hit throws the new `ArtifactPathTaken` (409 `ARTIFACT_PATH_TAKEN`), whose message names the existing path. The unique index is a backstop. If a bug let two writers past the check, the second insert would fail instead of storing a duplicate.

The order inside `commitNewArtifact` matters. The idempotency replay check runs before the claim, so a retried create returns its original result instead of a 409 against its own path. The claim runs after `storeFiles` (`src/application/publish-artifact.ts:253`), so a 409 leaves unreferenced, content-addressed blobs behind, as any failed commit does. ADR 0006 allows that (`project/spec/decisions/0006-postgres-external-storage-runtime.md:32`).

`newArtifactInputDigest` (`src/application/publish-artifact.ts:356`) adds `path` only when it is set. The digest of a publish without a path stays byte-identical, so an idempotency key issued before the upgrade still replays after it. The same key with a different path fails with `IdempotencyConflict`, as any other changed field does.

The two new error tags, `ArtifactPathTaken` and `InvalidArtifactPath`, need the usual edits:

- `errorCodes` and `artifactServerFailureSchema` (`src/core/errors.ts:4`, `:472`).
- The exhaustive switch in `src/http/artifact-http-failure.ts`, which ends in `casesHandled` (`:116`).
- `CommitNewFailure` (`src/application/publish-artifact.ts:86`).
- `classifyCommitNewFailure` (`src/local/create-local-application-layer.ts:1281`). Without this edit, the conflict becomes a 500.

Every query that fills an artifact row schema reads the new column (SQLite `artifactRowSchema` at `src/storage/sqlite-artifact-repository.ts:251`, Postgres at `src/storage/postgres-artifact-repository.ts:225`). Those include SQLite `listArtifacts`, `#readArtifactOrNull`, and `#readArtifactIncludingDeletedOrNull` (`:1826`, `:2654`, `:2673`), and Postgres `listArtifacts` and `#readArtifactOrNull` (`:1642`, `:3407`). Two client schemas change too:

- The MCP `artifactRecordSchema` is `.strict()` (`src/mcp/artifact-mcp-server.ts:131`). Without `path`, structured results fail validation.
- The client `artifactSchema` (`src/client/file-publication-client.ts:75`) drops unknown fields. It gains `path` so that CLI output shows it.

### Request routing

`parseSameHostContentRequest` (`src/http/same-host-content.ts:60`) stays the one pure predicate behind both the isolation wrapper (`src/http/create-http-app.ts:706`) and the content router (`:717`). It gains a third variant:

```ts
/** A request whose leading segments may name an artifact path. */
export interface SameHostPathRequest {
  /** Prefixes of the request path that are valid artifact paths, shortest first, at most 6. */
  readonly candidates: readonly [string, ...string[]];
  readonly kind: "path";
  readonly requestUrl: URL;
}
```

The first segment picks the form, in this order:

| First segment | Form | Lookup |
| --- | --- | --- |
| `v` | Version, unchanged | None |
| Matches the folder pattern (`src/http/same-host-content.ts:13`) | Folder, unchanged | `resolvePublicArtifact` by ID |
| Empty, a reserved root, or not a valid path segment | Application route | None |
| Any other valid path segment | Path | One indexed query |

The candidates are the prefixes `s1`, `s1/s2`, and so on, up to 6 segments. They stop at the first segment that is not valid, such as `index.html` or the empty segment after a trailing slash. `/2026/10/release-checklist/shots/a.jpg` has the candidates `2026`, `2026/10`, `2026/10/release-checklist`, and `2026/10/release-checklist/shots`.

The router calls a new `ContentAccessService.resolvePublicArtifactPath(candidates)`. That calls a new repository method, `findArtifactByPath(candidates)`, which runs `SELECT id, path FROM artifacts WHERE path IN (...) AND deleted_at IS NULL` on the partial unique index. It then reuses `resolvePublicArtifact` (`src/application/content-access.ts:409`). Paths are prefix-free, so at most one row comes back. The router then answers in one of four ways:

- **No row.** The router calls `next()`. No application route owns the segment, so `app.notFound` answers 404 `NOT_FOUND` (`src/http/create-http-app.ts:2531`), as it does for any unknown path today. The isolation wrapper still adds the sandbox headers, because the predicate claimed the URL.
- **An `account_required` artifact.** `resolvePublicArtifact` fails with `ContentSessionRequired`, which is 401 `CONTENT_NOT_PUBLIC`, as for folders.
- **A request that ends at the path with no slash**, such as `/2026/10/release-checklist?x=1`. The router answers 308 to `/2026/10/release-checklist/?x=1`, so relative URLs resolve inside the artifact.
- **Anything else.** The remaining segments become the in-version URL, and `serveVersionContent` runs as it does for folders (`:3574`). Range, ETag, HEAD, 405, and the SPA fallback come with it.

A new `serveArtifactPath` sits next to `serveArtifactFolder` (`:3559`). Both forms get their `{slashMissing, versionUrl}` from `same-host-content.ts`, so the two cannot drift apart.

The cost per request was counted from the code, not measured. An application route pays only for the pure classifier, as today. A path hit costs one indexed query more than a folder hit: 5 queries on Postgres and 6 statements on SQLite, against 4 and 5 for a folder. A miss costs one indexed query. A scanner probing `/wp-admin/` pays that query, which is acceptable on a private network.

A new `artifactContentRoot(artifact)` in `same-host-content.ts` returns `/<path>/` when the artifact has a path, else `/<folder>/`, else `null`. `artifactBrowserUrl` (`src/http/artifact-http-links.ts:4`) and the redirect guard of `/artifacts/:artifactId` (`src/http/create-http-app.ts:2518`) both call it. `links.artifact` therefore prefers the path at all 11 call sites. Each site passes a full artifact record (`grep -n "artifactBrowserUrl(" src`), so none needs an edit. An artifact that has a path still answers at its folder URL, with no redirect, because no response ever returned that URL as its link.

### Validation and reserved segments

`parseArtifactPath(raw)` lives in `src/http/same-host-content.ts`, next to the folder pattern and the classifier, so the publish rule and the routing rule read the same constants. It removes one leading and one trailing `/`, then requires:

- 1 to 6 segments joined by `/`, at most 200 characters in all.
- Each segment matches `^[a-z0-9][a-z0-9-]*$`.
- The first segment is not in `reservedPathRoots` and does not match the folder pattern.

Uppercase is rejected, not folded, because a folded path is a URL the publisher never typed. Each failure throws `InvalidArtifactPath` (422 `INVALID_INPUT`) with a message that names the segment, for example `The first path segment "api" is reserved by the application.` A Zod refinement would lose that message, because the Zod handler replaces every message with "The request does not match the API contract." (`src/http/create-http-app.ts:2567`).

`reservedPathRoots` is the one list of reserved first segments: `administration`, `api`, `artifacts`, `assets`, `auth`, `health`, `mcp`, `projects`, `ready`, `review`, `review-frame`, `v`, and `workbench`. `.well-known` and the empty root fail the segment grammar, so they need no entry. The classifier and `parseArtifactPath` both read the list.

The route-table walk in FRK-003-F (`tests/conformance/frk-003-artifact-folders.test.ts:153`) gains one assertion: every registered first segment that is a valid path segment is in `reservedPathRoots`. A route that upstream adds later fails CI until the fork reserves it. Reserving it hides every artifact whose path starts with that segment, although each one still answers at its folder URL. Before merging such an upstream change, list the affected rows with `SELECT path FROM artifacts WHERE path = '<root>' OR path LIKE '<root>/%'`.

Paths exist only in path mode. A new `assertArtifactPathsAvailable(contentDomain)`, modeled on `assertCookieSessionsAvailable` (`src/http/same-host-content.ts:134`), throws `CapabilityUnavailable` when a content domain is set. Host mode has no route that could serve a path, and a stored but unserved field would hide the mistake.

### API, CLI, and MCP

- **HTTP.** The `new_artifact` target of the commit body (`src/http/create-http-app.ts:203`) gains `path: z.string().min(1).max(200).optional()`. The commit route (`:2287`) calls `assertArtifactPathsAvailable` and `parseArtifactPath`, then passes `path: string | null` on. The `new_version` target stays `.strict()`, so a path there is 422.
- **Application.** `CommitStagedUploadTarget` (`src/application/staged-upload.ts:69`) and `PublishPreparedNewArtifactCommand` (`src/application/publish-artifact.ts:55`) gain `path: string | null`. `publishPreparedNew` (`:217`) puts it in the digest and the commit command.
- **MCP.** The `new_artifact` target of `artifact_commit_upload` (`src/mcp/artifact-mcp-server.ts:1261`) gains the same optional `path`, described as "Optional readable path such as 2026/10/report. 1 to 6 lowercase segments, served at /<path>/ and kept by new versions." The handler makes the same two calls.
- **CLI.** `publish --path 2026/10/release-checklist`. `FilePublicationTarget` (`src/client/file-publication-client.ts:187`) and `effectiveCommitTarget` (`:385`) carry it. The CLI does not validate it, so the operator reads the server's message. The new-version guard (`src/cli/publish-command.ts:145`) becomes "--name, --path, --public, and --tag apply only when creating a new artifact." `prepareFilePublication` (`:309`) already hashes the whole target into the operation digest, so a retried command reuses its idempotency key.
- **Responses.** Every artifact record carries `path`, and `links.artifact` is `/<path>/` when it is set.
- **No rename.** Changing a path needs a management route, an MCP tool, a CLI command, an action record, and a rule for the old URL. That is not free.
- **Docs.** `docs/cli.md`, `docs/mcp.md`, `skills/artifact-server/references/artifact-operations.md`, and the migration steps in `docs/fork/RUNBOOK.md`.

Suppose a report's HTML points at its sibling folder as `release-checklist/shots/a.jpg`. That link breaks at `/2026/10/release-checklist/`, because the document's base URL is now the artifact itself. Stage each report as a directory that holds `index.html` and the sibling folder's contents, and remove the `release-checklist/` prefix from those links. This is inferred from that layout and was not checked against real reports.

### Follow-up, not planned: folder index pages

A path miss could list the public artifacts under it, so `/2026/10/` would show the October reports. Paths are prefix-free, so `2026/10` can never be both an artifact and an index. The work is:

- One repository method per backend, `listPublicArtifactsUnder(prefix, limit)`, a range scan on the same index. D1 returns an empty list.
- One server-rendered HTML page with escaping. The sandbox headers already apply.
- One FRK requirement with its tests.

The estimate is about 150 source lines and 100 test lines, in one pull request, for half a day of work. An index makes every public artifact easy to find, so whether to build it is the operator's call.

### Commits

Branch `feat/artifact-paths`, one pull request. Each commit adds its ledger entry together with its tests, because `scripts/check-conformance-test-ids.rb` rejects unknown IDs. Local checks are single test files only. The Postgres checks run in CI.

| # | Commit | Check |
| --- | --- | --- |
| 1 | `docs(fork): design readable artifact paths` | This section. Its citations resolve at `b644213`. |
| 2 | `feat(storage): add the artifact path column` | SQLite: a new case in `tests/conformance/storage-migration.test.ts` builds a schema-12 database by hand, as the case at `:121` does, starts a server on it, and reads `user_version` 13, the new index, and `path: null` on its artifacts. Postgres (CI): `tests/integration/external-storage-runtime.test.ts:274` and `:464` import `requiredPostgresSchemaVersion` and migrate to it, so `0012` runs. `pnpm typecheck` covers all three backends. |
| 3 | `feat(publish): claim a readable path when an artifact is created` | FRK-006 in `tests/conformance/frk-006-artifact-paths.test.ts`. B: an HTTP publish with `/2026/10/release-checklist/` stores `2026/10/release-checklist`, a new version keeps it, and the same idempotency key replays. F: an equal, ancestor, or descendant path is 409. Two concurrent creates of one path give one 201 and one 409. Reserved, folder-shaped, uppercase, empty-segment, and 7-segment paths are 422 with their messages. A path on `new_version` is 422. A host-mode server answers `CapabilityUnavailable`. A deleted artifact frees its path. The FRK-003-F walk gains the reserved-root assertion. CI: a Postgres foundation case in which two processes race for one path. |
| 4 | `feat(http): serve artifacts at their readable paths` | FRK-007 in `tests/conformance/frk-007-artifact-path-serving.test.ts`. B: the entry, a nested asset, and the SPA fallback at the path. A new version at the same URL. `links.artifact` over HTTP and MCP. `/artifacts/:artifactId` answers 302 to the path. The folder URL still serves. The sandbox and CORS headers appear on 200, 206, 304, 404, and HEAD. F: `account_required` is 401. A missing slash is 308 and keeps its query. An unknown path is 404 `NOT_FOUND`. `/api/v1/session` carries no sandbox header. A deleted artifact's path is 404. POST is 405. |
| 5 | `feat(publish): accept a path from the CLI and MCP` | FRK-006-B gains an MCP commit and a spawned CLI `publish --path`, following `callMcpTool` and `publishOverCli` in `tests/conformance/frk-005-public-default.test.ts:192` and `:231`. `--path` together with `--artifact` fails with the guard message. |
| 6 | `docs: document readable artifact paths` | The four docs list `--path` and the MCP field, and every command matches `publish --help`. |

From this commit on, the fork owns migration numbers. Upstream's next migrations will also be Postgres `0012` and SQLite 13. Merging one means renumbering it after the fork's, because deployments will already have applied the fork's `0012`.

### Open decisions

1. Paths are prefix-free. The alternative, nesting with longest-prefix matching, fails silently when a new path hides files.
2. A deleted artifact frees its path. The alternative keeps the claim forever and leaves no way to reuse a path.
3. A path sent to a host-mode server is refused, not stored.
4. An artifact that has a path still answers at its folder URL, with no redirect.

## 12. Home page tree and view analytics

`docs/fork/HOMEPAGE.md` is the design for the home page at `/`: public artifacts as a folder tree built from the readable paths of section 11, plus per-artifact view counts from one three-column table. It follows issue 5 and depends on FRK-006 and FRK-007.

## 13. Asset store

`docs/fork/ASSETS.md` describes the per-artifact asset store: files outside versions, served at `/_blob/<id>`, with an allowlist, per-file caps, and a per-artifact quota. It is phase 1 of issue 19 and covers FRK-018, FRK-019, and FRK-020.

## 14. Viewer bar

`docs/fork/VIEWER.md` describes the bar above an artifact in Review's viewer: where it lives and why artifact code cannot reach it, the info endpoint, the visibility model, who may change visibility, and the logo variables. It follows issue 37 and covers FRK-026 and FRK-028.

## 15. The bar at readable URLs

Most people open an artifact at its readable URL, such as `https://artifacts.example.com/team/plans/some-page/`, not in Review. Before this section, that URL answered with the artifact's page itself at the top level, under the content sandbox of section 4, so it had no bar. This section puts the bar of section 14 above the page at that URL. It covers FRK-029 and FRK-030.

### Constraints

- The bar is application markup. The page stays as isolated as before: an opaque origin, no `allow-same-origin`, no reach into application cookies, storage, or DOM. Nothing is injected into artifact bytes.
- Relative assets, multi-file artifacts, in-page anchors, and both routing modes (`static`, `spa`) keep working.
- Agents, MCP fetches, `curl`, and link previews that send no Fetch Metadata keep reading the page's own bytes at the same URL.
- A private artifact answers exactly as before.
- One person opening the page is one view.

### Options

| | A. Fetch Metadata at the same URL | B. A raw path for the frame | C. A separate viewer route | D. Inject the bar |
| --- | --- | --- | --- | --- |
| Shape | A tab's navigation (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`) gets the viewer. It frames the same URL with `?raw=1`. Everything else gets the page. | The readable URL always answers the viewer for HTML. The frame loads a second prefix, such as `/raw/<path>/` or `/v/<token>/`. | The readable URL redirects a browser to `/view/<path>/`, which frames the readable URL. | The server writes the bar into the artifact's HTML. |
| URL the page sees | Its readable URL plus `raw=1` in the query. | `/raw/<path>/` or `/v/<token>/`. Root-absolute links and SPA base paths written for the readable URL break. A `/v/` frame also pins one version. | Its readable URL. | Its readable URL. |
| Non-browser clients | Unchanged. They send no `Sec-Fetch-Dest: document`. A previewer that drives a real browser tab gets the viewer, titled by script. | A client that fetches HTML gets the viewer unless it learns the raw prefix. | A client that follows redirects lands on the viewer page. | Every client gets changed bytes. |
| Address bar | The readable URL. | The readable URL. | `/view/...`, which is a new URL to share. | The readable URL. |
| Isolation | Unchanged for the page. The viewer is a normal application page. | Unchanged. | Unchanged. | Broken. The bar would run inside the sandboxed document, so artifact code could restyle or fake it. |
| New surface | One branch in the content router and one query parameter. | A new reserved root and a second content form. | A new reserved root and a redirect. | An HTML rewriter. |

**Decision: A.** It is the only option that keeps the URL a person shares, the URL the page sees, and the bytes an agent reads all unchanged. B changes what the page sees and needs a new reserved root. C changes the shared URL. D breaks the isolation rule.

The frame cannot load the same URL as the viewer. The HTML Standard skips an iframe whose URL, ignoring the fragment, equals the URL of its document or an ancestor's ("shared attribute processing steps for iframe and frame elements"). `?raw=1` makes the frame's URL different. It also gives a person a way to open the page alone, which the menu calls **Open raw**.

### Routing

`readableDelivery` in `src/http/same-host-content.ts` is the one pure decision. It runs only for the folder and path forms, after the router has resolved the artifact and the file, so an unknown path, a missing file, and a private artifact answer exactly as they did.

| Request at a readable URL | Answer |
| --- | --- |
| GET, `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, an HTML file, no `raw=1` | The viewer (`viewer.html`). |
| The same with `raw=1` | The page. |
| `Sec-Fetch-Dest: iframe` (the viewer's frame, or any other site's frame) | The page. |
| No Fetch Metadata (`curl`, agents, MCP fetches, link previews, browsers that predate Fetch Metadata) | The page. |
| `fetch()`, scripts, images, styles, HEAD | The page or file, as before. |
| A file that is not HTML, opened in a tab | The file, as before. |
| A private artifact | 401 `CONTENT_NOT_PUBLIC`, as before. |
| An unknown path or a missing file | 404, as before. |
| `/v/<token>/` | The page. The exact version URL never shows a viewer. |
| A server without `viewer.html` in its web bundle | The page. |

The SPA fallback (`permitsSpaEntryFallback`) used to accept only `Sec-Fetch-Dest: document`. A client route opened in the viewer is now a frame navigation, so it also accepts `iframe` and `frame`. This holds for every content form, `/v/<token>/`, content-domain hosts, and Review leases included, so any site that frames an SPA artifact's client route now gets its entry page, and that load counts as a view.

### Headers

| Response | `Content-Security-Policy` | `Access-Control-Allow-Origin` | `Vary` | `Cache-Control` |
| --- | --- | --- | --- | --- |
| Viewer | The application pages' policy, including `frame-ancestors 'none'` and `script-src 'self'`. No `sandbox`. | none | `Sec-Fetch-Dest, Sec-Fetch-Mode` | `no-cache, must-revalidate` |
| HTML page at a readable URL | The content sandbox, unchanged | `*` | `Sec-Fetch-Dest, Sec-Fetch-Mode` | Unchanged |
| Any other content | Unchanged | Unchanged | Unchanged | Unchanged |

The viewer also sends `X-Robots-Tag: noindex, nofollow`. The isolation wrapper still adds the sandbox to every content response. It skips only a response that the viewer branch marked, and only that branch sets the mark. A test that removes the skip fails, and so does a test that widens it to other readable responses.

`Vary` matters because one URL now has two bodies. Without it, a shared cache could hand the viewer to a frame, which would nest the bar, or hand the page to a tab, which would drop it. The two bodies also carry different ETags, so a tab that revalidates a page it cached before this change gets the viewer with a 200, and a frame that sends the viewer's ETag gets the page.

### The frame

The viewer frames the same path, query, and fragment with `raw=1` set in the query. The frame keeps the readable path, so relative URLs, root-absolute URLs written for the readable path, in-page anchors, and SPA routes resolve as they do at the top level. The frame element repeats the content policy's flags in its `sandbox` attribute, so the page stays sandboxed even if a response arrived without the header. It grants `allow="fullscreen; clipboard-write"`, which a top-level page already had.

The viewer adds no `message` listener. The page can post messages to it, and nothing reads them.

### Views

The viewer branch returns before `artifactViews.record`, so the viewer's own response counts nothing. The frame's request is an entry-document GET and counts once, through the existing rule of FRK-008. A person who opens the page therefore adds one view, whether they use the viewer, `?raw=1`, or `curl`.

### Info for anonymous readers

The bar needs the artifact's name and info without a credential. `GET /api/v1/public/artifact-info?path=<pathname>` takes the page's own path and runs the same classifier and resolver as the content router (FRK-030). It answers with the info shape of section 14, `canManage: false`, and the artifact's `projectId`. A private artifact, an unknown path, an application path, and any path on a content-domain server answer the same 404 `ARTIFACT_NOT_FOUND`, so this route never says whether a private artifact exists. The content route at the same path still answers 401 for a private artifact and 404 for a missing one, as it did before. `ProjectAnalyticsService.readPublicArtifactActivity` reads the views and refuses any artifact that is not `public_link`.

A browser that holds a session (its CSRF cookie is readable) also reads `/api/v1/session` and `GET /api/v1/artifacts/:id?projectId=...`. With that record the popover shows the visibility control of section 14 when `canManageArtifact` holds, and the menu adds **Open in Review**. Until that record arrives, the popover shows the public info. If either read fails, the reader sees what an anonymous reader sees. An anonymous browser never makes those calls.

### What changes for artifacts

| Change | Why | Escape |
| --- | --- | --- |
| `location.search` carries `raw=1` | The frame's URL must differ from the viewer's. The viewer sets the parameter, so an existing `raw` value is replaced. | None needed for most pages. |
| `target=_top` links do nothing in the viewer | The content policy grants no top navigation, and this section does not widen it. | **Open raw**. |
| The address bar keeps the first URL while the page navigates inside the frame | The viewer cannot read an opaque frame's location. | **Open raw**, or copy the link inside the page. |
| A page that checks `window.top === window` sees a frame | It is one. | **Open raw**. |

### Residual risk

The viewer is an application page with the person's session cookies, and it embeds untrusted HTML. Before, that HTML ran at the top level with no application page around it. The opaque origin keeps the page out of the viewer's DOM, cookies, and storage. FRK-029-B proves in Chromium that `window.parent.document` throws. A browser bug that let a sandboxed frame reach its parent would now reach an application page. Section 4 already accepts the same bug class for the top-level page.

## Decisions

All seven open decisions from revision 1 are settled:

1. Folder shape is `<name-slug>-<uuid>`.
2. Without login, new artifacts default to `public_link` in HTTP, MCP, and CLI. On a local-owner server, the default stays `account_required` (section 5).
3. A private version opened in its own tab returns `CapabilityUnavailable`.
4. One shared API key is accepted for now (section 5).
5. Both added sandbox flags stay.
6. The image is `linux/amd64` only.
7. Fork Actions settings and GHCR visibility are operator steps (section 10).
