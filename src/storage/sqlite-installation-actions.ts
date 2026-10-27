import type {DatabaseSync} from "node:sqlite";

import type {ListInstallationActions} from "../core/identity-ports.js";
import type {InstallationActionPage} from "../core/model.js";
import {
  installationActionColumns,
  installationActionKey,
  installationActionPage,
  type NewInstallationAction,
} from "./installation-action-row.js";

/**
 * Create the installation action history. The artifact and identity
 * repositories share one SQLite file and either may open it first, so both
 * run this.
 */
export function createSqliteInstallationActions(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS installation_actions (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'project_created', 'project_renamed', 'project_archived',
        'project_unarchived', 'member_admitted', 'member_deactivated',
        'api_key_issued', 'api_key_revoked'
      )),
      subject_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      principal_display_name TEXT NOT NULL,
      authorized_by_principal_id TEXT,
      action_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (installation_id, action_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS installation_actions_created
      ON installation_actions (installation_id, created_at DESC, id DESC);
  `);
}

/** Record one installation change; a once-only change already recorded is skipped. */
export function insertSqliteInstallationAction(
  database: DatabaseSync,
  installationId: string,
  action: NewInstallationAction,
): void {
  database.prepare(`
    INSERT INTO installation_actions (
      id, installation_id, kind, subject_id, principal_id,
      principal_display_name, authorized_by_principal_id, action_key, created_at
    ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (installation_id, action_key) DO NOTHING
  `).run(
    installationId,
    action.kind,
    action.subjectId,
    action.actor.principalId,
    action.actor.principalDisplayName,
    action.actor.authorizedByPrincipalId,
    installationActionKey(action),
    action.createdAt,
  );
}

/** One page of the installation action history, newest first. */
export function listSqliteInstallationActions(
  database: DatabaseSync,
  command: ListInstallationActions,
): InstallationActionPage {
  const cursorCreatedAt = command.cursor?.createdAt ?? null;
  const rows = database.prepare(`
    SELECT ${installationActionColumns}
    FROM installation_actions
    WHERE installation_id = ?
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(
    command.installationId,
    cursorCreatedAt,
    cursorCreatedAt,
    cursorCreatedAt,
    command.cursor?.id ?? null,
    command.limit + 1,
  );
  return installationActionPage(rows, command.limit);
}
