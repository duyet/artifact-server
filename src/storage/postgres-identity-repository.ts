import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {isSqlError} from "effect/unstable/sql/SqlError";
import {z} from "zod";

import {
  IdentityConflict,
  IdentityNotFound,
  LoginAttemptRejected,
} from "../core/errors.js";
import type {
  AdmitMemberRecord,
  BootstrapManagedApiKeyRepository,
  CreateApplicationSessionRecord,
  ListInstallationActions,
} from "../core/identity-ports.js";
import {
  type ApplicationSession,
  type InstallationMember,
  type LoginAttempt,
  type ManagedApiKey,
  memberStatuses,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../core/identity.js";
import {
  type InstallationActionPage,
  installationActionKinds,
  type InstallationActor,
} from "../core/model.js";
import type {PostgresDatabase} from "./postgres-database.js";
import {
  insertPostgresInstallationAction,
  listPostgresInstallationActions,
} from "./postgres-installation-actions.js";

const membershipRoleSchema = z.enum([
  membershipRoles.administrator,
  membershipRoles.member,
]);
const memberStatusSchema = z.enum([
  memberStatuses.active,
  memberStatuses.inactive,
]);
const principalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);
const principalCapabilitySchema = z.enum([
  principalCapabilities.connectAgents,
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageProjects,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.readArtifacts,
  principalCapabilities.writeComments,
]);
const memberRowSchema = z.object({
  createdAt: z.string(),
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  installationId: z.string(),
  role: membershipRoleSchema,
  status: memberStatusSchema,
  updatedAt: z.string(),
});
const sessionRowSchema = z.object({
  createdAt: z.string(),
  csrfDigest: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  memberCreatedAt: z.string(),
  memberDisplayName: z.string(),
  memberEmail: z.string(),
  memberId: z.string(),
  memberRole: membershipRoleSchema,
  memberStatus: memberStatusSchema,
  memberUpdatedAt: z.string(),
  revokedAt: z.string().nullable(),
  tokenDigest: z.string(),
});
const apiKeySessionRowSchema = z.object({
  sessionCreatedAt: z.string(),
  sessionCsrfDigest: z.string(),
  sessionExpiresAt: z.string(),
  sessionId: z.string(),
  sessionRevokedAt: z.string().nullable(),
  sessionTokenDigest: z.string(),
});
const apiKeyRowSchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilitiesJson: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  prefix: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
  revokedAt: z.string().nullable(),
  rotatedFromId: z.string().nullable(),
  secretDigest: z.string(),
});
const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  nonce: z.string().nullable(),
  provider: z.string(),
  returnTo: z.string(),
  stateDigest: z.string(),
});
const countRowSchema = z.object({count: z.coerce.number().int().nonnegative()});

/** Installation-scoped Postgres persistence for membership and credentials. */
export class PostgresIdentityRepository implements BootstrapManagedApiKeyRepository {
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  constructor(database: PostgresDatabase, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  async hasMembers(installationId: string): Promise<boolean> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{present: boolean}>(
        `SELECT EXISTS(
          SELECT 1 FROM installation_members WHERE installation_id = $1
        ) AS present`,
        [installationId],
      );
      return z.object({present: z.boolean()}).parse(rows[0]).present;
    }));
  }

  async admitMember(command: AdmitMemberRecord): Promise<InstallationMember> {
    this.#assertInstallationScope(command.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* sql`INSERT INTO installation_members (
          installation_id, id, email, display_name, role, status,
          created_at, updated_at
        ) VALUES (
          ${command.installationId}, ${command.id}, ${command.email},
          ${command.displayName}, ${command.role}, ${memberStatuses.active},
          ${command.createdAt}, ${command.createdAt}
        )`.pipe(Effect.mapError((cause) =>
          isConstraintFailure(cause)
            ? new IdentityConflict({
              message: "That email is already admitted to this installation.",
            })
            : cause
        ));
        yield* insertPostgresInstallationAction(command.installationId, {
          actor: command.actor,
          createdAt: command.createdAt,
          kind: installationActionKinds.memberAdmitted,
          subjectId: command.id,
        });
        const member = yield* this.#findMember(command.installationId, command.id, false);
        if (member === null) throw new Error("The admitted member was not persisted.");
        return member;
      }));
    }));
  }

  async listMembers(installationId: string): Promise<readonly InstallationMember[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(memberSelect(
        "WHERE installation_id = $1 ORDER BY created_at ASC, id ASC",
      ), [installationId]);
      return z.array(memberRowSchema).parse(rows);
    }));
  }

  async findMember(
    installationId: string,
    memberId: string,
  ): Promise<InstallationMember | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(this.#findMember(installationId, memberId, false));
  }

  async findActiveMemberByEmail(
    installationId: string,
    email: string,
  ): Promise<InstallationMember | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(memberSelect(
        "WHERE installation_id = $1 AND email = $2 AND status = $3",
      ), [installationId, email, memberStatuses.active]);
      return memberRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async deactivateMember(
    installationId: string,
    memberId: string,
    updatedAt: string,
    actor: InstallationActor,
  ): Promise<InstallationMember> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`artifact-server:member-policy:${installationId}`}, 0)
        )`;
        const existing = yield* this.#findMember(installationId, memberId, true);
        if (existing === null) {
          return yield* new IdentityNotFound({message: "The member does not exist."});
        }
        if (
          existing.status === memberStatuses.active &&
          existing.role === membershipRoles.administrator
        ) {
          const rows = yield* sql.unsafe<object>(
            `SELECT COUNT(*) AS count FROM installation_members
             WHERE installation_id = $1 AND role = $2 AND status = $3`,
            [
              installationId,
              membershipRoles.administrator,
              memberStatuses.active,
            ],
          );
          if (countRowSchema.parse(rows[0]).count <= 1) {
            return yield* new IdentityConflict({
              message: "The installation must retain one active administrator.",
            });
          }
        }
        yield* sql`UPDATE installation_members
          SET status = ${memberStatuses.inactive}, updated_at = ${updatedAt}
          WHERE installation_id = ${installationId} AND id = ${memberId}`;
        yield* sql`UPDATE application_sessions
          SET revoked_at = COALESCE(revoked_at, ${updatedAt})
          WHERE installation_id = ${installationId} AND member_id = ${memberId}`;
        yield* sql`UPDATE managed_api_keys
          SET revoked_at = COALESCE(revoked_at, ${updatedAt})
          WHERE installation_id = ${installationId}
            AND principal_kind = ${principalKinds.human}
            AND principal_id = ${memberId}`;
        yield* insertPostgresInstallationAction(installationId, {
          actor,
          createdAt: updatedAt,
          kind: installationActionKinds.memberDeactivated,
          subjectId: memberId,
        });
        return {...existing, status: memberStatuses.inactive, updatedAt};
      }));
    }));
  }

  async createApplicationSession(
    command: CreateApplicationSessionRecord,
  ): Promise<ApplicationSession> {
    this.#assertInstallationScope(command.installationId);
    const subject = command.subject;
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      switch (subject.kind) {
        case "member":
          yield* sql`INSERT INTO application_sessions (
            installation_id, id, member_id, token_digest, csrf_digest,
            created_at, expires_at, revoked_at
          ) VALUES (
            ${command.installationId}, ${command.id}, ${subject.memberId},
            ${command.tokenDigest}, ${command.csrfDigest}, ${command.createdAt},
            ${command.expiresAt}, NULL
          )`;
          return;
        case "api_key":
          yield* sql`INSERT INTO api_key_sessions (
            installation_id, id, api_key_id, token_digest, csrf_digest,
            created_at, expires_at, revoked_at
          ) VALUES (
            ${command.installationId}, ${command.id}, ${subject.apiKeyId},
            ${command.tokenDigest}, ${command.csrfDigest}, ${command.createdAt},
            ${command.expiresAt}, NULL
          )`;
          return;
      }
    }));
    const session = await this.findApplicationSession(
      command.installationId,
      command.tokenDigest,
      command.createdAt,
    );
    if (session === null) throw new Error("The application session was not persisted.");
    return session;
  }

  async findApplicationSession(
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ): Promise<ApplicationSession | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT session.id, session.installation_id AS "installationId",
          session.token_digest AS "tokenDigest",
          session.csrf_digest AS "csrfDigest",
          session.created_at AS "createdAt", session.expires_at AS "expiresAt",
          session.revoked_at AS "revokedAt", member.id AS "memberId",
          member.email AS "memberEmail",
          member.display_name AS "memberDisplayName",
          member.role AS "memberRole", member.status AS "memberStatus",
          member.created_at AS "memberCreatedAt",
          member.updated_at AS "memberUpdatedAt"
         FROM application_sessions AS session
         JOIN installation_members AS member
           ON member.installation_id = session.installation_id
          AND member.id = session.member_id
         WHERE session.installation_id = $1 AND session.token_digest = $2
           AND session.revoked_at IS NULL AND session.expires_at > $3
           AND member.status = $4`,
        [installationId, tokenDigest, requestTime, memberStatuses.active],
      );
      const parsed = sessionRowSchema.nullable().parse(rows[0] ?? null);
      if (parsed === null) {
        return yield* findApiKeySession(installationId, tokenDigest, requestTime);
      }
      const session: ApplicationSession = {
        createdAt: parsed.createdAt,
        csrfDigest: parsed.csrfDigest,
        expiresAt: parsed.expiresAt,
        id: parsed.id,
        installationId: parsed.installationId,
        revokedAt: parsed.revokedAt,
        subject: {
          kind: "member",
          member: {
            createdAt: parsed.memberCreatedAt,
            displayName: parsed.memberDisplayName,
            email: parsed.memberEmail,
            id: parsed.memberId,
            installationId: parsed.installationId,
            role: parsed.memberRole,
            status: parsed.memberStatus,
            updatedAt: parsed.memberUpdatedAt,
          },
        },
        tokenDigest: parsed.tokenDigest,
      };
      return session;
    }));
  }

  async revokeApplicationSession(
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ): Promise<void> {
    this.#assertInstallationScope(installationId);
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE application_sessions
        SET revoked_at = COALESCE(revoked_at, ${revokedAt})
        WHERE installation_id = ${installationId}
          AND token_digest = ${tokenDigest}`;
      yield* sql`UPDATE api_key_sessions
        SET revoked_at = COALESCE(revoked_at, ${revokedAt})
        WHERE installation_id = ${installationId}
          AND token_digest = ${tokenDigest}`;
    }));
  }

  async createApiKey(
    key: StoredManagedApiKey,
    actor: InstallationActor,
  ): Promise<ManagedApiKey> {
    this.#assertInstallationScope(key.installationId);
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(this.#insertIssuedApiKey(key, actor));
    }));
    return withoutSecretDigest(key);
  }

  async initializeBootstrapApiKey(
    key: StoredManagedApiKey,
    actor: InstallationActor,
  ): Promise<StoredManagedApiKey> {
    this.#assertInstallationScope(key.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* sql.unsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`artifact-server-bootstrap:${key.installationId}`],
        );
        const existing = yield* this.#findApiKey(
          key.installationId,
          key.id,
          false,
        );
        if (existing !== null) return existing;
        const rows = yield* sql.unsafe<{count: number}>(`
          SELECT (
            (SELECT COUNT(*) FROM installation_members WHERE installation_id = $1)
            + (SELECT COUNT(*) FROM managed_api_keys WHERE installation_id = $1)
          ) AS count
        `, [key.installationId]);
        if (countRowSchema.parse(rows[0]).count > 0) {
          return yield* new IdentityConflict({
            message:
              "The private-team bootstrap key id cannot change after installation identity exists.",
          });
        }
        yield* this.#insertIssuedApiKey(key, actor);
        return key;
      }));
    }));
  }

  async findApiKey(
    installationId: string,
    keyId: string,
  ): Promise<StoredManagedApiKey | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(this.#findApiKey(installationId, keyId, false));
  }

  async listApiKeys(installationId: string): Promise<readonly ManagedApiKey[]> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(apiKeySelect(
        "WHERE installation_id = $1 ORDER BY created_at DESC, id DESC",
      ), [installationId]);
      return z.array(apiKeyRowSchema).parse(rows).map((row) =>
        withoutSecretDigest(parseApiKey(row))
      );
    }));
  }

  async revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
    actor: InstallationActor,
  ): Promise<ManagedApiKey> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const updated = yield* sql`UPDATE managed_api_keys
          SET revoked_at = COALESCE(revoked_at, ${revokedAt})
          WHERE installation_id = ${installationId} AND id = ${keyId}
          RETURNING id`;
        if (updated.length !== 1) {
          return yield* new IdentityNotFound({
            message: "The API key does not exist.",
          });
        }
        yield* revokeApiKeySessions(installationId, keyId, revokedAt);
        yield* insertPostgresInstallationAction(installationId, {
          actor,
          createdAt: revokedAt,
          kind: installationActionKinds.apiKeyRevoked,
          subjectId: keyId,
        });
        const key = yield* this.#findApiKey(installationId, keyId, false);
        if (key === null) throw new Error("The revoked API key disappeared.");
        return withoutSecretDigest(key);
      }));
    }));
  }

  async rotateApiKey(
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
    actor: InstallationActor,
  ): Promise<ManagedApiKey> {
    this.#assertInstallationScope(installationId);
    this.#assertInstallationScope(replacement.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const existing = yield* this.#findApiKey(
          installationId,
          previousKeyId,
          true,
        );
        if (existing === null) {
          return yield* new IdentityNotFound({
            message: "The API key does not exist.",
          });
        }
        if (existing.revokedAt !== null) {
          return yield* new IdentityConflict({
            message: "A revoked API key cannot be rotated.",
          });
        }
        yield* sql`UPDATE managed_api_keys SET revoked_at = ${revokedAt}
          WHERE installation_id = ${installationId} AND id = ${previousKeyId}`;
        yield* revokeApiKeySessions(installationId, previousKeyId, revokedAt);
        yield* insertPostgresInstallationAction(installationId, {
          actor,
          createdAt: revokedAt,
          kind: installationActionKinds.apiKeyRevoked,
          subjectId: previousKeyId,
        });
        yield* this.#insertIssuedApiKey(replacement, actor);
        return withoutSecretDigest(replacement);
      }));
    }));
  }

  async listInstallationActions(
    command: ListInstallationActions,
  ): Promise<InstallationActionPage> {
    this.#assertInstallationScope(command.installationId);
    return this.#database.run(listPostgresInstallationActions(command));
  }

  async createLoginAttempt(attempt: LoginAttempt): Promise<void> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      // `/auth/login` is unauthenticated, so every insert clears the attempts
      // that can no longer be consumed instead of growing the table forever.
      yield* sql`DELETE FROM login_attempts
        WHERE installation_id = ${installationId}
          AND expires_at <= ${attempt.createdAt}`;
      yield* sql`INSERT INTO login_attempts (
        installation_id, state_digest, provider, code_verifier, nonce, return_to,
        created_at, expires_at, consumed_at
      ) VALUES (
        ${installationId}, ${attempt.stateDigest}, ${attempt.provider},
        ${attempt.codeVerifier}, ${attempt.nonce}, ${attempt.returnTo},
        ${attempt.createdAt}, ${attempt.expiresAt}, NULL
      )`;
    }));
  }

  async consumeLoginAttempt(
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ): Promise<LoginAttempt> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const rows = yield* sql.unsafe<object>(
          `SELECT state_digest AS "stateDigest", provider,
            code_verifier AS "codeVerifier", nonce, return_to AS "returnTo",
            created_at AS "createdAt", expires_at AS "expiresAt"
           FROM login_attempts
           WHERE installation_id = $1 AND state_digest = $2 AND provider = $3
             AND consumed_at IS NULL AND expires_at > $4
           FOR UPDATE`,
          [installationId, stateDigest, provider, consumedAt],
        );
        const attempt = loginAttemptRowSchema.nullable().parse(rows[0] ?? null);
        if (attempt === null) {
          return yield* new LoginAttemptRejected({
            message: "The browser login attempt is invalid or no longer active.",
          });
        }
        const updated = yield* sql`UPDATE login_attempts
          SET consumed_at = ${consumedAt}
          WHERE installation_id = ${installationId}
            AND state_digest = ${stateDigest}
            AND consumed_at IS NULL
          RETURNING state_digest`;
        if (updated.length !== 1) {
          return yield* new LoginAttemptRejected({
            message: "The browser login attempt was already used.",
          });
        }
        return attempt;
      }));
    }));
  }

  #assertInstallationScope(installationId: string): void {
    if (installationId !== this.#installationId) {
      throw new IdentityNotFound({
        message: "The installation identity does not exist in this repository.",
      });
    }
  }

  #findMember(
    installationId: string,
    memberId: string,
    lock: boolean,
  ): Effect.Effect<InstallationMember | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(memberSelect(
        `WHERE installation_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      ), [installationId, memberId]);
      return memberRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #findApiKey(
    installationId: string,
    keyId: string,
    lock: boolean,
  ): Effect.Effect<StoredManagedApiKey | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(apiKeySelect(
        `WHERE installation_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      ), [installationId, keyId]);
      const row = apiKeyRowSchema.nullable().parse(rows[0] ?? null);
      return row === null ? null : parseApiKey(row);
    });
  }

  #insertIssuedApiKey(
    key: StoredManagedApiKey,
    actor: InstallationActor,
  ): Effect.Effect<void, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      yield* this.#insertApiKey(key);
      yield* insertPostgresInstallationAction(key.installationId, {
        actor,
        createdAt: key.createdAt,
        kind: installationActionKinds.apiKeyIssued,
        subjectId: key.id,
      });
    });
  }

  #insertApiKey(
    key: StoredManagedApiKey,
  ): Effect.Effect<void, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO managed_api_keys (
        installation_id, id, name, prefix, secret_digest, principal_id,
        principal_kind, capabilities_json, authorized_by_principal_id,
        created_at, expires_at, revoked_at, rotated_from_id
      ) VALUES (
        ${key.installationId}, ${key.id}, ${key.name}, ${key.prefix},
        ${key.secretDigest}, ${key.principalId}, ${key.principalKind},
        ${JSON.stringify(key.capabilities)}, ${key.authorizedByPrincipalId},
        ${key.createdAt}, ${key.expiresAt}, ${key.revokedAt},
        ${key.rotatedFromId}
      )`;
    });
  }
}

const findApiKeySession = Effect.fnUntraced(function*(
  installationId: string,
  tokenDigest: string,
  requestTime: string,
) {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<object>(
    `SELECT session.id AS "sessionId",
      session.token_digest AS "sessionTokenDigest",
      session.csrf_digest AS "sessionCsrfDigest",
      session.created_at AS "sessionCreatedAt",
      session.expires_at AS "sessionExpiresAt",
      session.revoked_at AS "sessionRevokedAt",
      api_key.id, api_key.installation_id AS "installationId",
      api_key.name, api_key.prefix,
      api_key.secret_digest AS "secretDigest",
      api_key.principal_id AS "principalId",
      api_key.principal_kind AS "principalKind",
      api_key.capabilities_json AS "capabilitiesJson",
      api_key.authorized_by_principal_id AS "authorizedByPrincipalId",
      api_key.created_at AS "createdAt", api_key.expires_at AS "expiresAt",
      api_key.revoked_at AS "revokedAt",
      api_key.rotated_from_id AS "rotatedFromId"
     FROM api_key_sessions AS session
     JOIN managed_api_keys AS api_key
       ON api_key.installation_id = session.installation_id
      AND api_key.id = session.api_key_id
     WHERE session.installation_id = $1 AND session.token_digest = $2
       AND session.revoked_at IS NULL AND session.expires_at > $3
       AND api_key.revoked_at IS NULL AND api_key.expires_at > $3`,
    [installationId, tokenDigest, requestTime],
  );
  if (rows[0] === undefined) return null;
  const session = apiKeySessionRowSchema.parse(rows[0]);
  const found: ApplicationSession = {
    createdAt: session.sessionCreatedAt,
    csrfDigest: session.sessionCsrfDigest,
    expiresAt: session.sessionExpiresAt,
    id: session.sessionId,
    installationId,
    revokedAt: session.sessionRevokedAt,
    subject: {
      apiKey: withoutSecretDigest(parseApiKey(apiKeyRowSchema.parse(rows[0]))),
      kind: "api_key",
    },
    tokenDigest: session.sessionTokenDigest,
  };
  return found;
});

const revokeApiKeySessions = Effect.fnUntraced(function*(
  installationId: string,
  keyId: string,
  revokedAt: string,
) {
  const sql = yield* SqlClient;
  yield* sql`UPDATE api_key_sessions
    SET revoked_at = COALESCE(revoked_at, ${revokedAt})
    WHERE installation_id = ${installationId} AND api_key_id = ${keyId}`;
});

function memberSelect(suffix: string): string {
  return `SELECT id, installation_id AS "installationId", email,
    display_name AS "displayName", role, status,
    created_at AS "createdAt", updated_at AS "updatedAt"
    FROM installation_members ${suffix}`;
}

function apiKeySelect(suffix: string): string {
  return `SELECT id, installation_id AS "installationId", name, prefix,
    secret_digest AS "secretDigest", principal_id AS "principalId",
    principal_kind AS "principalKind",
    capabilities_json AS "capabilitiesJson",
    authorized_by_principal_id AS "authorizedByPrincipalId",
    created_at AS "createdAt", expires_at AS "expiresAt",
    revoked_at AS "revokedAt", rotated_from_id AS "rotatedFromId"
    FROM managed_api_keys ${suffix}`;
}

function parseApiKey(
  row: z.infer<typeof apiKeyRowSchema>,
): StoredManagedApiKey {
  const decoded: unknown = JSON.parse(row.capabilitiesJson);
  const capabilities = z.array(principalCapabilitySchema).parse(decoded);
  return {
    authorizedByPrincipalId: row.authorizedByPrincipalId,
    capabilities,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    id: row.id,
    installationId: row.installationId,
    name: row.name,
    prefix: row.prefix,
    principalId: row.principalId,
    principalKind: row.principalKind,
    revokedAt: row.revokedAt,
    rotatedFromId: row.rotatedFromId,
    secretDigest: row.secretDigest,
  };
}

function withoutSecretDigest(key: StoredManagedApiKey): ManagedApiKey {
  const {secretDigest: _secretDigest, ...metadata} = key;
  return metadata;
}


function isConstraintFailure(cause: unknown): boolean {
  if (isSqlError(cause)) {
    return cause.reason._tag === "ConstraintError" ||
      cause.reason._tag === "UniqueViolation";
  }
  return false;
}
