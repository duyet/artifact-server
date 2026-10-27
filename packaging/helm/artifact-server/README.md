# Artifact Server Helm chart

This chart runs Artifact Server on Kubernetes. It installs the application only.
Postgres, object storage, DNS, TLS certificates, and an Ingress or Gateway must
already exist.

## Supported versions

- Helm 4.2.x is the release baseline.
- Kubernetes 1.33, 1.34, 1.35, and 1.36 are supported by this chart version.
- The chart uses stable chart API `v2`. Chart API `v3` is still experimental.

The chart may render with other versions, but that is not a support claim.

## Required setup

Create one namespace Secret with the API token and Postgres URL. Add the S3 keys
only when the deployment does not use workload identity.

```sh
kubectl --namespace artifact-server create secret generic artifact-server-runtime \
  --from-file=api-token=/secure/artifact-server/api-token \
  --from-file=database-url=/secure/artifact-server/database-url \
  --from-file=s3-access-key-id=/secure/artifact-server/s3-access-key-id \
  --from-file=s3-secret-access-key=/secure/artifact-server/s3-secret-access-key
```

Keep credentials out of Helm values. Set `secret.name` and the key names instead.
If an external secret manager changes the Secret, update
`secret.rolloutChecksum` to its non-secret version or checksum so the Deployment
restarts in a controlled rollout.

The `api-token` Secret value is the installation bootstrap service key. Generate
it in `as_key_key_<id>_<secret>` form. Artifact Server persists it as an
ordinary visible, revocable managed key on first startup and refuses a new key
id after installation identity exists.

Create a values file containing the installation identity, origins, bucket,
region, released image repository and digest, and Secret reference:

```yaml
image:
  repository: ghcr.io/plannotator/artifact-server
  digest: sha256:replace_with_release_digest

configuration:
  installationId: team-example
  bootstrapAdministratorEmail: admin@example.com
  applicationOrigin: https://artifacts.example.com
  contentDomain: content.example.net
  postgresConnectionBudget: 22
  postgresPoolSize: 10
  s3:
    bucket: artifact-server-team-example
    region: us-east-1

secret:
  name: artifact-server-runtime
  rolloutChecksum: secret-version-1
  keys:
    s3AccessKeyId: s3-access-key-id
    s3SecretAccessKey: s3-secret-access-key
```

Install with Helm 4:

```sh
helm upgrade --install artifact-server ./packaging/helm/artifact-server \
  --namespace artifact-server \
  --create-namespace \
  --values artifact-server-values.yaml \
  --rollback-on-failure \
  --wait

helm test artifact-server --namespace artifact-server --logs
```

The pre-install and pre-upgrade migration Job must succeed before the
Deployment changes. Successful migration Jobs are removed. Failed Jobs remain
for inspection and are removed before the next Helm attempt.

The chart also creates a `CronJob` that runs one bounded expired-staging cleanup
pass every 15 minutes. It uses the same image, Secret, service account, workload
identity, Postgres database, and object-store configuration as the application.
Serving Pods set the cleanup schedule to `external`, so they do not run a
second background loop. Configure or disable this trigger under `cleanup` in
the values file. Disabling it is safe only when an operator runs the same
`artifactserver maintenance cleanup-staging --once` command elsewhere.

## Routing

The Service is private `ClusterIP`. Choose one routing path:

- Enable the included Ingress and provide the application TLS Secret name. Add
  the wildcard-content TLS Secret name when a content domain is set.
- Leave it disabled and point an existing Ingress or Gateway at the Service.
- On a managed cluster, leave it disabled and use the provider load balancer or
  edge configuration.

With a content domain, both `artifacts.example.com` and
`*.content.example.net` route to the same Service. The two hosts remain
separate registrable domains for browser isolation. An enabled Ingress requires
the application origin to have no path or explicit port.

### One host, no content domain

Leave `configuration.contentDomain` empty to serve everything from the
application host. The chart then renders one Ingress host and one TLS entry, so
only `ingress.applicationTlsSecretName` is needed. Leave
`ingress.contentTlsSecretName` empty. The chart does not set
`ARTIFACT_SERVER_CONTENT_DOMAIN`.

The server serves published content on the application host under paths. A CSP
sandbox isolates each artifact from the application and from other artifacts.
This is weaker than separate registrable domains, so use it only when you
cannot get a wildcard content domain.

### Uploads behind ingress-nginx

ingress-nginx limits request bodies to 1 MiB by default and buffers uploads.
Artifact uploads have no application size limit, so turn both off:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
```

## S3-compatible storage

For a server that is not AWS S3, set `configuration.s3.endpoint` to its URL.
Both `https://` and plain `http://` endpoints are accepted. Set
`configuration.s3.forcePathStyle` to `true` when the server does not support
bucket names in the host.

```yaml
configuration:
  s3:
    bucket: artifact-server
    region: us-east-1
    endpoint: http://s3.example.internal:7070
    forcePathStyle: true
```

`configuration.s3.region` must match the region the server expects. Some servers
reject a request signed for another region. A server that needs static keys
uses `secret.keys.s3AccessKeyId` and `secret.keys.s3SecretAccessKey`.

When NetworkPolicy is enabled, allow egress to the S3 port, for example 7070.

## Workload identity

Static S3 keys are optional. For a cloud workload identity, leave both S3 key
names empty, add the provider annotations under `serviceAccount.annotations`,
and set `serviceAccount.automountServiceAccountToken` only when that identity
mechanism requires the projected Kubernetes token.

## Browser sign-in

A team deployment signs browsers in with a managed API key (`POST /auth/api-key`).
The bootstrap key comes from the Secret key named by `secret.keys.apiToken`
(default `api-token`).

## OIDC sign-in, logo, help link, and asset quota

These settings are off by default. An empty value renders no environment
variable, so the server's own default applies.

```yaml
configuration:
  helpUrl: https://example.com/help
  logo:
    url: https://example.com/logo.svg
    alt: Example
    link: /
  assetQuota:
    count: 500
    bytes: 536870912
  oidc:
    issuer: https://sso.example.com
    clientId: artifact-server
    scopes: openid email profile
    unknownUsers: reject

secret:
  keys:
    oidcClientSecret: oidc-client-secret
```

| Value | Variable |
| --- | --- |
| `configuration.oidc.issuer` | `ARTIFACT_SERVER_OIDC_ISSUER` |
| `configuration.oidc.clientId` | `ARTIFACT_SERVER_OIDC_CLIENT_ID` |
| `secret.keys.oidcClientSecret` | `ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE` |
| `configuration.oidc.scopes` | `ARTIFACT_SERVER_OIDC_SCOPES` |
| `configuration.oidc.unknownUsers` (`reject` or `admit`) | `ARTIFACT_SERVER_OIDC_UNKNOWN_USERS` |
| `configuration.logo.url` | `ARTIFACT_SERVER_LOGO` |
| `configuration.logo.alt` | `ARTIFACT_SERVER_LOGO_ALT` |
| `configuration.logo.link` | `ARTIFACT_SERVER_LOGO_LINK` |
| `configuration.helpUrl` | `ARTIFACT_SERVER_HELP_URL` |
| `configuration.assetQuota.count` | `ARTIFACT_SERVER_ASSET_QUOTA_COUNT` |
| `configuration.assetQuota.bytes` | `ARTIFACT_SERVER_ASSET_QUOTA_BYTES` |

The OIDC client secret is never a value. Add it as a key of the runtime Secret
and name that key in `secret.keys.oidcClientSecret`. The chart mounts it with
the other secrets and sets `ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE`, as it does
for the database URL. Setting an issuer requires `clientId` and the secret key.
Setting any other OIDC value without an issuer is an error. Changing the Secret
follows the same `secret.rolloutChecksum` rule as the other keys.

The chart supports only the `https://` URL form of the logo. A file path would
need a volume and a file in the image or a ConfigMap, which the chart does not
provide. `logo.alt` is required with `logo.url`, and `logo.alt` and `logo.link`
need a `logo.url`. The chart rejects an invalid shape at render time. The server
still checks lengths and the image itself at startup.

## NetworkPolicy

NetworkPolicy is disabled by default. Standard Kubernetes policies cannot allow
external services by DNS name, so the chart cannot safely invent rules for a
managed database, bucket, or an OTLP collector. Operators can enable the
template and provide exact native `ingress` and `egress` rules for their CNI and
network. An empty enabled rule set is default-deny. An S3 server on a custom port
needs an egress rule for that port.

## Scaling and resources

The default is two replicas with a PodDisruptionBudget and preferred spreading
across nodes. Each serving replica has a bounded Postgres pool sized by
`configuration.postgresPoolSize` (default 10 connections); the migration Job
and cleanup CronJob each require one additional connection. The chart rejects
a replica count and pool size combination that exceeds
`configuration.postgresConnectionBudget`. Horizontal autoscaling is
intentionally not included until measured capacity defines safe thresholds.

The default request is `100m` CPU and `256Mi` memory. Treat it as a starting
request, observe the workload, and adjust `resources`. The chart does not set a
CPU limit by default.

## Uninstall and durable state

`helm uninstall` removes Artifact Server workloads. It does not remove the
external Secret, Postgres database, bucket, DNS, or TLS certificates. Back up
Postgres and the complete object prefix as one installation before destructive
provider operations.
