![Artifact Server](./docs/assets/banner.webp)

# Artifact Server

Artifact Server is a self-hosted server where agents publish versioned HTML artifacts and people review, comment on, and share them. Agents publish through the built-in MCP server or the `artifactserver` CLI. People open an exact version in Review, comment on it, and share a stable link that follows the current version.

This repository is a fork of [plannotator/artifact-server](https://github.com/plannotator/artifact-server). It targets one deployment shape: a private team server on one host, where readers open shared links without signing in and agents publish with API keys. Upstream parity is not a goal.

## What this fork adds

- **Path mode.** Without `ARTIFACT_SERVER_CONTENT_DOMAIN`, the server serves artifacts from the application host under a CSP sandbox, so one host name and one TLS certificate are enough. See [DESIGN.md](./docs/fork/DESIGN.md).
- **Readable paths.** `artifactserver publish --path 2026/10/release-checklist` gives an artifact the link `/2026/10/release-checklist/`, and new versions keep it. See [the CLI guide](./docs/cli.md#choose-a-readable-path).
- **Reading without login.** On a team server, new artifacts default to public links, and people sign in to Review with an API key. See [DESIGN.md section 5](./docs/fork/DESIGN.md#5-no-login-mode).
- **OpenID Connect sign-in.** Set `ARTIFACT_SERVER_OIDC_ISSUER`, and Review shows **Sign in with SSO** next to the API-key form. The provider must send a verified `email` claim that matches a member's email. See [the runbook](./docs/fork/RUNBOOK.md#sign-in-with-oidc).
- **Public home page.** `/` lists public artifacts as a folder tree with view counts, sparklines, and a daily chart. An owner can make a folder start collapsed. See [HOMEPAGE.md](./docs/fork/HOMEPAGE.md).
- **Viewer bar.** A bar above each artifact shows your logo, the artifact name, an info popover with views and visibility, and an actions menu. It appears in Review and at readable URLs. See [VIEWER.md](./docs/fork/VIEWER.md).
- **Asset store.** Each artifact holds images, data files, and other media outside its versions, served at `/_blob/<id>`. See [ASSETS.md](./docs/fork/ASSETS.md).
- **Broken reference check.** Each publish counts the references that the version's own files cannot satisfy, and `artifactserver assets check` lists them. See [the MCP guide](./docs/mcp.md#check-a-published-folder-for-broken-references).
- **Per-person keys.** `artifactserver admin issue-key --role member` gives each person their own key, and the key's name is the author of each write it makes. See [the runbook](./docs/fork/RUNBOOK.md#give-each-person-a-key).
- **Review app changes.** Rename, duplicate, and edit one text file of an artifact, read project analytics, search with a command palette, and switch between light, dark, and system themes.
- **Releases on GHCR.** A `vX.Y.Z` tag publishes the container image and the Helm chart. See [the runbook](./docs/fork/RUNBOOK.md#release).

The fork also removes upstream parts that it does not run: the Cloudflare and Pulumi deployments, the Azure Blob and Google Cloud Storage adapters, upstream's hosted sign-in, Git history, linked artifacts, the Docker Compose and npm launcher packages, and the docs site. [SIMPLIFY.md](./docs/fork/SIMPLIFY.md) records the plan for those deletions.

## Quick start

Running from source needs Node.js 24.12 or newer and pnpm 10.34.3.

1. Clone the repository and start a local server.

   ```sh
   git clone https://github.com/duyet/artifact-server.git
   cd artifact-server
   pnpm install
   pnpm dev
   ```

   The server listens on `http://localhost:8787`. Open the printed URL.

2. Create an API key under **Settings › API keys**, then connect your agent. For Claude Code:

   ```sh
   claude mcp add --transport http artifact-server http://localhost:8787/mcp --header "Authorization: Bearer <key>"
   ```

   For Codex, Cursor, and VS Code, add `http://localhost:8787/mcp` as a remote HTTP MCP server with the header `Authorization: Bearer <key>`. The [MCP guide](./docs/mcp.md) covers team servers and the supported operations.

3. Install the agent skill.

   ```sh
   npx skills add duyet/artifact-server
   ```

4. Ask the agent to publish something.

   ```text
   /artifact-server upload that HTML design doc
   ```

   The agent returns the Review link first.

The local server is for one developer on loopback. Path mode, readable paths, reading without login, and OIDC sign-in need a team server.

### Run a team server from the image

Compact mode keeps SQLite metadata and files in one data directory. The image runs as user `node` and is built for `linux/amd64`. Pick a version from the [tags](https://github.com/duyet/artifact-server/tags), then initialize the data directory and start the server.

```sh
docker run --rm --volume artifact-data:/var/lib/artifact-server \
  ghcr.io/duyet/artifact-server:<version> \
  init --admin-email admin@example.com --data /var/lib/artifact-server/data

docker run --detach --name artifact-server --publish 8787:8787 \
  --volume artifact-data:/var/lib/artifact-server \
  --env ARTIFACT_SERVER_ORIGIN=https://artifacts.example.com \
  ghcr.io/duyet/artifact-server:<version> \
  start-compact --data /var/lib/artifact-server/data --host 0.0.0.0 --port 8787
```

`ARTIFACT_SERVER_ORIGIN` must be an `https://` origin, so put a TLS proxy in front of port 8787. `init` writes the bootstrap API key to `data/secrets/api-token` in the volume. That key publishes but cannot administer. To create an administrator key, follow [Recover administrator access](./docs/fork/RUNBOOK.md#recover-administrator-access).

## Configuration

The server reads its settings from environment variables. These are the ones that the fork adds or that most deployments set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTIFACT_SERVER_ORIGIN` | required | The application's `https://` origin, without a path. |
| `ARTIFACT_SERVER_CONTENT_DOMAIN` | unset | Unset serves artifacts from the application host (path mode). Set it to a separate registrable domain to give each version its own origin, as upstream does. |
| `ARTIFACT_SERVER_OIDC_ISSUER` | unset (off) | The `https://` issuer URL of an OpenID Connect provider. Setting it turns on OIDC sign-in. |
| `ARTIFACT_SERVER_OIDC_CLIENT_ID` | required with an issuer | The client ID registered for this server. |
| `ARTIFACT_SERVER_OIDC_CLIENT_SECRET` | required with an issuer | The client secret. |
| `ARTIFACT_SERVER_OIDC_SCOPES` | `openid email profile` | Space-separated scopes that include `openid`. |
| `ARTIFACT_SERVER_OIDC_UNKNOWN_USERS` | `reject` | `reject` a verified email that names no member, or `admit` it as a new member. |
| `ARTIFACT_SERVER_LOGO` | unset | The viewer bar logo: an `https://` URL, or an absolute path to an image file of at most 256 KiB. |
| `ARTIFACT_SERVER_LOGO_ALT` | required with a logo | The logo's alternative text, 1 to 100 characters. |
| `ARTIFACT_SERVER_LOGO_LINK` | unset | Where the logo links: an `https://` URL or a path such as `/`. |
| `ARTIFACT_SERVER_HELP_URL` | unset | Adds a **Help** item to the account menu: an `https://` URL or a path that starts with one `/`. |
| `ARTIFACT_SERVER_ASSET_QUOTA_COUNT` | `500` | The maximum number of assets for each artifact. |
| `ARTIFACT_SERVER_ASSET_QUOTA_BYTES` | `536870912` (512 MiB) | The maximum asset bytes for each artifact. |

External-storage mode (Postgres and S3) also reads `ARTIFACT_SERVER_DATABASE_URL`, `ARTIFACT_SERVER_INSTALLATION_ID`, `ARTIFACT_SERVER_API_TOKEN`, `ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL`, and the `ARTIFACT_SERVER_S3_*` variables. The Helm chart sets those from its values. Each secret also accepts a `_FILE` variant, such as `ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE`, that names a file holding the value. Setting both forms fails at startup.

The Helm chart has values for the OIDC, logo, help, and asset quota variables. The OIDC client secret comes from a key of the runtime Secret. The chart accepts only the `https://` URL form of the logo. See the [chart README](./packaging/helm/artifact-server/README.md#oidc-sign-in-logo-help-link-and-asset-quota).

Run `artifactserver config check` to see the parsed configuration before a rollout. The output names each secret's source and never its value.

## Deploy on Kubernetes

Each `vX.Y.Z` tag publishes two public packages:

- The image `ghcr.io/duyet/artifact-server:X.Y.Z` for `linux/amd64`, with provenance and SBOM attestations.
- The chart `oci://ghcr.io/duyet/charts/artifact-server` at version `X.Y.Z`. Its `values.yaml` pins the image by digest.

The chart runs external-storage mode against your Postgres database and S3-compatible bucket. The release workflow summary lists the chart digest. Install by that digest, so one pin fixes both the chart and the image:

```sh
helm upgrade --install artifact-server \
  oci://ghcr.io/duyet/charts/artifact-server@sha256:<chart digest> \
  --namespace artifact-server \
  --values artifact-server-values.yaml \
  --rollback-on-failure --wait
```

The [runbook](./docs/fork/RUNBOOK.md) covers the bucket, the database role, the runtime Secret, the values file, the ingress annotations that uploads need, backup and restore, and upgrades. The [chart README](./packaging/helm/artifact-server/README.md) lists every value.

## Security model

With a content domain, the server keeps upstream's isolation: each version gets its own origin on a separate registrable domain. In path mode, artifacts share the application's origin, and a CSP `sandbox` without `allow-same-origin` is the one layer between artifact code and the application. Artifact code then cannot read cookies, call the API with the viewer's session, or use `localStorage`. [DESIGN.md section 4](./docs/fork/DESIGN.md#4-isolation-on-one-origin) lists what breaks for artifacts and the risk that remains.

Read the [security policy](./SECURITY.md) before you report a vulnerability.

## Development

Install dependencies once with `pnpm install`. Every pull request to `main` must pass five checks. To run a check locally, run its commands:

| Check | Commands |
| --- | --- |
| PR / Build and static policy | `pnpm check:ci`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm conformance:validate`, `pnpm conformance:tests` |
| PR / Unit and conformance behavior | `pnpm build`, then `pnpm test` |
| PR / Browser behavior | `pnpm build`, `pnpm exec playwright install --with-deps chromium`, then `pnpm test:web:prebuilt` |
| Helm chart static checks | `pnpm verify:helm-static` |
| Versity S3 gateway | `pnpm test:storage-versity` (needs Docker) |

The conformance checks need Ruby. `pnpm verify:changed` picks the checks that match the paths you changed.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md) before you open a pull request, and search the [open issues](https://github.com/duyet/artifact-server/issues) first. The [`project`](./project) directory holds the specifications, the [conformance ledger](./project/spec/conformance.yml), and the test evidence. The [documentation index](./docs/README.md) lists the other guides, including the upstream live-feedback integrations for Pi, Claude Code Channels, and OpenCode under [`integrations`](./integrations).

## License and credit

Artifact Server was created by [backnotprop](https://x.com/backnotprop) as part of [Plannotator](https://github.com/backnotprop/plannotator). This fork builds on [plannotator/artifact-server](https://github.com/plannotator/artifact-server) and keeps its license.

Artifact Server is dual-licensed under either of

- [MIT License](./LICENSE-MIT)
- [Apache License, Version 2.0](./LICENSE-APACHE)

at your option, © 2026 backnotprop.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in this project by you, as defined in the Apache-2.0
license, shall be dual licensed as above, without any additional terms or
conditions.
