import {DatabaseSync} from "node:sqlite";

import {
  decodeArtifactRows,
  decodeAssetRows,
  decodeEntryRows,
  decodeProjectReferenceRows,
  decodeProjectRows,
  decodeVersionRows,
  type IntegrityCatalog,
} from "../core/integrity-catalog.js";

/** Read the compact catalog read-only after SQLite reports a clean quick check. */
export function readSqliteIntegrityCatalog(databasePath: string): IntegrityCatalog {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    open: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    database.enableDefensive(true);
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (!quickCheck.some((row) => row["quick_check"] === "ok")) {
      throw new Error("SQLite quick check failed.");
    }
    return {
      artifacts: decodeArtifactRows(database.prepare(`
        SELECT id, project_id AS projectId,
          current_version_id AS currentVersionId
        FROM artifacts
        ORDER BY id
      `).all()),
      assets: decodeAssetRows(database.prepare(`
        SELECT id, artifact_id AS artifactId, sha256, size
        FROM assets
        WHERE deleted_at IS NULL
        ORDER BY id
      `).all()),
      entries: decodeEntryRows(database.prepare(`
        SELECT
          version_id AS versionId,
          path,
          size,
          media_type AS mediaType,
          sha256,
          disposition
        FROM manifest_entries
        ORDER BY version_id, path
      `).all()),
      projects: decodeProjectRows(database.prepare(`
        SELECT id FROM projects ORDER BY id
      `).all()),
      projectReferences: decodeProjectReferenceRows(database.prepare(`
        SELECT 'action' AS kind, id, project_id AS projectId,
          artifact_id AS artifactId, version_id AS versionId
        FROM actions
        UNION ALL
        SELECT 'idempotency', idempotency_key, project_id,
          artifact_id, version_id
        FROM idempotency_records
        UNION ALL
        SELECT 'staged_upload', id, project_id, NULL, committed_version_id
        FROM staged_uploads
        UNION ALL
        SELECT 'content_bootstrap', token_digest, project_id,
          artifact_id, version_id
        FROM content_bootstraps
        UNION ALL
        SELECT 'content_session', token_digest, project_id,
          artifact_id, version_id
        FROM content_sessions
        ORDER BY kind, id
      `).all()),
      versions: decodeVersionRows(database.prepare(`
        SELECT
          id,
          artifact_id AS artifactId,
          project_id AS projectId,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode
        FROM versions
        ORDER BY artifact_id, number
      `).all()),
    };
  } finally {
    database.close();
  }
}
