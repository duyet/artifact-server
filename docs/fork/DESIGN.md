# Same-host fork design

This fork runs one internal Artifact Server in upstream external-storage mode on Kubernetes 1.33 behind ingress-nginx on a VPN. The pods are stateless. Metadata lives in a dedicated database in an existing CloudNativePG cluster (PostgreSQL 18.1), and bytes live in the bucket `artifact-server` on an existing Versity S3 gateway (`versitygw` 1.4.1, `posix` backend, plain HTTP, path-style). Artifacts are served from the application host at readable paths. Viewers never log in, and publishers use one API key. The base is upstream `v0.1.2` (`5af28ac`).

The fork is a public repository, so deployment values stay in the deployment repository. This document uses `artifacts.example.internal` for the application host and `http://s3.example.internal:7070` for the S3 gateway.

This is revision 2 of a proposal. It replaces compact mode with external storage (brief r2). Compact mode gets the same path mode and no-login mode at no extra cost. Nothing below is implemented.

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
3. `live-…` goes to `serveLiveContent`. Linked sources work only on loopback.
4. Any other label goes to `serveVersionContent` (`:3422`).

`serveVersionContent` turns the URL path into a manifest path (`manifestPathFromUrl`, `src/manifest/create-manifest.ts:73`) and calls `ContentAccessService.authorizeVersionContent` (`src/application/content-access.ts:357`). The repository maps (token, path) to one manifest entry. The service allows the read if the artifact is `public_link` and the version is current (`:367`). Otherwise it needs a content-session cookie bound to that token (`:373`). `serveStoredVersionContent` streams the blob (`src/http/create-http-app.ts:3501`). Content responses carry no CSP. The separate origin is the only isolation.

### Where the content domain is used

- Both server parsers require `ARTIFACT_SERVER_CONTENT_DOMAIN`, compact at `src/lifecycle/runtime-configuration.ts:230` and external storage at `:282`. The external parser also serves `maintenance cleanup-staging` (`src/cli/lifecycle-commands.ts:123`).
- Both parsers then call `assertBrowserIsolation` (`:835`). After the HTTPS checks, it compares the tldts `getDomain()` result for the application host and for the content domain (`:866`). Equal or unknown registrable domains fail with `invalid_origin` (`:873`).
- The value passes unchanged through the runtime configs (`src/local/create-local-runtime.ts:89`, `src/external-storage/create-external-storage-runtime.ts:76`) into `HttpAppDependencies.contentDomain` (`src/http/create-http-app.ts:478`, 18 uses) and the MCP server (`src/mcp/artifact-mcp-server.ts:379`, 12 uses). Almost every use is an argument to one of the four builders.
- The Review frame CSP allows scripts, styles, and `connect-src` only from `*.<contentDomain>` (`reviewFrameContentSecurityPolicy`, `src/http/create-http-app.ts:4011`).
- The upstream chart routes a wildcard host with its own TLS secret (`packaging/helm/artifact-server/templates/ingress.yaml:22`, `:36`).
- The ledger encodes it in CNT-003, CNT-004, CNT-005, AUTH-010 to AUTH-014, CMT-013, DEP-014, and DEP-016 (`project/spec/conformance.yml:847` onward).

## 2. Storage on Versity

Versity compatibility is the riskiest assumption, so it is proved first, in commit 2, before any feature work.

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
3. **Gateway filesystem.** The directory behind the posix backend must support `user.` extended attributes. If it is NFS without them, the gateway needs `--sidecar`. Section 7 depends on this too.

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
- With no identity provider (section 5), the browser holds no session or CSRF cookie at all.

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
| A private (`account_required`) version opened in its own tab | An opaque document's subresource requests never carry the content-session cookie, so the bootstrap flow cannot work. Path mode answers it with `CapabilityUnavailable`. Review still shows private versions, because lease URLs carry the credential. | Only with OIDC. |
| A page loaded during a publish | The folder serves the current version. A publish between the HTML load and a subresource load can mix two versions. A publish between resolving the folder and serving it can answer 401 once. Upstream redirects to an immutable origin instead. | A reload fixes it. |

### Residual risk

Upstream isolates top-level content twice, with a separate registrable domain and with a per-version origin. Path mode has one layer, the CSP sandbox. If a browser bug let artifact code escape it while OIDC is on, that code could act as the viewer. With no identity provider, the browser holds no credential to take. Current Chromium, Firefox, and WebKit implement CSP `sandbox` (inferred, not tested here). The Phase 2 browser test runs in Chromium only, because `playwright.config.ts` defines no other project.

## 5. No-login mode

### Today

- Both server modes refuse to start without a browser login provider. They throw "A private-team server requires exactly one OIDC or WorkOS browser-login provider." External storage throws at `src/cli/lifecycle-commands.ts:323` and again in `startExternalStorageServer` (`src/external-storage/start-external-storage-server.ts:41`). Compact throws at `src/cli/lifecycle-commands.ts:394` and in `startLocalServer` (`src/local/start-local-server.ts:38`). `config check` throws too (`src/cli/lifecycle-commands.ts:535`).
- Two tests pin the guard (`tests/cli/lifecycle-cli.test.ts:110`, `tests/conformance/installation-identity.test.ts:457`), and so does AUTH-025 (`project/spec/conformance.yml:1663`).
- `maintenance cleanup-staging` loads no provider (`src/cli/lifecycle-commands.ts:490`), so it already runs without one.
- Viewing already needs no login for the current version of a public-link artifact (`src/application/content-access.ts:367`).
- `/api/*` and `/mcp` already accept the API key as a bearer token (`src/http/create-http-app.ts:800`).
- The default access setting is `account_required` in HTTP (`src/http/create-http-app.ts:192`), in MCP (`src/mcp/artifact-mcp-server.ts:1250`), and in the CLI, which sends the value explicitly (`src/cli/publish-command.ts:162`, `:167`).

### Change

1. Add the browser login kind `none` to `BrowserAccess` (`src/core/browser-access.ts:21`). Both server modes use `{mode: "private_team", loginKind: "none"}` when neither OIDC nor WorkOS is configured, instead of throwing. The two start guards accept it. `/auth/context` reports `none`. `/auth/login` already answers 404 `InteractiveLoginUnavailable` without a provider.
2. The Review sign-in gate (`apps/web/src/review/review-app.tsx:458`) shows that browser sign-in is off instead of a dead **Sign in** button. The client schema at `apps/web/src/api/client.ts:83` accepts `none`.
3. With login kind `none`, `GET /review?artifact=<id>…` redirects to `/artifacts/<id>`, which redirects to the folder. MCP tells agents to hand users the Review URL (`src/mcp/artifact-mcp-server.ts:1244`, `:2334`). Without this redirect, every link an agent shares would end at a sign-in page.
4. With login kind `none`, new artifacts default to `public_link`. One function, `defaultAccessSetting(browserAccess)` in `src/core/browser-access.ts`, owns the rule. It returns `public_link` for `none` and `account_required` otherwise.
   - HTTP: the commit schema (`src/http/create-http-app.ts:192`) makes `accessSetting` optional, and the commit route (`:2224`) fills in the default.
   - MCP: `McpHttpAdapterDependencies` and `ArtifactMcpServerDependencies` gain `defaultAccessSetting`, which `createHttpApp` sets. The commit tool schema (`src/mcp/artifact-mcp-server.ts:1250`) defaults to it.
   - CLI: `publish` sends `accessSetting` only with `--public` (`src/cli/publish-command.ts:162`, `:167`), and `FilePublicationTarget.accessSetting` becomes optional (`src/client/file-publication-client.ts:189`). The server then applies its own default. Against a server with login on, the result is `account_required`, as before.
   - The publish input digest includes the resolved setting (`src/application/publish-artifact.ts:232`), so retries on one server stay idempotent.

With OIDC configured, both modes keep upstream login, Review, comments, members, and key administration, and the default stays `account_required`. Review previews work through `/v/review-…` leases with no extra code. Opening a private version in its own tab does not work (section 4).

### The API key in external storage

The key comes from the runtime Secret as `ARTIFACT_SERVER_API_TOKEN_FILE` (`packaging/helm/artifact-server/templates/_helpers.tpl:142`). Its format is `as_key_key_<hex id>_<base64url secret>` (`src/core/installation-identity.ts:8`). Every serving start and every cleanup run calls `ensureBootstrapManagedApiKey` (`src/external-storage/create-external-storage-runtime.ts:154`). The first start registers the key with all capabilities. Later startups require the same key. A different key ID fails once any member or key exists (`src/storage/postgres-identity-repository.ts:412`), and a different secret under the same ID fails the digest check (`src/application/bootstrap-managed-api-key.ts:61`). Editing the Secret after the first start therefore crashes every pod and every cleanup run.

Issuing, rotating, or revoking keys needs a human administrator (`src/application/installation-access.ts:797`), and an administrator needs browser login. Without login, all publishers share this one key. This is accepted for now.

`ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL` stays required in external storage (`src/lifecycle/runtime-configuration.ts:304`), even without login.

## 6. Helm chart

### Patch the upstream chart

The fork patches `packaging/helm/artifact-server` (1,240 lines) instead of adding a chart. The patch touches about 40 chart lines plus about 25 README lines (counted from the files). A new chart would copy most of the 1,240 lines and then delete the same content-domain and provider paths.

Both the content domain and the identity provider become optional. Values that set them render exactly as upstream, so the upstream render and kind tests keep passing.

| File | Change |
| --- | --- |
| `Chart.yaml:7` | `kubeVersion` becomes `">=1.33.0-0 <1.37.0-0"`. The templates use only `apps/v1`, `batch/v1`, `networking.k8s.io/v1`, `policy/v1`, and `v1`, which 1.33 serves. |
| `values.schema.json:75` | `configuration.contentDomain` accepts `""`, in the same `oneOf` form that `s3.endpoint` uses (`:88`). |
| `values.schema.json:234` | No change. `ingress.contentTlsSecretName` is already a plain string that accepts `""`. |
| `templates/_helpers.tpl:80` | Delete the rule that requires exactly one browser-login provider. The partial-configuration rules for OIDC and WorkOS (`:63` to `:79`) stay. |
| `templates/_helpers.tpl:111` | Require `ingress.contentTlsSecretName` only when `configuration.contentDomain` is set. |
| `templates/_helpers.tpl:146` | Emit `ARTIFACT_SERVER_CONTENT_DOMAIN` only when it is set. The runtime treats an empty value as missing (`src/lifecycle/runtime-configuration.ts:655`). |
| `templates/ingress.yaml:22`, `:36` | Render the wildcard TLS entry and the wildcard rule only when `configuration.contentDomain` is set. The application rule already routes `path: /` with `pathType: Prefix` (`:26`), so path-mode content needs nothing more. |
| `templates/NOTES.txt:15` | Print the content line only when a content domain is set. |
| `templates/cleanup-cronjob.yaml:25` | Add `enableServiceLinks: false`. The CronJob passes no `--port` (`:38`), and a Service named `artifact-server` injects `ARTIFACT_SERVER_PORT=tcp://…`, which `portOption` reads (`src/cli/lifecycle-commands.ts:570`) and `parsePort` rejects. This is a latent upstream bug (inferred, not run). The Deployment already passes `--port 8787` (`deployment.yaml:77`). |
| `README.md` | Kubernetes 1.33 to 1.36, one host with one TLS secret, no identity provider, `s3.endpoint` and `s3.forcePathStyle`, egress to the S3 port, and the ingress annotations for uploads. |

These need no change:
- `s3.endpoint` accepts `http://` in both the schema (`values.schema.json:88`) and the runtime (`src/lifecycle/runtime-configuration.ts:791`). The runtime accepts any region string (`:471`), but the gateway does not (section 2). MinIO over plain HTTP with path-style is already proved (`tests/release/helm-chart.test.ts:590`).
- `templates/migration-job.yaml` needs only the database URL and the installation ID.
- `templates/deployment.yaml`, `networkpolicy.yaml`, and `tests/ready.yaml` need no change either. Egress rules come from values.

Outside the chart:
- `project/spec/decisions/0013-kubernetes-helm-release.md:12` to `:17` and `:83` add 1.33 to the window, and `:39` makes the wildcard host optional. The ADR asks for the window to move deliberately, and this is that change.
- `scripts/verify-helm-chart.sh:24` adds `1.33.0` to the render loop. `:84` to `:87` expect the no-provider render to fail, so the fork deletes that case. It adds a render case with no content domain and no provider, which asserts one ingress host and no `ARTIFACT_SERVER_CONTENT_DOMAIN`.
- `scripts/check-release-version.mjs:8` and `:99` pin `values.yaml` to `ghcr.io/plannotator/artifact-server`. The fork leaves `values.yaml` alone, and the release workflow writes the fork image into the packaged chart (section 8).

### Values the deployment sets

- `configuration.applicationOrigin` (`https://artifacts.example.internal`), `installationId`, `bootstrapAdministratorEmail`. Leave `contentDomain` empty.
- `configuration.s3`: `bucket: artifact-server`, `endpoint: http://s3.example.internal:7070`, `forcePathStyle: true`, and `region` equal to the gateway's `--region` (`us-east-1` unless the gateway sets another). Set `secret.keys.s3AccessKeyId` and `s3SecretAccessKey`, because Versity needs static keys.
- `ingress.applicationTlsSecretName` is the existing wildcard secret. Leave `contentTlsSecretName` empty. Set `ingress.annotations` to `nginx.ingress.kubernetes.io/proxy-body-size: "0"` and `proxy-request-buffering: "off"`, because upload `PUT`s have no application size limit and ingress-nginx defaults to 1 MiB.
- Postgres connection budget. The chart checks `postgresConnectionBudget` (default 22) against 2 replicas × `postgresPoolSize` 10 plus the migration and cleanup jobs (`templates/_helpers.tpl:87`). A rolling update with `maxSurge: 1` (`templates/deployment.yaml:17`) briefly runs a third pod. Give the CloudNativePG role a connection limit of at least 32.

## 7. Backup

Backup moves to the deployment repository. The fork ships no backup job.

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

"No downtime" is a new claim. Every upstream procedure stops the application first (`packaging/compose/README.md:303`, ADR 0012), and the restore qualification scales to zero before its snapshot (`scripts/run-aws-coordinated-restore-qualification.sh:245`). The deployment repository owns the first online drill. Its pass criterion is a healthy `integrity check` on the restored pair.

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
| 10 | `feat(auth): start without a browser login provider` | FRK-004 test for both modes: start with no provider, `/auth/context` reports `none`, `/auth/login` returns 404, `/review?artifact=` redirects, and bearer publish works. Update the two AUTH-025 tests. `pnpm --filter @artifact-server/web typecheck`. |
| 11 | `feat(publish): default to public links without login` | FRK-005 test: with login `none`, HTTP, MCP, and CLI publishes without a setting produce `public_link`. With OIDC, they produce `account_required`. `--public` still works against both. |
| 12 | `feat(helm): install on Kubernetes 1.33 without a content domain or login` | `pnpm verify:helm-static` with 1.33 and the new no-domain, no-provider case. The upstream kind test (`pnpm test:helm`, CI) still passes with its content domain and OIDC values. |
| 13 | `ci(fork): publish the image and chart on fork tags` | `zizmor` and `actionlint` on the workflow, then the first tag `v0.1.2-fork.1`: both digests in the summary, and `helm template` of the pulled chart shows the image digest. |
| 14 | `docs(fork): add the operator runbook` | It holds the operator steps below and the values of section 6. Every command matches the chart. |

As built, three things differ from this table. Commit 3 was not needed, because the Versity contract test passed in CI. The Review frame CSP of commit 8 landed in commit 5, because widening the content domain type forces it. The Versity commit landed after commit 4 in history.

The fork deviates from these ledger entries in path mode: CNT-004 and CNT-005 (per-version origins), DEP-014-F and DEP-016-B (path-only content as the isolation boundary), and AUTH-025 (start without a provider). The ledger entries for commits 5 to 12 say so. DEP-006 (stateless Kubernetes replicas) holds again.

## 10. Operator steps

The runbook lists these steps. Each one is a setting outside the repository:

1. In the fork's Actions settings, disable upstream `release.yml`. It fires on `v*` tags and pushes to `ghcr.io/plannotator`, which fails on the fork.
2. After the first release, make the `artifact-server` image and chart packages on GHCR public, or give the cluster an image pull secret. The first push to GHCR is private.
3. Create the bucket `artifact-server` on the gateway and an access key limited to it.
4. Create the database and role in the CloudNativePG cluster, with a connection limit of at least 32.
5. Generate the API key once, for example `printf 'as_key_key_%s_%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)"` (`packaging/compose/README.md:201`), and store it in the runtime Secret. Never change it after the first start.
6. Pick a stable `installationId`. It names the bucket prefix forever.
7. Allow egress from the pods to the gateway port and to Postgres.
8. Confirm the gateway's `--region` and set `configuration.s3.region` to it.
9. Confirm that the gateway's posix directory supports `user.` extended attributes, or that the gateway runs with `--sidecar`. Note whether it is ext4, because one file then caps near 11 GiB (section 2).
10. Run commit 2's contract test once against the real gateway, with a key that may create the throwaway bucket `artifact-server-integration`. Delete that bucket afterward.

## Decisions

All seven open decisions from revision 1 are settled:

1. Folder shape is `<name-slug>-<uuid>`.
2. Without login, new artifacts default to `public_link` in HTTP, MCP, and CLI. With login, the default stays `account_required` (section 5).
3. A private version opened in its own tab returns `CapabilityUnavailable`.
4. One shared API key is accepted for now (section 5).
5. Both added sandbox flags stay.
6. The image is `linux/amd64` only.
7. Fork Actions settings and GHCR visibility are operator steps (section 10).
