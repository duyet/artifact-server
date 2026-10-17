# Simplify the fork

This is a proposal. Nothing here is deleted yet. The coordinator reviews it before the deletion PRs start.

The operator's goal: "keep simplify the artifact server codebase". Upstream parity is no longer a goal. The fork is built for one deployment:

- One Kubernetes pod in compact mode (SQLite and files on NFS), path mode on one host, no browser identity provider.
- Anonymous viewers on a VPN open shared links. Agents publish over MCP and the CLI with one API key.
- Artifacts have readable paths like `/2026/10/agent-console/`.
- No Postgres, S3, Azure, GCS, Cloudflare, OIDC, or WorkOS is in use.

All line counts come from `wc -l` on tracked files at `origin/main` (`748e704`).

## 0. A conflict to settle first

The brief says the pod runs compact mode on NFS. The repository says otherwise:

- `docs/fork/DESIGN.md:7` says revision 2 "replaces compact mode with external storage".
- `docs/fork/RUNBOOK.md` installs the Helm chart against CloudNativePG and a Versity S3 gateway.
- The chart only runs external storage. `packaging/helm/artifact-server/templates/deployment.yaml:74` hard-codes `start-external-storage`. `values.yaml` has only Postgres and S3 settings and no volume claim.

So the compact pod must come from manifests in the deployment repository, not from this chart. This proposal treats the brief as the truth. The coordinator should confirm which mode the SG pod runs before PR 8. The earlier PRs do not depend on the answer.

## 1. Release tags (ask 1)

PR #6 (`ci/plain-semver-releases`) does this:

- `fork-release.yml` is renamed **Release**. It triggers on `v*.*.*` and accepts only `v<major>.<minor>.<patch>`. A `v0.2.0` tag publishes `ghcr.io/duyet/artifact-server:0.2.0` and chart `0.2.0`, with `appVersion` `0.2.0`.
- The job summary keeps the image digest and the chart digest.
- Upstream `release.yml` is deleted. It fired on every `v*` tag and pushed to `ghcr.io/plannotator`. `gh workflow list` still showed it active.
- The runbook drops the manual "disable release.yml" step.

## 2. What to delete (ask 2)

"Depends on it" lists code outside the candidate. "Tests" lists what goes with it.

| # | Candidate | What it is | Lines | Still depends on it | Tests and ledger | Risk | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | `deploy/cloudflare` | Cloudflare Worker deployment | 14,169 | `pnpm-workspace.yaml:3`, `package.json` `check`, `check:cloudflare*`, `qualify:cloudflare*`, `ci.yml:165-195` (job `cloudflare`), `.oxlintrc.json:14`, `tsconfig.json:35`, lint ignore, `README.md`, `docs/deployment.md` | Its own 11 test files | Low | Delete |
| D2 | `deploy/pulumi/aws`, `deploy/pulumi/gcp` | Pulumi stacks | 2,434 + 1,601 | `pnpm-workspace.yaml:4`, `test:aws-pulumi` and `test:gcp-pulumi` inside `verify:iteration`, `ci.yml:77,84`, `scripts/check-ci-full-gate.mjs` | Their own tests; `project/evidence/{aws,gcp}-pulumi.json` | Medium. `verify:iteration`, `ci.yml`, and the full-gate check must change together. | Delete |
| D3 | `src/deployment/` | Cloud deployment contract and evidence | 883 | No importer in `src/`. Only D1 and D2 use it. | `tests/deployment/cloud-deployment-contract.test.ts` (430). `tests/release/helm-chart.test.ts` mentions it; check before deleting. | Low | Delete with D1 and D2 |
| D4 | Cloud qualification scripts | `run-aws-*` (8), `run-gcp-*` (4), `qualify-*` (4), `purge-cloudflare-artifacts.ts`, `create-deployed-abandoned-upload.ts` | about 3,018 | `package.json` `qualify:*` and `purge:*` scripts | None | Low | Delete with D1 and D2 |
| D5 | `packaging/compose` | Docker Compose for compact and external storage | 682 | `test:compact-compose`, `test:external-storage-compose` in `ci.yml` and `verify:iteration` | `tests/release/compact-compose.test.ts` (829), `external-storage-compose.test.ts` (870), `scripts/run-*-compose-integration.sh` | Low. Compact backup and restore scripts live here (`compact-backup.sh`, `compact-restore.sh`); port them into the runbook first if the operator uses them. | Delete |
| D6 | `packaging/local` | npm launcher scripts | 7 (plus `scripts/build-local-package.sh`, 101) | `package:local`, `test:local-package` in `verify:iteration` | `tests/release/local-package.test.ts` (610) | Low. Keep `scripts/local-package-metadata.mjs`, because the Dockerfile copies it (`packaging/oci/Dockerfile:24`). | Delete |
| D7 | `apps/site` and marketing docs | Astro docs site, social cards, `docs/cloudflare-artifacts.md`, `docs/deployment.md` | 14,139 + about 3,500 | `pnpm-workspace.yaml` (`apps/*`), `build:site`, `dev:site`, `typecheck:site`, `verify:site` inside `check`, `ci.yml:71`, ADR 0027 | None | Low | Delete. Keep `docs/mcp.md`, `docs/cli.md`, `docs/agent-bridge-protocol.md`, `docs/fork/*`. Rewrite `README.md` links (lines 21, 101-106, 118-123). |
| D8 | Upstream release path | `install-verify.yml` (332) and the scripts only `release.yml` used: `assemble-release-assets`, `check-release-ref`, `extract-oci-sboms`, `generate-release-sboms`, `install-release-syft`, `build-oci-image`, `oci-image-metadata` | about 1,100 | `check-release-version.mjs` runs inside `check`, so it stays or is rewritten to check the fork's own version | None | Low | Delete after PR #6 |
| D9 | Azure and GCS adapters | `src/storage/azure-blob-object-storage.ts`, `gcs-object-storage.ts` | 488 + 277 | `src/lifecycle/runtime-configuration.ts:20-31` | `tests/integration/azure-blob-object-storage.test.ts` (56), `gcs-object-storage.test.ts` (51), `aws-s3-object-storage.probe.test.ts` (124), `scripts/run-native-cloud-storage-integration.sh`; deps `@azure/identity`, `@azure/storage-blob`, `@google-cloud/storage` | Low | Delete |
| D10 | OIDC and WorkOS | `src/identity/*` (1,396), `src/cli/oidc-configuration.ts` (111), `workos-configuration.ts` (70), the provider wiring in `lifecycle-commands.ts` (about 120 lines) | about 1,700 | `lifecycle-commands.ts:15-21,55-58`. `InteractiveLoginService` (`src/application/interactive-login.ts`) is generic and stays until D10 lands. | `oidc-keycloak.test.ts` (733), `oidc-mcp-authorization.test.ts` (552), `workos-mcp-authorization.test.ts` (351), `auth-019/020/021*.test.ts` (929), `tests/support/stub-oidc-provider.ts` (405); ledger AUTH-019, AUTH-020, AUTH-021, MCP-013; deps `@workos-inc/node`, `jose` | Medium. `src/cli/cli-auth-commands.ts` (362) and `cli-oauth-client.ts` (484) feed `cli-server-connection.ts:8`. Keep the API-key profile path and delete only the OAuth device flow. `tests/conformance/frk-004-no-login.test.ts` stays. | Delete after issue #4 lands, because API-key sign-in replaces the browser login |
| D11 | Git history (Cloudflare Artifacts) | `src/git-history/*` (1,997), `project-git-history.ts`, `git-history-access.ts`, `git-history-commands.ts`, the SQLite store | about 2,970 | About 132 references: `sqlite-artifact-repository.ts` (61), `create-http-app.ts:1565-1627` (routes), MCP tools `project_set_git_history`, `project_git_history_status`, `project_git_history_estimate`, `artifact_history_clone_token`, `create-local-*`, `main.ts` | About 5,500 test lines; ledger GIT-001 to GIT-014, SCP-004, GATE-004; deps `isomorphic-git`, `memfs` | High. It removes public HTTP, MCP, and CLI surface and touches SQLite tables. The only provider is Cloudflare Artifacts, so the feature is off here (`disabledGitHistoryCapability`, `create-http-app.ts:564`). | Delete, but last, as its own PR, after the coordinator agrees to drop the MCP tools |
| D12 | External storage (Postgres and S3) | `src/external-storage/*`, `src/storage/postgres-*`, `s3-object-storage.ts`, `cloud-object-storage.ts`, `object-storage-provider.ts` | about 7,700 in its own files, plus about 820 in shared files (`lifecycle-commands.ts` about 230, `runtime-configuration.ts` about 400, `integrity-check.ts` about 140, `runtime-inspection.ts`, `git-history-commands.ts` about 50) | The Helm chart (only mode it runs), `fork-ci.yml` (Versity and external-storage runtime jobs), `fork-release.yml` chart lint values, `RUNBOOK.md`, `AGENTS.md` gate list, `verify:iteration` | `external-storage-runtime.test.ts` (3,457), `s3-object-storage.test.ts` (425), `frk-000-versity-s3.test.ts` (157), and more, about 6,900 in all; ledger FRK-000, DEP-011, DEP-020, DEP-022, PUB-011, OPS-001; deps `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@effect/sql-pg` | High | **Keep for now.** See below. |

### Keep, and why

- **External storage (D12).** It is the only migration path off SQLite on NFS. SQLite on NFS is fragile: file locking over NFS is a known source of corruption, and the deployment cannot run two pods. The Helm chart and runbook in this repository also run only this mode. Delete it only when (1) the coordinator confirms the pod runs compact mode, (2) the operator accepts one pod on NFS as the long-term shape, and (3) the chart gains a compact mode (a `PersistentVolumeClaim` and `start` instead of `start-external-storage`) or the deployment repository keeps its own manifests. Until then, Postgres and S3 stay and keep their CI jobs.
- **Helm chart** (`packaging/helm/artifact-server`, 1,308 lines). `fork-release.yml` packages and pushes it, and `fork-ci.yml:47` checks it.
- **OCI image** (`packaging/oci/Dockerfile`, 73 lines) and `tests/release/oci-image.test.ts`.
- **Linked artifacts** (`src/local/linked-source-engine.ts`, `src/application/linked-artifacts.ts`, `src/cli/link-command.ts`, 1,595 lines). It is part of the compact server and off by default (`ARTIFACT_SERVER_LINKED_FILES=off`). Agents can use it from a laptop. Not worth the churn.
- **The conformance ledger.** It stays, but every deletion PR prunes the requirement IDs and the `deployments` sets it removes. 192 of 308 requirements list all six deployments (local, single_server, kubernetes, cloudflare, aws, gcp). After D1 and D2 the set becomes local, single_server, kubernetes.

### Size of the change

| Group | Lines removed (code plus tests, about) |
| --- | --- |
| D1 to D4 (cloud deploy) | 22,500 |
| D5 to D8 (packaging, site, upstream release) | 22,000 |
| D9 (Azure, GCS) | 1,000 |
| D10 (OIDC, WorkOS) | 5,000 |
| D11 (git history) | 8,500 |
| Total without D12 | about 59,000 |
| D12, if approved later | about 15,400 more |

For scale, `src/` is 51,371 lines and `tests/` is 53,082. `deploy/` and `apps/site` add about 32,000.

## 3. UI for viewers and publishers (ask 3)

### Today

- `GET /` redirects to `/review` (`src/http/create-http-app.ts:842`). With no identity provider and no session, the Review app shows "Browser sign-in is off" and nothing else (`apps/web/src/review/review-app.tsx:462`). A viewer who lands on the host has no way to find anything.
- Every `/api/*` route needs a key or a session (`create-http-app.ts:873-925`). The public-link inventory needs an administrator (`src/application/public-link-administration.ts:150`). No anonymous listing exists.
- Artifacts are served raw at their paths, in a `Content-Security-Policy: sandbox` response with no header bar (`src/http/same-host-content.ts:208-217`).
- An artifact has a `name` and a `path`, but no stored title and no updated time. The version has `createdAt` (`src/core/model.ts:68-81`, `:182-193`).
- The Review app defaults to dark and ignores `prefers-color-scheme` (`apps/web/src/review/main.tsx:14-18`).

### Proposed changes, smallest first

1. **API-key sign-in** (issue #4, in progress). The operator gets the workbench from a browser. The form only appears for login kind `none`.
2. **A public catalog at `/`.** For login kind `none` only. A signed-in browser still goes to `/review`.
   - It is a server-rendered HTML page with no JavaScript, so it works without the SPA and under the existing `default-src 'self'` policy.
   - The data comes from one new repository query: current `public_link` artifacts with a path, with `name`, `path`, and the current version's `createdAt`. It is sorted by path, then newest first.
   - Artifacts are grouped by their folders. The first two path segments are the group (`2026/10`). Folders newest first.
   - An artifact without a path is listed under "Other" by its `/artifacts/<id>` link.
3. **Folder pages.** `GET /2026/` and `GET /2026/10/` render the same list filtered to that prefix when no artifact owns that exact path. Today they return a JSON 404. Each folder page has a breadcrumb (`Artifacts / 2026 / 10`).
4. **Back to the folder.** Content is not modified, because injected markup would change immutable bytes and their ETags. Instead, the folder pages and the catalog are the navigation, and the 404 for a missing path inside a folder links to its nearest folder page.
5. **Titles.** The list shows `name` as the title and the last path segment under it in a monospace font, so `agent-console` and "Agent console" both read clearly. Reading `<title>` at publish time is left out for now; `name` is already set by every publisher.
6. **Themes.** The catalog and folder pages follow `prefers-color-scheme` through the same tokens as the Review app (`apps/web/src/theme-tokens.css`). The Review app starts from `prefers-color-scheme` when nothing is stored, instead of always dark.

### Mockups

Catalog at `/`, phone width and desktop share one column, max 720px:

```
Artifacts                                   [Sign in]
29 shared reports

2026 / 10
  Agent console                                 Oct 16
  /2026/10/agent-console/
  Weekly ClickHouse report                      Oct 14
  /2026/10/clickhouse-weekly/

2026 / 09
  ...

Other
  Untitled draft                                Sep 02
```

Folder page at `/2026/10/`:

```
Artifacts / 2026 / 10
  Agent console                                 Oct 16
  /2026/10/agent-console/
  ...
```

Sign-in gate in the Review app for login kind `none`:

```
Sign in with an API key
[ ••••••••••••••••••••••••• ]  [Sign in]
The key stays in this form. It is never saved in the browser.
Shared artifact links work without signing in.
```

Detail rules, from the `better-ui` and `web-design-guidelines` passes:

- Rows are full-width links with a 44px minimum height and a visible focus ring.
- Dates use `<time datetime>` and a short local format. Tabular numbers keep them aligned.
- The page sets `<meta name="color-scheme" content="light dark">`, so form controls and scrollbars match the theme.
- Empty state: "No public artifacts yet. Agents publish with `artifactserver publish --path 2026/10/<name>`."

### Screenshot plan for CI

Browsers do not run on this Mac, so screenshots come from the existing `browser` job in `.github/workflows/ci.yml:123-163`. It already installs Chromium and runs `pnpm test:web:prebuilt`.

1. `startBrowserFixture` (`tests/browser/browser-fixture.ts:18-38`) gains a no-login option. It starts the server with login kind `none` and an API key.
2. A new spec `tests/browser/ui-catalog.spec.ts` publishes three artifacts at `2026/10/a`, `2026/10/b`, `2026/09/c` and one without a path. It asserts the grouping and links, then saves screenshots of `/`, `/2026/10/`, the sign-in gate, and the signed-in Review app. Each one is taken in light and dark (`colorScheme`) at 1440x900 and 390x844.
3. The screenshots go to `test-results/browser/screenshots/`, which the job already uploads. A reviewer opens them from the run's artifacts. Screenshots are evidence, not pixel-diff gates, so font rendering changes do not fail CI.

## 4. PR plan

Each PR lands through auto-merge after CI. Each one ends in a check that passes before the next one starts.

| Order | PR | Check |
| --- | --- | --- |
| 1 | `ci(release): publish plain semver tags` (#6) | CI green. After merge, the coordinator's `v0.2.0` tag runs **Release** only, and the summary shows `ghcr.io/duyet/artifact-server@sha256:…` and the chart digest. |
| 2 | `feat(auth): sign in with an API key` and the shadcn restyle (issue #4) | The HTTP tests in the issue pass. The Playwright sandbox spec proves artifact JavaScript cannot read `/api/v1/session`. |
| 3 | `chore: remove Cloudflare and Pulumi deployments` (D1 to D4) | `rg 'deploy/(cloudflare\|pulumi)\|src/deployment'` finds nothing outside the ledger history. `pnpm check:ci` and `pnpm conformance:validate` pass with the reduced `deployments` sets. |
| 4 | `chore: remove compose, local package, docs site, and upstream release scripts` (D5 to D8) | `pnpm-workspace.yaml` lists only `apps/web`. `verify:iteration` runs without the removed steps. CI green. |
| 5 | `chore(storage): remove the Azure and GCS adapters` (D9) | `pnpm typecheck`; the three deps are gone from `pnpm-lock.yaml`. |
| 6 | `chore(auth): remove OIDC and WorkOS` (D10) | `frk-004-no-login.test.ts` and the new API-key sign-in tests pass. `artifactserver publish` with an API-key profile still works in `tests/cli`. |
| 7 | `feat(web): public catalog and folder pages` (UI items 2 to 6) | `ui-catalog.spec.ts` passes in CI, and its screenshots are reviewed. HTTP tests prove a `public_link` artifact is listed, and an `account_required` one or an old version is not. |
| 8 | `chore: remove git history` (D11) | Decision first. Then the MCP tool list no longer has the four git-history tools, the SQLite schema migration drops its tables idempotently, and CI is green. |
| 9 | Decision gate for D12 | Confirm the SG pod's mode. If compact is the long-term shape, add a compact mode to the chart first, then remove external storage in a separate PR. |

PRs 3 to 6 do not depend on each other and can run in parallel, but they all edit `package.json`, `ci.yml`, and `conformance.yml`. Landing them one at a time avoids conflicts.
