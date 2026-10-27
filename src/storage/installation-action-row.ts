import {z} from "zod";

import {
  type InstallationActionKind,
  installationActionKinds,
  type InstallationActionPage,
  type InstallationActor,
} from "../core/model.js";

/** One installation change a repository records inside the change's transaction. */
export interface NewInstallationAction {
  readonly actor: InstallationActor;
  readonly createdAt: string;
  readonly kind: InstallationActionKind;
  readonly subjectId: string;
}

/**
 * Whether a change can happen to its subject only once. Those changes carry an
 * action key, so a replayed revoke or deactivate records nothing. A project
 * can be renamed, archived, and unarchived again, so those carry none.
 */
const happensOnce = {
  [installationActionKinds.apiKeyIssued]: true,
  [installationActionKinds.apiKeyRevoked]: true,
  [installationActionKinds.memberAdmitted]: true,
  [installationActionKinds.memberDeactivated]: true,
  [installationActionKinds.projectArchived]: false,
  [installationActionKinds.projectCreated]: true,
  [installationActionKinds.projectRenamed]: false,
  [installationActionKinds.projectUnarchived]: false,
} satisfies Record<InstallationActionKind, boolean>;

/** The unique action key of a once-only change, or null for a repeatable one. */
export function installationActionKey(action: NewInstallationAction): string | null {
  return happensOnce[action.kind] ? `${action.kind}:${action.subjectId}` : null;
}

/** Columns selected for one installation action, named as the record's fields. */
export const installationActionColumns = `id, kind, subject_id AS "subjectId",
  principal_id AS "principalId",
  principal_display_name AS "principalDisplayName",
  authorized_by_principal_id AS "authorizedByPrincipalId",
  created_at AS "createdAt"`;

const installationActionRowSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  kind: z.enum(installationActionKinds),
  principalDisplayName: z.string(),
  principalId: z.string(),
  subjectId: z.string(),
});

/** One page from rows read newest first with one row past the limit. */
export function installationActionPage(
  rows: readonly unknown[],
  limit: number,
): InstallationActionPage {
  const parsed = z.array(installationActionRowSchema).parse(rows);
  const items = parsed.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: parsed.length > limit && last !== undefined
      ? {createdAt: last.createdAt, id: last.id}
      : null,
  };
}
