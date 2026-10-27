import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import type {ListInstallationActions} from "../core/identity-ports.js";
import {
  installationActionColumns,
  installationActionKey,
  installationActionPage,
  type NewInstallationAction,
} from "./installation-action-row.js";

/** Record one installation change; a once-only change already recorded is skipped. */
export const insertPostgresInstallationAction = Effect.fnUntraced(function*(
  installationId: string,
  action: NewInstallationAction,
) {
  const sql = yield* SqlClient;
  yield* sql`INSERT INTO installation_actions (
      installation_id, id, kind, subject_id, principal_id,
      principal_display_name, authorized_by_principal_id, action_key, created_at
    ) VALUES (
      ${installationId}, gen_random_uuid()::text, ${action.kind},
      ${action.subjectId}, ${action.actor.principalId},
      ${action.actor.principalDisplayName},
      ${action.actor.authorizedByPrincipalId},
      ${installationActionKey(action)}, ${action.createdAt}
    ) ON CONFLICT (installation_id, action_key) DO NOTHING`;
});

/** One page of the installation action history, newest first. */
export const listPostgresInstallationActions = Effect.fnUntraced(function*(
  command: ListInstallationActions,
) {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<object>(
    `SELECT ${installationActionColumns}
     FROM installation_actions
     WHERE installation_id = $1
       AND ($2::text IS NULL OR created_at < $2
         OR (created_at = $2 AND id < $3))
     ORDER BY created_at DESC, id DESC
     LIMIT $4`,
    [
      command.installationId,
      command.cursor?.createdAt ?? null,
      command.cursor?.id ?? null,
      command.limit + 1,
    ],
  );
  return installationActionPage(rows, command.limit);
});
