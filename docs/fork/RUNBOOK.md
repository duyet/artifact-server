# Fork operator runbook

This runbook releases, installs, publishes to, and backs up the same-host fork of Artifact Server. [DESIGN.md](./DESIGN.md) explains why each step exists.

The examples use `artifacts.example.internal` for the application host, `http://s3.example.internal:7070` for the S3 gateway, the namespace `artifact-server`, and the Helm release `artifact-server`. Real values belong in the deployment repository, not here.

## Before the first release

Do these steps once.

1. Disable the upstream release workflow. It fires on every `v*` tag and pushes to `ghcr.io/plannotator`, which fails in the fork. Select **Tagged Release** on the fork's Actions page and choose **Disable workflow**, or run this command.

   ```sh
   gh workflow disable release.yml --repo duyet/artifact-server
   ```

2. Create the bucket `artifact-server` on the gateway and an access key limited to it. Create the key with the gateway's own tools.

   ```sh
   aws --endpoint-url http://s3.example.internal:7070 s3api create-bucket --bucket artifact-server
   ```

3. Create the database and role in the CloudNativePG cluster. Two replicas with a pool of 10, plus the migration and cleanup jobs, use 22 connections. A rolling update briefly runs a third pod, so the role needs a limit of at least 32.

   ```sql
   CREATE ROLE artifact_server LOGIN PASSWORD '<password>' CONNECTION LIMIT 32;
   CREATE DATABASE artifact_server OWNER artifact_server;
   ```

4. Pick the installation ID, for example `artifacts-internal`. The bucket prefix is the SHA-256 of this string, so a different ID points at different data. Never change it.
5. If the cluster restricts egress, allow the pods to reach the gateway port (7070) and Postgres.
6. Run the checks in [Contract test against the real gateway](#contract-test-against-the-real-gateway).

## Release

Push an annotated tag named `v<upstream version>-fork.<n>`.

```sh
git tag --annotate v0.1.2-fork.1 --message "Fork release 0.1.2-fork.1"
git push origin v0.1.2-fork.1
```

The **Fork Release** workflow runs on tags that match `v*-fork.*`. It fails on any tag that is not `v<major>.<minor>.<patch>-fork.<n>`. It publishes two packages.

- The image `ghcr.io/duyet/artifact-server:0.1.2-fork.1` for `linux/amd64`, with BuildKit provenance and SBOM attestations.
- The chart `oci://ghcr.io/duyet/charts/artifact-server` at version `0.1.2-fork.1`. Its `values.yaml` sets `image.repository` and `image.digest` to the image above. `appVersion` stays the upstream version.

Open the run in the Actions tab. The summary lists the image digest and the chart digest. Pin the chart digest. The chart already carries the image digest, so one pin fixes both. Check that the chart holds the image digest.

```sh
helm show values oci://ghcr.io/duyet/charts/artifact-server@sha256:<chart digest> \
  | sed -n '/^image:/,/^$/p'
```

Never move or reuse a tag. If a run fails, fix the cause and push the next number, for example `v0.1.2-fork.2`.

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
  applicationTlsSecretName: wildcard-example-internal-tls # the existing wildcard secret
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

## The API key

Generate the key once, on a trusted machine.

```sh
printf 'as_key_key_%s_%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" > api-token
```

Store it as the `api-token` Secret value and in your secret manager. Never change it after the first start.

The first start registers the key with all capabilities. Every later start and every cleanup run requires the same key. A different key ID fails once the installation holds a key, and a different secret under the same ID fails a digest check. Editing the Secret therefore crashes every pod and every cleanup run.

There is no browser login, so nobody can issue, rotate, or revoke keys. All publishers share this one key.

## Publishing

Publish with the CLI from a fork checkout. Pass the key as a file, never on the command line.

```sh
pnpm artifactserver publish ./report \
  --server https://artifacts.example.internal \
  --token-file ./api-token \
  --name "Q3 cost report" | jq -r '.links.artifact'
```

`--public` is not needed. With no login, new artifacts default to public links. Against a server with login, the default stays `account_required`.

`links.artifact` is the link to share, for example `https://artifacts.example.internal/q3-cost-report-<uuid>/`. It always serves the current version, and a new version keeps the same link. Anyone who can reach the host and has the link can read it. Agents that call `/mcp` send the same key as a bearer token.

Artifact pages run in a CSP sandbox on the application host. Tell publishers three things.

- Build with relative URLs, for example `vite build --base ./`. A root-absolute URL such as `/assets/app.js` hits the application, not the artifact.
- `localStorage`, `sessionStorage`, IndexedDB, and cookies throw. Wrap them in `try`.
- Reload after a publish if a page mixes two versions.

## Backup and restore

Treat the database and the bucket prefix as one backup unit.

1. Take the database copy first. Use one snapshot, for example `pg_dump` or a CloudNativePG backup.
2. Then copy the whole bucket prefix. Compute it from the installation ID. The copy must keep object metadata, because every read checks it.

   ```sh
   printf 'installations/%s/\n' "$(printf '%s' 'artifacts-internal' | sha256sum | cut -d ' ' -f 1)"
   ```

   The Versity posix backend keeps metadata in `user.` extended attributes, or in sidecar files when the gateway runs with `--sidecar`. A copy on the gateway's filesystem must keep them, for example `rsync -aX` or `tar --xattrs`. A bucket-to-bucket copy through the S3 API keeps them.

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
2. Check that the gateway's data directory supports `user.` extended attributes, or that the gateway runs with `--sidecar`. Note the filesystem type. The current gateway passed this check on 2026-10-17: its data directory is ext4 on a local LVM volume, `user.` attributes work, and it needs no `--sidecar`. Repeat the check after any storage change.

   ```sh
   df -T <gateway data dir>
   touch probe && setfattr -n user.probe -v 1 probe && getfattr -n user.probe probe; rm probe
   ```

   Run the second command inside the gateway's data directory.

   On ext4, one file is capped near 11 GiB (versity/versitygw#2424). XFS is not reported. The current gateway is ext4, so this cap applies.
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
