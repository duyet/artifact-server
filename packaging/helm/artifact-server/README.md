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

identity:
  oidcClientId: artifact-server
  oidcIssuer: https://idp.example.com/realms/main

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

## WorkOS authentication

A browser identity provider is optional, and an installation has at most one. To
use WorkOS, set `identity.workosClientId`, `identity.workosIssuer`, and
`secret.keys.workosApiKey`. `identity.workosIssuer` is the exact HTTPS AuthKit
origin for this environment, and `secret.keys.workosApiKey` names a key in the
existing Kubernetes Secret. The chart rejects a partial WorkOS configuration.

## OIDC authentication

An installation that already runs its own OpenID Connect provider can use it for
browser login instead of WorkOS. Set `identity.oidcIssuer` to the exact issuer
URL and `identity.oidcClientId` to the registered client. The issuer must be an
HTTPS URL with no query or fragment. The redirect URI to register with the
provider is `configuration.applicationOrigin` followed by `/auth/callback`.

`secret.keys.oidcClientSecret` is optional, because a public client using PKCE
alone is valid; when set, it names a key in the existing Kubernetes Secret and
the chart mounts it as a file. `identity.oidcScopes` overrides the default
`openid email profile`. The chart rejects a partial OIDC configuration, and an
OIDC client secret or scope list without an issuer and client.

The same issuer also protects the MCP endpoint: agents may present an end-user
access token instead of an API key, and the server binds each call to the person
who obtained it. Such a token must name `configuration.applicationOrigin`
followed by `/mcp` in `aud`, which the provider produces from an audience mapper
or an RFC 8707 resource indicator.

One installation has one browser-login provider. The chart rejects values that
configure WorkOS and OIDC together.

## No identity provider

Leave every `identity` value and `secret.keys.workosApiKey` and
`secret.keys.oidcClientSecret` empty to run without browser login. Browser login
is then off, and people publish with the API key from the `api-token` Secret
value. All publishers share that one key.

## NetworkPolicy

NetworkPolicy is disabled by default. Standard Kubernetes policies cannot allow
external services by DNS name, so the chart cannot safely invent rules for a
managed database, bucket, WorkOS, or an OTLP collector. Operators can enable the
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
