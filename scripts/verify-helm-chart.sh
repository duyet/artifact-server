#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly artifactserver_repository
readonly artifactserver_chart="$artifactserver_repository/packaging/helm/artifact-server"
readonly artifactserver_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"

artifactserver_values=(
  --set "image.digest=$artifactserver_digest"
  --set "configuration.installationId=static-verification"
  --set "configuration.bootstrapAdministratorEmail=admin@example.test"
  --set "configuration.applicationOrigin=https://artifacts.example.test"
  --set "configuration.contentDomain=content.example.net"
  --set "configuration.s3.bucket=artifact-server-static-verification"
  --set "configuration.s3.region=us-east-1"
  --set "secret.name=artifact-server-runtime"
)

helm lint "$artifactserver_chart" --strict "${artifactserver_values[@]}"

for artifactserver_kubernetes_version in 1.33.0 1.34.0 1.35.0 1.36.0; do
  helm template artifact-server "$artifactserver_chart" \
    --kube-version "$artifactserver_kubernetes_version" \
    "${artifactserver_values[@]}" >/dev/null
done

helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 \
  "${artifactserver_values[@]}" \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.applicationTlsSecretName=artifact-server-application-tls \
  --set ingress.contentTlsSecretName=artifact-server-content-tls >/dev/null

# One host, a non-AWS S3 server over plain HTTP.
artifactserver_same_host_values=(
  "${artifactserver_values[@]}"
  --set configuration.contentDomain=
  --set configuration.s3.endpoint=http://s3.example.test:7070
  --set configuration.s3.forcePathStyle=true
  --set ingress.enabled=true
  --set ingress.className=nginx
  --set ingress.applicationTlsSecretName=artifact-server-application-tls
)

render_same_host() {
  helm template artifact-server "$artifactserver_chart" \
    --kube-version 1.33.0 "${artifactserver_same_host_values[@]}" "$@"
}

expect_rendered_count() {
  local artifactserver_expected=$1
  local artifactserver_pattern=$2
  local artifactserver_rendered=$3
  local artifactserver_actual
  artifactserver_actual=$(grep -Ec -- "$artifactserver_pattern" <<<"$artifactserver_rendered" || true)
  if [[ "$artifactserver_actual" != "$artifactserver_expected" ]]; then
    echo "Expected $artifactserver_expected rendered lines matching '$artifactserver_pattern', found $artifactserver_actual." >&2
    exit 1
  fi
}

artifactserver_same_host_chart=$(render_same_host)
artifactserver_same_host_deployment=$(render_same_host --show-only templates/deployment.yaml)
artifactserver_same_host_ingress=$(render_same_host --show-only templates/ingress.yaml)
artifactserver_same_host_cleanup=$(render_same_host --show-only templates/cleanup-cronjob.yaml)

expect_rendered_count 1 '^    - host: ' "$artifactserver_same_host_ingress"
expect_rendered_count 1 '^      secretName: ' "$artifactserver_same_host_ingress"
expect_rendered_count 0 'ARTIFACT_SERVER_CONTENT_DOMAIN' "$artifactserver_same_host_chart"
expect_rendered_count 1 'name: ARTIFACT_SERVER_S3_ENDPOINT$' "$artifactserver_same_host_deployment"
expect_rendered_count 1 '^          enableServiceLinks: false$' "$artifactserver_same_host_cleanup"

expect_render_failure() {
  local artifactserver_expected=$1
  shift
  local artifactserver_output
  if artifactserver_output=$(helm template artifact-server "$artifactserver_chart" \
    --kube-version 1.36.0 "$@" 2>&1); then
    echo "Expected Helm rendering to fail with: $artifactserver_expected" >&2
    exit 1
  fi
  if [[ "$artifactserver_output" != *"$artifactserver_expected"* ]]; then
    echo "Helm failed for an unexpected reason: $artifactserver_output" >&2
    exit 1
  fi
}

expect_render_failure "image.digest is required" \
  --set configuration.installationId=static-verification \
  --set configuration.bootstrapAdministratorEmail=admin@example.test \
  --set configuration.applicationOrigin=https://artifacts.example.test \
  --set configuration.contentDomain=content.example.net \
  --set configuration.s3.bucket=artifact-server-static-verification \
  --set configuration.s3.region=us-east-1 \
  --set secret.name=artifact-server-runtime

expect_render_failure "must be configured together" \
  "${artifactserver_values[@]}" \
  --set secret.keys.s3AccessKeyId=s3-access-key-id

expect_render_failure "terminationGracePeriodSeconds must be longer" \
  "${artifactserver_values[@]}" \
  --set terminationGracePeriodSeconds=5

expect_render_failure "postgresConnectionBudget must be at least 32" \
  "${artifactserver_values[@]}" \
  --set replicaCount=3

expect_render_failure "ingress.applicationTlsSecretName is required" \
  "${artifactserver_values[@]}" \
  --set ingress.enabled=true

expect_render_failure "application origin with no path or explicit port" \
  "${artifactserver_values[@]}" \
  --set configuration.applicationOrigin=https://artifacts.example.test:8443 \
  --set ingress.enabled=true \
  --set ingress.applicationTlsSecretName=artifact-server-application-tls \
  --set ingress.contentTlsSecretName=artifact-server-content-tls

expect_render_failure "podLabels cannot replace the chart-owned label" \
  "${artifactserver_values[@]}" \
  --set-string podLabels.app\\.kubernetes\\.io/component=other

mkdir -p -- "$artifactserver_repository/release"
helm package "$artifactserver_chart" \
  --destination "$artifactserver_repository/release" >/dev/null
