import {Effect, type Redacted} from "effect";

import {
  checkIntegrityCatalog,
  IntegrityCheckError,
  type IntegrityReport,
} from "../lifecycle/integrity-check.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from
  "../storage/object-storage-provider.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {readPostgresIntegrityCatalog} from
  "../storage/postgres-integrity-catalog.js";

/** Provider values required by an external-storage integrity scan. */
export interface ExternalIntegrityConfiguration {
  readonly databaseUrl: Redacted.Redacted;
  readonly installationId: string;
  readonly objectStorage: ObjectStorageProviderFactory;
}

/** Run the same read-only integrity contract against external providers. */
export async function checkExternalStorageIntegrity(
  configuration: ExternalIntegrityConfiguration,
): Promise<IntegrityReport> {
  let database: PostgresDatabase;
  try {
    database = await PostgresDatabase.inspect({
      applicationName: `artifact-server-integrity:${configuration.installationId}`,
      maxConnections: 1,
      url: configuration.databaseUrl,
    });
  } catch {
    throw new IntegrityCheckError({
      message: "Postgres could not be inspected.",
      provider: "postgres",
    });
  }
  let objectStorage: ObjectStorageProvider;
  try {
    objectStorage = configuration.objectStorage.create(
      configuration.installationId,
    );
  } catch {
    await database.close();
    throw new IntegrityCheckError({
      message: "Object storage could not be inspected.",
      provider: configuration.objectStorage.kind,
    });
  }
  try {
    const catalog = await database.health().then(() => database.run(
      readPostgresIntegrityCatalog(configuration.installationId),
    )).catch(() => {
      throw new IntegrityCheckError({
        message: "Postgres could not be inspected.",
        provider: "postgres",
      });
    });
    await objectStorage.readiness(AbortSignal.timeout(3_000)).catch(() => {
      throw new IntegrityCheckError({
        message: "Object storage could not be inspected.",
        provider: objectStorage.kind,
      });
    });
    return await Effect.runPromise(
      checkIntegrityCatalog(catalog, objectStorage.blobs),
    );
  } catch (error) {
    if (error instanceof IntegrityCheckError) throw error;
    throw new IntegrityCheckError({
      message: "The external providers could not be inspected.",
      provider: "postgres",
    });
  } finally {
    await Promise.all([objectStorage.close(), database.close()]);
  }
}
