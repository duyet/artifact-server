#!/usr/bin/env bash

set -euo pipefail

# The multi-arch index digest of tag v1.4.1, read on 2026-10-17 from the Docker
# Hub registry (HEAD registry-1.docker.io/v2/versity/versitygw/manifests/v1.4.1).
readonly versity_image="versity/versitygw:v1.4.1@sha256:0400cb59f59da0f1cf9f7fd49505191abc348dfadf54509bf1988caaff4eb96f"
readonly container_name="artifact-server-versity-${$}-${RANDOM}"
readonly volume_name="${container_name}-data"
readonly access_key="artifactserver"
readonly secret_key="artifactserver-integration-only"
readonly evidence_file="project/evidence/s3-versity.json"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  docker volume rm --force "${volume_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "${volume_name}" >/dev/null
docker run --detach \
  --name "${container_name}" \
  --env "ROOT_ACCESS_KEY_ID=${access_key}" \
  --env "ROOT_SECRET_ACCESS_KEY=${secret_key}" \
  --env "VGW_REGION=us-east-1" \
  --env "VGW_PORT=:7070" \
  --publish 127.0.0.1::7070 \
  --volume "${volume_name}:/data" \
  "${versity_image}" \
  posix /data >/dev/null

port="$(docker port "${container_name}" 7070/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
if [[ -z "${port}" ]]; then
  echo "Versity did not publish an IPv4 test port." >&2
  exit 1
fi

endpoint="http://127.0.0.1:${port}"
ready=false
for _ in $(seq 1 120); do
  if curl --silent --output /dev/null --max-time 2 "${endpoint}"; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${container_name}")" != "true" ]]; then
    break
  fi
  sleep 0.25
done

if [[ "${ready}" != true ]]; then
  echo "Versity did not become ready." >&2
  docker logs --tail 80 "${container_name}" >&2 || true
  exit 1
fi

ARTIFACT_SERVER_S3_ENDPOINT="${endpoint}" \
ARTIFACT_SERVER_S3_ACCESS_KEY="${access_key}" \
ARTIFACT_SERVER_S3_SECRET_KEY="${secret_key}" \
ARTIFACT_SERVER_MINIO_CONTAINER="${container_name}" \
ARTIFACT_SERVER_MINIO_IMAGE="${versity_image}" \
ARTIFACT_SERVER_MINIO_VOLUME="${volume_name}" \
NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=4096" \
pnpm exec vitest run --config tests/configs/vitest.integration.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile="${evidence_file}" \
  --testNamePattern='^(?!.*provider restart preserves bytes and unavailable storage fails closed)' \
  tests/integration/s3-object-storage.test.ts \
  tests/integration/frk-000-versity-s3.test.ts

node --input-type=module - "${evidence_file}" <<'EOF'
import {readFileSync} from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const passedTitles = report.testResults
  .flatMap((file) => file.assertionResults)
  .filter((test) => test.status === "passed")
  .map((test) => test.title);
const missing = ["FRK-000-B", "FRK-000-F"].filter(
  (id) => !passedTitles.some((title) => title.startsWith(`${id}:`)),
);
if (missing.length > 0) {
  console.error(`Versity run passed ${passedTitles.length} tests but not ${missing.join(", ")}.`);
  process.exit(1);
}
console.log(`Versity run passed ${passedTitles.length} tests including FRK-000-B and FRK-000-F.`);
EOF
