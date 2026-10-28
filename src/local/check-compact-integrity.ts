import path from "node:path";

import {Effect} from "effect";

import {
  checkIntegrityCatalog,
  IntegrityCheckError,
  type IntegrityReport,
} from "../lifecycle/integrity-check.js";
import {LocalBlobStore} from "../storage/local-blob-store.js";
import {readSqliteIntegrityCatalog} from "../storage/sqlite-integrity-catalog.js";

/** Run a complete read-only compact installation integrity scan. */
export const checkCompactIntegrity = Effect.fn("checkCompactIntegrity")(
  function*(
    dataDirectory: string,
  ): Effect.fn.Return<IntegrityReport, IntegrityCheckError> {
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    const catalog = yield* Effect.try({
      try: () => readSqliteIntegrityCatalog(databasePath),
      catch: () => new IntegrityCheckError({
        message: "The compact database could not be inspected.",
        provider: "sqlite",
      }),
    });
    const blobs = new LocalBlobStore(path.join(dataDirectory, "blobs"));
    return yield* checkIntegrityCatalog(catalog, blobs);
  },
);
