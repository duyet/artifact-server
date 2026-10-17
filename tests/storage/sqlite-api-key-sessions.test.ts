import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {principalCapabilities} from "../../src/core/identity.js";
import type {StoredManagedApiKey} from "../../src/core/installation-identity.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const installationId = "installation_api_key_sessions";
const createdAt = "2026-10-01T00:00:00.000Z";
const requestTime = "2026-10-02T00:00:00.000Z";

function storedKey(id: string, expiresAt = "2027-01-01T00:00:00.000Z"): StoredManagedApiKey {
  return {
    authorizedByPrincipalId: "member_admin",
    capabilities: [principalCapabilities.readArtifacts],
    createdAt,
    expiresAt,
    id,
    installationId,
    name: `Key ${id}`,
    prefix: `as_key_${id}`,
    principalId: `service:${id}`,
    principalKind: "service",
    revokedAt: null,
    rotatedFromId: null,
    secretDigest: `digest-${id}`,
  };
}

function keySession(apiKeyId: string, tokenDigest: string, expiresAt = "2026-10-03T00:00:00.000Z") {
  return {
    createdAt,
    csrfDigest: `csrf-${tokenDigest}`,
    expiresAt,
    id: `session_${tokenDigest}`,
    installationId,
    subject: {apiKeyId, kind: "api_key" as const},
    tokenDigest,
  };
}

describe("SQLite API-key browser sessions", () => {
  let directory: string;
  let databasePath: string;
  let repository: SqliteIdentityRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "api-key-sessions-"));
    databasePath = path.join(directory, "artifact-server.db");
    repository = new SqliteIdentityRepository(databasePath);
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, {force: true, recursive: true});
  });

  test("AUTH-030-B: a key session resolves to its key until the session or the key ends", async () => {
    await repository.createApiKey(storedKey("key_live"));
    const created = await repository.createApplicationSession(
      keySession("key_live", "token-live"),
    );
    const {secretDigest: _secretDigest, ...metadata} = storedKey("key_live");
    expect(created.subject).toEqual({apiKey: metadata, kind: "api_key"});

    const found = await repository.findApplicationSession(
      installationId,
      "token-live",
      requestTime,
    );
    expect(found).toEqual({
      createdAt,
      csrfDigest: "csrf-token-live",
      expiresAt: "2026-10-03T00:00:00.000Z",
      id: "session_token-live",
      installationId,
      revokedAt: null,
      subject: {apiKey: metadata, kind: "api_key"},
      tokenDigest: "token-live",
    });
    expect(await repository.findApplicationSession(
      installationId,
      "token-live",
      "2026-10-03T00:00:00.000Z",
    )).toBeNull();
    expect(await repository.findApplicationSession(
      "another-installation",
      "token-live",
      requestTime,
    )).toBeNull();

    await repository.revokeApplicationSession(installationId, "token-live", requestTime);
    expect(await repository.findApplicationSession(
      installationId,
      "token-live",
      requestTime,
    )).toBeNull();
  });

  test("foundation: revoking, rotating, or expiring the key ends every session it signed in", async () => {
    await repository.createApiKey(storedKey("key_revoked"));
    await repository.createApiKey(storedKey("key_rotated"));
    await repository.createApiKey(
      storedKey("key_expiring", "2026-10-02T12:00:00.000Z"),
    );
    await repository.createApplicationSession(keySession("key_revoked", "token-revoked"));
    await repository.createApplicationSession(keySession("key_rotated", "token-rotated"));
    await repository.createApplicationSession(keySession("key_expiring", "token-expiring"));

    await repository.revokeApiKey(installationId, "key_revoked", requestTime);
    await repository.rotateApiKey(
      installationId,
      "key_rotated",
      {...storedKey("key_replacement"), rotatedFromId: "key_rotated"},
      requestTime,
    );

    const lookups = await Promise.all(
      ["token-revoked", "token-rotated", "token-expiring"].map((digest) =>
        repository.findApplicationSession(
          installationId,
          digest,
          "2026-10-02T12:00:00.000Z",
        )
      ),
    );
    expect(lookups).toEqual([null, null, null]);

    const database = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(database.prepare(
        "SELECT token_digest, revoked_at FROM api_key_sessions ORDER BY token_digest",
      ).all()).toEqual([
        {revoked_at: null, token_digest: "token-expiring"},
        {revoked_at: requestTime, token_digest: "token-revoked"},
        {revoked_at: requestTime, token_digest: "token-rotated"},
      ]);
    } finally {
      database.close();
    }
  });

  test("foundation: a session for a key that does not exist is refused", async () => {
    await expect(repository.createApplicationSession(
      keySession("key_missing", "token-missing"),
    )).rejects.toThrow("FOREIGN KEY constraint failed");
  });

  test("foundation: a schema-13 identity database gains the API-key session table", async () => {
    repository.close();
    const previous = new DatabaseSync(databasePath);
    try {
      previous.exec(`
        DROP TABLE api_key_sessions;
        PRAGMA user_version = 13;
      `);
    } finally {
      previous.close();
    }

    repository = new SqliteIdentityRepository(databasePath);
    await repository.createApiKey(storedKey("key_upgraded"));
    await repository.createApplicationSession(keySession("key_upgraded", "token-upgraded"));
    const found = await repository.findApplicationSession(
      installationId,
      "token-upgraded",
      requestTime,
    );
    expect(found?.subject.kind).toBe("api_key");

    const upgraded = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({user_version: 16});
      expect(upgraded.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'api_key_sessions_key_idx'",
      ).get()).toEqual({name: "api_key_sessions_key_idx"});
    } finally {
      upgraded.close();
    }
  });
});
