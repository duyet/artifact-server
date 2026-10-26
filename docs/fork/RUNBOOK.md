# Fork operator runbook

This runbook releases, installs, publishes to, and backs up the same-host fork of Artifact Server. [DESIGN.md](./DESIGN.md) explains why each step exists.

The examples use `artifacts.example.internal` for the application host, `http://s3.example.internal:7070` for the S3 gateway, the namespace `artifact-server`, and the Helm release `artifact-server`. Real values belong in your own deployment configuration, not here.

## Before the first release

Do these steps once.

1. Create the bucket `artifact-server` on the gateway and an access key limited to it. Create the key with the gateway's own tools.

   ```sh
   aws --endpoint-url http://s3.example.internal:7070 s3api create-bucket --bucket artifact-server
   ```

2. Create the database and role in Postgres. Two replicas with a pool of 10, plus the migration and cleanup jobs, use 22 connections. A rolling update briefly runs a third pod, so the role needs a limit of at least 32.

   ```sql
   CREATE ROLE artifact_server LOGIN PASSWORD '<password>' CONNECTION LIMIT 32;
   CREATE DATABASE artifact_server OWNER artifact_server;
   ```

3. Pick the installation ID, for example `artifacts-internal`. The bucket prefix is the SHA-256 of this string, so a different ID points at different data. Never change it.
4. If the cluster restricts egress, allow the pods to reach the gateway port (7070) and Postgres.
5. Run the checks in [Contract test against the real gateway](#contract-test-against-the-real-gateway).

## Release

Push an annotated tag named `v<major>.<minor>.<patch>`.

```sh
git tag --annotate v0.2.0 --message "Release 0.2.0"
git push origin v0.2.0
```

The **Release** workflow (`fork-release.yml`) runs on tags that match `v*.*.*`. It fails on any tag that is not exactly `v<major>.<minor>.<patch>`, so the old `v0.1.2-fork.<n>` form is rejected. It publishes two packages.

- The image `ghcr.io/duyet/artifact-server:0.2.0` for `linux/amd64`, with BuildKit provenance and SBOM attestations.
- The chart `oci://ghcr.io/duyet/charts/artifact-server` at version `0.2.0` with `appVersion` `0.2.0`. Its `values.yaml` sets `image.repository` and `image.digest` to the image above.

The upstream `release.yml` is deleted, so no other workflow runs on these tags.

Open the run in the Actions tab. The summary lists the image digest and the chart digest. Pin the chart digest. The chart already carries the image digest, so one pin fixes both. Check that the chart holds the image digest.

```sh
helm show values oci://ghcr.io/duyet/charts/artifact-server@sha256:<chart digest> \
  | sed -n '/^image:/,/^$/p'
```

Never move or reuse a tag. If a run fails, fix the cause and push the next patch version, for example `v0.2.1`.

### After the first release

GHCR packages start private. Open each package under your GitHub profile, then **Package settings**, then **Change visibility**, and make both public.

- `artifact-server` (the image)
- `charts/artifact-server` (the chart)

To keep them private, list an image pull secret under `imagePullSecrets` and run `helm registry login ghcr.io` with a `read:packages` token wherever you run Helm.

## Install

Create the namespace and the runtime Secret. The `database-url` file holds `postgresql://artifact_server:<password>@postgres.example.internal:5432/artifact_server`.

```sh
kubectl create namespace artifact-server
kubectl --namespace artifact-server create secret generic artifact-server-runtime \
  --from-file=api-token=./api-token \
  --from-file=database-url=./database-url \
  --from-file=s3-access-key-id=./s3-access-key-id \
  --from-file=s3-secret-access-key=./s3-secret-access-key
```

Write `artifact-server-values.yaml`. Leave `contentDomain`, `contentTlsSecretName`, and every `identity` value empty. Do not set `image`.

```yaml
configuration:
  applicationOrigin: https://artifacts.example.internal
  installationId: artifacts-internal
  bootstrapAdministratorEmail: admin@example.internal
  contentDomain: ""
  postgresConnectionBudget: 32 # the role's connection limit
  s3:
    bucket: artifact-server
    endpoint: http://s3.example.internal:7070
    forcePathStyle: true
    region: us-east-1 # must equal the gateway's --region
secret:
  name: artifact-server-runtime
  keys:
    s3AccessKeyId: s3-access-key-id
    s3SecretAccessKey: s3-secret-access-key
ingress:
  enabled: true
  className: nginx
  applicationTlsSecretName: artifacts-example-internal-tls # a TLS secret that covers the host
  contentTlsSecretName: ""
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
```

The two annotations matter. Uploads have no application size limit, and ingress-nginx defaults to 1 MiB with buffering on. Install by chart digest.

```sh
helm upgrade --install artifact-server \
  oci://ghcr.io/duyet/charts/artifact-server@sha256:<chart digest> \
  --namespace artifact-server \
  --values artifact-server-values.yaml \
  --rollback-on-failure --wait
helm test artifact-server --namespace artifact-server --logs
curl --fail https://artifacts.example.internal/ready
```

To upgrade, run the same command with the digest of a newer release.

The release that removes OIDC and WorkOS needs two checks before the upgrade:

- Delete any `identity:` block from `artifact-server-values.yaml`. The chart schema rejects unknown keys, so the upgrade fails with it present.
- Postgres migration `0017_drop_external_identities` drops the `external_identities` table. Run `SELECT count(*) FROM external_identities;` first. It should be 0 on a deployment that never used a browser identity provider. If it is not, back up the table before upgrading, because the drop cannot be undone.

The release that removes Git history drops its tables in Postgres migration `0018_drop_git_history`: `git_history_budget_reservations`, `git_history_jobs`, `git_history_mappings`, `git_history_repositories`, `git_history_project_settings`, and `git_history_provider_identity`. They only tracked copies of versions in Cloudflare Artifacts, which this chart never configured. Run `SELECT count(*) FROM git_history_repositories;` first. If it is not 0, back up those tables before upgrading, because the drop cannot be undone. Repositories already created in Cloudflare Artifacts are not deleted.

## The API key

Generate the key once, on a trusted machine.

```sh
printf 'as_key_key_%s_%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" > api-token
```

Store it as the `api-token` Secret value and in your secret manager. Never change it after the first start.

The first start registers the key with all capabilities. Every later start and every cleanup run requires the same key. A different key ID fails once the installation holds a key, and a different secret under the same ID fails a digest check. Editing the Secret therefore crashes every pod and every cleanup run.

The bootstrap key publishes but cannot administer: admitting members and issuing, rotating, or revoking keys need an administrator. Create one with `artifactserver admin issue-key` (next section).

## Recover administrator access

Run this on a machine that can reach the installation's storage, with the same configuration the server uses. It creates the administrator member if the email is new, reuses it otherwise, and prints a new key once. Running it again with the same email and key name revokes the earlier key.

```sh
# Compact (SQLite) installation
artifactserver admin issue-key --mode compact --data /var/lib/artifact-server \
  --email ops@example.com --name "Ops Lead" > admin-key.json

# External storage (Postgres and S3): run it in the release image with the runtime env
kubectl --namespace artifact-server exec deploy/artifact-server -- \
  artifactserver admin issue-key --mode external-storage \
  --email ops@example.com --name "Ops Lead" > admin-key.json
```

The `token` field in the output is the key. Store it in your secret manager and delete the file. The key expires after 90 days unless `--expires-at` sets another time.

Open the application, choose API-key sign-in, and paste the key. That browser session is the administrator: it can admit members and issue, rotate, or revoke keys under Settings › API keys. Used as a bearer token, the same key is an ordinary delegated key and cannot administer. Deactivating the member revokes the key.

The command refuses an email whose member has another role, and an email of a deactivated member. It never promotes or demotes a member.

## Give each person a key

Give every person their own key on every machine, so each artifact and version names who published it. A bearer write records the key name as its author.

In a compact pod, the image runs `node dist/cli/main.js` from `/opt/artifact-server`, so call it by path:

```sh
kubectl --context <cluster> -n artifact-server exec deploy/artifact-server -c artifact-server -- \
  node /opt/artifact-server/dist/cli/main.js admin issue-key \
  --mode compact --data /var/lib/artifact-server/data \
  --role member --email ada@example.com --name "Ada Lovelace" \
  --key-name "Ada Lovelace @ laptop" > member-key.json
```

- `--role member` makes a key that creates artifacts, reads, comments, and opens review sessions. It publishes new versions only of artifacts its member created. It cannot manage other people's artifacts or projects. `--role` defaults to `administrator`.
- `--key-name` is the author shown on the key's writes. It defaults to `--name`.
- All keys of one member own the same artifacts, so any of that person's machines can publish a new version.
- Running the command again with the same email and key name revokes that key and prints a new one. The member's other keys keep working. The running server may accept the old key for up to 30 seconds.
- The output adds `apiKey.name` and `member.role`. Put the `token` in the person's CLI profile or MCP bearer setting and delete the file.

## Sign in with LDAP

People can sign in to Review with their directory username and password instead of an API key. The browser session acts as the member whose email the directory entry holds, so it sees and edits that member's artifacts. Agents and the CLI keep using keys. The feature is off until `ARTIFACT_SERVER_LDAP_URL` is set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTIFACT_SERVER_LDAP_URL` | unset (off) | `ldaps://host:636`. `ldap://` is refused unless `ARTIFACT_SERVER_LDAP_ALLOW_INSECURE=true`, which sends passwords in clear text. Use it only for a test directory. |
| `ARTIFACT_SERVER_LDAP_USER_DN` | required | Bind DN with `{username}` as one whole attribute value. |
| `ARTIFACT_SERVER_LDAP_CA_FILE` | system trust store | PEM bundle that replaces the trust store for this connection. |
| `ARTIFACT_SERVER_LDAP_REQUIRED_GROUP` | unset | Group DN that must appear in the entry's `memberOf`, compared without case. |
| `ARTIFACT_SERVER_LDAP_EMAIL_ATTRIBUTE` | `mail` | Attribute matched, without case, to a member's email. |
| `ARTIFACT_SERVER_LDAP_NAME_ATTRIBUTE` | `displayName` | Display name for members that `admit` creates. |
| `ARTIFACT_SERVER_LDAP_UNKNOWN_USERS` | `reject` | `reject` a directory user with no active member, or `admit` them as role `member`. |
| `ARTIFACT_SERVER_LDAP_TIMEOUT_MS` | `5000` | Connect and operation timeout. |

A FreeIPA example, with members already issued by `admin issue-key`:

```yaml
env:
  - name: ARTIFACT_SERVER_LDAP_URL
    value: ldaps://ipa.example.com:636
  - name: ARTIFACT_SERVER_LDAP_USER_DN
    value: uid={username},cn=users,cn=accounts,dc=example,dc=com
  - name: ARTIFACT_SERVER_LDAP_CA_FILE
    value: /etc/artifact-server/ldap/ca.crt # IPA serves its CA at http://ipa.example.com/ipa/config/ca.crt
  - name: ARTIFACT_SERVER_LDAP_UNKNOWN_USERS
    value: reject
```

To admit only one group, add `ARTIFACT_SERVER_LDAP_REQUIRED_GROUP=cn=artifact-users,cn=groups,cn=accounts,dc=example,dc=com`.

No secret is needed. The server binds as the person signing in and never stores the password. Check the result with `artifactserver config check`, which reports `ldapSignIn` without credentials.

Before you turn it on:

- **Emails must match.** A person whose directory `mail` differs from their member's email is refused. Compare them first, or set `ARTIFACT_SERVER_LDAP_UNKNOWN_USERS=admit` and accept new members.
- **The email attribute is the trust boundary.** A directory user who can change their own `mail` can sign in as any member, including an administrator. FreeIPA's default `User Self service` rule leaves `mail` out; confirm with `ipa selfservice-show "User Self service"`. On other directories, check the access rules or require a group.
- **Watch the logs.** Each attempt logs `auth.directory_sign_in.succeeded`, `.rejected` with a reason (`invalid_credentials`, `no_member`, `missing_email`, `not_in_required_group`), or `.unavailable` with the connection error. A `.unavailable` with a certificate error means the CA file does not cover the directory's chain.

Failed LDAP and API-key sign-ins share one limit, five per client address per minute. To turn the feature off, remove the variables and restart. Existing sessions stay valid until they expire or the person signs out.

## Publishing

Publish with the CLI from a fork checkout. Pass the key as a file, never on the command line.

```sh
pnpm artifactserver publish ./report \
  --server https://artifacts.example.internal \
  --token-file ./api-token \
  --name "Q3 cost report" | jq -r '.links.artifact'
```

`--public` is not needed. With no login, new artifacts default to public links. Against a server with login, the default stays `account_required`.

`links.artifact` is the link to share, for example `https://artifacts.example.internal/q3-cost-report-<uuid>/`, or `https://artifacts.example.internal/<path>/` when the artifact was published with `--path`. It always serves the current version, and a new version keeps the same link. Anyone who can reach the host and has the link can read it. Agents that call `/mcp` send the same key as a bearer token.

Artifact pages run in a CSP sandbox on the application host. Tell publishers three things.

- Build with relative URLs, for example `vite build --base ./`. A root-absolute URL such as `/assets/app.js` hits the application, not the artifact.
- `localStorage`, `sessionStorage`, IndexedDB, and cookies throw. Wrap them in `try`.
- Reload after a publish if a page mixes two versions.

### Migrate static reports

If you keep static reports as `<root>/<yyyy>/<mm>/<slug>.html`, each one can keep a URL of the same shape, such as `https://artifacts.example.internal/2026/10/release-checklist/`. Publish each one with `--path <yyyy>/<mm>/<slug>`.

1. Stage the report as a directory. Copy `<slug>.html` to `index.html`, and copy the contents of its sibling folder `<slug>/`, if there is one, next to it.
2. Remove the `<slug>/` prefix from links into that folder. The page is served at `/<yyyy>/<mm>/<slug>/`, so the document's base URL is the artifact itself, and `release-checklist/shots/a.jpg` must become `shots/a.jpg`.
3. Publish the directory.

   ```sh
   pnpm artifactserver publish ./staged/release-checklist \
     --server https://artifacts.example.internal \
     --token-file ./api-token \
     --name "Release checklist" \
     --path 2026/10/release-checklist | jq -r '.links.artifact'
   ```

   The command prints `https://artifacts.example.internal/2026/10/release-checklist/`.

Step 2 is inferred from this layout. Your reports may link differently, so open each published report and check that its images load.

A publish fails with `ARTIFACT_PATH_TAKEN` when another live artifact holds the same path, an ancestor such as `2026/10`, or a descendant. A path cannot change. To move a report, delete the artifact and publish it again, because deletion frees the path. The folder link of an artifact with a path keeps working.

A path is guessable, so anyone who can reach the host can read a report at its path. On a private network that may be acceptable. If it is not, publish without `--path` and share the folder link.

## The home page

`https://artifacts.example.internal/` lists every public artifact as a folder tree built from those paths, newest first, with the view count each artifact has collected. Anyone who can reach the host sees it. No credential, no cookie, no sign-in.

Read it directly when you want to check what a viewer sees:

```sh
curl -sS https://artifacts.example.internal/api/v1/public/tree | jq '.artifacts[] | {name, path, views}'
```

What the page needs from an operator:

- **Nothing, for public artifacts.** Artifacts with `accessSetting` other than `public_link` are absent from the tree and unreachable at it, which is the intended behaviour, not a missing page.
- **One grant for private artifacts.** Issue 4 adds browser sign-in with the API key. After it merges, a signed-in operator sees the private artifacts too.
- **The drain interval, if you ever need it changed.** Counts are buffered in memory and written every five seconds. A pod that is killed without draining loses at most five seconds of counts. Nothing else is configurable, and nothing needs to be.

Every folder starts expanded. To make one start collapsed, for example an archive that viewers rarely open, set it with a key that can manage artifacts, the same access that tags need:

```sh
curl -sS -X PUT https://artifacts.example.internal/api/v1/folder-defaults \
  -H "Authorization: Bearer $(cat api-token)" -H 'Content-Type: application/json' \
  -d '{"path": "team/archive", "defaultState": "collapsed"}'
```

Send `"defaultState": "expanded"` to undo it. Agents use the MCP tool `folder_set_default` with the same two fields. The tree response lists the collapsed folders in `collapsedFolders`, but only those that hold a public artifact, so a folder of private work is never named to an anonymous viewer. A viewer can still open a collapsed folder.

Postgres migration `0020_collapsed_folders` adds the `collapsed_folders` table. It is additive. A build older than this release refuses to start against the migrated database, so a rollback must also drop the table and delete row 20 from `artifact_server_postgres_migrations`. SQLite creates the table at start and keeps its schema version, so a compact installation can roll back without a step.

Nothing about a viewer is stored. The counter table is three columns, `artifact_id`, `day`, and `count`, and it holds no address, session, referrer, or user agent. To read the totals straight from the database:

```sh
kubectl --namespace artifact-server exec statefulset/artifact-server -- \
  psql "$ARTIFACT_SERVER_DATABASE_URL" -c \
  'SELECT day, SUM(count) FROM artifact_views GROUP BY day ORDER BY day DESC LIMIT 30'
```

## Backup and restore

Treat the database and the bucket prefix as one backup unit.

1. Take the database copy first. Use one snapshot, for example `pg_dump` or a CloudNativePG backup.
2. Then copy the whole bucket prefix. Compute it from the installation ID. The copy must keep object metadata, because every read checks it.

   ```sh
   printf 'installations/%s/\n' "$(printf '%s' 'artifacts-internal' | sha256sum | cut -d ' ' -f 1)"
   ```

   With Versity and its posix backend, the gateway keeps metadata in `user.` extended attributes, or in sidecar files when the gateway runs with `--sidecar`. A copy on the gateway's filesystem must keep them, for example `rsync -aX` or `tar --xattrs`. A bucket-to-bucket copy through the S3 API keeps them.

Database first is safe because the application writes every blob before the row that references it, and it never deletes a committed blob. Copying the bucket first is not safe, because a row committed during the copy could point at a blob the copy missed.

To restore, load the database, copy the prefix back with its metadata, and install with the same `installationId`. Then run the integrity check before serving traffic. The check re-hashes every referenced blob, so it can take a while. This job reuses the cleanup CronJob's environment, so it works with zero replicas.

```sh
kubectl --namespace artifact-server create job integrity-check \
  --from=cronjob/artifact-server-cleanup-staging --dry-run=client --output=json \
  | jq 'del(.spec.activeDeadlineSeconds) | .spec.template.spec.containers[0].args = ["integrity", "check", "--mode", "external-storage"]' \
  | kubectl --namespace artifact-server create --filename -
kubectl --namespace artifact-server wait --for=condition=complete job/integrity-check --timeout=30m
kubectl --namespace artifact-server logs job/integrity-check
```

The report must say `"status": "healthy"`. An unhealthy report fails the Job, and the wait then times out, so read the logs either way. The jq filter drops the CronJob's five-minute deadline, which is too short for a full re-hash. Delete the Job afterward.

Backing up while the application runs is a new claim. Upstream procedures stop the application first. Prove it with one restore drill before you rely on it. The pass criterion is a healthy integrity check on the restored pair.

## Contract test against the real gateway

Run this once before the first install.

1. Read the gateway's `--region` and set `configuration.s3.region` to it. A different signing region fails with `AuthorizationHeaderMalformed`. The contract test fixes the region at `us-east-1`, so on a gateway with another region it fails for that reason alone.
2. Check that the gateway's data directory supports `user.` extended attributes, or that the gateway runs with `--sidecar`. Note the filesystem type. Repeat the check after any storage change.

   ```sh
   df -T <gateway data dir>
   touch probe && setfattr -n user.probe -v 1 probe && getfattr -n user.probe probe; rm probe
   ```

   Run the second command inside the gateway's data directory.

   On ext4, one file is capped near 11 GiB (versity/versitygw#2424). XFS is not reported.
3. Run the contract test from a fork checkout, after `pnpm install`. Use a key that may create buckets. The test creates the throwaway buckets `artifact-server-integration` and `artifact-server-frk-000`. The three `MINIO` variables are required but unused, because the MinIO restart case is excluded.

   ```sh
   ARTIFACT_SERVER_S3_ENDPOINT=http://s3.example.internal:7070 \
   ARTIFACT_SERVER_S3_ACCESS_KEY=<key id> \
   ARTIFACT_SERVER_S3_SECRET_KEY=<secret> \
   ARTIFACT_SERVER_MINIO_CONTAINER=unused \
   ARTIFACT_SERVER_MINIO_IMAGE=unused \
   ARTIFACT_SERVER_MINIO_VOLUME=unused \
   pnpm exec vitest run --config tests/configs/vitest.integration.config.ts \
     --testNamePattern='^(?!.*provider restart preserves bytes and unavailable storage fails closed)' \
     tests/integration/s3-object-storage.test.ts \
     tests/integration/frk-000-versity-s3.test.ts
   ```

4. Delete both throwaway buckets with `aws s3 rb --force`, then revoke the bucket-creating key.
