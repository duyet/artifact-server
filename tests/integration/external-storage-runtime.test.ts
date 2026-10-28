import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {request} from "node:http";
import path from "node:path";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import {Effect, Redacted} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {afterAll, afterEach, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import {duplicateArtifact} from
  "../../apps/web/src/artifact-actions/duplicate-artifact.js";
import {createBearerTransport} from
  "../../apps/web/src/artifact-actions/transport.js";
import {startExternalStorageServer} from "../../src/external-storage/start-external-storage-server.js";
import type {IssueOperatorKeyCommand} from
  "../../src/application/installation-access.js";
import {createExternalStorageRuntime} from
  "../../src/external-storage/create-external-storage-runtime.js";
import {checkExternalStorageIntegrity} from
  "../../src/external-storage/check-external-storage-integrity.js";
import {defaultStagingCleanupPolicy} from
  "../../src/lifecycle/staging-cleanup.js";
import type {ArtifactViewDrainReport} from
  "../../src/application/artifact-view-recorder.js";
import {createS3ObjectStorageProviderFactory} from
  "../../src/storage/s3-object-storage.js";
import {PostgresDatabase} from "../../src/storage/postgres-database.js";
import {
  assetListingSchema,
  assetPlanSchema,
  assetSchema,
  commitAsset,
  committedAssetSchema,
  deleteAsset,
  listAssets,
  planAsset,
  putAssetBytes,
  sha256,
} from "../support/assets.js";
import {MutableClock} from "../support/agent-dispatch.js";
import {
  type FakeOidcPerson,
  startFakeOidcProvider,
} from "../support/fake-oidc-provider.js";
import {unknownOidcUserPolicies} from "../../src/core/oidc-sign-in.js";
import {createOidcProvider} from "../../src/identity/oidc-provider.js";
import {requiredPostgresSchemaVersion} from
  "../../src/storage/postgres-migrations.js";
import {PostgresArtifactRepository} from "../../src/storage/postgres-artifact-repository.js";
import {PostgresIdentityRepository} from "../../src/storage/postgres-identity-repository.js";
import {defaultProjectId} from "../../src/core/model.js";
import {defaultAssetQuota} from "../../src/core/asset-policy.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {
  installationOperatorActor,
  managedApiKeyCredentialPattern,
} from "../../src/core/installation-identity.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const externalStorageCli = path.join(repositoryRoot, "dist/cli/main.js");
const region = "us-east-1";
const bucket = "artifact-server-external-storage-integration";
const installationId = "external-storage-integration-installation";
const apiToken = managedTestKey("external-storage-integration");
const administratorEmail = "administrator@example.test";
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const runningInProcessServers = new Set<InProcessExternalStorageServer>();
const day = 24 * 60 * 60 * 1_000;

const publishResponseSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    name: z.string(),
    path: z.string().nullable(),
    projectId: z.string(),
  }),
  links: z.object({artifact: z.url(), version: z.url()}),
  replayed: z.boolean(),
  version: z.object({
    id: z.string(),
    number: z.number().int().positive(),
    projectId: z.string(),
  }),
});

const taggedFailureSchema = z.object({_tag: z.string()}).loose();

const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});

const issuedKeySchema = z.object({
  apiKey: z.object({
    authorizedByPrincipalId: z.string(),
    id: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
    rotatedFromId: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});

const uploadResponseSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })),
  projectId: z.string(),
  uploadId: z.string(),
});

const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({
      currentVersionId: z.string(),
      id: z.string(),
      name: z.string(),
      projectId: z.string(),
    }),
    commentCount: z.number().int().nonnegative(),
  })),
});

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});

const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
}).loose();

const commentCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).strict();

const commentThreadEnvelopeSchema = z.object({thread: commentThreadSchema})
  .strict();

const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  threadId: z.string(),
}).loose();

const replyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
}).strict();

const commentPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();

const commentDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
}).strict();

const commentActionPageSchema = z.object({
  actions: z.array(z.object({action: z.string()}).loose()),
}).loose();

const commentFailureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

const publicArtifactViewCountsSchema = z.object({
  last7Days: z.number().int().nonnegative(),
  last30Days: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const publicArtifactTreeSchema = z.object({
  artifacts: z.array(z.object({
    name: z.string(),
    series: z.array(z.object({
      count: z.number().int().nonnegative(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    })),
    updates: z.array(z.object({
      count: z.number().int().positive(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    })),
    views: publicArtifactViewCountsSchema,
  })),
  truncated: z.boolean(),
}).loose();

const analyticsDayPattern = /^\d{4}-\d{2}-\d{2}$/u;

const projectActivityReportSchema = z.object({
  daily: z.array(z.object({
    day: z.string().regex(analyticsDayPattern),
    uploads: z.number().int().nonnegative(),
    views: z.number().int().nonnegative(),
  }).strict()),
  generatedAt: z.iso.datetime(),
  today: z.string().regex(analyticsDayPattern),
  topArtifacts: z.array(z.object({
    artifactId: z.string(),
    name: z.string(),
    total: z.number().int().nonnegative(),
    views30d: z.number().int().nonnegative(),
  }).strict()),
  totals: z.object({
    artifacts: z.number().int().nonnegative(),
    artifactsViewedToday: z.number().int().nonnegative(),
    averageViewsPerArtifact: z.number().nonnegative(),
    pageViews: z.number().int().nonnegative(),
    publicArtifacts: z.number().int().nonnegative(),
    uploadedToday: z.number().int().nonnegative(),
    uploads: z.number().int().nonnegative(),
  }).strict(),
  windowDays: z.literal(365),
}).strict();

const artifactActivityReportSchema = z.object({
  artifactId: z.string(),
  daily: z.array(z.object({
    day: z.string().regex(analyticsDayPattern),
    views: z.number().int().positive(),
  }).strict()),
  today: z.string().regex(analyticsDayPattern),
  views: publicArtifactViewCountsSchema.strict(),
  windowDays: z.literal(30),
}).strict();

const memberTreeSchema = z.object({
  artifacts: z.array(z.object({
    access: z.enum(["account_required", "public_link"]),
    manage: z.object({
      artifactId: z.string(),
      currentVersionId: z.string(),
      projectId: z.string(),
      tags: z.array(z.string()),
    }).strict().nullable(),
    mine: z.boolean(),
    name: z.string(),
    owner: z.string().nullable(),
    visibility: z.enum(["private", "public", "unlisted"]),
  }).loose()),
  viewer: z.object({name: z.string()}).strict().nullable(),
}).loose();

const mcpToolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});

const mcpAssetPlanSchema = z.object({
  commit: z.object({mcpTool: z.literal("asset_commit_upload"), uploadId: z.string()}),
  file: z.object({method: z.literal("PUT"), uploadUrl: z.url()}).loose(),
}).loose();

const artifactInfoSchema = z.object({
  artifactId: z.string(),
  canManage: z.boolean(),
  name: z.string(),
  owner: z.object({displayName: z.string().nullable()}).strict(),
  updatedAt: z.iso.datetime(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).strict(),
  views: z.object({
    daily: z.array(z.object({
      day: z.string().regex(analyticsDayPattern),
      views: z.number().int().positive(),
    }).strict()),
    last30Days: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  visibility: z.enum(["private", "public", "unlisted"]),
  windowDays: z.literal(30),
}).strict();

const artifactStateSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string()}).loose(),
  replayed: z.boolean(),
  version: z.object({id: z.string()}).loose(),
}).loose();

const artifactActionsSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    idempotencyKey: z.string(),
    versionId: z.string(),
  }).loose()),
}).loose();

const folderTreeSchema = z.object({
  artifacts: z.array(z.object({name: z.string()}).loose()),
  collapsedFolders: z.array(z.string()),
}).loose();

const folderDefaultSchema = z.object({
  defaultState: z.enum(["collapsed", "expanded"]),
  path: z.string(),
}).strict();

const sessionPrincipalSchema = z.object({
  principal: z.object({
    displayName: z.string(),
    id: z.string(),
    kind: z.string(),
    membershipRole: z.string(),
  }).loose(),
});

const memberAdmissionSchema = z.object({member: z.object({id: z.string()}).loose()}).loose();

const apiKeyListSchema = z.object({
  apiKeys: z.array(z.object({id: z.string(), principalId: z.string()}).loose()),
}).loose();

const authorshipSchema = z.object({
  artifact: z.object({
    name: z.string(),
    owner: z.object({displayName: z.string().nullable(), principalId: z.string()}),
  }),
  current: z.object({
    version: z.object({
      publisherDisplayName: z.string().nullable(),
      publisherPrincipalId: z.string(),
    }),
  }),
});

const publishedVersionAuthorSchema = z.object({
  version: z.object({
    id: z.string(),
    publisherDisplayName: z.string().nullable(),
    publisherPrincipalId: z.string(),
  }),
});

const assetReferenceSchema = z.object({
  confidence: z.enum(["certain", "heuristic"]),
  file: z.string(),
  kind: z.string(),
  line: z.number().nullable(),
  raw: z.string(),
  resolvedPath: z.string(),
}).strict();

const assetCheckReportSchema = z.object({
  artifactId: z.string(),
  references: z.array(assetReferenceSchema),
  summary: z.object({
    broken: z.number(),
    byKind: z.record(z.string(), z.number()),
    checkedFiles: z.number(),
    heuristic: z.number(),
    truncated: z.boolean(),
  }).strict(),
  version: z.object({id: z.string()}).loose(),
}).strict();

const assetCheckCommitSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  assetCheck: z.object({broken: z.number(), heuristic: z.number()}).strict().nullable(),
  version: z.object({id: z.string()}).loose(),
}).loose();

const mcpToolTextResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string()}).loose()),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});

const manifestSchema = z.object({
  digest: z.string(),
  entries: z.array(z.object({
    disposition: z.enum(["attachment", "inline"]),
    mediaType: z.string(),
    path: z.string(),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
  })),
  entryPath: z.string(),
  routingMode: z.enum(["spa", "static"]),
});

const versionManifestSchema = z.object({
  manifest: manifestSchema,
  version: z.object({id: z.string()}).loose(),
}).loose();

const artifactDetailsSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    name: z.string(),
    tags: z.array(z.string()),
  }).loose(),
  current: versionManifestSchema,
}).loose();

const versionListSchema = z.object({
  versions: z.array(z.object({version: z.object({id: z.string()}).loose()}).loose()),
}).loose();

interface IntegrationEnvironment {
  readonly accessKey: string;
  readonly databaseUrl: string;
  readonly endpoint: string;
  readonly postgresContainer: string;
  readonly postgresUser: string;
  readonly secretKey: string;
}

interface BackedUpObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>> | undefined;
}

interface ExternalStorageProcess {
  readonly baseUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

interface InProcessExternalStorageServer {
  readonly baseUrl: string;
  /** Write buffered entry-document view counts to Postgres now. */
  flushArtifactViews(): Promise<ArtifactViewDrainReport>;
  stop(): Promise<void>;
}

describe.sequential("external-storage Postgres and S3 runtime", () => {
  let environment: IntegrationEnvironment;
  let s3Client: S3Client;

  beforeAll(async () => {
    environment = readIntegrationEnvironment();
    s3Client = new S3Client({
      credentials: {
        accessKeyId: environment.accessKey,
        secretAccessKey: environment.secretKey,
      },
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
    });
    await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
  });

  afterEach(async () => {
    await Promise.all([
      ...[...runningProcesses].map(stopChild),
      ...[...runningInProcessServers].map((server) => server.stop()),
    ]);
  });

  test("external-storage foundation: migration status is read-only and serving begins only after explicit apply", async () => {
    const migrationEnvironment = {
      ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: installationId,
    };
    const before = await runExternalCli(["migrate", "status"], migrationEnvironment);
    expect(before.exitCode).toBe(0);
    expect(JSON.parse(before.output)).toMatchObject({
      compatibility: "missing",
      currentVersion: 0,
      requiredVersion: requiredPostgresSchemaVersion,
    });

    const applied = await runExternalCli(["migrate", "apply"], migrationEnvironment);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.output)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
      requiredVersion: requiredPostgresSchemaVersion,
    });

    const after = await runExternalCli(["migrate", "status"], migrationEnvironment);
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.output)).toEqual(JSON.parse(applied.output));

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-divergent-migration-test",
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl, {label: "test-database-url"}),
    });
    try {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`
          UPDATE artifact_server_postgres_migrations
          SET name = 'divergent_test_history'
          WHERE migration_id = 1
        `;
      }));
      const divergent = await runExternalCli(
        ["migrate", "apply"],
        migrationEnvironment,
      );
      expect(divergent.exitCode).not.toBe(0);
      expect(divergent.output).toContain("divergent");
      expect(divergent.output).not.toContain(environment.databaseUrl);
    } finally {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`
          UPDATE artifact_server_postgres_migrations
          SET name = 'initial_shared_schema'
          WHERE migration_id = 1
        `;
      }));
      await database.close();
    }
  });

  test("a populated Postgres v1 installation migrates without changing identity or bytes", async () => {
    const databaseName = `artifactserver_project_migration_${randomUUID().replaceAll("-", "")}`;
    await createPostgresDatabase(environment, databaseName);
    const migrationEnvironment = {
      ...environment,
      databaseUrl: databaseUrlFor(environment.databaseUrl, databaseName),
    };
    const identity = {
      apiToken: managedTestKey("postgres-project-migration"),
      installationId: "postgres-project-migration-installation",
    };
    const applied = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(applied.exitCode).toBe(0);

    const source = await startExternalStorageProcess(migrationEnvironment, identity);
    const published = await publishNew(source.baseUrl, identity.apiToken, {
      content: "<!doctype html><title>Postgres project migration</title>",
      idempotencyKey: "postgres-project-migration-publish",
      name: "Postgres project migration",
    });
    await source.stop();

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-project-migration-fixture",
      maxConnections: 1,
      url: Redacted.make(migrationEnvironment.databaseUrl),
    });
    try {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const statements = [
          // Every table a later migration created is dropped, so the rewind
          // really is the v1 schema and each migration finds its own work
          // undone rather than a relation it already made.
          "DROP TABLE installation_actions",
          "DROP TABLE collapsed_folders",
          "DROP TABLE assets",
          "DROP TABLE api_key_sessions",
          "DROP TABLE artifact_views",
          `ALTER TABLE actions
            DROP CONSTRAINT actions_action_check,
            ADD CONSTRAINT actions_action_check
              CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete'))`,
          `ALTER TABLE idempotency_records
            DROP CONSTRAINT idempotency_records_operation_check,
            ADD CONSTRAINT idempotency_records_operation_check
              CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete'))`,
          `ALTER TABLE versions
            DROP CONSTRAINT versions_routing_mode_check,
            ADD CONSTRAINT versions_routing_mode_check
              CHECK (routing_mode = 'static')`,
          `ALTER TABLE staged_uploads
            DROP CONSTRAINT staged_uploads_routing_mode_check,
            ADD CONSTRAINT staged_uploads_routing_mode_check
              CHECK (routing_mode = 'static')`,
          "ALTER TABLE content_sessions DROP COLUMN project_id CASCADE",
          "ALTER TABLE content_bootstraps DROP COLUMN project_id CASCADE",
          "ALTER TABLE staged_uploads DROP COLUMN project_id CASCADE",
          "ALTER TABLE actions DROP COLUMN project_id CASCADE",
          "ALTER TABLE idempotency_records DROP COLUMN project_id CASCADE",
          "ALTER TABLE versions DROP COLUMN project_id CASCADE",
          "ALTER TABLE idempotency_records DROP COLUMN artifact_name",
          "ALTER TABLE versions DROP COLUMN publisher_display_name",
          "ALTER TABLE artifacts DROP COLUMN owner_display_name",
          "ALTER TABLE artifacts DROP COLUMN owner_principal_id",
          "ALTER TABLE artifacts DROP COLUMN path",
          "ALTER TABLE artifacts DROP COLUMN search_name",
          "ALTER TABLE artifacts DROP COLUMN project_id CASCADE",
          "ALTER TABLE login_attempts DROP COLUMN nonce",
          "DROP TABLE comment_replies",
          "DROP TABLE comment_threads",
          "DROP TABLE agent_dispatches",
          "DROP TABLE registered_agents",
          "DROP TABLE projects",
          `ALTER TABLE artifacts ADD CONSTRAINT artifacts_current_version_fk
            FOREIGN KEY (installation_id, current_version_id)
            REFERENCES versions(installation_id, id)
            DEFERRABLE INITIALLY DEFERRED`,
          "ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (installation_id, idempotency_key)",
          "ALTER TABLE actions ADD CONSTRAINT actions_installation_id_idempotency_key_key UNIQUE (installation_id, idempotency_key)",
          "CREATE INDEX versions_artifact_id ON versions (installation_id, artifact_id, number)",
          "CREATE INDEX artifacts_active_created ON artifacts (installation_id, deleted_at, created_at DESC, id DESC)",
          "CREATE INDEX actions_artifact_created ON actions (installation_id, artifact_id, created_at DESC, id DESC)",
          "DELETE FROM artifact_server_postgres_migrations WHERE migration_id >= 2",
        ] as const;
        for (const statement of statements) {
          yield* sql.unsafe(statement);
        }
      }));
    } finally {
      await database.close();
    }

    const pending = await runExternalCli(["migrate", "status"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(JSON.parse(pending.output)).toMatchObject({
      compatibility: "pending",
      currentVersion: 1,
      requiredVersion: requiredPostgresSchemaVersion,
    });
    const migrated = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(migrated).toMatchObject({exitCode: 0});
    expect(JSON.parse(migrated.output)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
    });
    const migratedDatabase = await PostgresDatabase.inspect({
      applicationName: "artifact-server-project-migration-tables",
      maxConnections: 1,
      url: Redacted.make(migrationEnvironment.databaseUrl),
    });
    try {
      // Migrations 0007 to 0009 create the Git history tables and 0018 drops them.
      const gitHistoryTables = await migratedDatabase.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql<{readonly tablename: string}>`
          SELECT tablename FROM pg_tables WHERE tablename LIKE 'git_history%'
        `;
      }));
      expect(gitHistoryTables).toEqual([]);
    } finally {
      await migratedDatabase.close();
    }

    const restored = await startExternalStorageProcess(migrationEnvironment, identity);
    const detailsResponse = await authenticatedFetch(
      restored.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${published.body.artifact.id}`,
    );
    expect(detailsResponse.status).toBe(200);
    const details = z.object({
      artifact: z.object({
        id: z.string(),
        projectId: z.string(),
        tags: z.array(z.string()),
      }),
      current: z.object({
        links: z.object({version: z.url()}),
        manifest: z.object({digest: z.string()}),
        version: z.object({id: z.string(), projectId: z.string()}),
      }),
    }).parse(await detailsResponse.json());
    expect(details).toMatchObject({
      artifact: {
        id: published.body.artifact.id,
        projectId: defaultProjectId,
        tags: ["external-storage-runtime"],
      },
      current: {
        version: {
          id: published.body.version.id,
          projectId: defaultProjectId,
        },
      },
    });
    const rendered = await fetchContentThroughServer(
      restored.baseUrl,
      details.current.links.version,
    );
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe(
      "<!doctype html><title>Postgres project migration</title>",
    );
    await restored.stop();

    const repeated = await runExternalCli(["migrate", "apply"], {
      ARTIFACT_SERVER_DATABASE_URL: migrationEnvironment.databaseUrl,
      ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
    });
    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(repeated.output)).toMatchObject({
      compatibility: "current",
      currentVersion: requiredPostgresSchemaVersion,
    });
  });

  test("Postgres project scope survives restart", async () => {
    const identity = {
      apiToken: managedTestKey("postgres-project"),
      installationId: "postgres-project-scope",
    };
    let server = await startInProcessExternalStorageServer(environment, identity);
    const createdResponse = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Postgres project"}),
      headers: mutationHeaders(identity.apiToken, `project-${randomUUID()}`),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = z.object({
      project: z.object({id: z.string(), name: z.string()}),
    }).parse(await createdResponse.json()).project;

    const sharedKey = `project-local-idempotency-${randomUUID()}`;
    const [defaultArtifact, projectArtifact] = await Promise.all([
      publishNew(server.baseUrl, identity.apiToken, {
        content: "default Postgres project",
        idempotencyKey: sharedKey,
        name: "Default Postgres artifact",
        projectId: defaultProjectId,
      }),
      publishNew(server.baseUrl, identity.apiToken, {
        content: "named Postgres project",
        idempotencyKey: sharedKey,
        name: "Named Postgres artifact",
        projectId: created.id,
      }),
    ]);
    expect(defaultArtifact.response.status).toBe(201);
    expect(projectArtifact.response.status).toBe(201);
    expect(defaultArtifact.body.artifact.projectId).toBe(defaultProjectId);
    expect(projectArtifact.body.artifact.projectId).toBe(created.id);

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-project-fk-proof",
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl),
    });
    try {
      await expect(database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql.withTransaction(sql`
          UPDATE artifacts
          SET current_version_id = ${projectArtifact.body.version.id}
          WHERE installation_id = ${identity.installationId}
            AND project_id = ${defaultProjectId}
            AND id = ${defaultArtifact.body.artifact.id}
        `);
      }))).rejects.toBeDefined();
    } finally {
      await database.close();
    }

    await server.stop();
    server = await startInProcessExternalStorageServer(environment, identity);
    const namedList = await fetch(
      `${server.baseUrl}/api/v1/artifacts?projectId=${created.id}`,
      {headers: bearerHeaders(identity.apiToken)},
    );
    expect(namedList.status).toBe(200);
    expect(artifactListSchema.parse(await namedList.json()).artifacts)
      .toEqual([expect.objectContaining({
        artifact: expect.objectContaining({id: projectArtifact.body.artifact.id}),
      })]);

    const crossProjectRead = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${projectArtifact.body.artifact.id}?projectId=${defaultProjectId}`,
      {headers: bearerHeaders(identity.apiToken)},
    );
    expect(crossProjectRead.status).toBe(404);

    const archive = await fetch(
      `${server.baseUrl}/api/v1/projects/${created.id}/archive`,
      {headers: bearerHeaders(identity.apiToken), method: "POST"},
    );
    expect(archive.status).toBe(200);
    const archivedWrite = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: "0".repeat(64),
          size: 0,
        }],
        projectId: created.id,
      }),
      headers: mutationHeaders(identity.apiToken, `archived-${randomUUID()}`),
      method: "POST",
    });
    expect(archivedWrite.status).toBe(409);
    await expect(archivedWrite.json()).resolves.toMatchObject({
      error: {code: "PROJECT_ARCHIVED"},
    });
    expect((await fetch(
      `${server.baseUrl}/api/v1/artifacts/${projectArtifact.body.artifact.id}?projectId=${created.id}`,
      {headers: bearerHeaders(identity.apiToken)},
    )).status).toBe(200);
  });

  afterAll(async () => {
    s3Client.destroy();
  });

  test("PUB-011-B PUB-011-F: independent external-storage processes accept uploaded bytes, reject remote sources, serialize writes, restart, and isolate installations", async () => {
    expect.hasAssertions();
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, {apiToken, installationId}),
      startExternalStorageProcess(environment, {apiToken, installationId}),
    ]);

    const remoteSource = await fetch(`${first.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: "0".repeat(64),
          size: 0,
        }],
        sourceUrl: "http://169.254.169.254/latest/meta-data/",
      }),
      headers: new Headers({
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      }),
      method: "POST",
    });
    expect(remoteSource.status).toBe(422);

    const initial = await publishNew(first.baseUrl, apiToken, {
      content: "<h1>external-storage version one</h1>",
      idempotencyKey: `external-storage-create-${randomUUID()}`,
      name: "External-storage process proof",
    });
    expect(initial.response.status).toBe(201);

    const listedBySecond = await listArtifacts(second.baseUrl, apiToken);
    expect(listedBySecond.response.status).toBe(200);
    expect(listedBySecond.body.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          currentVersionId: initial.body.version.id,
          id: initial.body.artifact.id,
          name: "External-storage process proof",
        }),
      }),
    ]);

    const raceKey = randomUUID();
    const races = await Promise.all([
      publishVersion(first.baseUrl, apiToken, {
        artifactId: initial.body.artifact.id,
        content: "<h1>writer A</h1>",
        expectedCurrentVersionId: initial.body.version.id,
        idempotencyKey: `race-a-${raceKey}`,
      }),
      publishVersion(second.baseUrl, apiToken, {
        artifactId: initial.body.artifact.id,
        content: "<h1>writer B</h1>",
        expectedCurrentVersionId: initial.body.version.id,
        idempotencyKey: `race-b-${raceKey}`,
      }),
    ]);
    expect(
      races.map(({response}) => response.status).toSorted((left, right) => left - right),
    ).toEqual([201, 409]);
    const winner = races.find(({response}) => response.status === 201);
    if (winner === undefined) throw new Error("The publish race had no winner.");
    const winnerBody = publishResponseSchema.parse(winner.body);

    await Promise.all([first.stop(), second.stop()]);
    const restarted = await startExternalStorageProcess(environment, {apiToken, installationId});
    const afterRestart = await listArtifacts(restarted.baseUrl, apiToken);
    expect(afterRestart.body.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          currentVersionId: winnerBody.version.id,
          id: initial.body.artifact.id,
        }),
      }),
    ]);

    const isolatedApiToken = managedTestKey("isolated-installation");
    const isolated = await startExternalStorageProcess(environment, {
      apiToken: isolatedApiToken,
      installationId: "isolated-external-storage-installation",
    });
    const isolatedList = await listArtifacts(
      isolated.baseUrl,
      isolatedApiToken,
    );
    expect(isolatedList.response.status).toBe(200);
    expect(isolatedList.body.artifacts).toEqual([]);
    const guessed = await fetch(
      `${isolated.baseUrl}/api/v1/artifacts/${initial.body.artifact.id}`,
      {
        headers: {
          Authorization: `Bearer ${isolatedApiToken}`,
        },
      },
    );
    expect(guessed.status).toBe(404);
  });

  test("an external-storage process without a content domain serves published bytes from the application origin", async () => {
    expect.hasAssertions();
    const sameHostApiToken = managedTestKey("same-host-installation");
    const server = await startExternalStorageProcess(environment, {
      apiToken: sameHostApiToken,
      installationId: "same-host-external-storage-installation",
      sameHost: true,
    });
    const context = await fetch(`${server.baseUrl}/auth/context`);
    expect(await context.json()).toEqual({
      accessMode: "private_team",
      helpUrl: null,
      login: {kind: "none", oidc: false},
    });
    const content = "<h1>same-host external-storage proof</h1>";
    const published = await publishNew(server.baseUrl, sameHostApiToken, {
      content,
      idempotencyKey: `same-host-create-${randomUUID()}`,
      name: "Same-host proof",
    });
    expect(published.response.status).toBe(201);

    const applicationOrigin = new URL(server.baseUrl).origin;
    const versionLink = new URL(published.body.links.version);
    expect(versionLink.origin).toBe(applicationOrigin);
    expect(versionLink.pathname).toMatch(/^\/v\/[^/]+\/$/u);
    const version = await fetchContentThroughServer(
      server.baseUrl,
      published.body.links.version,
    );
    expect(version.status).toBe(200);
    expect(await version.text()).toBe(content);

    const artifactLink = new URL(published.body.links.artifact);
    expect(artifactLink.origin).toBe(applicationOrigin);
    expect(artifactLink.pathname).toBe(
      `/same-host-proof-${published.body.artifact.id.replace(/^art_/u, "")}/`,
    );
    const folder = await fetchContentThroughServer(
      server.baseUrl,
      published.body.links.artifact,
    );
    expect(folder.status).toBe(200);
    expect(await folder.text()).toBe(content);
  });

  test("external-storage foundation: Postgres commits a staged asset once across two processes, serves it from either, and stops serving it after delete", async () => {
    const assetToken = managedTestKey("asset-store-installation");
    const assetInstallationId = "asset-store-external-storage-installation";
    const options = {
      apiToken: assetToken,
      installationId: assetInstallationId,
      sameHost: true,
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, options),
      startExternalStorageProcess(environment, options),
    ]);
    const published = await publishNew(first.baseUrl, assetToken, {
      content: "<h1>asset page</h1>",
      idempotencyKey: `asset-page-${randomUUID()}`,
      name: "Asset page",
    });
    expect(published.response.status).toBe(201);
    const artifactId = published.body.artifact.id;
    const chart = {
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]),
      mediaType: "image/png",
      name: "chart.png",
    };

    const planned = await planAsset(first, assetToken, artifactId, chart);
    expect(planned.status).toBe(201);
    const plan = assetPlanSchema.parse(await planned.json());
    expect((await putAssetBytes(plan.file.uploadUrl, assetToken, chart.bytes)).status).toBe(200);
    const keys = [`asset-commit-a-${randomUUID()}`, `asset-commit-b-${randomUUID()}`];
    const raced = await Promise.all([
      commitAsset(plan, assetToken, keys[0] ?? ""),
      commitAsset({...plan, commitUrl: plan.commitUrl.replace(first.baseUrl, second.baseUrl)},
        assetToken, keys[1] ?? ""),
    ]);
    const winner = raced.findIndex((response) => response.status === 201);
    expect(winner).not.toBe(-1);
    // The losing commit either read the upload before the winner ended it
    // and was refused inside the transaction, or read it already ended.
    const loser = raced[1 - winner];
    expect([409, 410]).toContain(loser?.status);
    expect(["UPLOAD_CLOSED", "UPLOAD_EXPIRED"]).toContain(
      z.object({error: z.object({code: z.string()})}).parse(await loser?.json()).error.code,
    );
    const committed = committedAssetSchema.parse(await raced[winner]?.json());
    const replay = await commitAsset(plan, assetToken, keys[winner] ?? "");
    expect(replay.status).toBe(200);
    expect(committedAssetSchema.parse(await replay.json()).asset.id).toBe(committed.asset.id);

    const listing = await listAssets(second, assetToken, artifactId);
    expect(listing.assets.map((asset) => asset.id)).toEqual([committed.asset.id]);
    expect(listing.usage).toEqual({assetCount: 1, byteCount: chart.bytes.byteLength});
    const blobPath = new URL(committed.asset.url).pathname;
    const served = await fetch(`${second.baseUrl}${blobPath}`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(chart.bytes);

    expect((await deleteAsset(first, assetToken, artifactId, committed.asset.id)).status).toBe(200);
    expect((await fetch(`${second.baseUrl}${blobPath}`)).status).toBe(404);
    expect((await listAssets(second, assetToken, artifactId)).assets).toEqual([]);
  });

  test("external-storage foundation: a Postgres asset commit that reaches the transaction after another commit under its key returns the first asset as a replay", async () => {
    const token = managedTestKey("asset-replay-race-installation");
    const identity = {apiToken: token, installationId: `asset-replay-race-${randomUUID()}`};
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const published = await publishNew(server.baseUrl, token, {
      content: "<h1>asset replay page</h1>",
      idempotencyKey: `asset-replay-page-${randomUUID()}`,
      name: "Asset replay page",
    });
    expect(published.response.status).toBe(201);
    const {artifact} = published.body;
    const principal = managedTestPrincipal(token);
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 3, 2, 1]);
    const ids = new SystemIdGenerator();
    const assetWithId = (id: string) => ({
      artifactId: artifact.id,
      // The upload expires an hour after the plan, so commit at the real time.
      createdAt: new Date().toISOString(),
      createdByDisplayName: principal.displayName,
      createdByPrincipalId: principal.principalId,
      id,
      mediaType: "image/png",
      name: "chart.png",
      projectId: artifact.projectId,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
    const planned = await planAsset(server, token, artifact.id, {
      bytes,
      mediaType: "image/png",
      name: "chart.png",
    });
    expect(planned.status).toBe(201);
    const plan = assetPlanSchema.parse(await planned.json());
    // Both committers hold the claim they read before the first one ended
    // the upload, as a client retrying after a lost response does.
    const command = {
      authorizedByPrincipalId: null,
      idempotencyKey: `asset-replay-race-${randomUUID()}`,
      inputDigest: "same-asset-commit-input",
      quota: defaultAssetQuota,
      upload: {
        expiresAt: plan.expiresAt,
        id: plan.uploadId,
        principalId: principal.principalId,
      },
    };
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        identity.installationId,
      );
      const first = await repository.commitAsset({...command, asset: assetWithId(ids.assetId())});
      expect(first.replayed).toBe(false);
      // The second committer checked for its key before the first one wrote
      // it, so it enters the transaction holding a different new asset ID.
      const second = await repository.commitAsset({...command, asset: assetWithId(ids.assetId())});
      expect(second).toEqual({asset: first.asset, replayed: true});
      const listed = await repository.listAssets(artifact.projectId, artifact.id);
      expect(listed.assets.map((asset) => asset.id)).toEqual([first.asset.id]);
    } finally {
      await database.close();
      await server.stop();
    }
  });

  test("external-storage foundation: Postgres records each asset addition, copy, and deletion as one attributed action in the asset's own transaction", async () => {
    const token = managedTestKey("asset-actions-installation");
    const identity = {apiToken: token, installationId: `asset-actions-${randomUUID()}`};
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const principal = managedTestPrincipal(token);
    const published = await publishNew(server.baseUrl, token, {
      content: "<h1>asset actions page</h1>",
      idempotencyKey: `asset-actions-page-${randomUUID()}`,
      name: "Asset actions page",
    });
    expect(published.response.status).toBe(201);
    const {artifact, version} = published.body;
    const chart = {
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]),
      mediaType: "image/png",
      name: "chart.png",
    };
    const assetActions = async () => {
      const response = await authenticatedFetch(
        server.baseUrl,
        token,
        `/api/v1/artifacts/${artifact.id}/actions?limit=100`,
      );
      expect(response.status).toBe(200);
      return artifactActionsSchema.parse(await response.json()).actions
        .filter((action) => action.action.startsWith("asset_"))
        .map((action) => ({
          action: action.action,
          authorizedByPrincipalId: action["authorizedByPrincipalId"],
          idempotencyKey: action.idempotencyKey,
          principalId: action["principalId"],
          versionId: action.versionId,
        }))
        .toSorted((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
    };
    const recorded = (action: string, assetId: string) => ({
      action,
      authorizedByPrincipalId: principal.authorizedByPrincipalId,
      idempotencyKey: `asset:${assetId}:${action}`,
      principalId: principal.principalId,
      versionId: version.id,
    });
    const plannedUpload = async () => {
      const planned = await planAsset(server, token, artifact.id, chart);
      expect(planned.status).toBe(201);
      const plan = assetPlanSchema.parse(await planned.json());
      expect((await putAssetBytes(plan.file.uploadUrl, token, chart.bytes)).status).toBe(200);
      return plan;
    };
    const copy = (sourceAssetId: string, idempotencyKey: string) => {
      const headers = bearerHeaders(token);
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", idempotencyKey);
      return fetch(`${server.baseUrl}/api/v1/artifacts/${artifact.id}/assets/copies`, {
        body: JSON.stringify({sourceArtifactId: artifact.id, sourceAssetId}),
        headers,
        method: "POST",
      });
    };
    const liveAssetIds = async () =>
      (await listAssets(server, token, artifact.id)).assets.map((asset) => asset.id);
    const suffix = randomUUID().replaceAll("-", "");
    const refusal = `refuse_asset_actions_${suffix}`;
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const plan = await plannedUpload();
      const commitKey = `asset-actions-commit-${randomUUID()}`;
      const first = await commitAsset(plan, token, commitKey);
      expect(first.status).toBe(201);
      const added = committedAssetSchema.parse(await first.json()).asset;
      const replay = await commitAsset(plan, token, commitKey);
      expect(replay.status).toBe(200);
      await replay.arrayBuffer();
      const copied = await copy(added.id, `asset-actions-copy-${randomUUID()}`);
      expect(copied.status).toBe(201);
      const copiedAsset = committedAssetSchema.parse(await copied.json()).asset;
      expect((await deleteAsset(server, token, artifact.id, added.id)).status).toBe(200);
      const repeated = await deleteAsset(server, token, artifact.id, added.id);
      expect(repeated.status).toBe(404);
      await repeated.arrayBuffer();
      const expected = [
        recorded("asset_added", added.id),
        recorded("asset_deleted", added.id),
        recorded("asset_added", copiedAsset.id),
      ].toSorted((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
      expect(await assetActions()).toEqual(expected);

      // A commit that reaches the transaction after another commit wrote its
      // key replays that asset and records no second action.
      const repository = await PostgresArtifactRepository.open(
        database,
        identity.installationId,
      );
      const ids = new SystemIdGenerator();
      const command = {
        authorizedByPrincipalId: principal.authorizedByPrincipalId,
        idempotencyKey: `asset-actions-direct-${randomUUID()}`,
        inputDigest: "same-direct-asset-input",
        quota: defaultAssetQuota,
        upload: null,
      };
      const direct = (id: string) => repository.commitAsset({
        ...command,
        asset: {
          artifactId: artifact.id,
          createdAt: new Date().toISOString(),
          createdByDisplayName: principal.displayName,
          createdByPrincipalId: principal.principalId,
          id,
          mediaType: "image/png",
          name: "direct.png",
          projectId: artifact.projectId,
          sha256: sha256(chart.bytes),
          size: chart.bytes.byteLength,
        },
      });
      const directFirst = await direct(ids.assetId());
      expect(await direct(ids.assetId())).toEqual({asset: directFirst.asset, replayed: true});
      const withDirect = [...expected, recorded("asset_added", directFirst.asset.id)]
        .toSorted((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
      expect(await assetActions()).toEqual(withDirect);

      // With the action insert refused for this installation only, a commit,
      // a copy, and a delete each fail and leave the assets and actions alone.
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`CREATE FUNCTION ${refusal}() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'the action ledger refused the write';
          END
          $$`);
        yield* sql.unsafe(`CREATE TRIGGER ${refusal}
          BEFORE INSERT ON actions
          FOR EACH ROW
          WHEN (NEW.installation_id = '${identity.installationId}')
          EXECUTE FUNCTION ${refusal}()`);
      }));
      const liveBefore = await liveAssetIds();
      const refusedPlan = await plannedUpload();
      const refusedKey = `asset-actions-refused-${randomUUID()}`;
      const refusedCommit = await commitAsset(refusedPlan, token, refusedKey);
      expect(refusedCommit.status).toBe(500);
      await refusedCommit.arrayBuffer();
      const refusedCopy = await copy(copiedAsset.id, `asset-actions-refused-copy-${randomUUID()}`);
      expect(refusedCopy.status).toBe(500);
      await refusedCopy.arrayBuffer();
      const refusedDelete = await deleteAsset(server, token, artifact.id, copiedAsset.id);
      expect(refusedDelete.status).toBe(500);
      await refusedDelete.arrayBuffer();
      expect(await liveAssetIds()).toEqual(liveBefore);
      expect(await assetActions()).toEqual(withDirect);

      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP TRIGGER ${refusal} ON actions`);
      }));
      // The refused commit left its upload open, so the same key commits now.
      const retried = await commitAsset(refusedPlan, token, refusedKey);
      expect(retried.status).toBe(201);
      await retried.arrayBuffer();
      expect((await deleteAsset(server, token, artifact.id, copiedAsset.id)).status).toBe(200);
      expect((await assetActions()).filter((action) =>
        action.idempotencyKey === `asset:${copiedAsset.id}:asset_deleted`
      )).toEqual([recorded("asset_deleted", copiedAsset.id)]);
    } finally {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${refusal} ON actions`);
        yield* sql.unsafe(`DROP FUNCTION IF EXISTS ${refusal}()`);
      }));
      await database.close();
      await server.stop();
    }
  });

  test("external-storage foundation: Postgres records each project, member, and API-key change as one attributed installation action in the change's own transaction", async () => {
    const token = managedTestKey("installation-actions");
    const identity = {
      apiToken: token,
      installationId: `installation-actions-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const administrator = await seedAdministratorSession(environment, identity.installationId);
    const origin = "https://artifacts.example.com";
    const asAdministrator = (method: string, routePath: string, body?: InstallationChangeBody) =>
      fetch(`${server.baseUrl}${routePath}`, body === undefined
        ? {headers: browserMutationHeaders(origin, administrator), method}
        : {
          body: JSON.stringify(body),
          headers: browserMutationHeaders(origin, administrator),
          method,
        });
    const asBearer = (bearer: string, method: string, routePath: string, body?: InstallationChangeBody) => {
      const headers = bearerHeaders(bearer);
      headers.set("Content-Type", "application/json");
      return fetch(`${server.baseUrl}${routePath}`, body === undefined
        ? {headers, method}
        : {body: JSON.stringify(body), headers, method});
    };
    const actionPageSchema = z.object({
      actions: z.array(installationActionSchema),
      nextCursor: z.string().nullable(),
    }).strict();
    const projectRecordSchema = z.object({
      archivedAt: z.string().nullable(),
      id: z.string(),
      name: z.string(),
    }).loose();
    const projectSchema = z.object({project: projectRecordSchema}).loose();
    const memberRecordSchema = z.object({id: z.string(), status: z.string()}).loose();
    const memberSchema = z.object({member: memberRecordSchema}).loose();
    const keyListSchema = z.object({
      apiKeys: z.array(z.object({id: z.string(), revokedAt: z.string().nullable()}).loose()),
    }).loose();
    const readActions = async () =>
      (await json(
        asAdministrator("GET", "/api/v1/administration/actions?limit=100"),
        200,
        actionPageSchema,
      )).actions;
    const readState = async () => ({
      actions: await readActions(),
      keys: await json(asAdministrator("GET", "/api/v1/api-keys"), 200, keyListSchema),
      members: await json(
        asAdministrator("GET", "/api/v1/members"),
        200,
        z.object({members: z.array(memberRecordSchema)}).loose(),
      ),
      projects: await json(
        asAdministrator("GET", "/api/v1/projects"),
        200,
        z.object({projects: z.array(projectRecordSchema)}).loose(),
      ),
    });
    const issueKey = (capabilities: readonly string[], name: string) =>
      json(asAdministrator("POST", "/api/v1/api-keys", {
        capabilities,
        expiresAt: "2099-01-01T00:00:00.000Z",
        name,
      }), 201, issuedKeySchema);
    const suffix = randomUUID().replaceAll("-", "");
    const refusal = `refuse_installation_actions_${suffix}`;
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const administratorId = (await json(
        fetch(`${server.baseUrl}/api/v1/session`, {headers: {Cookie: administrator.header}}),
        200,
        z.object({principal: z.object({id: z.string()}).loose()}).loose(),
      )).principal.id;
      const bootstrapKeyId = managedApiKeyCredentialPattern.exec(token)?.[1] ?? "";
      const denied = await asBearer(token, "GET", "/api/v1/administration/actions");
      expect(denied.status).toBe(403);
      await denied.arrayBuffer();

      const byAdministrator = (kind: string, subjectId: string) => ({
        authorizedByPrincipalId: null,
        kind,
        principalDisplayName: "Team administrator",
        principalId: administratorId,
        subjectId,
      });
      const bootstrapIssue = {
        authorizedByPrincipalId: null,
        kind: "api_key_issued",
        principalDisplayName: "Installation bootstrap",
        principalId: "installation-bootstrap",
        subjectId: bootstrapKeyId,
      };
      expect(summarize(await readActions())).toEqual(summarize([
        bootstrapIssue,
        byOperator("member_admitted", administratorId),
      ]));

      const stewardKey = await issueKey(["project:manage"], "Project steward");
      const project = (await json(
        asAdministrator("POST", "/api/v1/projects", {name: "Audited project"}),
        201,
        projectSchema,
      )).project;
      await json(asBearer(stewardKey.token, "PATCH", `/api/v1/projects/${project.id}`, {
        name: "Audited project, renamed",
      }), 200, projectSchema);
      await json(
        asAdministrator("POST", `/api/v1/projects/${project.id}/archive`),
        200,
        projectSchema,
      );
      await json(
        asBearer(stewardKey.token, "POST", `/api/v1/projects/${project.id}/unarchive`),
        200,
        projectSchema,
      );
      const memberEmail = `audited-${suffix}@example.test`;
      const member = (await json(asAdministrator("POST", "/api/v1/members", {
        displayName: "Audited member",
        email: memberEmail,
      }), 201, memberSchema)).member;
      await json(
        asAdministrator("POST", `/api/v1/members/${member.id}/deactivate`),
        200,
        memberSchema,
      );
      const rotatedKey = await issueKey(["artifact:read"], "Rotated reader");
      const replacementKey = await json(
        asAdministrator("POST", `/api/v1/api-keys/${rotatedKey.apiKey.id}/rotate`),
        201,
        issuedKeySchema,
      );
      const revoked = await asAdministrator(
        "POST",
        `/api/v1/api-keys/${replacementKey.apiKey.id}/revoke`,
      );
      expect(revoked.status).toBe(200);
      await revoked.arrayBuffer();

      const answered = await asAdministrator("GET", "/api/v1/administration/actions?limit=100");
      const body: unknown = await answered.json();
      expect(answered.status).toBe(200);
      const serialized = JSON.stringify(body);
      for (const secret of [
        token,
        stewardKey.token,
        rotatedKey.token,
        replacementKey.token,
        memberEmail,
      ]) {
        expect(serialized).not.toContain(secret);
      }
      const recorded = actionPageSchema.parse(body).actions;
      const createdTimes = recorded.map((action) => action.createdAt);
      expect(createdTimes).toEqual(createdTimes.toSorted().toReversed());
      const bySteward = (kind: string) => ({
        authorizedByPrincipalId: administratorId,
        kind,
        principalDisplayName: "Project steward",
        principalId: stewardKey.apiKey.principalId,
        subjectId: project.id,
      });
      expect(summarize(recorded)).toEqual(summarize([
        bootstrapIssue,
        byOperator("member_admitted", administratorId),
        byAdministrator("api_key_issued", stewardKey.apiKey.id),
        byAdministrator("project_created", project.id),
        bySteward("project_renamed"),
        byAdministrator("project_archived", project.id),
        bySteward("project_unarchived"),
        byAdministrator("member_admitted", member.id),
        byAdministrator("member_deactivated", member.id),
        byAdministrator("api_key_issued", rotatedKey.apiKey.id),
        byAdministrator("api_key_revoked", rotatedKey.apiKey.id),
        byAdministrator("api_key_issued", replacementKey.apiKey.id),
        byAdministrator("api_key_revoked", replacementKey.apiKey.id),
      ]));
      const pageOne = await json(
        asAdministrator("GET", "/api/v1/administration/actions?limit=10"),
        200,
        actionPageSchema,
      );
      expect(pageOne.nextCursor).not.toBeNull();
      const pageTwo = await json(
        asAdministrator(
          "GET",
          `/api/v1/administration/actions?limit=10&cursor=${pageOne.nextCursor ?? ""}`,
        ),
        200,
        actionPageSchema,
      );
      expect([...pageOne.actions, ...pageTwo.actions]).toEqual(recorded);
      expect(pageTwo.nextCursor).toBeNull();

      // With installation actions refused for this installation only, every
      // change fails and leaves projects, members, keys, and actions alone.
      const archived = (await json(
        asAdministrator("POST", "/api/v1/projects", {name: "Archived project"}),
        201,
        projectSchema,
      )).project;
      await json(
        asAdministrator("POST", `/api/v1/projects/${archived.id}/archive`),
        200,
        projectSchema,
      );
      const keptMember = (await json(asAdministrator("POST", "/api/v1/members", {
        displayName: "Kept member",
        email: `kept-${suffix}@example.test`,
      }), 201, memberSchema)).member;
      const keptKey = await issueKey(["artifact:read"], "Kept reader");
      const before = await readState();
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`CREATE FUNCTION ${refusal}() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'the installation action history refused the write';
          END
          $$`);
        yield* sql.unsafe(`CREATE TRIGGER ${refusal}
          BEFORE INSERT ON installation_actions
          FOR EACH ROW
          WHEN (NEW.installation_id = '${identity.installationId}')
          EXECUTE FUNCTION ${refusal}()`);
      }));
      const refusals: readonly (readonly [string, () => Promise<Response>])[] = [
        ["project create", () =>
          asAdministrator("POST", "/api/v1/projects", {name: "Never created"})],
        ["project rename", () =>
          asAdministrator("PATCH", `/api/v1/projects/${project.id}`, {name: "Never renamed"})],
        ["project archive", () =>
          asAdministrator("POST", `/api/v1/projects/${project.id}/archive`)],
        ["project unarchive", () =>
          asAdministrator("POST", `/api/v1/projects/${archived.id}/unarchive`)],
        ["member admit", () => asAdministrator("POST", "/api/v1/members", {
          displayName: "Never admitted",
          email: `never-${suffix}@example.test`,
        })],
        ["member deactivate", () =>
          asAdministrator("POST", `/api/v1/members/${keptMember.id}/deactivate`)],
        ["key issue", () => asAdministrator("POST", "/api/v1/api-keys", {
          capabilities: ["artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          name: "Never issued",
        })],
        ["key revoke", () =>
          asAdministrator("POST", `/api/v1/api-keys/${keptKey.apiKey.id}/revoke`)],
        ["key rotate", () =>
          asAdministrator("POST", `/api/v1/api-keys/${keptKey.apiKey.id}/rotate`)],
      ];
      for (const [label, attempt] of refusals) {
        // eslint-disable-next-line no-await-in-loop
        const response = await attempt();
        expect({label, status: response.status}).toEqual({label, status: 500});
        // eslint-disable-next-line no-await-in-loop
        await response.arrayBuffer();
      }
      expect(await readState()).toEqual(before);
      const stillValid = await asBearer(keptKey.token, "GET", "/api/v1/projects");
      expect(stillValid.status).toBe(200);
      await stillValid.arrayBuffer();

      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP TRIGGER ${refusal} ON installation_actions`);
      }));
      // Each change runs twice in a row; only the first is recorded.
      for (const routePath of [
        `/api/v1/members/${keptMember.id}/deactivate`,
        `/api/v1/members/${keptMember.id}/deactivate`,
        `/api/v1/api-keys/${keptKey.apiKey.id}/revoke`,
        `/api/v1/api-keys/${keptKey.apiKey.id}/revoke`,
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const response = await asAdministrator("POST", routePath);
        expect({routePath, status: response.status}).toEqual({routePath, status: 200});
        // eslint-disable-next-line no-await-in-loop
        await response.arrayBuffer();
      }
      const afterReplays = await readActions();
      const added = afterReplays.slice(0, afterReplays.length - before.actions.length);
      expect(afterReplays.slice(added.length)).toEqual(before.actions);
      expect(summarize(added)).toEqual(summarize([
        byAdministrator("member_deactivated", keptMember.id),
        byAdministrator("api_key_revoked", keptKey.apiKey.id),
      ]));
    } finally {
      await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${refusal} ON installation_actions`);
        yield* sql.unsafe(`DROP FUNCTION IF EXISTS ${refusal}()`);
      }));
      await database.close();
      await server.stop();
    }
  });

  test("external-storage foundation: a Postgres version commit whose staged files are not all verified fails as UploadIncomplete inside the transaction", async () => {
    const token = managedTestKey("version-readiness-race-installation");
    const identity = {apiToken: token, installationId: `version-readiness-race-${randomUUID()}`};
    const server = await startInProcessExternalStorageServer(environment, identity);
    const published = await publishNew(server.baseUrl, token, {
      content: "<h1>first version</h1>",
      idempotencyKey: `version-readiness-page-${randomUUID()}`,
      name: "Version readiness page",
    });
    expect(published.response.status).toBe(201);
    const {artifact, version} = published.body;
    const principal = managedTestPrincipal(token);
    const files = [
      textFile("index.html", "text/html; charset=utf-8", "<h1>second version</h1>"),
      textFile("notes.md", "text/markdown; charset=utf-8", "# Never uploaded\n"),
    ];
    const upload = await planExternalStorageUpload(server.baseUrl, token, files, "index.html");
    const entrySlot = upload.files.find((file) => file.path === "index.html");
    const entryFile = files[0];
    if (entrySlot === undefined || entryFile === undefined) {
      throw new Error("The upload plan has no entry file slot.");
    }
    const verified = await fetch(entrySlot.uploadUrl, {
      body: copiedArrayBuffer(entryFile.bytes),
      headers: {Authorization: `Bearer ${token}`},
      method: "PUT",
    });
    expect(verified.ok).toBe(true);
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        identity.installationId,
      );
      const staged = await repository.findStagedUpload(
        upload.projectId,
        upload.uploadId,
        principal.principalId,
      );
      if (staged === null) throw new Error("The staged upload is missing.");
      expect(Object.fromEntries(staged.files.map((file) =>
        [file.entry.path, file.uploadedAt !== null]
      ))).toEqual({"index.html": true, "notes.md": false});
      const ids = new SystemIdGenerator();
      // The committer read the upload as ready before this point, so only the
      // transaction's own count stands between it and a version with no bytes.
      await expect(repository.commitVersion({
        artifactId: artifact.id,
        authorizedByPrincipalId: principal.authorizedByPrincipalId,
        contentToken: ids.contentToken(),
        createdAt: new Date().toISOString(),
        edit: null,
        expectedCurrentVersionId: version.id,
        idempotencyKey: `version-readiness-race-${randomUUID()}`,
        inputDigest: "unverified-version-input",
        manifest: staged.manifest,
        principalDisplayName: principal.displayName,
        principalId: principal.principalId,
        projectId: upload.projectId,
        source: {
          kind: "staged_upload",
          principalId: principal.principalId,
          projectId: upload.projectId,
          uploadId: upload.uploadId,
        },
        versionId: ids.versionId(),
      })).rejects.toMatchObject({_tag: "UploadIncomplete"});
      const versions = await repository.listArtifactVersions(artifact.projectId, artifact.id);
      expect(versions.map((saved) => saved.id)).toEqual([version.id]);
      await expect(repository.findStagedUpload(
        upload.projectId,
        upload.uploadId,
        principal.principalId,
      )).resolves.toMatchObject({committedVersionId: null, status: "open"});
    } finally {
      await database.close();
      await server.stop();
    }
  });

  test("external-storage foundation: two processes racing for one artifact path admit exactly one create and both serve it", async () => {
    expect.hasAssertions();
    const pathApiToken = managedTestKey("artifact-path-installation");
    const identity = {
      apiToken: pathApiToken,
      installationId: "artifact-path-external-storage-installation",
      sameHost: true,
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, identity),
      startExternalStorageProcess(environment, identity),
    ]);
    const commitWithPath = async (
      server: ExternalStorageProcess,
      artifactPath: string,
      idempotencyKey: string,
    ) => {
      const upload = await stageExternalStorageFile(
        server.baseUrl,
        pathApiToken,
        `<h1>${idempotencyKey}</h1>`,
      );
      return fetch(upload.commitUrl, {
        body: JSON.stringify({target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: `Path claim ${idempotencyKey}`,
          path: artifactPath,
        }}),
        headers: mutationHeaders(pathApiToken, idempotencyKey),
        method: "POST",
      });
    };

    const raceKey = randomUUID();
    const races = await Promise.all([
      commitWithPath(first, "2026/10/raced", `path-race-a-${raceKey}`),
      commitWithPath(second, "2026/10/raced", `path-race-b-${raceKey}`),
    ]);
    expect(
      races.map(({status}) => status).toSorted((left, right) => left - right),
    ).toEqual([201, 409]);
    const outcomes = await Promise.all(races.map(async (response) => {
      const body: unknown = await response.json();
      return {body, status: response.status};
    }));
    const winner = z.object({
      artifact: z.object({path: z.string()}),
      links: z.object({artifact: z.url()}),
    }).parse(outcomes.find(({status}) => status === 201)?.body);
    const loser = outcomes.find(({status}) => status === 409);
    expect(winner.artifact.path).toBe("2026/10/raced");
    expect(new URL(winner.links.artifact).pathname).toBe("/2026/10/raced/");
    expect(z.object({error: z.object({code: z.string()})}).parse(loser?.body))
      .toEqual({error: {code: "ARTIFACT_PATH_TAKEN"}});
    const served = await Promise.all([first, second].map((server) =>
      fetchContentThroughServer(server.baseUrl, winner.links.artifact)));
    expect(await Promise.all(served.map(async (response) => ({
      body: await response.text(),
      status: response.status,
    })))).toEqual(Array.from({length: 2}, () => ({
      body: expect.stringMatching(/^<h1>path-race-[ab]-/u),
      status: 200,
    })));

    const ancestor = await commitWithPath(second, "2026/10", `path-ancestor-${raceKey}`);
    expect(ancestor.status).toBe(409);
    await ancestor.arrayBuffer();
    const sibling = await commitWithPath(first, "2026/10/raced-v2", `path-sibling-${raceKey}`);
    expect(sibling.status).toBe(201);
    await sibling.arrayBuffer();
  });

  test("foundation: independent external-storage processes expose the same stateless MCP installation", async () => {
    expect.hasAssertions();
    const identity = {
      apiToken: managedTestKey("external-storage-mcp"),
      installationId: `external-storage-mcp-${randomUUID()}`,
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, identity),
      startExternalStorageProcess(environment, identity),
    ]);
    const published = await publishNew(first.baseUrl, identity.apiToken, {
      content: "<main>external-storage MCP visibility</main>",
      idempotencyKey: `external-storage-mcp-create-${randomUUID()}`,
      name: "External-storage MCP proof",
    });
    expect(published.response.status).toBe(201);

    const discovery = await externalStorageMcpRequest(
      second.baseUrl,
      identity.apiToken,
      "server/discover",
      {},
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.has("mcp-session-id")).toBe(false);
    await expect(discovery.json()).resolves.toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
      },
    });

    const listed = await externalStorageMcpRequest(
      second.baseUrl,
      identity.apiToken,
      "tools/call",
      {
        arguments: {cursor: null, limit: 10, tag: null},
        name: "artifact_list",
      },
      "artifact_list",
    );
    expect(listed.status).toBe(200);
    const listResult = z.object({
      result: z.object({
        isError: z.boolean().optional(),
        resultType: z.literal("complete"),
        structuredContent: z.object({
          artifacts: z.array(z.object({id: z.string()}).loose()),
        }),
      }).loose(),
    }).loose().parse(await listed.json()).result;
    expect(listResult.isError).not.toBe(true);
    expect(listResult.structuredContent.artifacts).toContainEqual(
      expect.objectContaining({id: published.body.artifact.id}),
    );
  });

  test("external-storage foundation: a scoped identity adapter rejects a caller-selected installation", async () => {
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = new PostgresIdentityRepository(
        database,
        "trusted-identity-installation",
      );
      await expect(repository.hasMembers("foreign-identity-installation"))
        .rejects.toMatchObject({_tag: "IdentityNotFound"});
      await expect(repository.hasMembers("trusted-identity-installation"))
        .resolves.toBe(false);
    } finally {
      await database.close();
    }
  });

  test("AUTH-017-B: each installation's processes write rows, objects, integrity scans, and cleanup jobs only under their own trusted scope", async () => {
    const suffix = randomUUID();
    const first = {
      apiToken: managedTestKey(`auth-017-b-first-${suffix}`),
      installationId: `auth-017-b-first-${suffix}`,
    };
    const second = {
      apiToken: managedTestKey(`auth-017-b-second-${suffix}`),
      installationId: `auth-017-b-second-${suffix}`,
    };
    const [firstServer, secondServer] = await Promise.all([
      startExternalStorageProcess(environment, first),
      startExternalStorageProcess(environment, second),
    ]);
    const firstContent = `<h1>first installation ${suffix}</h1>`;
    const secondContent = `<h1>second installation ${suffix}</h1>`;
    const [firstPublished, secondPublished] = await Promise.all([
      publishNew(firstServer.baseUrl, first.apiToken, {
        content: firstContent,
        idempotencyKey: `auth-017-b-first-${suffix}`,
        name: "First installation artifact",
      }),
      publishNew(secondServer.baseUrl, second.apiToken, {
        content: secondContent,
        idempotencyKey: `auth-017-b-second-${suffix}`,
        name: "Second installation artifact",
      }),
    ]);
    expect(firstPublished.response.status).toBe(201);
    expect(secondPublished.response.status).toBe(201);
    const openUpload = await stageExternalStorageFile(
      firstServer.baseUrl,
      first.apiToken,
      `<p>uncommitted first installation upload ${suffix}</p>`,
    );

    const [firstList, secondList] = await Promise.all([
      listArtifacts(firstServer.baseUrl, first.apiToken),
      listArtifacts(secondServer.baseUrl, second.apiToken),
    ]);
    expect(firstList.body.artifacts.map(({artifact}) => artifact.id))
      .toEqual([firstPublished.body.artifact.id]);
    expect(secondList.body.artifacts.map(({artifact}) => artifact.id))
      .toEqual([secondPublished.body.artifact.id]);

    const database = await PostgresDatabase.open({
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const owners = await database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql<{
          readonly id: string;
          readonly installation_id: string;
          readonly kind: string;
        }>`
          SELECT id, installation_id, 'artifact' AS kind FROM artifacts
          WHERE id IN (${firstPublished.body.artifact.id}, ${secondPublished.body.artifact.id})
          UNION ALL
          SELECT id, installation_id, 'version' AS kind FROM versions
          WHERE id IN (${firstPublished.body.version.id}, ${secondPublished.body.version.id})
          UNION ALL
          SELECT id, installation_id, 'upload' AS kind FROM staged_uploads
          WHERE id = ${openUpload.uploadId}
          ORDER BY kind, installation_id
        `.withoutTransform;
      }));
      expect(owners).toEqual([
        {id: firstPublished.body.artifact.id, installation_id: first.installationId, kind: "artifact"},
        {id: secondPublished.body.artifact.id, installation_id: second.installationId, kind: "artifact"},
        {id: openUpload.uploadId, installation_id: first.installationId, kind: "upload"},
        {id: firstPublished.body.version.id, installation_id: first.installationId, kind: "version"},
        {id: secondPublished.body.version.id, installation_id: second.installationId, kind: "version"},
      ]);
    } finally {
      await database.close();
    }

    const firstBlob = sha256(new TextEncoder().encode(firstContent));
    const secondBlob = sha256(new TextEncoder().encode(secondContent));
    const [firstKeys, secondKeys] = await Promise.all([
      installationObjectKeys(s3Client, first.installationId),
      installationObjectKeys(s3Client, second.installationId),
    ]);
    expect(firstKeys.filter((key) => key.endsWith(`/${firstBlob}`))).toHaveLength(1);
    expect(firstKeys.some((key) => key.endsWith(`/${secondBlob}`))).toBe(false);
    expect(firstKeys.some((key) => key.includes(`/staging/${openUpload.uploadId}/`))).toBe(true);
    expect(secondKeys.filter((key) => key.endsWith(`/${secondBlob}`))).toHaveLength(1);
    expect(secondKeys.some((key) => key.endsWith(`/${firstBlob}`))).toBe(false);
    expect(secondKeys.some((key) => key.includes(`/staging/${openUpload.uploadId}/`))).toBe(false);

    const integrity = (scoped: typeof first) => checkExternalStorageIntegrity({
      databaseUrl: Redacted.make(environment.databaseUrl),
      installationId: scoped.installationId,
      objectStorage: createS3ObjectStorageProviderFactory({
        accessKeyId: environment.accessKey,
        bucket,
        endpoint: environment.endpoint,
        forcePathStyle: true,
        region,
        secretAccessKey: Redacted.make(environment.secretKey),
      }),
    });
    const scans = await Promise.all([integrity(first), integrity(second)]);
    for (const scan of scans) {
      expect(scan).toMatchObject({
        artifactsChecked: 1,
        problems: [],
        status: "healthy",
        versionsChecked: 1,
      });
    }

    await Promise.all([firstServer.stop(), secondServer.stop()]);
    const afterExpiry = new MutableClock(
      new Date(Date.now() + 30 * day).toISOString(),
    );
    const cleanup = async (scoped: typeof first) => {
      const runtime = await createExternalStorageRuntime({
        apiToken: Redacted.make(scoped.apiToken),
        applicationOrigin: "https://artifacts.example.com",
        bootstrapAdministratorEmail: administratorEmail,
        browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
        clock: afterExpiry,
        contentDomain: "content.example.net",
        databaseUrl: Redacted.make(environment.databaseUrl),
        installationId: scoped.installationId,
        objectStorage: createS3ObjectStorageProviderFactory({
          accessKeyId: environment.accessKey,
          bucket,
          endpoint: environment.endpoint,
          forcePathStyle: true,
          region,
          secretAccessKey: Redacted.make(environment.secretKey),
        }),
        stagingCleanupPolicy: {...defaultStagingCleanupPolicy, schedule: "external"},
      });
      try {
        return await runtime.cleanupStaging(100);
      } finally {
        await runtime.close();
      }
    };
    expect(await cleanup(second)).toMatchObject({deleted: 0, failed: 0, selected: 0});
    expect((await installationObjectKeys(s3Client, first.installationId))
      .some((key) => key.includes(`/staging/${openUpload.uploadId}/`))).toBe(true);
    expect(await cleanup(first)).toMatchObject({deleted: 1, failed: 0, selected: 1});
    expect((await installationObjectKeys(s3Client, first.installationId))
      .some((key) => key.includes(`/staging/${openUpload.uploadId}/`))).toBe(false);
  });

  test("AUTH-017-F: header, host, query, body, path, token, session, idempotency-key, upload, and MCP tampering on one installation's process cannot reach another installation", async () => {
    const suffix = randomUUID();
    const victim = {
      apiToken: managedTestKey(`auth-017-f-victim-${suffix}`),
      installationId: `auth-017-f-victim-${suffix}`,
    };
    const attacker = {
      apiToken: managedTestKey(`auth-017-f-attacker-${suffix}`),
      installationId: `auth-017-f-attacker-${suffix}`,
    };
    const [victimServer, attackerServer] = await Promise.all([
      startExternalStorageProcess(environment, victim),
      startExternalStorageProcess(environment, attacker),
    ]);
    const projectResponse = await fetch(`${victimServer.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Victim project"}),
      headers: mutationHeaders(victim.apiToken, `auth-017-f-project-${suffix}`),
      method: "POST",
    });
    expect(projectResponse.status).toBe(201);
    const victimProject = z.object({project: z.object({id: z.string()})})
      .parse(await projectResponse.json()).project;
    const sharedIdempotencyKey = `auth-017-f-shared-${suffix}`;
    const victimContent = `<h1>victim installation ${suffix}</h1>`;
    const published = await publishNew(victimServer.baseUrl, victim.apiToken, {
      content: victimContent,
      idempotencyKey: sharedIdempotencyKey,
      name: "Victim artifact",
      projectId: defaultProjectId,
    });
    expect(published.response.status).toBe(201);
    const victimArtifact = published.body.artifact;
    const victimVersion = published.body.version;
    const victimFile = {
      bytes: new TextEncoder().encode(`<p>victim open upload ${suffix}</p>`),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    };
    const openUpload = await planExternalStorageUpload(
      victimServer.baseUrl,
      victim.apiToken,
      [victimFile],
      "index.html",
      defaultProjectId,
    );
    const openFile = openUpload.files[0];
    if (openFile === undefined) throw new Error("The victim upload plan had no file.");
    const victimCookies = await seedAdministratorSession(environment, victim.installationId);
    const victimContentHost = new URL(published.body.links.version).host;

    const victimControls = {
      artifact: await authenticatedFetch(
        victimServer.baseUrl,
        victim.apiToken,
        `/api/v1/artifacts/${victimArtifact.id}?projectId=${defaultProjectId}`,
      ),
      content: await fetchContentThroughServer(
        victimServer.baseUrl,
        published.body.links.version,
      ),
      mcp: await externalStorageMcpRequest(
        victimServer.baseUrl,
        victim.apiToken,
        "tools/call",
        {
          arguments: {artifactId: victimArtifact.id, projectId: defaultProjectId},
          name: "artifact_get",
        },
        "artifact_get",
      ),
      project: await authenticatedFetch(
        victimServer.baseUrl,
        victim.apiToken,
        `/api/v1/projects/${victimProject.id}`,
      ),
      session: await fetch(`${victimServer.baseUrl}/api/v1/session`, {
        headers: {Cookie: victimCookies.header},
      }),
    };
    expect(victimControls.artifact.status).toBe(200);
    expect(victimControls.content.status).toBe(200);
    expect(await victimControls.content.text()).toBe(victimContent);
    expect(victimControls.mcp.status).toBe(200);
    expect(mcpToolTextResultSchema.parse(await victimControls.mcp.json()).result.isError)
      .not.toBe(true);
    expect(victimControls.project.status).toBe(200);
    expect(victimControls.session.status).toBe(200);
    await victimServer.stop();

    const victimRowsBefore = await installationRows(environment, victim.installationId);
    const victimKeysBefore = await installationObjectKeys(s3Client, victim.installationId);
    expect(victimRowsBefore["artifacts"]?.count).toBe(1);
    expect(victimKeysBefore.length).toBeGreaterThan(0);

    const attackerHeaders = (extra: Record<string, string> = {}) => new Headers({
      Authorization: `Bearer ${attacker.apiToken}`,
      ...extra,
    });
    const forgedHeaders = {
      Forwarded: `host=${victimContentHost};proto=https`,
      "X-Artifact-Installation-Id": victim.installationId,
      "X-Forwarded-Host": victimContentHost,
      "X-Forwarded-Proto": "https",
      "X-Installation-Id": victim.installationId,
      "X-Original-Host": victimContentHost,
      "X-Tenant-Id": victim.installationId,
    };
    const expected: {readonly label: string; readonly status: number}[] = [];
    const observed: {readonly label: string; readonly status: number}[] = [];
    const attempt = async (label: string, status: number, response: Promise<Response>) => {
      const settled = await response;
      await settled.arrayBuffer();
      expected.push({label, status});
      observed.push({label, status: settled.status});
    };

    await attempt("victim token", 401, authenticatedFetch(
      attackerServer.baseUrl,
      victim.apiToken,
      `/api/v1/artifacts/${victimArtifact.id}`,
    ));
    await attempt("victim token with forged installation headers", 401, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts`,
      {headers: {Authorization: `Bearer ${victim.apiToken}`, ...forgedHeaders}},
    ));
    await attempt("victim session cookie", 401, fetch(`${attackerServer.baseUrl}/api/v1/session`, {
      headers: {Cookie: victimCookies.header, ...forgedHeaders},
    }));
    await attempt("victim artifact ID", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts/${victimArtifact.id}`,
      {headers: attackerHeaders(forgedHeaders)},
    ));
    await attempt("victim artifact ID with installation query", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts/${victimArtifact.id}?installationId=${victim.installationId}&installation=${victim.installationId}`,
      {headers: attackerHeaders()},
    ));
    await attempt("victim version ID", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts/${victimArtifact.id}/versions/${victimVersion.id}`,
      {headers: attackerHeaders(forgedHeaders)},
    ));
    await attempt("victim project ID in path", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/projects/${victimProject.id}`,
      {headers: attackerHeaders(forgedHeaders)},
    ));
    await attempt("victim project ID in list query", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts?projectId=${victimProject.id}`,
      {headers: attackerHeaders(forgedHeaders)},
    ));
    await attempt("encoded traversal to the victim artifact", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/projects/${defaultProjectId}/..%2F..%2Fartifacts%2F${victimArtifact.id}`,
      {headers: attackerHeaders()},
    ));
    await attempt("victim content host", 404, fetchContentThroughServer(
      attackerServer.baseUrl,
      published.body.links.version,
      forgedHeaders,
    ));
    await attempt("victim content session", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts/${victimArtifact.id}/content-sessions`,
      {headers: attackerHeaders(forgedHeaders), method: "POST"},
    ));
    await attempt("upload plan naming the victim project", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/uploads`,
      {
        body: JSON.stringify({
          entryPath: "index.html",
          files: [{
            mediaType: victimFile.mediaType,
            path: victimFile.path,
            sha256: sha256(victimFile.bytes),
            size: victimFile.bytes.byteLength,
          }],
          projectId: victimProject.id,
        }),
        headers: attackerHeaders({"Content-Type": "application/json", ...forgedHeaders}),
        method: "POST",
      },
    ));
    await attempt("upload plan with an installation body field", 422, fetch(
      `${attackerServer.baseUrl}/api/v1/uploads`,
      {
        body: JSON.stringify({
          entryPath: "index.html",
          files: [{
            mediaType: victimFile.mediaType,
            path: victimFile.path,
            sha256: sha256(victimFile.bytes),
            size: victimFile.bytes.byteLength,
          }],
          installationId: victim.installationId,
        }),
        headers: attackerHeaders({"Content-Type": "application/json"}),
        method: "POST",
      },
    ));
    await attempt("bytes for the victim upload", 404, fetch(
      replaceOrigin(openFile.uploadUrl, attackerServer.baseUrl),
      {
        body: copiedArrayBuffer(victimFile.bytes),
        headers: attackerHeaders(forgedHeaders),
        method: "PUT",
      },
    ));
    await attempt("commit of the victim upload", 404, fetch(
      replaceOrigin(openUpload.commitUrl, attackerServer.baseUrl),
      {
        body: JSON.stringify({target: {kind: "new_artifact", name: "Stolen upload", tags: []}}),
        headers: mutationHeaders(attacker.apiToken, `auth-017-f-steal-${suffix}`),
        method: "POST",
      },
    ));
    const attackerUpload = await stageExternalStorageFile(
      attackerServer.baseUrl,
      attacker.apiToken,
      `<h1>attacker version ${suffix}</h1>`,
    );
    await attempt("new version of the victim artifact", 404, fetch(
      attackerUpload.commitUrl,
      {
        body: JSON.stringify({target: {
          artifactId: victimArtifact.id,
          expectedCurrentVersionId: victimVersion.id,
          kind: "new_version",
        }}),
        headers: mutationHeaders(attacker.apiToken, `auth-017-f-version-${suffix}`),
        method: "POST",
      },
    ));
    await attempt("delete of the victim artifact", 404, fetch(
      `${attackerServer.baseUrl}/api/v1/artifacts/${victimArtifact.id}`,
      {
        body: JSON.stringify({expectedCurrentVersionId: victimVersion.id}),
        headers: mutationHeaders(attacker.apiToken, `auth-017-f-delete-${suffix}`),
        method: "DELETE",
      },
    ));
    expect(observed).toEqual(expected);

    const mcpAttempts = [
      {arguments: {artifactId: victimArtifact.id}, name: "artifact_get"},
      {arguments: {artifactId: victimArtifact.id, projectId: victimProject.id}, name: "artifact_get"},
      {arguments: {artifactId: victimArtifact.id}, name: "artifact_version_list"},
      {
        arguments: {
          artifactId: victimArtifact.id,
          expectedCurrentVersionId: victimVersion.id,
          idempotencyKey: `auth-017-f-mcp-delete-${suffix}`,
        },
        name: "artifact_delete",
      },
    ] as const;
    const mcpResponses = await Promise.all(mcpAttempts.map(async (call) => {
      const response = await externalStorageMcpRequest(
        attackerServer.baseUrl,
        attacker.apiToken,
        "tools/call",
        call,
        call.name,
      );
      const body: unknown = await response.json();
      return {body, call, response};
    }));
    for (const {body, call, response} of mcpResponses) {
      expect({call: call.name, status: response.status}).toEqual({call: call.name, status: 200});
      const result = mcpToolTextResultSchema.parse(body).result;
      expect({call: call.name, isError: result.isError}).toEqual({call: call.name, isError: true});
      expect(JSON.stringify(result.content)).not.toContain(victimContent);
    }
    const victimTokenMcp = await externalStorageMcpRequest(
      attackerServer.baseUrl,
      victim.apiToken,
      "tools/call",
      {arguments: {artifactId: victimArtifact.id}, name: "artifact_get"},
      "artifact_get",
    );
    expect(victimTokenMcp.status).toBe(401);
    await victimTokenMcp.arrayBuffer();

    const replay = await publishNew(attackerServer.baseUrl, attacker.apiToken, {
      content: victimContent,
      idempotencyKey: sharedIdempotencyKey,
      name: "Victim artifact",
    });
    expect(replay.response.status).toBe(201);
    expect(replay.body.replayed).toBe(false);
    expect(replay.body.artifact.id).not.toBe(victimArtifact.id);
    expect(replay.body.version.id).not.toBe(victimVersion.id);

    expect(await installationRows(environment, victim.installationId)).toEqual(victimRowsBefore);
    expect(await installationObjectKeys(s3Client, victim.installationId)).toEqual(victimKeysBefore);
    expect(await installationRowsMentioning(
      environment,
      attacker.installationId,
      [victim.installationId, victimArtifact.id, victimVersion.id, victimProject.id, openUpload.uploadId],
    )).toEqual([]);
  });

  test("external-storage foundation: a local browser login attempt is consumed once through Postgres", async () => {
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    const scopedInstallation = `login-attempt-${randomUUID()}`;
    try {
      await PostgresArtifactRepository.open(database, scopedInstallation);
      const repository = new PostgresIdentityRepository(
        database,
        scopedInstallation,
      );
      await repository.createLoginAttempt({
        codeVerifier: "not-applicable",
        createdAt: "2026-08-18T12:00:00.000Z",
        expiresAt: "2126-08-18T12:00:00.000Z",
        nonce: null,
        provider: "artifact-server-local",
        returnTo: "/",
        stateDigest: "postgres-login-attempt-local-state",
      });
      const consumed = await repository.consumeLoginAttempt(
        "postgres-login-attempt-local-state",
        "artifact-server-local",
        "2026-08-18T12:00:05.000Z",
      );
      expect(consumed).toMatchObject({
        provider: "artifact-server-local",
        returnTo: "/",
      });
      await expect(repository.consumeLoginAttempt(
        "postgres-login-attempt-local-state",
        "artifact-server-local",
        "2026-08-18T12:00:06.000Z",
      )).rejects.toMatchObject({_tag: "LoginAttemptRejected"});
    } finally {
      await database.close();
    }
  });

  test("external-storage foundation: concurrent replicas cannot deactivate the last two administrators", async () => {
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    const scopedInstallation = `administrator-race-${randomUUID()}`;
    try {
      await PostgresArtifactRepository.open(database, scopedInstallation);
      const repository = new PostgresIdentityRepository(
        database,
        scopedInstallation,
      );
      const createdAt = "2026-08-13T15:00:00.000Z";
      await Promise.all([
        repository.admitMember({
          actor: installationOperatorActor,
          createdAt,
          displayName: "Administrator A",
          email: "administrator-a@example.test",
          id: "administrator-a",
          installationId: scopedInstallation,
          role: "administrator",
        }),
        repository.admitMember({
          actor: installationOperatorActor,
          createdAt,
          displayName: "Administrator B",
          email: "administrator-b@example.test",
          id: "administrator-b",
          installationId: scopedInstallation,
          role: "administrator",
        }),
      ]);
      const results = await Promise.allSettled([
        repository.deactivateMember(
          scopedInstallation,
          "administrator-a",
          "2026-08-13T15:01:00.000Z",
          installationOperatorActor,
        ),
        repository.deactivateMember(
          scopedInstallation,
          "administrator-b",
          "2026-08-13T15:01:00.000Z",
          installationOperatorActor,
        ),
      ]);
      expect(results.map(({status}) => status).toSorted((left, right) =>
        left.localeCompare(right)
      )).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find(({status}) => status === "rejected");
      if (rejected?.status !== "rejected") {
        throw new Error("The administrator race did not reject one mutation.");
      }
      expect(rejected.reason).toMatchObject({_tag: "IdentityConflict"});
      const members = await repository.listMembers(scopedInstallation);
      expect(members.filter((member) =>
        member.role === "administrator" && member.status === "active"
      )).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  test("AUTH-009-B AUTH-009-F: sessions, managed keys, and staged uploads cross process boundaries", async () => {
    expect.hasAssertions();
    const externalStorageIdentity = {
      apiToken: managedTestKey("identity-runtime"),
      installationId: "external-storage-identity-installation",
    };
    const [first, second] = await Promise.all([
      startExternalStorageProcess(environment, externalStorageIdentity),
      startInProcessExternalStorageServer(environment, externalStorageIdentity),
    ]);

    const cookies = await seedAdministratorSession(
      environment,
      externalStorageIdentity.installationId,
    );

    const session = await fetch(`${second.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(session.status).toBe(200);
    sessionResponseSchema.parse(await session.json());

    const memberResponse = await fetch(`${second.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "External-storage team member",
        email: "external-storage-member@example.test",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(memberResponse.status).toBe(201);
    const member = z.object({member: z.object({id: z.string()})}).parse(
      await memberResponse.json(),
    ).member;
    const duplicateMember = await fetch(`${second.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Duplicate team member",
        email: "EXTERNAL-STORAGE-MEMBER@example.test",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(duplicateMember.status).toBe(409);
    const memberList = await fetch(`${second.baseUrl}/api/v1/members`, {
      headers: {Cookie: cookies.header},
    });
    expect(memberList.status).toBe(200);
    expect(z.object({members: z.array(z.object({id: z.string()}))})
      .parse(await memberList.json()).members).toHaveLength(2);

    const issueResponse = await fetch(`${second.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Cross-process reader",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(issueResponse.status).toBe(201);
    const issued = issuedKeySchema.parse(await issueResponse.json());
    const keyList = await fetch(`${second.baseUrl}/api/v1/api-keys`, {
      headers: {Cookie: cookies.header},
    });
    expect(keyList.status).toBe(200);
    const listedKeys = z.object({apiKeys: z.array(z.object({
      id: z.string(),
      name: z.string(),
    }))}).parse(await keyList.json()).apiKeys;
    expect(listedKeys).toHaveLength(2);
    expect(listedKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({id: issued.apiKey.id}),
      expect.objectContaining({name: "Installation bootstrap key"}),
    ]));
    expect(await bearerStatus(first.baseUrl, issued.token)).toBe(200);

    const rotateResponse = await fetch(
      `${second.baseUrl}/api/v1/api-keys/${issued.apiKey.id}/rotate`,
      {
        headers: browserMutationHeaders("https://artifacts.example.com", cookies),
        method: "POST",
      },
    );
    expect(rotateResponse.status).toBe(201);
    const rotated = issuedKeySchema.parse(await rotateResponse.json());
    expect(rotated.apiKey).toMatchObject({
      authorizedByPrincipalId: issued.apiKey.authorizedByPrincipalId,
      principalId: issued.apiKey.principalId,
      principalKind: issued.apiKey.principalKind,
      rotatedFromId: issued.apiKey.id,
    });
    expect(await bearerStatus(second.baseUrl, issued.token)).toBe(401);
    expect(await bearerStatus(second.baseUrl, rotated.token)).toBe(200);

    const revokeResponse = await fetch(
      `${second.baseUrl}/api/v1/api-keys/${rotated.apiKey.id}/revoke`,
      {
        headers: browserMutationHeaders("https://artifacts.example.com", cookies),
        method: "POST",
      },
    );
    expect(revokeResponse.status).toBe(200);
    expect(await bearerStatus(first.baseUrl, rotated.token)).toBe(401);

    const deactivateMember = await fetch(
      `${second.baseUrl}/api/v1/members/${member.id}/deactivate`,
      {
        headers: browserMutationHeaders("https://artifacts.example.com", cookies),
        method: "POST",
      },
    );
    expect(deactivateMember.status).toBe(200);

    const fileBytes = new TextEncoder().encode(
      "<main>cross-process staged content</main>",
    );
    const createUpload = await fetch(`${first.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: createHash("sha256").update(fileBytes).digest("hex"),
          size: fileBytes.byteLength,
        }],
      }),
      headers: {
        Authorization: `Bearer ${externalStorageIdentity.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(createUpload.status).toBe(201);
    const upload = uploadResponseSchema.parse(await createUpload.json());
    const plannedFile = upload.files[0];
    if (plannedFile === undefined) throw new Error("The staged upload has no file.");

    const uploadToSecond = replaceOrigin(plannedFile.uploadUrl, second.baseUrl);
    const uploaded = await fetch(uploadToSecond, {
      body: copiedArrayBuffer(fileBytes),
      headers: {Authorization: `Bearer ${externalStorageIdentity.apiToken}`},
      method: "PUT",
    });
    expect(uploaded.status).toBe(200);

    const commit = await fetch(replaceOrigin(upload.commitUrl, second.baseUrl), {
      body: JSON.stringify({
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Cross-process staged site",
          tags: ["staged", "external-storage"],
        },
      }),
      headers: mutationHeaders(
        externalStorageIdentity.apiToken,
        `staged-commit-${randomUUID()}`,
      ),
      method: "POST",
    });
    expect(commit.status).toBe(201);
    const committed = publishResponseSchema.parse(await commit.json());
    const rendered = await fetchContentThroughServer(
      first.baseUrl,
      committed.links.version,
    );
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe(new TextDecoder().decode(fileBytes));

    const logout = await fetch(`${second.baseUrl}/api/v1/session/logout`, {
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect((await fetch(`${first.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    })).status).toBe(401);
  });

  test("external-storage preview lease foundation: Postgres serves management, history, comparison, idempotency, and private content", async () => {
    expect.hasAssertions();
    const repositoryIdentity = {
      apiToken: managedTestKey("repository-runtime"),
      installationId: "postgres-repository-surface",
    };
    let server = await startInProcessExternalStorageServer(environment, repositoryIdentity);
    const first = await publishNew(server.baseUrl, repositoryIdentity.apiToken, {
      content: "<p>repository version one</p>",
      idempotencyKey: `surface-create-${randomUUID()}`,
      name: "Repository surface",
    });
    const versionKey = `surface-version-${randomUUID()}`;
    const second = await publishVersion(
      server.baseUrl,
      repositoryIdentity.apiToken,
      {
        artifactId: first.body.artifact.id,
        content: "<p>repository version two</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: versionKey,
      },
    );
    expect(second.response.status).toBe(201);
    const secondBody = publishResponseSchema.parse(second.body);
    const replay = await publishVersion(
      server.baseUrl,
      repositoryIdentity.apiToken,
      {
        artifactId: first.body.artifact.id,
        content: "<p>repository version two</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: versionKey,
      },
    );
    expect(replay.response.status).toBe(200);
    expect(publishResponseSchema.parse(replay.body)).toMatchObject({
      replayed: true,
      version: {id: secondBody.version.id},
    });

    const tagChange = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/tags`,
      "PATCH",
      `surface-tags-${randomUUID()}`,
      {
        expectedCurrentVersionId: secondBody.version.id,
        tags: ["POSTGRES", "review"],
      },
    );
    expect(tagChange.status).toBe(200);

    const staleAccessChange = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/access`,
      "PATCH",
      `surface-stale-access-${randomUUID()}`,
      {
        accessSetting: "account_required",
        expectedCurrentVersionId: first.body.version.id,
      },
    );
    expect(staleAccessChange.status).toBe(409);
    expect(await staleAccessChange.json()).toEqual({
      error: {
        code: "ARTIFACT_MUTATION_CONFLICT",
        message: `The artifact moved to version ${secondBody.version.id}.`,
      },
    });

    const filtered = await fetch(
      `${server.baseUrl}/api/v1/artifacts?tag=postgres`,
      {headers: bearerHeaders(repositoryIdentity.apiToken)},
    );
    expect(filtered.status).toBe(200);
    expect(artifactListSchema.parse(await filtered.json()).artifacts).toHaveLength(1);

    const accessChange = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/access`,
      "PATCH",
      `surface-access-${randomUUID()}`,
      {
        accessSetting: "account_required",
        expectedCurrentVersionId: secondBody.version.id,
      },
    );
    expect(accessChange.status).toBe(200);
    expect((await fetchContentThroughServer(
      server.baseUrl,
      secondBody.links.version,
    )).status).toBe(401);

    const bootstrapResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/content-sessions`,
      {
        headers: bearerHeaders(repositoryIdentity.apiToken),
        method: "POST",
      },
    );
    expect(bootstrapResponse.status).toBe(201);
    const bootstrap = z.object({bootstrapUrl: z.url()}).parse(
      await bootstrapResponse.json(),
    );
    const previewLeaseResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}/preview-leases?projectId=${defaultProjectId}`,
      {
        headers: bearerHeaders(repositoryIdentity.apiToken),
        method: "POST",
      },
    );
    expect(previewLeaseResponse.status).toBe(201);
    const previewLease = z.object({
      baseUrl: z.url(),
      versionId: z.literal(first.body.version.id),
    }).parse(await previewLeaseResponse.json());
    await server.stop();
    server = await startInProcessExternalStorageServer(environment, repositoryIdentity);
    const exchange = await fetchContentThroughServer(
      server.baseUrl,
      bootstrap.bootstrapUrl,
    );
    expect(exchange.status).toBe(200);
    expect(await exchange.clone().text()).toContain('content="0;url=/"');
    const contentCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (contentCookie === undefined) {
      throw new Error("The private-content exchange did not issue a cookie.");
    }
    const privateContent = await fetchContentThroughServer(
      server.baseUrl,
      secondBody.links.version,
      {Cookie: contentCookie},
    );
    expect(privateContent.status).toBe(200);
    expect(await privateContent.text()).toBe("<p>repository version two</p>");

    const historicalPreview = await fetchContentThroughServer(
      server.baseUrl,
      new URL("index.html", previewLease.baseUrl).toString(),
    );
    expect(historicalPreview.status).toBe(200);
    expect(historicalPreview.headers.get("access-control-allow-origin")).toBe("*");
    expect(historicalPreview.headers.get("cross-origin-resource-policy"))
      .toBe("cross-origin");
    expect(await historicalPreview.text()).toBe("<p>repository version one</p>");
    const forgedPreviewUrl = new URL("index.html", previewLease.baseUrl);
    const [leaseLabel, ...contentDomainLabels] = forgedPreviewUrl.hostname.split(".");
    if (leaseLabel === undefined) throw new Error("Preview lease hostname has no label.");
    forgedPreviewUrl.hostname = `${leaseLabel.slice(0, -1)}${
      leaseLabel.endsWith("a") ? "b" : "a"
    }.${contentDomainLabels.join(".")}`;
    expect((await fetchContentThroughServer(
      server.baseUrl,
      forgedPreviewUrl.toString(),
    )).status).toBe(401);

    const versions = await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/versions`,
    );
    expect(versions.status).toBe(200);
    const versionIds = z.object({
      versions: z.array(z.object({version: z.object({id: z.string()})})),
    }).parse(await versions.json()).versions.map(({version}) => version.id);
    expect(versionIds).toEqual([secondBody.version.id, first.body.version.id]);

    const comparison = await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/comparisons?${
        new URLSearchParams({
          fromVersionId: first.body.version.id,
          toVersionId: secondBody.version.id,
        })
      }`,
    );
    expect(comparison.status).toBe(200);
    expect(await comparison.json()).toMatchObject({
      from: {
        artifactId: first.body.artifact.id,
        id: first.body.version.id,
      },
      to: {
        artifactId: first.body.artifact.id,
        id: secondBody.version.id,
      },
    });

    const actions = await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/actions`,
    );
    expect(actions.status).toBe(200);
    expect(z.object({actions: z.array(z.object({action: z.string()}))})
      .parse(await actions.json()).actions.map(({action}) => action)).toEqual([
        "change_access",
        "change_tags",
        "publish",
        "publish",
      ]);

    const restoreKey = `surface-restore-${randomUUID()}`;
    const restored = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/restore`,
      "POST",
      restoreKey,
      {
        expectedCurrentVersionId: secondBody.version.id,
        versionId: first.body.version.id,
      },
    );
    expect(restored.status).toBe(200);
    expect(publishResponseSchema.parse(await restored.json())).toMatchObject({
      artifact: {currentVersionId: first.body.version.id},
      replayed: false,
    });
    const restoredReplay = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}/restore`,
      "POST",
      restoreKey,
      {
        expectedCurrentVersionId: secondBody.version.id,
        versionId: first.body.version.id,
      },
    );
    expect(publishResponseSchema.parse(await restoredReplay.json()).replayed)
      .toBe(true);

    const deleted = await mutateArtifact(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}`,
      "DELETE",
      `surface-delete-${randomUUID()}`,
      {expectedCurrentVersionId: first.body.version.id},
    );
    expect(deleted.status).toBe(200);
    expect((await authenticatedFetch(
      server.baseUrl,
      repositoryIdentity.apiToken,
      `/api/v1/artifacts/${first.body.artifact.id}`,
    )).status).toBe(404);
  });

  test("external-storage foundation: integrity scans committed Postgres records and S3 bytes without repair", async () => {
    const identity = {
      apiToken: managedTestKey("integrity-runtime"),
      installationId: `external-integrity-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity, {
      contentDomain: null,
    });
    const published = await publishNew(server.baseUrl, identity.apiToken, {
      content: "external integrity proof",
      idempotencyKey: `external-integrity-${randomUUID()}`,
      name: "External integrity proof",
      routingMode: "spa",
    });
    expect(published.response.status).toBe(201);
    const assetBytes = new TextEncoder().encode("external integrity asset\n");
    const planned = await planAsset(server, identity.apiToken, published.body.artifact.id, {
      bytes: assetBytes,
      mediaType: "text/markdown",
      name: "notes.md",
    });
    expect(planned.status).toBe(201);
    const plan = assetPlanSchema.parse(await planned.json());
    expect((await putAssetBytes(plan.file.uploadUrl, identity.apiToken, assetBytes)).status)
      .toBe(200);
    expect((await commitAsset(plan, identity.apiToken, `external-integrity-asset-${randomUUID()}`))
      .status).toBe(201);
    await server.stop();

    const configuration = {
      databaseUrl: Redacted.make(environment.databaseUrl),
      installationId: identity.installationId,
      objectStorage: createS3ObjectStorageProviderFactory({
        accessKeyId: environment.accessKey,
        bucket,
        endpoint: environment.endpoint,
        forcePathStyle: true,
        region,
        secretAccessKey: Redacted.make(environment.secretKey),
      }),
    };
    const healthy = await checkExternalStorageIntegrity(configuration);
    expect(healthy).toMatchObject({
      artifactsChecked: 1,
      blobsChecked: 2,
      problems: [],
      status: "healthy",
      versionsChecked: 1,
    });

    const namespace = createHash("sha256")
      .update(identity.installationId)
      .digest("hex");
    const assetDigest = sha256(assetBytes);
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: `installations/${namespace}/blobs/${assetDigest.slice(0, 2)}/${assetDigest}`,
    }));
    const missingAsset = await checkExternalStorageIntegrity(configuration);
    expect(missingAsset).toMatchObject({
      problems: [{artifactId: published.body.artifact.id, code: "blob_missing"}],
      status: "corrupt",
    });

    const listed = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `installations/${namespace}/blobs/`,
    }));
    const key = listed.Contents?.[0]?.Key;
    if (key === undefined) throw new Error("The integrity fixture blob was not stored.");
    await s3Client.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));

    const corrupt = await checkExternalStorageIntegrity(configuration);
    expect(corrupt).toMatchObject({
      problems: [{code: "blob_missing"}, {code: "blob_missing"}],
      status: "corrupt",
    });
  });

  test("external-storage foundation: logical Postgres and object backups restore stable IDs and bytes", async () => {
    expect.hasAssertions();
    const backupIdentity = {
      apiToken: managedTestKey("backup-runtime"),
      installationId: "backup-restore-installation",
    };
    const source = await startExternalStorageProcess(environment, backupIdentity);
    const projectResponse = await fetch(`${source.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Backup project"}),
      headers: mutationHeaders(
        backupIdentity.apiToken,
        `backup-project-${randomUUID()}`,
      ),
      method: "POST",
    });
    expect(projectResponse.status).toBe(201);
    const backupProject = z.object({
      project: z.object({
        archivedAt: z.string().nullable(),
        id: z.string(),
        name: z.string(),
      }),
    }).parse(await projectResponse.json()).project;
    const published = await publishNew(source.baseUrl, backupIdentity.apiToken, {
      content: "<article>logical backup survives</article>",
      idempotencyKey: `backup-create-${randomUUID()}`,
      name: "Backup proof",
      projectId: backupProject.id,
    });
    expect(published.response.status).toBe(201);
    const cookies = await seedAdministratorSession(
      environment,
      backupIdentity.installationId,
    );
    const issueResponse = await fetch(`${source.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Restored reader",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", cookies),
      method: "POST",
    });
    expect(issueResponse.status).toBe(201);
    const issued = issuedKeySchema.parse(await issueResponse.json());
    const actionPath =
      `/api/v1/artifacts/${published.body.artifact.id}/actions?projectId=${backupProject.id}`;
    const sourceActions = z.object({
      actions: z.array(z.object({
        action: z.string(),
        artifactId: z.string(),
        id: z.string(),
        versionId: z.string(),
      })),
    }).parse(await (await authenticatedFetch(
      source.baseUrl,
      backupIdentity.apiToken,
      actionPath,
    )).json()).actions;
    const archivedProjectResponse = await fetch(
      `${source.baseUrl}/api/v1/projects/${backupProject.id}/archive`,
      {headers: bearerHeaders(backupIdentity.apiToken), method: "POST"},
    );
    expect(archivedProjectResponse.status).toBe(200);
    const archivedProject = z.object({
      project: z.object({archivedAt: z.string(), id: z.string()}),
    }).parse(await archivedProjectResponse.json()).project;
    await source.stop();

    const [databaseDump, objectBackup] = await Promise.all([
      dumpPostgres(environment),
      backupBucket(s3Client, bucket),
    ]);
    expect(databaseDump.byteLength).toBeGreaterThan(0);
    expect(objectBackup.length).toBeGreaterThan(0);

    const restoreDatabase = `artifactserver_restore_${randomUUID().replaceAll("-", "")}`;
    const restoreBucket = `artifact-server-restore-${randomUUID()}`;
    await Promise.all([
      restorePostgres(environment, restoreDatabase, databaseDump),
      restoreBucketObjects(s3Client, restoreBucket, objectBackup),
    ]);

    const restoredEnvironment = {
      ...environment,
      databaseUrl: databaseUrlFor(environment.databaseUrl, restoreDatabase),
    };
    const restored = await startExternalStorageProcess(restoredEnvironment, {
      ...backupIdentity,
      storageBucket: restoreBucket,
    });
    const restoredProjectResponse = await authenticatedFetch(
      restored.baseUrl,
      backupIdentity.apiToken,
      `/api/v1/projects/${backupProject.id}`,
    );
    expect(restoredProjectResponse.status).toBe(200);
    await expect(restoredProjectResponse.json()).resolves.toMatchObject({
      project: {
        archivedAt: archivedProject.archivedAt,
        id: backupProject.id,
        name: "Backup project",
      },
    });
    const listed = await listArtifacts(
      restored.baseUrl,
      backupIdentity.apiToken,
      backupProject.id,
    );
    expect(listed.body.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({
          currentVersionId: published.body.version.id,
          id: published.body.artifact.id,
          name: "Backup proof",
          projectId: backupProject.id,
        }),
      }),
    ]);
    expect(await bearerStatus(restored.baseUrl, issued.token)).toBe(200);
    expect((await fetch(`${restored.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    })).status).toBe(200);
    const restoredActions = z.object({
      actions: z.array(z.object({
        action: z.string(),
        artifactId: z.string(),
        id: z.string(),
        versionId: z.string(),
      })),
    }).parse(await (await authenticatedFetch(
      restored.baseUrl,
      backupIdentity.apiToken,
      actionPath,
    )).json()).actions;
    expect(restoredActions).toEqual(sourceActions);
    const rendered = await fetchContentThroughServer(
      restored.baseUrl,
      published.body.links.version,
    );
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe("<article>logical backup survives</article>");
  });

  test("external-storage foundation: invalid database and object-store credentials fail before readiness", async () => {
    expect.hasAssertions();
    const invalidStorage = {
      ...environment,
      secretKey: "wrong-object-store-secret",
    };
    await expect(startExternalStorageProcess(invalidStorage, {
      apiToken: managedTestKey("invalid-storage"),
      installationId: "invalid-storage-installation",
    })).rejects.toThrow(/exited before readiness/u);

    const databaseUrl = new URL(environment.databaseUrl);
    databaseUrl.password = "wrong-postgres-password";
    const invalidDatabase = {...environment, databaseUrl: databaseUrl.toString()};
    await expect(startExternalStorageProcess(invalidDatabase, {
      apiToken: managedTestKey("invalid-database"),
      installationId: "invalid-database-installation",
    })).rejects.toThrow(/exited before readiness/u);

    const unavailableStorage = {
      ...environment,
      endpoint: "http://127.0.0.1:1",
    };
    await expect(startExternalStorageProcess(unavailableStorage, {
      apiToken: managedTestKey("unavailable-storage"),
      installationId: "unavailable-storage-installation",
    })).rejects.toThrow(/exited before readiness/u);
  });

  test("OPS-001-B OPS-001-F: health and dependency readiness are separate and fail closed", async () => {
    expect.hasAssertions();
    const readinessBucket = `artifact-server-readiness-${randomUUID()}`;
    await s3Client.send(new CreateBucketCommand({Bucket: readinessBucket}));
    const server = await startExternalStorageProcess(environment, {
      apiToken: managedTestKey("readiness-runtime"),
      installationId: `readiness-${randomUUID()}`,
      storageBucket: readinessBucket,
    });

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({status: "ok"});

    const ready = await fetch(`${server.baseUrl}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      components: {
        configuration: {latencyMilliseconds: 0, status: "ready"},
        database: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        migrations: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        objectStorage: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
      },
      lifecycle: "ready",
      status: "ready",
    });

    await s3Client.send(new DeleteBucketCommand({Bucket: readinessBucket}));
    const unavailable = await fetch(`${server.baseUrl}/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      components: {
        configuration: {latencyMilliseconds: 0, status: "ready"},
        database: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        migrations: {
          latencyMilliseconds: expect.any(Number),
          status: "ready",
        },
        objectStorage: {
          latencyMilliseconds: expect.any(Number),
          status: "unavailable",
        },
      },
      lifecycle: "ready",
      status: "not_ready",
    });

    const stillAlive = await fetch(`${server.baseUrl}/health`);
    expect(stillAlive.status).toBe(200);
  });

  test("OPS-010-B: SIGTERM withdraws readiness, keeps liveness, refuses new connections, finishes an accepted upload and commit, and exits with the publish durable", async () => {
    const suffix = randomUUID();
    const identity = {
      apiToken: managedTestKey(`ops-010-b-${suffix}`),
      installationId: `ops-010-b-${suffix}`,
    };
    const withdrawalMilliseconds = 1_500;
    const deadlineMilliseconds = 8_000;
    const server = await startExternalStorageProcess(environment, identity, {
      ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: String(withdrawalMilliseconds),
      ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: String(deadlineMilliseconds),
    });
    const committedContent = `<h1>committed while draining ${suffix}</h1>`;
    const committing = await stageExternalStorageFile(
      server.baseUrl,
      identity.apiToken,
      committedContent,
    );
    const uploadedBytes = new TextEncoder().encode(`<p>uploaded while draining ${suffix}</p>`.repeat(2_000));
    const uploading = await planExternalStorageUpload(server.baseUrl, identity.apiToken, [{
      bytes: uploadedBytes,
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    }], "index.html");
    const uploadingFile = uploading.files[0];
    if (uploadingFile === undefined) throw new Error("The draining upload plan had no file.");

    const heldCommit = startHeldRequest(
      replaceOrigin(committing.commitUrl, server.baseUrl),
      "POST",
      mutationHeaders(identity.apiToken, `ops-010-b-commit-${suffix}`),
      Buffer.from(JSON.stringify({target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Committed while draining",
        tags: [],
      }})),
    );
    const heldUpload = startHeldRequest(
      replaceOrigin(uploadingFile.uploadUrl, server.baseUrl),
      "PUT",
      bearerHeaders(identity.apiToken),
      Buffer.from(uploadedBytes),
    );
    await Promise.all([heldCommit.accepted, heldUpload.accepted]);

    const exited = childExit(server.child);
    const signalledAt = Date.now();
    server.child.kill("SIGTERM");
    const draining = await waitForFreshResponse(server.baseUrl, "/ready", (response) =>
      response.status === 503 && response.body.includes('"lifecycle":"draining"'));
    expect(Date.now() - signalledAt).toBeLessThan(withdrawalMilliseconds);
    expect(JSON.parse(draining.body)).toMatchObject({lifecycle: "draining", status: "not_ready"});
    const liveness = await freshRequest(server.baseUrl, "/health");
    expect(liveness).toEqual({body: '{"status":"ok"}', status: 200});

    const refused = await waitForFreshFailure(server.baseUrl, "/health");
    expect(refused).toBe("ECONNREFUSED");
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(withdrawalMilliseconds - 100);
    expect(server.child.exitCode).toBeNull();

    heldUpload.finish();
    heldCommit.finish();
    const [uploaded, committed] = await Promise.all([heldUpload.response, heldCommit.response]);
    expect(uploaded).toMatchObject({status: 200});
    expect(committed).toMatchObject({status: 201});
    if (!("body" in committed)) throw new Error("The draining commit had no response.");
    const publication = publishResponseSchema.parse(JSON.parse(committed.body));

    const exit = await exited;
    runningProcesses.delete(server.child);
    expect(exit).toEqual({code: 0, signal: null});
    expect(Date.now() - signalledAt).toBeLessThan(withdrawalMilliseconds + deadlineMilliseconds);

    const restarted = await startExternalStorageProcess(environment, identity);
    const details = await authenticatedFetch(
      restarted.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${publication.artifact.id}`,
    );
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      artifact: {currentVersionId: publication.version.id, id: publication.artifact.id},
    });
    const rendered = await fetchContentThroughServer(restarted.baseUrl, publication.links.version);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe(committedContent);
  });

  test("OPS-010-F: a draining process stops being ready, refuses new work, cuts a request still open at the deadline, saves nothing for it, and still exits cleanly", async () => {
    const suffix = randomUUID();
    const identity = {
      apiToken: managedTestKey(`ops-010-f-${suffix}`),
      installationId: `ops-010-f-${suffix}`,
    };
    const withdrawalMilliseconds = 500;
    const deadlineMilliseconds = 1_500;
    const server = await startExternalStorageProcess(environment, identity, {
      ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: String(withdrawalMilliseconds),
      ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: String(deadlineMilliseconds),
    });
    const stuck = await stageExternalStorageFile(
      server.baseUrl,
      identity.apiToken,
      `<h1>never committed ${suffix}</h1>`,
    );
    const heldCommit = startHeldRequest(
      replaceOrigin(stuck.commitUrl, server.baseUrl),
      "POST",
      mutationHeaders(identity.apiToken, `ops-010-f-commit-${suffix}`),
      Buffer.from(JSON.stringify({target: {
        kind: "new_artifact",
        name: "Never committed",
        tags: [],
      }})),
    );
    await heldCommit.accepted;

    const exited = childExit(server.child);
    const signalledAt = Date.now();
    server.child.kill("SIGTERM");
    const draining = await waitForFreshResponse(server.baseUrl, "/ready", (response) =>
      response.status === 503 && response.body.includes('"lifecycle":"draining"'));
    expect(JSON.parse(draining.body)).toMatchObject({lifecycle: "draining", status: "not_ready"});
    expect(await waitForFreshFailure(server.baseUrl, "/api/v1/artifacts")).toBe("ECONNREFUSED");

    const exitBound = withdrawalMilliseconds + deadlineMilliseconds + 5_000;
    const cut = await settledWithin(heldCommit.response, exitBound);
    const cutAt = Date.now() - signalledAt;
    expect(cut).toEqual({error: "ECONNRESET"});
    expect(cutAt).toBeGreaterThanOrEqual(withdrawalMilliseconds + deadlineMilliseconds - 100);
    const exit = await settledWithin(exited, exitBound);
    runningProcesses.delete(server.child);
    expect(exit).toEqual({code: 0, signal: null});
    expect(Date.now() - signalledAt).toBeLessThan(exitBound);

    const rows = await installationRows(environment, identity.installationId);
    expect(rows["artifacts"]?.count ?? 0).toBe(0);
    expect(rows["versions"]?.count ?? 0).toBe(0);
    expect(rows["staged_uploads"]?.count).toBe(1);
    const restarted = await startExternalStorageProcess(environment, identity);
    const listed = await listArtifacts(restarted.baseUrl, identity.apiToken);
    expect(listed.body.artifacts).toEqual([]);
  });

  test("external-storage foundation: Postgres serves the comment lifecycle, paging, and same-instant ledger keys", async () => {
    expect.hasAssertions();
    const commentIdentity = {
      apiToken: managedTestKey("postgres-comment"),
      installationId: `postgres-comments-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      commentIdentity,
    );
    const first = await publishNew(server.baseUrl, commentIdentity.apiToken, {
      content: "<p>comment target version one</p>",
      idempotencyKey: `comment-publish-${randomUUID()}`,
      name: "Comment target",
    });
    const artifactId = first.body.artifact.id;
    const second = await publishVersion(
      server.baseUrl,
      commentIdentity.apiToken,
      {
        artifactId,
        content: "<p>comment target version two</p>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: `comment-publish-second-${randomUUID()}`,
      },
    );
    expect(second.response.status).toBe(201);
    const secondVersionId = publishResponseSchema.parse(second.body).version.id;

    const threadKey = `comment-thread-${randomUUID()}`;
    const created = await createCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      {artifactId, versionId: first.body.version.id},
      threadKey,
      {body: "The axis label is wrong.", path: "index.html"},
    );
    expect(created.response.status).toBe(201);
    const thread = commentCreationSchema.parse(created.body);
    expect(thread.replayed).toBe(false);
    expect(thread.thread.versionId).toBe(first.body.version.id);
    expect(thread.thread.versionId).not.toBe(secondVersionId);
    expect(thread.thread.replyCount).toBe(0);
    expect(thread.thread.author.displayName).toBe("Installation bootstrap key");

    const replayedCreate = await createCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      {artifactId, versionId: first.body.version.id},
      threadKey,
      {body: "The axis label is wrong.", path: "index.html"},
    );
    expect(replayedCreate.response.status).toBe(201);
    const replayedThread = commentCreationSchema.parse(replayedCreate.body);
    expect(replayedThread.replayed).toBe(true);
    expect(replayedThread.thread.id).toBe(thread.thread.id);
    expect(replayedThread.thread.createdAt).toBe(thread.thread.createdAt);

    const replyKey = `comment-reply-${randomUUID()}`;
    const reply = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      replyKey,
      "Corrected in the next publish.",
    );
    expect(reply.response.status).toBe(201);
    const replyBody = replyCreationSchema.parse(reply.body);
    expect(replyBody.replayed).toBe(false);
    const replayedReply = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      replyKey,
      "Corrected in the next publish.",
    );
    expect(replyCreationSchema.parse(replayedReply.body)).toMatchObject({
      replayed: true,
      reply: {id: replyBody.reply.id},
    });

    const resolved = await patchCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      {state: "resolved"},
    );
    expect(resolved.status).toBe(200);
    expect(commentThreadEnvelopeSchema.parse(await resolved.json()).thread)
      .toMatchObject({
        replyCount: 1,
        resolvedBy: {
          displayName: "Installation bootstrap key",
          principalKind: "service",
        },
        state: "resolved",
      });

    const refused = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      `comment-reply-refused-${randomUUID()}`,
      "Too late to answer.",
    );
    expect(refused.response.status).toBe(409);
    expect(commentFailureSchema.parse(refused.body).error.code)
      .toBe("COMMENT_RESOLVED");

    const reopened = await patchCommentThread(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      {state: "open"},
    );
    expect(reopened.status).toBe(200);
    expect(commentThreadEnvelopeSchema.parse(await reopened.json()).thread)
      .toMatchObject({resolvedAt: null, resolvedBy: null, state: "open"});
    const acceptedAfterReopen = await createCommentReply(
      server.baseUrl,
      commentIdentity.apiToken,
      artifactId,
      thread.thread.id,
      `comment-reply-after-reopen-${randomUUID()}`,
      "Reopened because the fix regressed.",
    );
    expect(acceptedAfterReopen.response.status).toBe(201);

    const extraThreads = await Promise.all([1, 2].map((index) =>
      createCommentThread(
        server.baseUrl,
        commentIdentity.apiToken,
        {artifactId, versionId: secondVersionId},
        `comment-thread-page-${index}-${randomUUID()}`,
        {body: `Paged observation ${index}.`, path: "index.html"},
      )
    ));
    expect(extraThreads.map(({response}) => response.status)).toEqual([201, 201]);
    const laterThreadIds = extraThreads.map(({body}) =>
      commentCreationSchema.parse(body).thread.id
    );

    const firstPage = commentPageSchema.parse(await (await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments?limit=2`,
    )).json());
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = commentPageSchema.parse(await (await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments?limit=2&cursor=${
        encodeURIComponent(firstPage.nextCursor ?? "")
      }`,
    )).json());
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map(({id}) => id)
      .toSorted()).toEqual([thread.thread.id, ...laterThreadIds].toSorted());
    const listedArtifact = await listArtifacts(server.baseUrl, commentIdentity.apiToken);
    expect(listedArtifact.body.artifacts).toEqual([
      expect.objectContaining({commentCount: 3}),
    ]);
    const commentedArtifact = await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      "/api/v1/artifacts?comments=with&sort=comments&limit=1",
    );
    expect(commentedArtifact.status).toBe(200);
    expect(artifactListSchema.parse(await commentedArtifact.json()).artifacts).toEqual([
      expect.objectContaining({commentCount: 3}),
    ]);
    const uncommentedArtifact = await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      "/api/v1/artifacts?comments=without",
    );
    expect(uncommentedArtifact.status).toBe(200);
    expect(artifactListSchema.parse(await uncommentedArtifact.json()).artifacts).toEqual([]);

    const versionFiltered = commentPageSchema.parse(await (await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments?versionId=${first.body.version.id}`,
    )).json());
    expect(versionFiltered.items.map(({id}) => id)).toEqual([thread.thread.id]);

    // Two mutations on one thread can land in the same millisecond. The derived
    // ledger key must stay unique, or the Postgres uniqueness constraint on
    // (installation_id, project_id, idempotency_key) rejects the second write.
    const commentPrincipal = managedTestPrincipal(commentIdentity.apiToken);
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        commentIdentity.installationId,
      );
      const sameInstant = "2026-08-18T09:15:00.000Z";
      const sameInstantEdit = (body: string) => repository.updateThread({
        anchor: null,
        artifactId,
        authorizedByPrincipalId: commentPrincipal.authorizedByPrincipalId,
        body,
        principalId: commentPrincipal.principalId,
        projectId: thread.thread.projectId,
        state: null,
        threadId: thread.thread.id,
        updatedAt: sameInstant,
      });
      await sameInstantEdit("Same-instant edit one.");
      await sameInstantEdit("Same-instant edit two.");
    } finally {
      await database.close();
    }

    const ledger = await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/actions`,
    );
    expect(ledger.status).toBe(200);
    const recorded = commentActionPageSchema.parse(await ledger.json()).actions
      .filter(({action}) => action.startsWith("comment_"))
      .map(({action}) => action);
    expect(recorded.toSorted()).toEqual([
      "comment_create",
      "comment_create",
      "comment_create",
      "comment_reopen",
      "comment_reply",
      "comment_reply",
      "comment_resolve",
      "comment_update",
      "comment_update",
    ]);

    const detail = await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments/${thread.thread.id}`,
    );
    expect(detail.status).toBe(200);
    expect(commentDetailsSchema.parse(await detail.json())).toMatchObject({
      thread: {body: "Same-instant edit two.", replyCount: 2},
    });

    const removed = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${thread.thread.id}`,
      {headers: bearerHeaders(commentIdentity.apiToken), method: "DELETE"},
    );
    expect(removed.status).toBe(204);
    expect((await authenticatedFetch(
      server.baseUrl,
      commentIdentity.apiToken,
      `/api/v1/artifacts/${artifactId}/comments/${thread.thread.id}`,
    )).status).toBe(404);
    await server.stop();
  });

  test("external-storage foundation: Postgres serves the dispatch mailbox, lease reclaim, and consumptive comment listings", async () => {
    expect.hasAssertions();
    const dispatchIdentity = {
      apiToken: managedTestKey("postgres-dispatch"),
      installationId: `postgres-dispatch-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      dispatchIdentity,
    );
    const published = await publishNew(
      server.baseUrl,
      dispatchIdentity.apiToken,
      {
        content: "<p>dispatch target</p>",
        idempotencyKey: `dispatch-publish-${randomUUID()}`,
        name: "Dispatch target",
      },
    );
    const artifactId = published.body.artifact.id;
    const versionId = published.body.version.id;
    const annotate = async (body: string): Promise<string> => {
      const created = await createCommentThread(
        server.baseUrl,
        dispatchIdentity.apiToken,
        {artifactId, versionId},
        `dispatch-thread-${randomUUID()}`,
        {body, path: "index.html"},
      );
      expect(created.response.status).toBe(201);
      return commentCreationSchema.parse(created.body).thread.id;
    };
    const listDefaultCommentIds = async (): Promise<readonly string[]> => {
      const listed = await authenticatedFetch(
        server.baseUrl,
        dispatchIdentity.apiToken,
        `/api/v1/artifacts/${artifactId}/comments`,
      );
      expect(listed.status).toBe(200);
      return commentPageSchema.parse(await listed.json()).items
        .map(({id}) => id);
    };
    const [firstThreadId, secondThreadId, thirdThreadId] = [
      await annotate("The axis label is wrong."),
      await annotate("The legend overlaps the chart."),
      await annotate("The footer year is stale."),
    ];
    expect((await listDefaultCommentIds()).toSorted()).toEqual(
      [firstThreadId, secondThreadId, thirdThreadId].toSorted(),
    );

    const baseInstant = Date.now();
    const at = (offsetMilliseconds: number): string =>
      new Date(baseInstant + offsetMilliseconds).toISOString();
    const sender = managedTestPrincipal(dispatchIdentity.apiToken);
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        dispatchIdentity.installationId,
      );
      const connectionKey = `dispatch-connection-${randomUUID()}`;
      const registration = {
        agentSessionId: "pi-session-one",
        capabilities: {beacon: false, evidence: "native"},
        connectionKey,
        displayName: "site",
        installationId: dispatchIdentity.installationId,
        kind: "pi",
        principalId: sender.principalId,
        workingDirectory: "/work/site",
      } as const;
      const agent = await repository.registerAgent({
        ...registration,
        id: `agt_${randomUUID()}`,
        registeredAt: at(0),
      });
      // The connection key is the identity: a restarted session upserts back
      // into the same row, so dispatches queued for it survive.
      const reregistered = await repository.registerAgent({
        ...registration,
        agentSessionId: "pi-session-two",
        displayName: "site (resumed)",
        id: `agt_${randomUUID()}`,
        registeredAt: at(500),
      });
      expect(reregistered).toMatchObject({
        agentSessionId: "pi-session-two",
        createdAt: at(0),
        displayName: "site (resumed)",
        id: agent.id,
        lastSeenAt: at(500),
      });

      const sendKey = `dispatch-send-${randomUUID()}`;
      const sent = await repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(1_000),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: sendKey,
        installationId: dispatchIdentity.installationId,
        note: "Fix both before the review.",
        projectId: defaultProjectId,
        sender,
        threadIds: [firstThreadId, secondThreadId],
      });
      expect(sent.replayed).toBe(false);
      expect(sent.dispatch).toMatchObject({
        agentId: agent.id,
        state: "queued",
        threadIds: [firstThreadId, secondThreadId],
      });
      const replayedSend = await repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(1_100),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: sendKey,
        installationId: dispatchIdentity.installationId,
        note: "Fix both before the review.",
        projectId: defaultProjectId,
        sender,
        threadIds: [firstThreadId, secondThreadId],
      });
      expect(replayedSend).toMatchObject({
        dispatch: {createdAt: at(1_000), id: sent.dispatch.id},
        replayed: true,
      });

      // Sending is consumptive: the annotations leave the default listing and
      // stay reachable only through the dispatched filter.
      expect(await listDefaultCommentIds()).toEqual([thirdThreadId]);
      const listThreads = (dispatched: "exclude" | "include" | "only") =>
        repository.listThreads({
          artifactId,
          cursor: null,
          dispatched,
          limit: 20,
          projectId: defaultProjectId,
          since: null,
          state: null,
          versionId: null,
        });
      expect((await listThreads("only")).items.map(({id}) => id).toSorted())
        .toEqual([firstThreadId, secondThreadId].toSorted());
      expect((await listThreads("include")).items).toHaveLength(3);

      await expect(repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(1_200),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: `dispatch-send-${randomUUID()}`,
        installationId: dispatchIdentity.installationId,
        note: null,
        projectId: defaultProjectId,
        sender,
        threadIds: [secondThreadId, thirdThreadId],
      })).rejects.toMatchObject({_tag: "InvalidDispatch"});
      expect(await listDefaultCommentIds()).toEqual([thirdThreadId]);

      const claimed = await repository.claimNextDispatch(agent.id, at(2_000), true);
      expect(claimed).toMatchObject({
        claimedAt: at(2_000),
        id: sent.dispatch.id,
        state: "claimed",
      });
      // One active claim per agent: the next poll waits for the report.
      expect(await repository.claimNextDispatch(agent.id, at(2_500), true)).toBeNull();
      // A held poll's re-check attempt answers the same way as a pure read.
      expect(await repository.claimNextDispatch(agent.id, at(2_600), false)).toBeNull();
      await expect(repository.markDelivered({
        agentId: `agt_${randomUUID()}`,
        deliveredAt: at(3_000),
        dispatchId: sent.dispatch.id,
        installationId: dispatchIdentity.installationId,
      })).rejects.toMatchObject({_tag: "DispatchStateConflict"});
      const delivered = await repository.markDelivered({
        agentId: agent.id,
        deliveredAt: at(3_000),
        dispatchId: sent.dispatch.id,
        installationId: dispatchIdentity.installationId,
      });
      expect(delivered).toMatchObject({
        deliveredAt: at(3_000),
        state: "delivered",
      });

      const resolve = async (threadId: string): Promise<void> => {
        const resolved = await patchCommentThread(
          server.baseUrl,
          dispatchIdentity.apiToken,
          artifactId,
          threadId,
          {state: "resolved"},
        );
        expect(resolved.status).toBe(200);
      };
      await resolve(firstThreadId);
      // Addressed is inferred from thread resolution, so a partly answered
      // bundle stays delivered.
      expect(await repository.findDispatch(
        dispatchIdentity.installationId,
        sent.dispatch.id,
        at(3_500),
      )).toMatchObject({addressedAt: null, state: "delivered"});
      await resolve(secondThreadId);
      expect(await repository.observeAddressed(sent.dispatch.id, at(4_000)))
        .toMatchObject({addressedAt: at(4_000), state: "addressed"});

      const second = await repository.createDispatch({
        agentDisplayName: reregistered.displayName,
        agentId: agent.id,
        createdAt: at(5_000),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: `dispatch-send-${randomUUID()}`,
        installationId: dispatchIdentity.installationId,
        note: null,
        projectId: defaultProjectId,
        sender,
        threadIds: [thirdThreadId],
      });
      expect(await listDefaultCommentIds()).toEqual([]);
      expect(await repository.claimNextDispatch(agent.id, at(6_000), true))
        .toMatchObject({id: second.dispatch.id, state: "claimed"});
      // A claimer that never reports loses its lease, and the same dispatch
      // returns to the queue for the next poll — even for a heartbeat-free
      // re-check attempt, which opens the write path once a lease expires.
      const reclaimed = await repository.claimNextDispatch(
        agent.id,
        at(600_000),
        false,
      );
      expect(reclaimed).toMatchObject({
        claimedAt: at(600_000),
        id: second.dispatch.id,
        state: "claimed",
      });

      const canceled = await repository.cancelDispatch({
        canceledAt: at(660_000),
        dispatchId: second.dispatch.id,
        installationId: dispatchIdentity.installationId,
        projectId: defaultProjectId,
      });
      expect(canceled).toMatchObject({
        canceledAt: at(660_000),
        state: "canceled",
      });
      // Cancellation clears the markers, so the annotation comes back.
      expect(await listDefaultCommentIds()).toEqual([thirdThreadId]);
      await expect(repository.cancelDispatch({
        canceledAt: at(661_000),
        dispatchId: second.dispatch.id,
        installationId: dispatchIdentity.installationId,
        projectId: defaultProjectId,
      })).rejects.toMatchObject({_tag: "DispatchStateConflict"});

      // Agent rows are disposable liveness records; the dispatch history is
      // the durable record and keeps its own name snapshot.
      await repository.registerAgent({
        ...registration,
        connectionKey: `dispatch-connection-${randomUUID()}`,
        displayName: "abandoned",
        id: `agt_${randomUUID()}`,
        registeredAt: new Date(baseInstant - 8 * 24 * 60 * 60 * 1_000)
          .toISOString(),
      });
      expect((await repository.listAgents(
        dispatchIdentity.installationId,
        at(700_000),
      )).map(({agent: listed}) => listed.id)).toEqual([agent.id]);

      const firstPage = await repository.listDispatches({
        agentId: null,
        cursor: null,
        installationId: dispatchIdentity.installationId,
        limit: 1,
        now: at(700_000),
        projectId: defaultProjectId,
        state: null,
      });
      expect(firstPage.items.map(({id, state}) => ({id, state}))).toEqual([
        {id: second.dispatch.id, state: "canceled"},
      ]);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await repository.listDispatches({
        agentId: agent.id,
        cursor: firstPage.nextCursor,
        installationId: dispatchIdentity.installationId,
        limit: 1,
        now: at(700_000),
        projectId: defaultProjectId,
        state: null,
      });
      expect(secondPage.items.map(({agentDisplayName, id, state}) => ({
        agentDisplayName,
        id,
        state,
      }))).toEqual([{
        agentDisplayName: "site (resumed)",
        id: sent.dispatch.id,
        state: "addressed",
      }]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await database.close();
    }
    await server.stop();
  });

  test("external-storage foundation: Postgres protects dispatched comments atomically through every dispatch state", async () => {
    expect.hasAssertions();
    const identity = {
      apiToken: managedTestKey("postgres-dispatch-deletion"),
      installationId: `postgres-dispatch-deletion-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const published = await publishNew(server.baseUrl, identity.apiToken, {
      content: "<p>dispatch deletion target</p>",
      idempotencyKey: `dispatch-deletion-publish-${randomUUID()}`,
      name: "Dispatch deletion target",
    });
    const artifactId = published.body.artifact.id;
    const versionId = published.body.version.id;
    const sender = managedTestPrincipal(identity.apiToken);
    const baseInstant = Date.now();
    let clockOffset = 0;
    const now = (): string =>
      new Date(baseInstant + ++clockOffset * 1_000).toISOString();
    const database = await PostgresDatabase.open({
      maxConnections: 2,
      url: Redacted.make(environment.databaseUrl),
    }, "validate");
    try {
      const repository = await PostgresArtifactRepository.open(
        database,
        identity.installationId,
      );
      const agent = await repository.registerAgent({
        agentSessionId: "pi-session-dispatch-deletion",
        capabilities: {beacon: false, evidence: "native"},
        connectionKey: `dispatch-deletion-${randomUUID()}`,
        displayName: "deletion worker",
        id: `agt_${randomUUID()}`,
        installationId: identity.installationId,
        kind: "pi",
        principalId: sender.principalId,
        registeredAt: now(),
        workingDirectory: "/work/deletion-worker",
      });
      const annotate = async (body: string): Promise<string> => {
        const created = await createCommentThread(
          server.baseUrl,
          identity.apiToken,
          {artifactId, versionId},
          `dispatch-deletion-thread-${randomUUID()}`,
          {body, path: "index.html"},
        );
        expect(created.response.status).toBe(201);
        return commentCreationSchema.parse(created.body).thread.id;
      };
      const remove = (threadId: string) => repository.deleteThread({
        artifactId,
        authorizedByPrincipalId: sender.authorizedByPrincipalId,
        deletedAt: now(),
        principalId: sender.principalId,
        projectId: defaultProjectId,
        threadId,
      });
      const send = (threadId: string) => repository.createDispatch({
        agentDisplayName: agent.displayName,
        agentId: agent.id,
        createdAt: now(),
        id: `dsp_${randomUUID()}`,
        idempotencyKey: `dispatch-deletion-send-${randomUUID()}`,
        installationId: identity.installationId,
        note: null,
        projectId: defaultProjectId,
        sender,
        threadIds: [threadId],
      });

      const canceledThread = await annotate("Cancel this work.");
      const canceledDispatch = await send(canceledThread);
      await expect(remove(canceledThread)).rejects.toMatchObject({
        _tag: "DispatchStateConflict",
      });
      await repository.cancelDispatch({
        canceledAt: now(),
        dispatchId: canceledDispatch.dispatch.id,
        installationId: identity.installationId,
        projectId: defaultProjectId,
      });
      await expect(remove(canceledThread)).resolves.toMatchObject({
        thread: {id: canceledThread},
      });

      const failedThread = await annotate("Fail this work.");
      const failedDispatch = await send(failedThread);
      expect(await repository.claimNextDispatch(agent.id, now(), true))
        .toMatchObject({id: failedDispatch.dispatch.id, state: "claimed"});
      await expect(remove(failedThread)).rejects.toMatchObject({
        _tag: "DispatchStateConflict",
      });
      await repository.markFailed({
        agentId: agent.id,
        dispatchId: failedDispatch.dispatch.id,
        failedAt: now(),
        installationId: identity.installationId,
        reason: "Test delivery failure",
      });
      await expect(remove(failedThread)).resolves.toMatchObject({
        thread: {id: failedThread},
      });

      const addressedThread = await annotate("Address this work.");
      const addressedDispatch = await send(addressedThread);
      expect(await repository.claimNextDispatch(agent.id, now(), true))
        .toMatchObject({id: addressedDispatch.dispatch.id, state: "claimed"});
      await repository.markDelivered({
        agentId: agent.id,
        deliveredAt: now(),
        dispatchId: addressedDispatch.dispatch.id,
        installationId: identity.installationId,
      });
      await expect(remove(addressedThread)).rejects.toMatchObject({
        _tag: "DispatchStateConflict",
      });
      await expect(repository.clearThreads({
        artifactId,
        authorizedByPrincipalId: sender.authorizedByPrincipalId,
        clearedAt: now(),
        principalId: sender.principalId,
        projectId: defaultProjectId,
        scope: "all",
        versionId: null,
      })).resolves.toEqual({deleted: 0, skippedDispatched: 1});
      expect((await patchCommentThread(
        server.baseUrl,
        identity.apiToken,
        artifactId,
        addressedThread,
        {state: "resolved"},
      )).status).toBe(200);
      expect(await repository.observeAddressed(
        addressedDispatch.dispatch.id,
        now(),
      )).toMatchObject({state: "addressed"});
      await expect(repository.clearThreads({
        artifactId,
        authorizedByPrincipalId: sender.authorizedByPrincipalId,
        clearedAt: now(),
        principalId: sender.principalId,
        projectId: defaultProjectId,
        scope: "all",
        versionId: null,
      })).resolves.toEqual({deleted: 1, skippedDispatched: 0});

      const racedThread = await annotate("Race this work.");
      const [sent, deleted] = await Promise.allSettled([
        send(racedThread),
        remove(racedThread),
      ]);
      expect([sent.status, deleted.status].filter((status) =>
        status === "fulfilled"
      )).toHaveLength(1);
      const raceOutcome = sent.status === "fulfilled"
        ? {
          deletedTag: deleted.status === "rejected"
            ? taggedFailureSchema.parse(deleted.reason)._tag
            : "committed",
          dispatchedThreadIds: (await repository.findDispatch(
            identity.installationId,
            sent.value.dispatch.id,
            now(),
          ))?.threadIds,
          sentTag: "committed",
        }
        : {
          deletedTag: deleted.status === "fulfilled"
            ? "committed"
            : taggedFailureSchema.parse(deleted.reason)._tag,
          dispatchedThreadIds: [],
          sentTag: taggedFailureSchema.parse(sent.reason)._tag,
        };
      expect(raceOutcome).toEqual(sent.status === "fulfilled"
        ? {
          deletedTag: "DispatchStateConflict",
          dispatchedThreadIds: [racedThread],
          sentTag: "committed",
        }
        : {
          deletedTag: "committed",
          dispatchedThreadIds: [],
          sentTag: "InvalidDispatch",
        });
    } finally {
      await database.close();
      await server.stop();
    }
  });

  test("Postgres counts one entry-document view per drain, and probes, misses, and the home shell add nothing", async () => {
    // One pinned instant, so the counted view lands on a day the assertions
    // can name without racing a midnight boundary.
    const viewDay = "2026-10-17";
    const identity = {
      apiToken: managedTestKey("view-collection"),
      installationId: `view-collection-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {clock: {now: () => new Date(`${viewDay}T09:30:00.000Z`)}},
    );
    const published = await publishNew(server.baseUrl, identity.apiToken, {
      content: "<h1>counted entry document</h1>",
      idempotencyKey: `view-collection-publish-${randomUUID()}`,
      name: "Viewed proof",
    });
    expect(published.response.status).toBe(201);

    const versionUrl = published.body.links.version;
    const entryResponse = await fetchContentThroughServer(
      server.baseUrl,
      versionUrl,
    );
    expect(entryResponse.status).toBe(200);
    expect(await entryResponse.text()).toBe("<h1>counted entry document</h1>");

    const readTree = async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
      expect(response.status).toBe(200);
      return publicArtifactTreeSchema.parse(await response.json());
    };

    // The count is buffered in-process, so a read before the drain sees zero.
    expect(publicTreeEntry(await readTree(), "Viewed proof").views.total)
      .toBe(0);

    expect(await server.flushArtifactViews()).toEqual({
      failedChunks: 0,
      writtenRows: 1,
    });
    const counted = publicTreeEntry(await readTree(), "Viewed proof");
    expect(counted.views).toEqual({last7Days: 1, last30Days: 1, total: 1});
    expect(counted.series).toEqual([{count: 1, day: viewDay}]);
    // The one publish counts as one update on the pinned day, read through
    // the Postgres version index.
    expect(counted.updates).toEqual([{count: 1, day: viewDay}]);

    const database = await PostgresDatabase.inspect({
      applicationName: "artifact-server-view-collection-test",
      maxConnections: 1,
      url: Redacted.make(environment.databaseUrl),
    });
    try {
      const readViewRows = () => database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql<{
          readonly artifact_id: string;
          readonly count: number;
          readonly day: string;
        }>`
          SELECT artifact_id, count, day
          FROM artifact_views
          WHERE installation_id = ${identity.installationId}
        `.withoutTransform;
      }));
      // One GET of the entry document is one row with one count, on the UTC
      // day the served request happened.
      expect(await readViewRows()).toEqual([{
        artifact_id: published.body.artifact.id,
        count: 1,
        day: viewDay,
      }]);

      // A HEAD probe answers the entry document without carrying it, a
      // miss resolves no manifest entry, and `/` serves the application
      // shell. None of them carries an entry document, so none may count.
      expect((await fetchContentThroughServer(
        server.baseUrl,
        versionUrl,
        undefined,
        "HEAD",
      )).status).toBe(200);
      expect((await fetchContentThroughServer(
        server.baseUrl,
        `${versionUrl}missing.html`,
      )).status).toBe(404);
      expect((await fetch(`${server.baseUrl}/`)).status).toBe(200);

      expect(await server.flushArtifactViews()).toEqual({
        failedChunks: 0,
        writtenRows: 0,
      });
      expect(publicTreeEntry(await readTree(), "Viewed proof").views.total)
        .toBe(1);
      expect(await readViewRows()).toEqual([{
        artifact_id: published.body.artifact.id,
        count: 1,
        day: viewDay,
      }]);
    } finally {
      await database.close();
    }
  });

  test("external-storage foundation: Postgres builds the project and artifact activity reports from versions and stored views, and a deleted artifact leaves them", async () => {
    const identity = {
      apiToken: managedTestKey("project-analytics"),
      installationId: `project-analytics-${randomUUID()}`,
    };
    // 400 days before 2026-10-17, so the first upload and view fall outside
    // the 365-day series but inside the all-time totals.
    const clock = new MutableClock("2025-09-12T10:00:00.000Z");
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {clock},
    );
    const publish = async (
      name: string,
      accessSetting: "account_required" | "public_link",
    ) => {
      const published = await publishNew(server.baseUrl, identity.apiToken, {
        accessSetting,
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `project-analytics-${name}-${randomUUID()}`,
        name,
      });
      expect(published.response.status).toBe(201);
      return published.body;
    };
    const view = async (versionUrl: string, times: number) => {
      const responses = await Promise.all(Array.from(
        {length: times},
        () => fetchContentThroughServer(server.baseUrl, versionUrl),
      ));
      expect(responses.map((response) => response.status))
        .toEqual(responses.map(() => 200));
      // Views land on the clock's day when they drain, so drain before
      // moving the clock.
      expect(await server.flushArtifactViews())
        .toMatchObject({failedChunks: 0});
    };
    const readProject = async () => {
      const response = await authenticatedFetch(
        server.baseUrl,
        identity.apiToken,
        "/api/v1/analytics",
      );
      expect(response.status).toBe(200);
      return projectActivityReportSchema.parse(await response.json());
    };
    const artifactReport = (artifactId: string) => authenticatedFetch(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${artifactId}/analytics`,
    );

    const atlas = await publish("Atlas", "public_link");
    await view(atlas.links.version, 3);

    clock.advance(398 * day); // 2026-10-15
    const atlasTwo = await publishVersion(server.baseUrl, identity.apiToken, {
      artifactId: atlas.artifact.id,
      content: "<!doctype html><title>Atlas two</title>",
      expectedCurrentVersionId: atlas.version.id,
      idempotencyKey: `project-analytics-atlas-two-${randomUUID()}`,
    });
    expect(atlasTwo.response.status).toBe(201);
    const atlasTwoBody = publishResponseSchema.parse(atlasTwo.body);
    const ledger = await publish("Ledger", "account_required");
    await view(atlasTwoBody.links.version, 2);

    clock.advance(2 * day); // 2026-10-17
    const notes = await publish("Notes", "public_link");
    await view(atlasTwoBody.links.version, 1);
    await view(notes.links.version, 4);

    const report = await readProject();
    expect(report).toEqual({
      daily: [
        {day: "2026-10-15", uploads: 2, views: 2},
        {day: "2026-10-17", uploads: 1, views: 5},
      ],
      generatedAt: "2026-10-17T10:00:00.000Z",
      today: "2026-10-17",
      // Ledger has no views, so it is absent from the ranking.
      topArtifacts: [
        {artifactId: notes.artifact.id, name: "Notes", total: 4, views30d: 4},
        {artifactId: atlas.artifact.id, name: "Atlas", total: 6, views30d: 3},
      ],
      totals: {
        artifacts: 3,
        artifactsViewedToday: 2,
        // (3 + 2 + 1 + 4) views over three artifacts.
        averageViewsPerArtifact: 3.3,
        pageViews: 10,
        publicArtifacts: 2,
        uploadedToday: 1,
        uploads: 4,
      },
      windowDays: 365,
    });
    expect(report.topArtifacts.map((item) => item.name))
      .not.toContain(ledger.artifact.name);

    const atlasReport = await artifactReport(atlas.artifact.id);
    expect(atlasReport.status).toBe(200);
    expect(artifactActivityReportSchema.parse(await atlasReport.json()))
      .toEqual({
        artifactId: atlas.artifact.id,
        daily: [
          {day: "2026-10-15", views: 2},
          {day: "2026-10-17", views: 1},
        ],
        today: "2026-10-17",
        views: {last7Days: 3, last30Days: 3, total: 6},
        windowDays: 30,
      });

    expect((await mutateArtifact(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${notes.artifact.id}`,
      "DELETE",
      `project-analytics-delete-notes-${randomUUID()}`,
      {expectedCurrentVersionId: notes.version.id},
    )).status).toBe(200);

    expect(await readProject()).toMatchObject({
      // Notes was today's only upload and four of today's five views.
      daily: [
        {day: "2026-10-15", uploads: 2, views: 2},
        {day: "2026-10-17", uploads: 0, views: 1},
      ],
      topArtifacts: [
        {artifactId: atlas.artifact.id, name: "Atlas", total: 6, views30d: 3},
      ],
      totals: {
        artifacts: 2,
        artifactsViewedToday: 1,
        averageViewsPerArtifact: 3,
        pageViews: 6,
        publicArtifacts: 1,
        uploadedToday: 0,
        uploads: 3,
      },
    });
    expect((await artifactReport(notes.artifact.id)).status).toBe(404);
  });

  test("external-storage foundation: Postgres serves a member's tree with every live artifact, mine on their own, and a manage handle only where the owner-or-administrator rule allows", async () => {
    const identity = {
      apiToken: managedTestKey("member-tree"),
      installationId: `member-tree-${randomUUID()}`,
    };
    const clock = new MutableClock();
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {clock},
    );
    const administrator = await seedAdministratorSession(
      environment,
      identity.installationId,
    );
    const applicationOrigin = "https://artifacts.example.com";

    const issueMemberKey = async (displayName: string, email: string) => {
      const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName, email}),
        headers: browserMutationHeaders(applicationOrigin, administrator),
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      const memberId = z.object({member: z.object({id: z.string()})})
        .parse(await admitted.json()).member.id;
      const issued = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
        body: JSON.stringify({
          capabilities: ["artifact:create", "artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          memberId,
          name: `${displayName} laptop`,
        }),
        headers: browserMutationHeaders(applicationOrigin, administrator),
        method: "POST",
      });
      expect(issued.status).toBe(201);
      return {memberId, token: issuedKeySchema.parse(await issued.json()).token};
    };
    // A member's own browser session, so the viewer is the member herself
    // and the owner rule admits her as a direct human principal.
    const signIn = (memberId: string) =>
      seedMemberSession(environment, identity.installationId, memberId);
    const readTree = async (cookies: ApplicationCookies | null) => {
      const response = await fetch(`${server.baseUrl}/api/v1/public/tree`, {
        headers: cookies === null ? {} : {Cookie: cookies.header},
      });
      expect(response.status).toBe(200);
      // The body depends on the session, so no shared cache may keep it and
      // no cache may answer one viewer with another viewer's copy.
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("vary") ?? "").toContain("Cookie");
      return memberTreeSchema.parse(await response.json());
    };
    const publish = async (
      token: string,
      name: string,
      accessSetting: "account_required" | "public_link",
    ) => {
      const published = await publishNew(server.baseUrl, token, {
        accessSetting,
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `member-tree-${name}-${randomUUID()}`,
        name,
      });
      expect(published.response.status).toBe(201);
      // Each publish a minute after the last, so newest first is fixed.
      clock.advance(60_000);
      return published.body;
    };

    const alice = await issueMemberKey("Alice Example", "alice@example.test");
    const bob = await issueMemberKey("Bob Example", "bob@example.test");
    await publish(alice.token, "Alice public", "public_link");
    await publish(alice.token, "Alice private", "account_required");
    await publish(bob.token, "Bob report", "public_link");
    const bobUnlisted = await publish(bob.token, "Bob unlisted", "public_link");
    expect((await mutateArtifact(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${bobUnlisted.artifact.id}/tags`,
      "PATCH",
      `member-tree-unlist-${randomUUID()}`,
      {
        expectedCurrentVersionId: bobUnlisted.version.id,
        tags: ["unlisted", "archive"],
      },
    )).status).toBe(200);

    const anonymous = await readTree(null);
    expect(anonymous.viewer).toBeNull();
    expect(anonymous.artifacts.map((artifact) => ({
      manage: artifact.manage,
      mine: artifact.mine,
      name: artifact.name,
      owner: artifact.owner,
      visibility: artifact.visibility,
    }))).toEqual([
      {manage: null, mine: false, name: "Bob report", owner: "Bob Example laptop", visibility: "public"},
      {manage: null, mine: false, name: "Alice public", owner: "Alice Example laptop", visibility: "public"},
    ]);

    // Alice reads every live artifact, including Bob's unlisted one and her
    // own private one, through the member branch of the catalog query.
    const aliceTree = await readTree(await signIn(alice.memberId));
    expect(aliceTree.viewer).toEqual({name: "Alice Example"});
    expect(aliceTree.artifacts.map((artifact) => ({
      access: artifact.access,
      manageable: artifact.manage !== null,
      mine: artifact.mine,
      name: artifact.name,
      visibility: artifact.visibility,
    }))).toEqual([
      {access: "public_link", manageable: false, mine: false, name: "Bob unlisted", visibility: "unlisted"},
      {access: "public_link", manageable: false, mine: false, name: "Bob report", visibility: "public"},
      {access: "account_required", manageable: true, mine: true, name: "Alice private", visibility: "private"},
      {access: "public_link", manageable: true, mine: true, name: "Alice public", visibility: "public"},
    ]);

    // Bob's own session reads the mirror image: his rows are his.
    const bobTree = await readTree(await signIn(bob.memberId));
    expect(bobTree.artifacts.map((artifact) => ({
      manageable: artifact.manage !== null,
      mine: artifact.mine,
      name: artifact.name,
    }))).toEqual([
      {manageable: true, mine: true, name: "Bob unlisted"},
      {manageable: true, mine: true, name: "Bob report"},
      {manageable: false, mine: false, name: "Alice private"},
      {manageable: false, mine: false, name: "Alice public"},
    ]);

    // An administrator owns none of them but may change every one, and the
    // handle carries the artifact's tags sorted.
    const administratorTree = await readTree(administrator);
    expect(administratorTree.artifacts.map((artifact) => ({
      manageable: artifact.manage !== null,
      mine: artifact.mine,
      name: artifact.name,
    }))).toEqual([
      {manageable: true, mine: false, name: "Bob unlisted"},
      {manageable: true, mine: false, name: "Bob report"},
      {manageable: true, mine: false, name: "Alice private"},
      {manageable: true, mine: false, name: "Alice public"},
    ]);
    expect(administratorTree.artifacts[0]?.manage).toMatchObject({
      artifactId: bobUnlisted.artifact.id,
      tags: ["archive", "unlisted"],
    });
  });

  test("external-storage foundation: Postgres serves the asset MCP tools, so a copy replays its key and keeps serving after the original is deleted", async () => {
    const identity = {
      apiToken: managedTestKey("asset-mcp"),
      installationId: `asset-mcp-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const csv = new TextEncoder().encode("day,views\n2026-10-01,3\n");
    const callTool = async (name: string, toolArguments: McpTestParameters) => {
      const response = await externalStorageMcpRequest(
        server.baseUrl,
        identity.apiToken,
        "tools/call",
        {arguments: toolArguments, name},
        name,
      );
      expect(response.status).toBe(200);
      const result = mcpToolResultSchema.parse(await response.json()).result;
      expect(result.isError).not.toBe(true);
      return result.structuredContent;
    };
    // The MCP request names the application host, so the URLs it returns
    // name it too; reach them through this server.
    const readBlob = (url: string) => fetch(replaceOrigin(url, server.baseUrl));
    const publish = async (name: string) => {
      const published = await publishNew(server.baseUrl, identity.apiToken, {
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `asset-mcp-${name}-${randomUUID()}`,
        name,
      });
      expect(published.response.status).toBe(201);
      return published.body.artifact.id;
    };
    const source = await publish("Asset MCP source");
    const target = await publish("Asset MCP target");

    const plan = mcpAssetPlanSchema.parse(await callTool("asset_create_upload", {
      artifactId: source,
      mediaType: "text/csv",
      name: "views.csv",
      sha256: sha256(csv),
      size: csv.byteLength,
    }));
    expect((await putAssetBytes(
      replaceOrigin(plan.file.uploadUrl, server.baseUrl),
      identity.apiToken,
      csv,
    )).status).toBe(200);
    const commitKey = `asset-mcp-commit-${randomUUID()}`;
    const commit = () => callTool("asset_commit_upload", {
      artifactId: source,
      idempotencyKey: commitKey,
      uploadId: plan.commit.uploadId,
    });
    const committed = committedAssetSchema.parse(await commit());
    expect(committed).toMatchObject({
      asset: {mediaType: "text/csv", name: "views.csv", size: csv.byteLength},
      replayed: false,
    });
    expect(committedAssetSchema.parse(await commit()))
      .toMatchObject({asset: {id: committed.asset.id}, replayed: true});
    const original = await readBlob(committed.asset.url);
    expect(original.status).toBe(200);
    expect(await original.text()).toBe(new TextDecoder().decode(csv));

    expect(assetListingSchema.parse(await callTool("asset_list", {artifactId: source})))
      .toMatchObject({
        assets: [{id: committed.asset.id}],
        usage: {assetCount: 1, byteCount: csv.byteLength},
      });

    // A copy is a new row in the target over the same stored bytes, and its
    // key replays that row rather than adding another.
    const copyKey = `asset-mcp-copy-${randomUUID()}`;
    const copyToTarget = () => callTool("asset_copy", {
      artifactId: target,
      idempotencyKey: copyKey,
      sourceArtifactId: source,
      sourceAssetId: committed.asset.id,
    });
    const copied = committedAssetSchema.parse(await copyToTarget());
    expect(copied.replayed).toBe(false);
    expect(copied.asset.id).not.toBe(committed.asset.id);
    expect(copied.asset.sha256).toBe(committed.asset.sha256);
    expect(committedAssetSchema.parse(await copyToTarget()))
      .toMatchObject({asset: {id: copied.asset.id}, replayed: true});
    expect(assetListingSchema.parse(await callTool("asset_list", {artifactId: target})))
      .toMatchObject({
        assets: [{id: copied.asset.id}],
        usage: {assetCount: 1, byteCount: csv.byteLength},
      });

    // Deleting the original must not take the copy's shared bytes with it.
    const deleted = z.object({asset: assetSchema}).parse(await callTool("asset_delete", {
      artifactId: source,
      assetId: committed.asset.id,
    }));
    expect(deleted.asset.id).toBe(committed.asset.id);
    expect((await readBlob(committed.asset.url)).status).toBe(404);
    const copy = await readBlob(copied.asset.url);
    expect(copy.status).toBe(200);
    expect(await copy.text()).toBe(new TextDecoder().decode(csv));
    expect(assetListingSchema.parse(await callTool("asset_list", {artifactId: source})))
      .toMatchObject({assets: [], usage: {assetCount: 0, byteCount: 0}});
  });

  test("external-storage foundation: Postgres finds or admits the member an OIDC sign-in names, once, and never revives a deactivated one", async () => {
    const identity = {
      apiToken: managedTestKey("oidc-member"),
      installationId: `oidc-member-${randomUUID()}`,
    };
    const provider = await startFakeOidcProvider();
    try {
      const server = await startInProcessExternalStorageServer(environment, identity, {
        browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
          provider: createOidcProvider({
            clientId: provider.clientId,
            clientSecret: Redacted.make(provider.clientSecret),
            fetch: provider.fetch,
            issuer: provider.issuer,
            redirectUri: "https://artifacts.example.com/auth/oidc/callback",
            scopes: "openid email profile",
          }),
          unknownUsers: unknownOidcUserPolicies.admit,
        }),
      });
      const database = await PostgresDatabase.open({
        maxConnections: 1,
        url: Redacted.make(environment.databaseUrl),
      }, "validate");
      const members = new PostgresIdentityRepository(database, identity.installationId);
      try {
        const dave = await members.admitMember({
          actor: installationOperatorActor,
          createdAt: new Date().toISOString(),
          displayName: "Dave Example",
          email: "dave@example.test",
          id: `member_${randomUUID()}`,
          installationId: identity.installationId,
          role: "member",
        });
        await members.deactivateMember(
          identity.installationId,
          dave.id,
          new Date().toISOString(),
          installationOperatorActor,
        );
        const signIn = async (person: FakeOidcPerson) => {
          const started = await fetch(`${server.baseUrl}/auth/oidc/start`, {redirect: "manual"});
          expect(started.status).toBe(302);
          const pending = hostCookiePair(started, "artifact_oidc");
          if (pending === undefined) throw new Error("The start set no pending sign-in cookie.");
          const redirect = new URL(provider.approve(started.headers.get("location") ?? "", person));
          return fetch(`${server.baseUrl}/auth/oidc/callback${redirect.search}`, {
            headers: {Cookie: pending},
            redirect: "manual",
          });
        };
        const principalOf = async (response: Response) => {
          expect(response.status).toBe(303);
          expect(response.headers.get("location")).toBe("/review");
          const session = hostCookiePair(response, "artifact_session");
          const csrf = hostCookiePair(response, "artifact_csrf");
          if (session === undefined || csrf === undefined) {
            throw new Error("The callback set no session.");
          }
          const read = await fetch(`${server.baseUrl}/api/v1/session`, {
            headers: {Cookie: `${session}; ${csrf}`},
          });
          expect(read.status).toBe(200);
          return sessionPrincipalSchema.parse(await read.json()).principal;
        };
        const newcomer = {
          email: "newcomer@example.test",
          email_verified: true,
          name: "New Comer",
          sub: "newcomer-subject",
        } satisfies FakeOidcPerson;

        const admitted = await principalOf(await signIn(newcomer));
        expect(admitted).toMatchObject({
          displayName: "New Comer",
          kind: "human",
          membershipRole: "member",
        });
        // The next sign-in, in another casing, is the same member.
        const again = await principalOf(await signIn({...newcomer, email: "NewComer@Example.TEST"}));
        expect(again.id).toBe(admitted.id);

        // Admitting Dave's email again conflicts with his deactivated row, and
        // the lookup that follows finds no active member, so he is refused.
        const refused = await signIn({
          email: "dave@example.test",
          email_verified: true,
          sub: "dave-subject",
        });
        expect(refused.status).toBe(303);
        expect(refused.headers.get("location")).toBe("/review?sso=failed");
        expect(hostCookiePair(refused, "artifact_session")).toBeUndefined();

        expect((await members.listMembers(identity.installationId)).map((member) => ({
          email: member.email,
          id: member.id,
          status: member.status,
        })).filter((member) => member.email !== administratorEmail)).toEqual([
          {email: "dave@example.test", id: dave.id, status: "inactive"},
          {email: "newcomer@example.test", id: admitted.id, status: "active"},
        ]);
      } finally {
        await database.close();
      }
    } finally {
      await provider.stop();
    }
  });

  test("external-storage foundation: Postgres reads the viewer bar's artifact info and lets only the owner or an administrator change visibility", async () => {
    const identity = {
      apiToken: managedTestKey("viewer-bar"),
      installationId: `viewer-bar-${randomUUID()}`,
    };
    // Pinned at the present: managed keys and seeded sessions use the wall clock.
    const clock = new MutableClock();
    const server = await startInProcessExternalStorageServer(environment, identity, {clock});
    const administrator = await seedAdministratorSession(environment, identity.installationId);
    const admitMember = async (displayName: string, email: string) => {
      const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName, email}),
        headers: browserMutationHeaders("https://artifacts.example.com", administrator),
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      return z.object({member: z.object({id: z.string()})})
        .parse(await admitted.json()).member.id;
    };
    const issueKey = async (memberId: string, capabilities: readonly string[], name: string) => {
      const issued = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
        body: JSON.stringify({capabilities, expiresAt: "2099-01-01T00:00:00.000Z", memberId, name}),
        headers: browserMutationHeaders("https://artifacts.example.com", administrator),
        method: "POST",
      });
      expect(issued.status).toBe(201);
      return issuedKeySchema.parse(await issued.json()).token;
    };
    const readInfo = (token: string, artifactId: string) =>
      authenticatedFetch(server.baseUrl, token, `/api/v1/artifacts/${artifactId}/info`);
    const info = async (token: string, artifactId: string) => {
      const response = await readInfo(token, artifactId);
      expect(response.status).toBe(200);
      return artifactInfoSchema.parse(await response.json());
    };
    const changeAccess = (
      token: string,
      published: {readonly artifact: {readonly id: string}; readonly version: {readonly id: string}},
      accessSetting: "account_required" | "public_link",
    ) => mutateArtifact(
      server.baseUrl,
      token,
      `/api/v1/artifacts/${published.artifact.id}/access`,
      "PATCH",
      `viewer-bar-access-${randomUUID()}`,
      {accessSetting, expectedCurrentVersionId: published.version.id},
    );
    const changeTags = (
      token: string,
      published: {readonly artifact: {readonly id: string}; readonly version: {readonly id: string}},
      tags: readonly string[],
    ) => mutateArtifact(
      server.baseUrl,
      token,
      `/api/v1/artifacts/${published.artifact.id}/tags`,
      "PATCH",
      `viewer-bar-tags-${randomUUID()}`,
      {expectedCurrentVersionId: published.version.id, tags},
    );
    const visibilityOf = async (artifactId: string) =>
      (await info(identity.apiToken, artifactId)).visibility;

    const aliceId = await admitMember("Alice Example", "alice@example.test");
    const alice = await issueKey(aliceId, ["artifact:create", "artifact:read"], "Alice laptop");
    const aliceReader = await issueKey(aliceId, ["artifact:read"], "Alice reader");
    const bobId = await admitMember("Bob Example", "bob@example.test");
    const bob = await issueKey(bobId, ["artifact:create", "artifact:read"], "Bob laptop");

    const published = await publishNew(server.baseUrl, alice, {
      content: "<!doctype html><title>Alice notes</title>",
      idempotencyKey: `viewer-bar-publish-${randomUUID()}`,
      name: "Alice notes",
    });
    expect(published.response.status).toBe(201);
    const notes = published.body;
    const viewed = await Promise.all(Array.from(
      {length: 3},
      () => fetchContentThroughServer(server.baseUrl, notes.links.version),
    ));
    expect(viewed.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await server.flushArtifactViews()).toMatchObject({failedChunks: 0});

    expect(await info(alice, notes.artifact.id)).toEqual({
      artifactId: notes.artifact.id,
      canManage: true,
      name: "Alice notes",
      owner: {displayName: "Alice laptop"},
      updatedAt: clock.now().toISOString(),
      version: {id: notes.version.id, number: 1},
      views: {
        daily: [{day: clock.now().toISOString().slice(0, 10), views: 3}],
        last30Days: 3,
        total: 3,
      },
      visibility: "public",
      windowDays: 30,
    });

    // Bob's key may read Alice's artifact but neither owns nor administers it.
    expect((await info(bob, notes.artifact.id)).canManage).toBe(false);
    expect((await changeAccess(bob, notes, "account_required")).status).toBe(403);
    expect((await changeTags(bob, notes, ["external-storage-runtime", "unlisted"])).status)
      .toBe(403);
    // A key on Alice's own principal that may only read does not own it.
    expect((await info(aliceReader, notes.artifact.id)).canManage).toBe(false);
    const readerRefused = await changeAccess(aliceReader, notes, "account_required");
    expect(readerRefused.status).toBe(403);
    expect(z.object({error: z.object({code: z.string()})}).parse(await readerRefused.json())
      .error.code).toBe("AUTHORIZATION_DENIED");
    expect((await changeTags(aliceReader, notes, ["external-storage-runtime", "unlisted"]))
      .status).toBe(403);
    expect(await visibilityOf(notes.artifact.id)).toBe("public");

    // Alice's creating key owns it and changes both halves of visibility.
    expect((await changeTags(alice, notes, ["external-storage-runtime", "unlisted"])).status)
      .toBe(200);
    expect(await visibilityOf(notes.artifact.id)).toBe("unlisted");
    expect((await changeAccess(alice, notes, "account_required")).status).toBe(200);
    expect(await visibilityOf(notes.artifact.id)).toBe("private");

    // An administrator's session changes an artifact it does not own.
    const administratorHeaders =
      browserMutationHeaders("https://artifacts.example.com", administrator);
    administratorHeaders.set("Idempotency-Key", `viewer-bar-admin-${randomUUID()}`);
    const restored = await fetch(`${server.baseUrl}/api/v1/artifacts/${notes.artifact.id}/access`, {
      body: JSON.stringify({accessSetting: "public_link", expectedCurrentVersionId: notes.version.id}),
      headers: administratorHeaders,
      method: "PATCH",
    });
    expect(restored.status).toBe(200);
    expect(await visibilityOf(notes.artifact.id)).toBe("unlisted");

    expect((await readInfo(alice, "art_00000000-0000-4000-8000-000000000000")).status)
      .toBe(404);
  });

  test("external-storage foundation: Postgres renames over HTTP and MCP, replays the name a key set, and refuses a stale version or a reused key without changing anything", async () => {
    const identity = {
      apiToken: managedTestKey("artifact-rename"),
      installationId: `artifact-rename-${randomUUID()}`,
    };
    // Each action a minute after the last, so newest first is fixed.
    const clock = new MutableClock();
    const server = await startInProcessExternalStorageServer(environment, identity, {clock});
    const rename = async (
      artifactId: string,
      idempotencyKey: string,
      body: {readonly expectedCurrentVersionId: string; readonly name: string},
    ) => {
      const response = await mutateArtifact(
        server.baseUrl,
        identity.apiToken,
        `/api/v1/artifacts/${artifactId}/name`,
        "PATCH",
        idempotencyKey,
        body,
      );
      clock.advance(60_000);
      return response;
    };
    const searchNames = async (search: string) => {
      const response = await authenticatedFetch(
        server.baseUrl,
        identity.apiToken,
        `/api/v1/artifacts?search=${encodeURIComponent(search)}`,
      );
      expect(response.status).toBe(200);
      return artifactListSchema.parse(await response.json()).artifacts
        .map((item) => item.artifact.name);
    };
    const renamedActions = async (artifactId: string) => {
      const response = await authenticatedFetch(
        server.baseUrl,
        identity.apiToken,
        `/api/v1/artifacts/${artifactId}/actions?limit=100`,
      );
      expect(response.status).toBe(200);
      return artifactActionsSchema.parse(await response.json()).actions
        .filter((action) => action.action === "renamed")
        .map(({idempotencyKey, versionId}) => ({idempotencyKey, versionId}));
    };
    const publish = async (name: string) => {
      const published = await publishNew(server.baseUrl, identity.apiToken, {
        accessSetting: "account_required",
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `artifact-rename-publish-${randomUUID()}`,
        name,
      });
      expect(published.response.status).toBe(201);
      clock.advance(60_000);
      return published.body;
    };

    const draft = await publish("Quarterly draft");
    const firstKey = `artifact-rename-first-${randomUUID()}`;
    const renamed = await rename(draft.artifact.id, firstKey, {
      expectedCurrentVersionId: draft.version.id,
      name: "  Quarterly report  ",
    });
    expect(renamed.status).toBe(200);
    expect(artifactStateSchema.parse(await renamed.json())).toMatchObject({
      artifact: {id: draft.artifact.id, name: "Quarterly report"},
      replayed: false,
      // A rename saves no version.
      version: {id: draft.version.id},
    });
    expect(await searchNames("quarterly report")).toEqual(["Quarterly report"]);
    expect(await searchNames("draft")).toEqual([]);

    const mcpKey = `artifact-rename-mcp-${randomUUID()}`;
    const viaMcp = await externalStorageMcpRequest(
      server.baseUrl,
      identity.apiToken,
      "tools/call",
      {
        arguments: {
          artifactId: draft.artifact.id,
          expectedCurrentVersionId: draft.version.id,
          idempotencyKey: mcpKey,
          name: "Quarterly report (final)",
        },
        name: "artifact_rename",
      },
      "artifact_rename",
    );
    clock.advance(60_000);
    expect(viaMcp.status).toBe(200);
    const mcpResult = mcpToolResultSchema.parse(await viaMcp.json()).result;
    expect(mcpResult.isError).not.toBe(true);
    expect(artifactStateSchema.parse(mcpResult.structuredContent).artifact.name)
      .toBe("Quarterly report (final)");
    expect(await searchNames("final")).toEqual(["Quarterly report (final)"]);

    // The first key replays the name it set, not the name the artifact has now.
    const replayed = await rename(draft.artifact.id, firstKey, {
      expectedCurrentVersionId: draft.version.id,
      name: "  Quarterly report  ",
    });
    expect(replayed.status).toBe(200);
    expect(artifactStateSchema.parse(await replayed.json())).toMatchObject({
      artifact: {name: "Quarterly report"},
      replayed: true,
      version: {id: draft.version.id},
    });
    const [current] = (await listArtifacts(server.baseUrl, identity.apiToken)).body.artifacts;
    expect(current?.artifact).toMatchObject({
      currentVersionId: draft.version.id,
      name: "Quarterly report (final)",
    });
    expect(await renamedActions(draft.artifact.id)).toEqual([
      {idempotencyKey: mcpKey, versionId: draft.version.id},
      {idempotencyKey: firstKey, versionId: draft.version.id},
    ]);

    const roadmap = await publish("Roadmap");
    const second = await publishVersion(server.baseUrl, identity.apiToken, {
      artifactId: roadmap.artifact.id,
      content: "<!doctype html><title>Roadmap two</title>",
      expectedCurrentVersionId: roadmap.version.id,
      idempotencyKey: `artifact-rename-roadmap-second-${randomUUID()}`,
    });
    expect(second.response.status).toBe(201);
    const secondVersionId = publishResponseSchema.parse(second.body).version.id;

    const stale = await rename(roadmap.artifact.id, `artifact-rename-stale-${randomUUID()}`, {
      expectedCurrentVersionId: roadmap.version.id,
      name: "Stale roadmap",
    });
    expect(stale.status).toBe(409);
    expect(commentFailureSchema.parse(await stale.json()).error.code)
      .toBe("ARTIFACT_MUTATION_CONFLICT");
    expect(await searchNames("roadmap")).toEqual(["Roadmap"]);

    const acceptedKey = `artifact-rename-accepted-${randomUUID()}`;
    const accepted = await rename(roadmap.artifact.id, acceptedKey, {
      expectedCurrentVersionId: secondVersionId,
      name: "Roadmap 2027",
    });
    expect(accepted.status).toBe(200);
    const reused = await rename(roadmap.artifact.id, acceptedKey, {
      expectedCurrentVersionId: secondVersionId,
      name: "Roadmap 2028",
    });
    expect(reused.status).toBe(409);
    expect(commentFailureSchema.parse(await reused.json()).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");
    expect(await searchNames("roadmap")).toEqual(["Roadmap 2027"]);
    expect(await renamedActions(roadmap.artifact.id)).toEqual([
      {idempotencyKey: acceptedKey, versionId: secondVersionId},
    ]);
  });

  test("external-storage foundation: Postgres stores collapsed folders, names only those the public tree lists, and refuses a key that may not manage them", async () => {
    const identity = {
      apiToken: managedTestKey("collapsed-folders"),
      installationId: `collapsed-folders-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const readTree = async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
      expect(response.status).toBe(200);
      return folderTreeSchema.parse(await response.json());
    };
    const setFolder = (
      body: {readonly defaultState: "collapsed" | "expanded"; readonly path: string},
      token = identity.apiToken,
    ) => fetch(`${server.baseUrl}/api/v1/folder-defaults`, {
      body: JSON.stringify(body),
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      method: "PUT",
    });
    const publish = async (
      name: string,
      artifactPath: string,
      accessSetting: "account_required" | "public_link" = "public_link",
    ) => {
      const published = await publishNew(server.baseUrl, identity.apiToken, {
        accessSetting,
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `collapsed-folders-${randomUUID()}`,
        name,
        path: artifactPath,
      });
      expect(published.response.status).toBe(201);
      expect(published.body.artifact.path).toBe(artifactPath);
    };

    await publish("Old report", "team/archive/old-report");
    await publish("Q1 notes", "team/archive/2025/q1-notes");
    await publish("Agent console", "2026/10/agent-console");
    expect((await readTree()).collapsedFolders).toEqual([]);

    const collapsed = await setFolder({defaultState: "collapsed", path: "/team/archive/"});
    expect(collapsed.status).toBe(200);
    expect(folderDefaultSchema.parse(await collapsed.json()))
      .toEqual({defaultState: "collapsed", path: "team/archive"});
    // A repeated set is the same stored state, not a second row or a conflict.
    expect((await setFolder({defaultState: "collapsed", path: "team/archive"})).status)
      .toBe(200);
    expect((await setFolder({defaultState: "collapsed", path: "team/archive/2025"})).status)
      .toBe(200);
    const tree = await readTree();
    expect(tree.collapsedFolders).toEqual(["team/archive", "team/archive/2025"]);
    expect(tree.artifacts.map((artifact) => artifact.name).toSorted())
      .toEqual(["Agent console", "Old report", "Q1 notes"]);

    const expanded = await externalStorageMcpRequest(
      server.baseUrl,
      identity.apiToken,
      "tools/call",
      {
        arguments: {defaultState: "expanded", path: "team/archive"},
        name: "folder_set_default",
      },
      "folder_set_default",
    );
    expect(expanded.status).toBe(200);
    const expandedResult = mcpToolResultSchema.parse(await expanded.json()).result;
    expect(expandedResult.isError).not.toBe(true);
    expect(folderDefaultSchema.parse(expandedResult.structuredContent))
      .toEqual({defaultState: "expanded", path: "team/archive"});
    expect((await readTree()).collapsedFolders).toEqual(["team/archive/2025"]);

    // A member key creates and reads its own work but does not manage
    // artifact settings, so it cannot change how a shared folder starts.
    const administrator = await seedAdministratorSession(environment, identity.installationId);
    const issued = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:create", "artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Member laptop",
      }),
      headers: browserMutationHeaders("https://artifacts.example.com", administrator),
      method: "POST",
    });
    expect(issued.status).toBe(201);
    const memberKey = issuedKeySchema.parse(await issued.json()).token;
    const refused = await setFolder({defaultState: "collapsed", path: "2026/10"}, memberKey);
    expect(refused.status).toBe(403);
    expect(commentFailureSchema.parse(await refused.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect((await readTree()).collapsedFolders).toEqual(["team/archive/2025"]);

    // A folder that holds only a private artifact stays unnamed, and the
    // stored setting applies as soon as a public artifact lands there.
    await publish("Payroll", "team/private/payroll", "account_required");
    expect((await setFolder({defaultState: "collapsed", path: "team/private"})).status)
      .toBe(200);
    expect((await readTree()).collapsedFolders).toEqual(["team/archive/2025"]);
    await publish("Handbook", "team/private/handbook");
    expect((await readTree()).collapsedFolders)
      .toEqual(["team/archive/2025", "team/private"]);
  });

  test("external-storage foundation: Postgres refuses an equal, ancestor, or descendant artifact path, and a deleted artifact frees its path", async () => {
    const identity = {
      apiToken: managedTestKey("artifact-paths"),
      installationId: `artifact-paths-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const claim = async (artifactPath: string) => {
      const upload = await stageExternalStorageFile(
        server.baseUrl,
        identity.apiToken,
        `<h1>${artifactPath}</h1>`,
      );
      const response = await fetch(upload.commitUrl, {
        body: JSON.stringify({target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: `Path claim ${randomUUID()}`,
          path: artifactPath,
        }}),
        headers: mutationHeaders(identity.apiToken, `artifact-paths-${randomUUID()}`),
        method: "POST",
      });
      const body: unknown = await response.json();
      return {body, status: response.status};
    };
    const refusal = (attempt: {readonly body: unknown; readonly status: number}) => ({
      ...commentFailureSchema.parse(attempt.body).error,
      status: attempt.status,
    });

    const held = await claim("2026/10/agent-console");
    expect(held.status).toBe(201);
    const holder = publishResponseSchema.parse(held.body);
    expect(holder.artifact.path).toBe("2026/10/agent-console");

    // Each message names the live path the overlap query found, so a refusal
    // proves that query and not some other conflict.
    expect(refusal(await claim("2026/10/agent-console"))).toEqual({
      code: "ARTIFACT_PATH_TAKEN",
      message: 'The path "2026/10/agent-console" already belongs to another artifact.',
      status: 409,
    });
    expect(refusal(await claim("2026/10"))).toEqual({
      code: "ARTIFACT_PATH_TAKEN",
      message: 'The path "2026/10" overlaps the existing artifact path "2026/10/agent-console".',
      status: 409,
    });
    expect(refusal(await claim("2026/10/agent-console/shots"))).toEqual({
      code: "ARTIFACT_PATH_TAKEN",
      message: 'The path "2026/10/agent-console/shots" overlaps the existing artifact path "2026/10/agent-console".',
      status: 409,
    });

    const deleted = await mutateArtifact(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${holder.artifact.id}`,
      "DELETE",
      `artifact-paths-delete-${randomUUID()}`,
      {expectedCurrentVersionId: holder.version.id},
    );
    expect(deleted.status).toBe(200);
    await deleted.arrayBuffer();
    const reclaimed = await claim("2026/10/agent-console");
    expect(reclaimed.status).toBe(201);
    const reclaimer = publishResponseSchema.parse(reclaimed.body);
    expect(reclaimer.artifact.id).not.toBe(holder.artifact.id);
    expect(reclaimer.artifact.path).toBe("2026/10/agent-console");
    // The new holder claims the path as fully as the deleted one did.
    expect(refusal(await claim("2026/10/agent-console/shots"))).toMatchObject({
      code: "ARTIFACT_PATH_TAKEN",
      status: 409,
    });
  });

  test("external-storage foundation: Postgres reuses the member an operator key names, refuses the replaced key, signs the browser in as that administrator, and gives a non-administrator email no key", async () => {
    const identity = {
      apiToken: managedTestKey("operator-key"),
      installationId: `operator-key-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const first = await issueOperatorKey(environment, identity, {
      displayName: "Ops Lead",
      email: "ops@example.test",
      keyName: "Ops Lead",
      role: "administrator",
    });
    const repeated = await issueOperatorKey(environment, identity, {
      displayName: "Ops Lead",
      email: "OPS@example.test",
      keyName: "Ops Lead",
      role: "administrator",
    });
    expect(repeated.member.id).toBe(first.member.id);
    expect(repeated.issued.apiKey.id).not.toBe(first.issued.apiKey.id);

    // The server never saw the first key before it was replaced, so no cached
    // credential can stand in for the revocation Postgres holds.
    expect((await apiKeySignIn(server.baseUrl, first.issued.token)).status).toBe(401);
    const session = await signInWithApiKey(server.baseUrl, repeated.issued.token);
    const current = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: session.header},
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      authenticationMethod: "session",
      principal: {
        authorizedByPrincipalId: null,
        id: first.member.id,
        kind: "human",
        membershipRole: "administrator",
      },
    });

    const origin = "https://artifacts.example.com";
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Reader",
        email: "reader@example.test",
        role: "member",
      }),
      headers: browserMutationHeaders(origin, session),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const reader = memberAdmissionSchema.parse(await admitted.json()).member;
    const readerKey = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        memberId: reader.id,
        name: "Reader laptop",
      }),
      headers: browserMutationHeaders(origin, session),
      method: "POST",
    });
    expect(readerKey.status).toBe(201);

    const listKeys = async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
        headers: {Cookie: session.header},
      });
      expect(response.status).toBe(200);
      return apiKeyListSchema.parse(await response.json()).apiKeys;
    };
    const keysBefore = await listKeys();
    expect(keysBefore.filter((key) => key.principalId === first.member.id)
      .map((key) => key.id).toSorted())
      .toEqual([first.issued.apiKey.id, repeated.issued.apiKey.id].toSorted());
    expect(keysBefore.filter((key) => key.principalId === reader.id)).toHaveLength(1);

    // As a bearer the operator key stays a delegated key, not the administrator.
    expect((await authenticatedFetch(
      server.baseUrl,
      repeated.issued.token,
      "/api/v1/members",
    )).status).toBe(403);

    await expect(issueOperatorKey(environment, identity, {
      displayName: "Reader",
      email: "reader@example.test",
      keyName: "Reader",
      role: "administrator",
    })).rejects.toMatchObject({
      _tag: "IdentityConflict",
      message: expect.stringContaining("role is member, not administrator"),
    });
    expect((await listKeys()).map((key) => key.id).toSorted())
      .toEqual(keysBefore.map((key) => key.id).toSorted());

    const readerLaptop = await issueOperatorKey(environment, identity, {
      displayName: "Reader",
      email: "reader@example.test",
      keyName: "Reader @ laptop",
      role: "member",
    });
    expect(readerLaptop.member.id).toBe(reader.id);
    expect(readerLaptop.issued.apiKey.name).toBe("Reader @ laptop");
  });

  test("external-storage foundation: Postgres records each member key's name as author, keeps a member key off another principal's artifact, and re-issuing a key name revokes only that key", async () => {
    const identity = {
      apiToken: managedTestKey("member-keys"),
      installationId: `member-keys-${randomUUID()}`,
    };
    let server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const laptop = "Duyet Le @ duet-mbp";
    const desktop = "Duyet Le @ duet-linux";
    const issue = (keyName: string, role: "administrator" | "member" = "member") =>
      issueOperatorKey(environment, identity, {
        displayName: "Duyet Le",
        email: "duyet@example.test",
        keyName,
        role,
      });
    const details = async (artifactId: string) => {
      const response = await authenticatedFetch(
        server.baseUrl,
        identity.apiToken,
        `/api/v1/artifacts/${artifactId}`,
      );
      expect(response.status).toBe(200);
      return authorshipSchema.parse(await response.json());
    };

    const onLaptop = await issue(laptop);
    const onDesktop = await issue(desktop);
    expect(onLaptop.member.role).toBe("member");
    expect(onDesktop.member.id).toBe(onLaptop.member.id);

    const created = await publishNew(server.baseUrl, onLaptop.issued.token, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Report</title>",
      idempotencyKey: `member-keys-report-${randomUUID()}`,
      name: "Report",
    });
    expect(created.response.status).toBe(201);
    const fromDesktop = await publishVersion(server.baseUrl, onDesktop.issued.token, {
      artifactId: created.body.artifact.id,
      content: "<!doctype html><title>Report, desktop edit</title>",
      expectedCurrentVersionId: created.body.version.id,
      idempotencyKey: `member-keys-desktop-${randomUUID()}`,
    });
    expect(fromDesktop.response.status).toBe(201);
    const desktopVersion = publishedVersionAuthorSchema.parse(fromDesktop.body).version;
    expect(desktopVersion).toMatchObject({
      publisherDisplayName: desktop,
      publisherPrincipalId: onLaptop.member.id,
    });
    const fromLaptop = await publishVersion(server.baseUrl, onLaptop.issued.token, {
      artifactId: created.body.artifact.id,
      content: "<!doctype html><title>Report, laptop edit</title>",
      expectedCurrentVersionId: desktopVersion.id,
      idempotencyKey: `member-keys-laptop-${randomUUID()}`,
    });
    expect(fromLaptop.response.status).toBe(201);
    const report = await details(created.body.artifact.id);
    expect(report.artifact.owner).toEqual({
      displayName: laptop,
      principalId: onLaptop.member.id,
    });
    expect(report.current.version).toEqual({
      publisherDisplayName: laptop,
      publisherPrincipalId: onLaptop.member.id,
    });

    const theirs = await publishNew(server.baseUrl, identity.apiToken, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Theirs</title>",
      idempotencyKey: `member-keys-theirs-${randomUUID()}`,
      name: "Theirs",
    });
    expect(theirs.response.status).toBe(201);
    const overwrite = await publishVersion(server.baseUrl, onLaptop.issued.token, {
      artifactId: theirs.body.artifact.id,
      content: "<!doctype html><title>Taken</title>",
      expectedCurrentVersionId: theirs.body.version.id,
      idempotencyKey: `member-keys-overwrite-${randomUUID()}`,
    });
    expect(overwrite.response.status).toBe(403);
    const renamed = await mutateArtifact(
      server.baseUrl,
      onLaptop.issued.token,
      `/api/v1/artifacts/${theirs.body.artifact.id}/name`,
      "PATCH",
      `member-keys-rename-${randomUUID()}`,
      {expectedCurrentVersionId: theirs.body.version.id, name: "Taken"},
    );
    expect(renamed.status).toBe(403);
    const untouched = await details(theirs.body.artifact.id);
    expect(untouched.artifact.name).toBe("Theirs");
    expect(untouched.current.version.publisherPrincipalId)
      .toBe(managedTestPrincipal(identity.apiToken).principalId);

    const reissued = await issue(laptop);
    expect(reissued.issued.apiKey.id).not.toBe(onLaptop.issued.apiKey.id);
    // The serving process caches the laptop key it already verified, and only
    // the issuing runtime clears its own cache, so a fresh server reads the
    // revocation from Postgres.
    await server.stop();
    server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    expect(await bearerStatus(server.baseUrl, onLaptop.issued.token)).toBe(401);
    expect(await bearerStatus(server.baseUrl, reissued.issued.token)).toBe(200);
    expect(await bearerStatus(server.baseUrl, onDesktop.issued.token)).toBe(200);

    await expect(issue("Promoted", "administrator")).rejects.toMatchObject({
      _tag: "IdentityConflict",
      message: expect.stringContaining("role is member, not administrator"),
    });
  });

  test("external-storage foundation: Postgres and S3 report a folder's broken references over REST and MCP for the current and an exact version, with the counts on both commit results", async () => {
    const identity = {
      apiToken: managedTestKey("asset-check"),
      installationId: `asset-check-${randomUUID()}`,
    };
    // The expected references assume the same-origin served roots.
    const server = await startInProcessExternalStorageServer(
      environment,
      identity,
      {contentDomain: null},
    );
    const encoder = new TextEncoder();
    const file = (filePath: string, mediaType: string, text: string): StagedTestFile => ({
      bytes: encoder.encode(text),
      mediaType,
      path: filePath,
    });
    const reportFolder = [
      file("index.html", "text/html", [
        "<!doctype html><html><head>",
        "<link rel=\"stylesheet\" href=\"css/site.css\">",
        "</head><body>",
        "<img src=\"shots/a.jpg\" alt=\"correct\">",
        "<img src=\"my-report/shots/a.jpg\" alt=\"repeats its own folder\">",
        "<img srcset=\"shots/a.jpg 1x, shots/a@2x.jpg 2x\" alt=\"one missing candidate\">",
        "<img src=\"https://images.example.com/logo.png\" alt=\"external\">",
        "<template><img src=\"${src}\" alt=\"template\"></template>",
        "<a href=\"pages/about.html\">About</a>",
        "<img src=\"/elsewhere/logo.png\" alt=\"outside the artifact\">",
        "<script>fetch(\"data/ok.json\"); fetch(\"data/missing.json\");</script>",
        "</body></html>",
      ].join("\n")),
      file("css/site.css", "text/css", [
        "@font-face { font-family: Brand; src: url(\"../fonts/brand.woff2\") format(\"woff2\"); }",
        "body { background: url(../shots/a.jpg); }",
      ].join("\n")),
      file("pages/about.html", "text/html",
        "<!doctype html><a href=\"../index.html\">Home</a><img src=\"../shots/a.jpg\" alt=\"up\">"),
      file("pages/based.html", "text/html",
        "<!doctype html><base href=\"../\"><img src=\"shots/a.jpg\" alt=\"via base\"><img src=\"shots/b.jpg\" alt=\"missing via base\">"),
      file("shots/a.jpg", "image/jpeg", "jpeg"),
      file("data/ok.json", "application/json", "{}"),
    ];
    const expectedBroken = [
      {confidence: "certain", file: "css/site.css", kind: "css-url", line: 1, raw: "../fonts/brand.woff2", resolvedPath: "fonts/brand.woff2"},
      {confidence: "heuristic", file: "index.html", kind: "outside", line: 10, raw: "/elsewhere/logo.png", resolvedPath: "/elsewhere/logo.png"},
      {confidence: "heuristic", file: "index.html", kind: "script", line: 11, raw: "data/missing.json", resolvedPath: "data/missing.json"},
      {confidence: "certain", file: "index.html", kind: "html-attr", line: 5, raw: "my-report/shots/a.jpg", resolvedPath: "my-report/shots/a.jpg"},
      {confidence: "certain", file: "index.html", kind: "html-attr", line: 6, raw: "shots/a@2x.jpg", resolvedPath: "shots/a@2x.jpg"},
      {confidence: "certain", file: "pages/based.html", kind: "html-attr", line: 1, raw: "shots/b.jpg", resolvedPath: "shots/b.jpg"},
    ];
    const readAssetCheck = async (artifactId: string, versionId: string | null) => {
      const response = await authenticatedFetch(
        server.baseUrl,
        identity.apiToken,
        versionId === null
          ? `/api/v1/artifacts/${artifactId}/asset-check`
          : `/api/v1/artifacts/${artifactId}/versions/${versionId}/asset-check`,
      );
      expect(response.status).toBe(200);
      return assetCheckReportSchema.parse(await response.json());
    };
    const callTool = async (name: string, toolArguments: McpTestParameters) => {
      const response = await externalStorageMcpRequest(
        server.baseUrl,
        identity.apiToken,
        "tools/call",
        {arguments: toolArguments, name},
        name,
      );
      expect(response.status).toBe(200);
      const {result} = mcpToolTextResultSchema.parse(await response.json());
      expect(result.isError).not.toBe(true);
      return result;
    };

    const firstUpload = await stageExternalStorageFiles(
      server.baseUrl,
      identity.apiToken,
      reportFolder,
      "index.html",
    );
    const committed = await fetch(firstUpload.commitUrl, {
      body: JSON.stringify({target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "My report",
        path: "my-report",
        tags: [],
      }}),
      headers: mutationHeaders(identity.apiToken, `asset-check-first-${randomUUID()}`),
      method: "POST",
    });
    expect(committed.status).toBe(201);
    const first = assetCheckCommitSchema.parse(await committed.json());
    expect(first.assetCheck).toEqual({broken: 4, heuristic: 2});

    const current = await readAssetCheck(first.artifact.id, null);
    expect(current.version.id).toBe(first.version.id);
    expect(sortedAssetReferences(current.references)).toEqual(expectedBroken);
    expect(current.summary).toEqual({
      broken: 4,
      byKind: {
        "css-import": 0,
        "css-url": 1,
        "html-attr": 3,
        "meta-refresh": 0,
        outside: 1,
        script: 1,
      },
      checkedFiles: 4,
      heuristic: 2,
      truncated: false,
    });

    // A second version must not change what the first one reports.
    const secondUpload = await stageExternalStorageFiles(server.baseUrl, identity.apiToken, [
      file("index.html", "text/html", "<!doctype html><img src=\"shots/a.jpg\" alt=\"kept\"><img src=\"shots/c.jpg\" alt=\"new miss\">"),
      file("shots/a.jpg", "image/jpeg", "jpeg"),
    ], "index.html");
    const viaMcp = await callTool("artifact_commit_upload", {
      idempotencyKey: `asset-check-second-${randomUUID()}`,
      target: {
        artifactId: first.artifact.id,
        expectedCurrentVersionId: first.version.id,
        kind: "new_version",
      },
      uploadId: secondUpload.uploadId,
    });
    const second = assetCheckCommitSchema.parse(viaMcp.structuredContent);
    expect(second.assetCheck).toEqual({broken: 1, heuristic: 0});
    expect(viaMcp.content[0]?.text)
      .toContain("Asset check: 1 broken and 0 possibly broken references.");

    const exactFirst = await readAssetCheck(first.artifact.id, first.version.id);
    expect(exactFirst.version.id).toBe(first.version.id);
    expect(sortedAssetReferences(exactFirst.references)).toEqual(expectedBroken);
    const mcpFirst = assetCheckReportSchema.parse((await callTool("artifact_check_assets", {
      artifactId: first.artifact.id,
      versionId: first.version.id,
    })).structuredContent);
    expect(sortedAssetReferences(mcpFirst.references)).toEqual(expectedBroken);
    expect(mcpFirst.summary).toEqual(exactFirst.summary);
    const mcpCurrent = assetCheckReportSchema.parse((await callTool("artifact_check_assets", {
      artifactId: first.artifact.id,
    })).structuredContent);
    expect(mcpCurrent.version.id).toBe(second.version.id);
    expect(mcpCurrent.references.map((reference) => reference.raw)).toEqual(["shots/c.jpg"]);

    const unknownVersion = await authenticatedFetch(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${first.artifact.id}/versions/ver_missing/asset-check`,
    );
    expect(unknownVersion.status).toBe(404);
  });

  test("external-storage foundation: Postgres and S3 save an edit equal to its base except the edited file, record it as edited, replay it, and save nothing for an unknown base or an unverified upload", async () => {
    const identity = {
      apiToken: managedTestKey("artifact-edit"),
      installationId: `artifact-edit-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const handbook = handbookFiles();
    const published = await publishExternalStorageFiles(server.baseUrl, identity.apiToken, {
      files: handbook,
      idempotencyKey: `artifact-edit-publish-${randomUUID()}`,
      name: "Handbook",
    });
    const read = readerFor(server.baseUrl, identity.apiToken, published.artifact.id);
    const base = await read.version(published.version.id);
    const edited = textFile("notes.md", "text/markdown; charset=utf-8", "# Notes\n\nSecond draft.\n");
    const editKey = `artifact-edit-notes-${randomUUID()}`;
    const edit = () => commitExternalStorageEdit(server.baseUrl, identity.apiToken, {
      artifactId: published.artifact.id,
      baseVersionId: published.version.id,
      expectedCurrentVersionId: published.version.id,
      file: edited,
      idempotencyKey: editKey,
    });

    const saved = await edit();
    expect(saved.status).toBe(201);
    const committed = publishResponseSchema.parse(await saved.json());
    expect(committed).toMatchObject({replayed: false, version: {number: 2}});
    const next = await read.version(committed.version.id);
    expect(next.manifest.entryPath).toBe(base.manifest.entryPath);
    expect(next.manifest.routingMode).toBe(base.manifest.routingMode);
    expect(withoutEntry(next.manifest.entries, "notes.md"))
      .toEqual(withoutEntry(base.manifest.entries, "notes.md"));
    expect(withoutEntry(next.manifest.entries, "notes.md")).toHaveLength(handbook.length - 1);
    expect(next.manifest.entries.find((entry) => entry.path === "notes.md")).toEqual({
      disposition: "inline",
      mediaType: "text/markdown; charset=utf-8",
      path: "notes.md",
      sha256: createHash("sha256").update(edited.bytes).digest("hex"),
      size: edited.bytes.byteLength,
    });
    // Every other file, the binary one included, is the base's bytes from S3.
    expect(await Promise.all(handbook.map((file) => read.file(committed.version.id, file.path))))
      .toEqual(handbook.map((file) => file.path === "notes.md" ? edited.bytes : file.bytes));
    expect(await read.file(published.version.id, "notes.md"))
      .toEqual(handbook.find((file) => file.path === "notes.md")?.bytes);

    const replay = await edit();
    expect(replay.status).toBe(200);
    expect(publishResponseSchema.parse(await replay.json())).toMatchObject({
      replayed: true,
      version: {id: committed.version.id},
    });
    const actions = await authenticatedFetch(
      server.baseUrl,
      identity.apiToken,
      `/api/v1/artifacts/${published.artifact.id}/actions?limit=100`,
    );
    expect(actions.status).toBe(200);
    expect(artifactActionsSchema.parse(await actions.json()).actions
      .filter((action) => action.action === "edited")
      .map(({action, idempotencyKey, versionId}) => ({action, idempotencyKey, versionId})))
      .toEqual([{action: "edited", idempotencyKey: editKey, versionId: committed.version.id}]);

    const unknownBase = await commitExternalStorageEdit(server.baseUrl, identity.apiToken, {
      artifactId: published.artifact.id,
      baseVersionId: "ver_00000000-0000-4000-8000-000000000000",
      expectedCurrentVersionId: committed.version.id,
      file: textFile("notes.md", "text/markdown", "# Notes\n\nFrom nowhere.\n"),
      idempotencyKey: `artifact-edit-unknown-base-${randomUUID()}`,
    });
    expect(unknownBase.status).toBe(404);
    expect(commentFailureSchema.parse(await unknownBase.json()).error.code)
      .toBe("VERSION_NOT_FOUND");
    const unverified = await commitExternalStorageEdit(server.baseUrl, identity.apiToken, {
      artifactId: published.artifact.id,
      baseVersionId: committed.version.id,
      expectedCurrentVersionId: committed.version.id,
      file: textFile("notes.md", "text/markdown", "# Never uploaded\n"),
      idempotencyKey: `artifact-edit-unverified-${randomUUID()}`,
      upload: false,
    });
    expect(unverified.status).toBe(409);
    expect(await read.versionIds()).toEqual([committed.version.id, published.version.id]);
    expect(await read.file(committed.version.id, "notes.md")).toEqual(edited.bytes);
  });

  test("external-storage foundation: Postgres and S3 keep an edit's byte order mark and CRLF endings exactly, and a stale save is the publish conflict naming the current version with nothing saved", async () => {
    const identity = {
      apiToken: managedTestKey("artifact-edit-bytes"),
      installationId: `artifact-edit-bytes-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const handbook = handbookFiles();
    const published = await publishExternalStorageFiles(server.baseUrl, identity.apiToken, {
      files: handbook,
      idempotencyKey: `artifact-edit-bytes-publish-${randomUUID()}`,
      name: "Handbook",
    });
    const read = readerFor(server.baseUrl, identity.apiToken, published.artifact.id);
    const bomCrlf: StagedTestFile = {
      bytes: Uint8Array.from([
        0xef, 0xbb, 0xbf,
        ...new TextEncoder().encode("Line one\r\nLine two, changed\r\nLine three\r\n"),
      ]),
      mediaType: "text/plain; charset=utf-8",
      path: "readme.txt",
    };

    const theirs = await commitExternalStorageEdit(server.baseUrl, identity.apiToken, {
      artifactId: published.artifact.id,
      baseVersionId: published.version.id,
      expectedCurrentVersionId: published.version.id,
      file: bomCrlf,
      idempotencyKey: `artifact-edit-bytes-theirs-${randomUUID()}`,
    });
    expect(theirs.status).toBe(201);
    const current = publishResponseSchema.parse(await theirs.json()).version.id;
    expect(await read.file(current, "readme.txt")).toEqual(bomCrlf.bytes);
    expect(await read.file(current, "notes.md"))
      .toEqual(handbook.find((file) => file.path === "notes.md")?.bytes);

    const mine = await commitExternalStorageEdit(server.baseUrl, identity.apiToken, {
      artifactId: published.artifact.id,
      baseVersionId: published.version.id,
      expectedCurrentVersionId: published.version.id,
      file: textFile("notes.md", "text/markdown", "# Notes\n\nMine.\n"),
      idempotencyKey: `artifact-edit-bytes-stale-${randomUUID()}`,
    });
    expect(mine.status).toBe(409);
    const conflict = commentFailureSchema.parse(await mine.json()).error;
    expect(conflict.code).toBe("PUBLISH_CONFLICT");
    expect(conflict.message).toContain(current);
    expect(await read.versionIds()).toEqual([current, published.version.id]);
    expect(await read.file(current, "notes.md"))
      .toEqual(handbook.find((file) => file.path === "notes.md")?.bytes);
  });

  test("external-storage foundation: the browser helper duplicates a Postgres and S3 version byte for byte into a private copy, replays its key, and copies nothing when a source file is missing", async () => {
    const identity = {
      apiToken: managedTestKey("artifact-duplicate"),
      installationId: `artifact-duplicate-${randomUUID()}`,
    };
    const server = await startInProcessExternalStorageServer(environment, identity);
    const transport = createBearerTransport(server.baseUrl, identity.apiToken);
    const handbook = handbookFiles();
    const published = await publishExternalStorageFiles(server.baseUrl, identity.apiToken, {
      files: handbook,
      idempotencyKey: `artifact-duplicate-publish-${randomUUID()}`,
      name: "Quarterly dashboard",
      tags: ["finance", "q3"],
    });
    const detailsOf = async (artifactId: string) => {
      const response = await authenticatedFetch(
        server.baseUrl,
        identity.apiToken,
        `/api/v1/artifacts/${artifactId}`,
      );
      expect(response.status).toBe(200);
      return artifactDetailsSchema.parse(await response.json());
    };
    const names = async () => (await listArtifacts(server.baseUrl, identity.apiToken))
      .body.artifacts.map((item) => item.artifact.name).toSorted();
    const source = await detailsOf(published.artifact.id);
    const input = {
      artifactId: published.artifact.id,
      artifactName: source.artifact.name,
      artifactTags: source.artifact.tags,
      idempotencyKey: `artifact-duplicate-copy-${randomUUID()}`,
      manifest: source.current.manifest,
      projectId: published.version.projectId,
      versionId: source.current.version.id,
    };

    const copy = await duplicateArtifact(transport, input);
    expect(copy).toMatchObject({
      artifact: {accessSetting: "account_required", name: "Quarterly dashboard (copy)", tags: ["finance", "q3"]},
      replayed: false,
      version: {number: 1},
    });
    expect(copy.artifact.id).not.toBe(published.artifact.id);
    const copied = await detailsOf(copy.artifact.id);
    expect(copied.current.manifest.entries).toEqual(source.current.manifest.entries);
    const read = readerFor(server.baseUrl, identity.apiToken, copy.artifact.id);
    expect(await Promise.all(handbook.map((file) => read.file(copy.version.id, file.path))))
      .toEqual(handbook.map((file) => file.bytes));
    const unchanged = await detailsOf(published.artifact.id);
    expect(unchanged.current.version.id).toBe(published.version.id);
    expect(unchanged.artifact).toMatchObject({accessSetting: "public_link", name: "Quarterly dashboard"});

    const retry = await duplicateArtifact(transport, input);
    expect(retry).toMatchObject({artifact: {id: copy.artifact.id}, replayed: true, version: {id: copy.version.id}});
    expect(await names()).toEqual(["Quarterly dashboard", "Quarterly dashboard (copy)"]);

    await expect(duplicateArtifact(transport, {
      ...input,
      idempotencyKey: `artifact-duplicate-missing-${randomUUID()}`,
      manifest: {
        ...source.current.manifest,
        entries: [...source.current.manifest.entries, {
          disposition: "attachment",
          mediaType: "text/plain; charset=utf-8",
          path: "missing/notes.txt",
          sha256: "1".repeat(64),
          size: 3,
        }],
      },
    })).rejects.toMatchObject({status: 404});
    expect(await names()).toEqual(["Quarterly dashboard", "Quarterly dashboard (copy)"]);
  });
});

function withoutEntry(
  entries: z.infer<typeof manifestSchema>["entries"],
  filePath: string,
): z.infer<typeof manifestSchema>["entries"] {
  return entries.filter((entry) => entry.path !== filePath);
}

function textFile(filePath: string, mediaType: string, text: string): StagedTestFile {
  return {bytes: new TextEncoder().encode(text), mediaType, path: filePath};
}

/** A multi-file site with a binary file, so byte identity means something. */
function handbookFiles(): readonly StagedTestFile[] {
  return [
    textFile("index.html", "text/html; charset=utf-8", "<!doctype html><title>Handbook</title>\r\n"),
    textFile("notes.md", "text/markdown; charset=utf-8", "# Notes\n\nFirst draft.\n"),
    textFile("readme.txt", "text/plain; charset=utf-8", "Plain text.\n"),
    {
      bytes: Uint8Array.from({length: 256}, (_, index) => index),
      mediaType: "application/octet-stream",
      path: "assets/blob.bin",
    },
  ];
}

async function publishExternalStorageFiles(
  baseUrl: string,
  token: string,
  input: {
    readonly files: readonly StagedTestFile[];
    readonly idempotencyKey: string;
    readonly name: string;
    readonly tags?: readonly string[];
  },
) {
  const upload = await stageExternalStorageFiles(baseUrl, token, input.files, "index.html");
  const response = await fetch(upload.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: input.name,
      tags: input.tags ?? [],
    }}),
    headers: mutationHeaders(token, input.idempotencyKey),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return publishResponseSchema.parse(await response.json());
}

/** Stage one replacement file and commit it as an edit of `path`. */
async function commitExternalStorageEdit(
  baseUrl: string,
  token: string,
  input: {
    readonly artifactId: string;
    readonly baseVersionId: string;
    readonly expectedCurrentVersionId: string;
    readonly file: StagedTestFile;
    readonly idempotencyKey: string;
    readonly upload?: false;
  },
): Promise<Response> {
  const upload = input.upload === false
    ? await planExternalStorageUpload(baseUrl, token, [input.file], input.file.path)
    : await stageExternalStorageFiles(baseUrl, token, [input.file], input.file.path);
  return fetch(upload.commitUrl, {
    body: JSON.stringify({target: {
      artifactId: input.artifactId,
      baseVersionId: input.baseVersionId,
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      kind: "edit",
      path: input.file.path,
    }}),
    headers: mutationHeaders(token, input.idempotencyKey),
    method: "POST",
  });
}

/** Read one artifact's versions and files back over HTTP. */
function readerFor(baseUrl: string, token: string, artifactId: string) {
  return {
    async file(versionId: string, filePath: string): Promise<Uint8Array> {
      const response = await authenticatedFetch(
        baseUrl,
        token,
        `/api/v1/artifacts/${artifactId}/versions/${versionId}/file?${new URLSearchParams({path: filePath})}`,
      );
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    },
    async version(versionId: string) {
      const response = await authenticatedFetch(
        baseUrl,
        token,
        `/api/v1/artifacts/${artifactId}/versions/${versionId}`,
      );
      expect(response.status).toBe(200);
      return versionManifestSchema.parse(await response.json());
    },
    async versionIds(): Promise<readonly string[]> {
      const response = await authenticatedFetch(
        baseUrl,
        token,
        `/api/v1/artifacts/${artifactId}/versions`,
      );
      expect(response.status).toBe(200);
      return versionListSchema.parse(await response.json()).versions
        .map((item) => item.version.id);
    },
  };
}

type PublicArtifactTree = z.infer<typeof publicArtifactTreeSchema>;

function sortedAssetReferences(
  references: readonly z.infer<typeof assetReferenceSchema>[],
) {
  return references.toSorted((left, right) =>
    `${left.file}\u0000${left.raw}` < `${right.file}\u0000${right.raw}` ? -1 : 1
  );
}

/** Resolve one public tree item by name, failing loudly rather than silently. */
function publicTreeEntry(tree: PublicArtifactTree, name: string) {
  const found = tree.artifacts.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`The public tree holds no artifact named ${name}.`);
  }
  return found;
}

function readIntegrationEnvironment(): IntegrationEnvironment {
  const accessKey = process.env["ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"];
  const databaseUrl = process.env["ARTIFACT_SERVER_TEST_DATABASE_URL"];
  const endpoint = process.env["ARTIFACT_SERVER_TEST_S3_ENDPOINT"];
  const postgresContainer =
    process.env["ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER"];
  const postgresUser = process.env["ARTIFACT_SERVER_TEST_POSTGRES_USER"];
  const secretKey = process.env["ARTIFACT_SERVER_TEST_S3_SECRET_KEY"];
  if (
    accessKey === undefined || databaseUrl === undefined ||
    endpoint === undefined || postgresContainer === undefined ||
    postgresUser === undefined || secretKey === undefined
  ) {
    throw new Error("Run this test through pnpm test:external-storage-runtime.");
  }
  return {
    accessKey,
    databaseUrl,
    endpoint,
    postgresContainer,
    postgresUser,
    secretKey,
  };
}

function managedTestKey(label: string): string {
  const id = createHash("sha256").update(`id:${label}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update(`secret:${label}`).digest("base64url");
  return `as_key_key_${id}_${secret}`;
}

function managedTestPrincipal(token: string) {
  const keyId = managedApiKeyCredentialPattern.exec(token)?.[1];
  if (keyId === undefined) throw new Error("The test key is not a managed API key.");
  return {
    authorizedByPrincipalId: "installation-bootstrap",
    displayName: "Installation bootstrap key",
    principalId: `service:${keyId}`,
    principalKind: "service",
  } as const;
}

function startExternalStorageProcess(
  environment: IntegrationEnvironment,
  identity: {
    readonly apiToken: string;
    readonly installationId: string;
    readonly sameHost?: boolean;
    readonly storageBucket?: string;
  },
  environmentOverrides: Readonly<Record<string, string>> = {},
): Promise<ExternalStorageProcess> {
  const sameHost = identity.sameHost === true;
  const child = spawn(
    process.execPath,
    [externalStorageCli, "start-external-storage", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SERVER_API_TOKEN: identity.apiToken,
        ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
        ARTIFACT_SERVER_CONTENT_DOMAIN: sameHost
          ? undefined
          : "content.example.net",
        ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
        ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
        ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
        ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
        ARTIFACT_SERVER_S3_ACCESS_KEY_ID: environment.accessKey,
        ARTIFACT_SERVER_S3_BUCKET: identity.storageBucket ?? bucket,
        ARTIFACT_SERVER_S3_ENDPOINT: environment.endpoint,
        ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
        ARTIFACT_SERVER_S3_REGION: region,
        ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: environment.secretKey,
        ...environmentOverrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  runningProcesses.add(child);
  return waitForExternalStorageProcess(child);
}

interface InstallationTableSnapshot {
  readonly count: number;
  readonly digest: string | null;
}

/** Fingerprint every row any installation-scoped table holds for one installation. */
async function installationRows(
  environment: IntegrationEnvironment,
  scopedInstallationId: string,
): Promise<Readonly<Record<string, InstallationTableSnapshot>>> {
  return withInstallationTables(environment, (sql, tables) => Effect.gen(function*() {
    const snapshot: Record<string, InstallationTableSnapshot> = {};
    for (const table of tables) {
      const [row] = yield* sql.unsafe<InstallationTableSnapshot>(
        `SELECT count(*)::int AS count,
           md5(string_agg(t::text, ',' ORDER BY t::text)) AS digest
         FROM "${table}" t WHERE installation_id = $1`,
        [scopedInstallationId],
      ).withoutTransform;
      if (row !== undefined) snapshot[table] = row;
    }
    return snapshot;
  }));
}

/** Name each installation-scoped table whose rows for one installation mention a foreign value. */
async function installationRowsMentioning(
  environment: IntegrationEnvironment,
  scopedInstallationId: string,
  foreignValues: readonly string[],
): Promise<readonly string[]> {
  return withInstallationTables(environment, (sql, tables) => Effect.gen(function*() {
    const mentioning: string[] = [];
    for (const table of tables) {
      for (const value of foreignValues) {
        const [row] = yield* sql.unsafe<{readonly count: number}>(
          `SELECT count(*)::int AS count FROM "${table}" t
           WHERE installation_id = $1 AND strpos(t::text, $2) > 0`,
          [scopedInstallationId, value],
        ).withoutTransform;
        if ((row?.count ?? 0) > 0) mentioning.push(`${table}: ${value}`);
      }
    }
    return mentioning;
  }));
}

async function withInstallationTables<A>(
  environment: IntegrationEnvironment,
  read: (
    sql: SqlClient,
    tables: readonly string[],
  ) => Effect.Effect<A, unknown>,
): Promise<A> {
  const database = await PostgresDatabase.open({
    maxConnections: 1,
    url: Redacted.make(environment.databaseUrl),
  }, "validate");
  try {
    return await database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql<{readonly table_name: string}>`
        SELECT DISTINCT table_name FROM information_schema.columns
        WHERE column_name = 'installation_id'
          AND table_schema = current_schema()
        ORDER BY table_name
      `.withoutTransform;
      const tables = rows.map(({table_name: table}) => {
        if (!/^[a-z_]+$/u.test(table)) throw new Error(`Unexpected table name ${table}.`);
        return table;
      });
      return yield* read(sql, tables);
    }));
  } finally {
    await database.close();
  }
}

/** List every object key under one installation's derived prefix. */
async function installationObjectKeys(
  client: S3Client,
  scopedInstallationId: string,
): Promise<readonly string[]> {
  const namespace = createHash("sha256").update(scopedInstallationId).digest("hex");
  const listFrom = async (continuationToken?: string): Promise<readonly string[]> => {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      Prefix: `installations/${namespace}/`,
    }));
    const keys = (page.Contents ?? []).flatMap(({Key}) => Key === undefined ? [] : [Key]);
    return page.NextContinuationToken === undefined
      ? keys
      : [...keys, ...await listFrom(page.NextContinuationToken)];
  };
  return (await listFrom()).toSorted();
}

type HeldRequestResult =
  | {readonly body: string; readonly status: number}
  | {readonly error: string};

interface HeldRequest {
  /** Resolves once the headers and the first half of the body reached the server. */
  readonly accepted: Promise<void>;
  /** Send the rest of the body. */
  finish(): void;
  readonly response: Promise<HeldRequestResult>;
}

/** Open a request on its own socket and hold it with half of its declared body sent. */
function startHeldRequest(
  url: string,
  method: string,
  headers: Headers,
  body: Buffer,
): HeldRequest {
  const target = new URL(url);
  const half = Math.floor(body.byteLength / 2);
  const accepted = Promise.withResolvers<void>();
  let held: ReturnType<typeof request> | undefined;
  const response = new Promise<HeldRequestResult>((resolve) => {
    const outgoing = request({
      agent: false,
      headers: {
        ...Object.fromEntries(headers),
        "Content-Length": String(body.byteLength),
      },
      hostname: target.hostname,
      method,
      path: `${target.pathname}${target.search}`,
      port: target.port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", (error: NodeJS.ErrnoException) =>
        resolve({error: error.code ?? error.message}));
      incoming.once("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        status: incoming.statusCode ?? 0,
      }));
    });
    outgoing.once("error", (error: NodeJS.ErrnoException) =>
      resolve({error: error.code ?? error.message}));
    outgoing.flushHeaders();
    outgoing.write(body.subarray(0, half), () => {
      setTimeout(accepted.resolve, 200);
    });
    held = outgoing;
  });
  return {
    accepted: accepted.promise,
    finish: () => {
      held?.end(body.subarray(half));
    },
    response,
  };
}

/** Send one GET on a new socket, so a pooled keep-alive socket cannot hide a closed listener. */
function freshRequest(
  baseUrl: string,
  pathname: string,
): Promise<{readonly body: string; readonly status: number}> {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      agent: false,
      headers: {Connection: "close"},
      hostname: target.hostname,
      method: "GET",
      path: target.pathname,
      port: target.port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        status: incoming.statusCode ?? 0,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function waitForFreshResponse(
  baseUrl: string,
  pathname: string,
  matches: (response: {readonly body: string; readonly status: number}) => boolean,
): Promise<{readonly body: string; readonly status: number}> {
  const deadline = Date.now() + 5_000;
  const attempt = async (): Promise<{readonly body: string; readonly status: number}> => {
    const response = await freshRequest(baseUrl, pathname);
    if (matches(response)) return response;
    if (Date.now() >= deadline) {
      throw new Error(`${pathname} never returned the expected response.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return attempt();
  };
  return attempt();
}

/** Poll on new sockets until the listener refuses one, and return the refusal code. */
async function waitForFreshFailure(baseUrl: string, pathname: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  const attempt = async (): Promise<string> => {
    const refusal = await freshConnectionRefusal(baseUrl, pathname);
    // A connection that arrives while the listener is closing is reset rather
    // than refused; keep asking until the closed listener refuses outright.
    if (refusal !== null && refusal !== "ECONNRESET") return refusal;
    if (Date.now() >= deadline) {
      throw new Error(`${pathname} kept accepting new connections.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return attempt();
  };
  return attempt();
}

/** Resolve with the socket error code of one new-connection GET, or null when it was served. */
function freshConnectionRefusal(baseUrl: string, pathname: string): Promise<string | null> {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve) => {
    const outgoing = request({
      agent: false,
      headers: {Connection: "close"},
      hostname: target.hostname,
      method: "GET",
      path: target.pathname,
      port: target.port,
    }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(null));
    });
    outgoing.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? error.message));
    outgoing.end();
  });
}

/** Resolve with the promise's value, or with "timed out" once the bound passes. */
function settledWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | "timed out"> {
  return Promise.race([
    promise,
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), milliseconds)),
  ]);
}

function childExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{readonly code: number | null; readonly signal: NodeJS.Signals | null}> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({code, signal}));
  });
}

function runExternalCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{readonly exitCode: number; readonly output: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [externalStorageCli, ...arguments_], {
      cwd: repositoryRoot,
      env: {...process.env, ...environment},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({
      exitCode: exitCode ?? -1,
      output: Buffer.concat(output).toString("utf8").trim(),
    }));
  });
}

async function startInProcessExternalStorageServer(
  environment: IntegrationEnvironment,
  identity: {readonly apiToken: string; readonly installationId: string},
  options: Partial<Pick<
    Parameters<typeof startExternalStorageServer>[0],
    "browserAccess" | "clock" | "contentDomain"
  >> = {},
): Promise<InProcessExternalStorageServer> {
  const server = await startExternalStorageServer({
    apiToken: Redacted.make(identity.apiToken),
    applicationOrigin: "https://artifacts.example.com",
    bootstrapAdministratorEmail: administratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
    contentDomain: "content.example.net",
    databaseUrl: Redacted.make(environment.databaseUrl),
    hostname: "127.0.0.1",
    installationId: identity.installationId,
    objectStorage: createS3ObjectStorageProviderFactory({
      accessKeyId: environment.accessKey,
      bucket,
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
      secretAccessKey: Redacted.make(environment.secretKey),
    }),
    port: 0,
    ...options,
  });
  let stopped = false;
  const running: InProcessExternalStorageServer = {
    baseUrl: `http://${server.hostname}:${server.port}`,
    flushArtifactViews: () => server.flushArtifactViews(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      runningInProcessServers.delete(running);
      await server.close();
    },
  };
  runningInProcessServers.add(running);
  return running;
}

function waitForExternalStorageProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<ExternalStorageProcess> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`External-storage process did not become ready: ${output}`));
    }, 20_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Artifact Server \(external-storage\): (http:\/\/127\.0\.0\.1:\d+)/u.exec(
        output,
      );
      if (match?.[1] === undefined) return;
      cleanup();
      const baseUrl = match[1];
      resolve({baseUrl, child, stop: () => stopChild(child)});
    };
    const exit = () => {
      cleanup();
      reject(new Error(`External-storage process exited before readiness: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

async function publishNew(
  baseUrl: string,
  token: string,
  input: {
    readonly accessSetting?: "account_required" | "public_link";
    readonly content: string;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly path?: string;
    readonly projectId?: string;
    readonly routingMode?: "spa" | "static";
  },
) {
  const upload = await stageExternalStorageFile(
    baseUrl,
    token,
    input.content,
    input.projectId,
    input.routingMode,
  );
  const response = await fetch(upload.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: input.accessSetting ?? "public_link",
      kind: "new_artifact",
      name: input.name,
      path: input.path,
      tags: ["external-storage-runtime"],
    }}),
    headers: mutationHeaders(token, input.idempotencyKey),
    method: "POST",
  });
  const body: unknown = await response.json();
  return {body: publishResponseSchema.parse(body), response};
}

async function publishVersion(
  baseUrl: string,
  token: string,
  input: {
    readonly artifactId: string;
    readonly content: string;
    readonly expectedCurrentVersionId: string;
    readonly idempotencyKey: string;
    readonly projectId?: string;
  },
) {
  const upload = await stageExternalStorageFile(
    baseUrl,
    token,
    input.content,
    input.projectId,
  );
  const response = await fetch(upload.commitUrl, {
      body: JSON.stringify({target: {
        artifactId: input.artifactId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        kind: "new_version",
      }}),
      headers: mutationHeaders(token, input.idempotencyKey),
      method: "POST",
  });
  const body: unknown = await response.json();
  return {body, response};
}

async function stageExternalStorageFile(
  baseUrl: string,
  token: string,
  content: string,
  projectId?: string,
  routingMode?: "spa" | "static",
): Promise<z.infer<typeof uploadResponseSchema>> {
  return stageExternalStorageFiles(baseUrl, token, [{
    bytes: new TextEncoder().encode(content),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  }], "index.html", projectId, routingMode);
}

interface StagedTestFile {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly path: string;
}

/** Declare the files to stage without sending any of their bytes. */
async function planExternalStorageUpload(
  baseUrl: string,
  token: string,
  stagedFiles: readonly StagedTestFile[],
  entryPath: string,
  projectId?: string,
  routingMode?: "spa" | "static",
): Promise<z.infer<typeof uploadResponseSchema>> {
  const files = stagedFiles.map((file) => ({
    mediaType: file.mediaType,
    path: file.path,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    size: file.bytes.byteLength,
  }));
  const body = {entryPath, files, projectId, routingMode};
  const createUpload = await fetch(`${baseUrl}/api/v1/uploads`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const upload = uploadResponseSchema.parse(await createUpload.json());
  if (upload.files.length !== stagedFiles.length) {
    throw new Error("The external-storage upload plan did not contain every declared file.");
  }
  return upload;
}

async function stageExternalStorageFiles(
  baseUrl: string,
  token: string,
  stagedFiles: readonly StagedTestFile[],
  entryPath: string,
  projectId?: string,
  routingMode?: "spa" | "static",
): Promise<z.infer<typeof uploadResponseSchema>> {
  const upload = await planExternalStorageUpload(
    baseUrl,
    token,
    stagedFiles,
    entryPath,
    projectId,
    routingMode,
  );
  await Promise.all(upload.files.map(async (plannedFile) => {
    const file = stagedFiles.find((candidate) => candidate.path === plannedFile.path);
    if (file === undefined) {
      throw new Error(`The external-storage upload plan names undeclared ${plannedFile.path}.`);
    }
    const uploaded = await fetch(plannedFile.uploadUrl, {
      body: copiedArrayBuffer(file.bytes),
      headers: {Authorization: `Bearer ${token}`},
      method: "PUT",
    });
    if (!uploaded.ok) {
      throw new Error(`The external-storage staged upload failed with HTTP ${uploaded.status}.`);
    }
  }));
  return upload;
}

async function listArtifacts(
  baseUrl: string,
  token: string,
  projectId?: string,
) {
  const url = new URL("/api/v1/artifacts", baseUrl);
  if (projectId !== undefined) url.searchParams.set("projectId", projectId);
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${token}`},
  });
  const body: unknown = await response.json();
  return {body: artifactListSchema.parse(body), response};
}

function externalStorageMcpRequest(
  baseUrl: string,
  token: string,
  method: string,
  parameters: McpTestParameters,
  name?: string,
): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    Host: "artifacts.example.com",
    Origin: "https://artifacts.example.com",
  });
  if (name !== undefined) headers.set("Mcp-Name", name);
  const body = JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "external-storage-runtime-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        },
      },
    });
  return rawHttpRequest(new URL("/mcp", baseUrl), headers, "POST", body);
}

function rawHttpRequest(
  target: URL,
  headers: Headers,
  method: string,
  body: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: Object.fromEntries(headers),
      hostname: target.hostname,
      method,
      path: `${target.pathname}${target.search}`,
      port: target.port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            responseHeaders.append(name, value);
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          headers: responseHeaders,
          status: incoming.statusCode ?? 500,
        }));
      });
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

interface McpTestParameters {
  readonly [key: string]: McpTestParameterValue;
}

type McpTestParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpTestParameterValue[]
  | McpTestParameters;

function mutationHeaders(token: string, idempotencyKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
}

function bearerHeaders(token: string): Headers {
  return new Headers({Authorization: `Bearer ${token}`});
}

function authenticatedFetch(
  baseUrl: string,
  token: string,
  pathname: string,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {headers: bearerHeaders(token)});
}

async function createCommentThread(
  baseUrl: string,
  token: string,
  target: {readonly artifactId: string; readonly versionId: string},
  idempotencyKey: string,
  input: {readonly body: string; readonly path?: string},
): Promise<{readonly body: unknown; readonly response: Response}> {
  const response = await fetch(
    `${baseUrl}/api/v1/artifacts/${target.artifactId}/versions/${target.versionId}/comments`,
    {
      body: JSON.stringify(input),
      headers: mutationHeaders(token, idempotencyKey),
      method: "POST",
    },
  );
  return {body: await response.json(), response};
}

async function createCommentReply(
  baseUrl: string,
  token: string,
  artifactId: string,
  threadId: string,
  idempotencyKey: string,
  body: string,
): Promise<{readonly body: unknown; readonly response: Response}> {
  const response = await fetch(
    `${baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}/replies`,
    {
      body: JSON.stringify({body}),
      headers: mutationHeaders(token, idempotencyKey),
      method: "POST",
    },
  );
  return {body: await response.json(), response};
}

function patchCommentThread(
  baseUrl: string,
  token: string,
  artifactId: string,
  threadId: string,
  changes: {readonly body?: string; readonly state?: "open" | "resolved"},
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}`,
    {
      body: JSON.stringify(changes),
      headers: new Headers({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }),
      method: "PATCH",
    },
  );
}

type ArtifactMutationBody =
  | {readonly expectedCurrentVersionId: string}
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly expectedCurrentVersionId: string;
  }
  | {
    readonly expectedCurrentVersionId: string;
    readonly tags: readonly string[];
  }
  | {
    readonly expectedCurrentVersionId: string;
    readonly versionId: string;
  }
  | {
    readonly expectedCurrentVersionId: string;
    readonly name: string;
  };

function mutateArtifact(
  baseUrl: string,
  token: string,
  pathname: string,
  method: "DELETE" | "PATCH" | "POST",
  idempotencyKey: string,
  body: ArtifactMutationBody,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: mutationHeaders(token, idempotencyKey),
    method,
  });
}

const installationActionSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  kind: z.string(),
  principalDisplayName: z.string(),
  principalId: z.string(),
  subjectId: z.string(),
}).strict();
type InstallationActionSummary =
  Omit<z.infer<typeof installationActionSchema>, "createdAt" | "id">;

// Actions written in the same millisecond have no defined order, so
// comparisons sort by what each action changed.
function summarize(
  actions: readonly InstallationActionSummary[],
): readonly InstallationActionSummary[] {
  return actions.map((action) => ({
    authorizedByPrincipalId: action.authorizedByPrincipalId,
    kind: action.kind,
    principalDisplayName: action.principalDisplayName,
    principalId: action.principalId,
    subjectId: action.subjectId,
  })).toSorted((left, right) =>
    `${left.kind}:${left.subjectId}`.localeCompare(`${right.kind}:${right.subjectId}`)
  );
}

async function json<T>(
  response: Promise<Response>,
  status: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const answered = await response;
  const body: unknown = await answered.json();
  expect({body, status: answered.status}).toMatchObject({status});
  return schema.parse(body);
}

function byOperator(kind: string, subjectId: string): InstallationActionSummary {
  return {
    authorizedByPrincipalId: null,
    kind,
    principalDisplayName: "Installation operator",
    principalId: "installation-operator",
    subjectId,
  };
}

/** The JSON body of one project, member, or API-key change request. */
type InstallationChangeBody = Readonly<Record<string, string | readonly string[]>>;

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/**
 * Seed a human administrator session, since a no-login team server has no
 * administrator sign-in of its own.
 */
async function seedAdministratorSession(
  environment: IntegrationEnvironment,
  scopedInstallationId: string,
): Promise<ApplicationCookies> {
  const database = await PostgresDatabase.open({
    maxConnections: 1,
    url: Redacted.make(environment.databaseUrl),
  }, "validate");
  let memberId: string;
  try {
    const member = await new PostgresIdentityRepository(
      database,
      scopedInstallationId,
    ).admitMember({
      actor: installationOperatorActor,
      createdAt: new Date().toISOString(),
      displayName: "Team administrator",
      email: administratorEmail,
      id: `member_${randomUUID()}`,
      installationId: scopedInstallationId,
      role: "administrator",
    });
    memberId = member.id;
  } finally {
    await database.close();
  }
  return seedMemberSession(environment, scopedInstallationId, memberId);
}

/** Seed a signed-in session for one existing member, as a browser login would. */
async function seedMemberSession(
  environment: IntegrationEnvironment,
  scopedInstallationId: string,
  memberId: string,
): Promise<ApplicationCookies> {
  const database = await PostgresDatabase.open({
    maxConnections: 1,
    url: Redacted.make(environment.databaseUrl),
  }, "validate");
  const token = `session_${randomUUID()}`;
  const csrf = `csrf_${randomUUID()}`;
  try {
    const now = new Date();
    await new PostgresIdentityRepository(
      database,
      scopedInstallationId,
    ).createApplicationSession({
      createdAt: now.toISOString(),
      csrfDigest: sha256Hex(csrf),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      id: `session_${randomUUID()}`,
      installationId: scopedInstallationId,
      subject: {kind: "member", memberId},
      tokenDigest: sha256Hex(token),
    });
  } finally {
    await database.close();
  }
  return {
    csrf,
    header: `__Host-artifact_session=${token}; __Host-artifact_csrf=${csrf}`,
  };
}

/**
 * Issue a key as artifactserver admin issue-key does in external-storage mode:
 * a second runtime on the same Postgres and S3, closed once the key exists.
 */
async function issueOperatorKey(
  environment: IntegrationEnvironment,
  identity: {readonly apiToken: string; readonly installationId: string},
  command: Omit<IssueOperatorKeyCommand, "expiresAt">,
) {
  const runtime = await createExternalStorageRuntime({
    apiToken: Redacted.make(identity.apiToken),
    applicationOrigin: "https://artifacts.example.com",
    bootstrapAdministratorEmail: administratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
    contentDomain: null,
    databaseUrl: Redacted.make(environment.databaseUrl),
    installationId: identity.installationId,
    objectStorage: createS3ObjectStorageProviderFactory({
      accessKeyId: environment.accessKey,
      bucket,
      endpoint: environment.endpoint,
      forcePathStyle: true,
      region,
      secretAccessKey: Redacted.make(environment.secretKey),
    }),
  });
  try {
    return await runtime.issueOperatorKey({
      ...command,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  } finally {
    await runtime.close();
  }
}

function apiKeySignIn(baseUrl: string, apiKey: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey}),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://artifacts.example.com",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    method: "POST",
  });
}

async function signInWithApiKey(
  baseUrl: string,
  apiKey: string,
): Promise<ApplicationCookies> {
  const response = await apiKeySignIn(baseUrl, apiKey);
  expect(response.status).toBe(204);
  const session = hostCookiePair(response, "artifact_session");
  const csrf = hostCookiePair(response, "artifact_csrf");
  if (session === undefined || csrf === undefined) {
    throw new Error("API-key sign-in did not issue both application cookies.");
  }
  return {csrf: csrf.slice(csrf.indexOf("=") + 1), header: `${session}; ${csrf}`};
}

/** One Set-Cookie pair; an https application origin names every cookie with __Host-. */
function hostCookiePair(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith(`__Host-${name}=`));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function browserMutationHeaders(
  origin: string,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

function bearerStatus(baseUrl: string, token: string): Promise<number> {
  return fetch(`${baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

function replaceOrigin(url: string, baseUrl: string): string {
  const target = new URL(url);
  const replacement = new URL(baseUrl);
  target.protocol = replacement.protocol;
  target.host = replacement.host;
  return target.toString();
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function fetchContentThroughServer(
  baseUrl: string,
  contentUrl: string,
  headers?: HeadersInit,
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  const server = new URL(baseUrl);
  const target = new URL(contentUrl);
  return new Promise((resolve, reject) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Host", target.host);
    const outgoing = request(
      {
        headers: Object.fromEntries(requestHeaders),
        hostname: server.hostname,
        method,
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) {
              responseHeaders.append(name, value);
            }
          }
          resolve(new Response(bytes, {
            headers: responseHeaders,
            status: incoming.statusCode ?? 500,
          }));
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function dumpPostgres(
  environment: IntegrationEnvironment,
): Promise<Buffer> {
  return runCommand("docker", [
    "exec",
    environment.postgresContainer,
    "pg_dump",
    "--username",
    environment.postgresUser,
    "--dbname",
    new URL(environment.databaseUrl).pathname.slice(1),
    "--no-owner",
    "--no-privileges",
  ]);
}

async function restorePostgres(
  environment: IntegrationEnvironment,
  database: string,
  dump: Uint8Array,
): Promise<void> {
  await runCommand("docker", [
    "exec",
    environment.postgresContainer,
    "createdb",
    "--username",
    environment.postgresUser,
    database,
  ]);
  await runCommand(
    "docker",
    [
      "exec",
      "--interactive",
      environment.postgresContainer,
      "psql",
      "--username",
      environment.postgresUser,
      "--dbname",
      database,
      "--set",
      "ON_ERROR_STOP=on",
    ],
    dump,
  );
}

async function createPostgresDatabase(
  environment: IntegrationEnvironment,
  database: string,
): Promise<void> {
  await runCommand("docker", [
    "exec",
    environment.postgresContainer,
    "createdb",
    "--username",
    environment.postgresUser,
    database,
  ]);
}

function databaseUrlFor(databaseUrl: string, database: string): string {
  const target = new URL(databaseUrl);
  target.pathname = `/${database}`;
  return target.toString();
}

async function backupBucket(
  client: S3Client,
  sourceBucket: string,
  continuationToken?: string,
): Promise<readonly BackedUpObject[]> {
  const page = await client.send(new ListObjectsV2Command({
    Bucket: sourceBucket,
    ContinuationToken: continuationToken,
  }));
  const objects = await Promise.all((page.Contents ?? []).map(async ({Key}) => {
    if (Key === undefined) throw new Error("An object-store listing omitted its key.");
    const object = await client.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key,
    }));
    if (object.Body === undefined) {
      throw new Error(`The object-store backup could not read ${Key}.`);
    }
    return {
      bytes: await object.Body.transformToByteArray(),
      contentType: object.ContentType,
      key: Key,
      metadata: object.Metadata,
    };
  }));
  if (!page.IsTruncated || page.NextContinuationToken === undefined) {
    return objects;
  }
  const remaining = await backupBucket(
    client,
    sourceBucket,
    page.NextContinuationToken,
  );
  return [...objects, ...remaining];
}

async function restoreBucketObjects(
  client: S3Client,
  targetBucket: string,
  objects: readonly BackedUpObject[],
): Promise<void> {
  await client.send(new CreateBucketCommand({Bucket: targetBucket}));
  await Promise.all(objects.map((object) => {
    let input: PutObjectCommandInput = {
      Body: object.bytes,
      Bucket: targetBucket,
      Key: object.key,
    };
    if (object.contentType !== undefined) {
      input = {...input, ContentType: object.contentType};
    }
    if (object.metadata !== undefined) {
      input = {...input, Metadata: object.metadata};
    }
    return client.send(new PutObjectCommand(input));
  }));
}

function runCommand(
  command: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["pipe", "pipe", "pipe"]});
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new Error(
        `${command} exited with ${exitCode ?? "no status"}: ${
          Buffer.concat(stderr).toString("utf8")
        }`,
      ));
    });
    child.stdin.end(input);
  });
}
