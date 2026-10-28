import {mkdirSync} from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

const sqliteBusyCode = 5;
const sqliteErrorSchema = z.object({errcode: z.number().int()});

/** Proof that this process is the only server using one data directory. */
export interface DataDirectoryLock {
  /** Let another server process open the data directory. */
  release(): void;
}

/** Another process already holds the data-directory lock. */
export class DataDirectoryInUseError extends Error {}

/**
 * Hold an exclusive lock on the data directory for this server process.
 *
 * SQLite takes a kernel file lock on `server.lock`, so the lock follows the
 * volume rather than a PID: it holds across containers that share the volume,
 * and the kernel drops it when the process exits or crashes.
 */
export function acquireDataDirectoryLock(dataDirectory: string): DataDirectoryLock {
  const resolved = path.resolve(dataDirectory);
  mkdirSync(resolved, {mode: 0o700, recursive: true});
  const database = new DatabaseSync(path.join(resolved, "server.lock"), {
    allowExtension: false,
    timeout: 0,
  });
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    const parsed = sqliteErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.errcode === sqliteBusyCode) {
      throw new DataDirectoryInUseError(
        `Another Artifact Server process is already serving ${resolved}. Stop it before starting a new one; this process changed nothing.`,
        {cause: error},
      );
    }
    throw error;
  }
  return {
    release: () => {
      if (database.isOpen) database.close();
    },
  };
}
