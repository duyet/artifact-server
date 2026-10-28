import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import {
  type ArtifactRow,
  type AssetRow,
  decodeArtifactRows,
  decodeAssetRows,
  decodeEntryRows,
  decodeProjectReferenceRows,
  decodeProjectRows,
  decodeVersionRows,
  type EntryRow,
  type IntegrityCatalog,
  type ProjectReferenceRow,
  type ProjectRow,
  type VersionRow,
} from "../core/integrity-catalog.js";

/** Read one installation's external-storage catalog without writing Postgres. */
export function readPostgresIntegrityCatalog(installationId: string) {
  return Effect.gen(function*() {
    const sql = yield* SqlClient;
    const [artifacts, versions, entries, assets, projects, projectReferences] =
      yield* Effect.all([
      sql<ArtifactRow>`
        SELECT id, project_id AS "projectId",
          current_version_id AS "currentVersionId"
        FROM artifacts
        WHERE installation_id = ${installationId}
        ORDER BY id
      `.withoutTransform,
      sql<VersionRow>`
        SELECT
          id,
          artifact_id AS "artifactId",
          project_id AS "projectId",
          manifest_digest AS "manifestDigest",
          entry_path AS "entryPath",
          routing_mode AS "routingMode"
        FROM versions
        WHERE installation_id = ${installationId}
        ORDER BY artifact_id, number
      `.withoutTransform,
      sql<EntryRow>`
        SELECT
          version_id AS "versionId",
          path,
          CAST(size AS DOUBLE PRECISION) AS size,
          media_type AS "mediaType",
          sha256,
          disposition
        FROM manifest_entries
        WHERE installation_id = ${installationId}
        ORDER BY version_id, path
      `.withoutTransform,
      sql<AssetRow>`
        SELECT id, artifact_id AS "artifactId", sha256,
          CAST(size AS DOUBLE PRECISION) AS size
        FROM assets
        WHERE installation_id = ${installationId} AND deleted_at IS NULL
        ORDER BY id
      `.withoutTransform,
      sql<ProjectRow>`
        SELECT id FROM projects
        WHERE installation_id = ${installationId}
        ORDER BY id
      `.withoutTransform,
      sql<ProjectReferenceRow>`
        SELECT 'action' AS kind, id, project_id AS "projectId",
          artifact_id AS "artifactId", version_id AS "versionId"
        FROM actions WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'idempotency', idempotency_key, project_id,
          artifact_id, version_id
        FROM idempotency_records WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'staged_upload', id, project_id, NULL, committed_version_id
        FROM staged_uploads WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'content_bootstrap', token_digest, project_id,
          artifact_id, version_id
        FROM content_bootstraps WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'content_session', token_digest, project_id,
          artifact_id, version_id
        FROM content_sessions WHERE installation_id = ${installationId}
        ORDER BY kind, id
      `.withoutTransform,
    ]);
    return {
      artifacts: decodeArtifactRows(artifacts),
      assets: decodeAssetRows(assets),
      entries: decodeEntryRows(entries),
      projects: decodeProjectRows(projects),
      projectReferences: decodeProjectReferenceRows(projectReferences),
      versions: decodeVersionRows(versions),
    } satisfies IntegrityCatalog;
  });
}
