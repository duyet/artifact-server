import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {DatabaseSync} from "node:sqlite";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createArtifactViewRecorder,
  defaultArtifactViewDrainChunkSize,
} from "../../src/application/artifact-view-recorder.js";
import {SqliteArtifactRepository} from
  "../../src/storage/sqlite-artifact-repository.js";
import {ArtifactRepositoryFailure} from "../../src/core/errors.js";
import type {ArtifactViewDelta} from "../../src/core/ports.js";
import {defaultProjectId} from "../../src/core/model.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const storedRowSchema = z.object({
  artifact_id: z.string(),
  count: z.number().int().nonnegative(),
  day: z.string(),
});

/** A clock a test moves by hand, so a day boundary is a fact and not a wait. */
function movableClock(start: Date) {
  return {
    instant: start,
    now() {
      return this.instant;
    },
  };
}

describe("buffered artifact view recorder", () => {
  let dataDirectory: string;
  let databasePath: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-views-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
  });

  afterEach(async () => {
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  /** Seed one public artifact, because the counter's row references it. */
  function seedArtifact(artifactId: string, createdAt: string): void {
    const writer = new DatabaseSync(databasePath, {allowExtension: false});
    try {
      writer.exec(
        `INSERT OR IGNORE INTO projects (id, installation_id, name, created_at)
         VALUES ('${defaultProjectId}', 'local', 'Project', '${createdAt}')`,
      );
      writer.prepare(
        `INSERT INTO artifacts (
           id, project_id, name, search_name, access_setting,
           current_version_id, created_at, deleted_at
         ) VALUES (?, ?, ?, ?, 'public_link', NULL, ?, NULL)`,
      ).run(artifactId, defaultProjectId, artifactId, artifactId, createdAt);
    } finally {
      writer.close();
    }
  }

  /** Stored counter rows, read through a second connection to the same file. */
  function storedRows(artifactIds: readonly string[]): readonly z.infer<
    typeof storedRowSchema
  >[] {
    if (artifactIds.length === 0) return [];
    const reader = new DatabaseSync(databasePath, {
      allowExtension: false,
      readOnly: true,
    });
    try {
      const placeholders = artifactIds.map(() => "?").join(", ");
      return z.array(storedRowSchema).parse(reader.prepare(
        `SELECT artifact_id, day, count FROM artifact_views
         WHERE artifact_id IN (${placeholders})
         ORDER BY artifact_id, day`,
      ).all(...artifactIds));
    } finally {
      reader.close();
    }
  }

  test("repeated views coalesce into one row, and a clock crossing midnight opens a second", async () => {
    const clock = movableClock(new Date("2026-10-17T23:59:59.500Z"));
    const recorder = createArtifactViewRecorder({
      chunkSize: defaultArtifactViewDrainChunkSize,
      clock,
      repository,
    });
    seedArtifact("art_one", "2026-10-17T00:00:00.000Z");

    recorder.record("art_one");
    recorder.record("art_one");
    recorder.record("art_one");
    clock.instant = new Date("2026-10-18T00:00:00.100Z");
    recorder.record("art_one");

    // Nothing reaches storage before a drain, so the buffer is the only state.
    expect(recorder.pending()).toBe(2);
    expect(await recorder.flush()).toEqual({failedChunks: 0, writtenRows: 2});
    expect(recorder.pending()).toBe(0);
    expect(storedRows(["art_one"])).toEqual([
      {artifact_id: "art_one", count: 3, day: "2026-10-17"},
      {artifact_id: "art_one", count: 1, day: "2026-10-18"},
    ]);
  });

  test("a burst larger than one chunk lands every row exactly once", async () => {
    const clock = movableClock(new Date("2026-10-17T08:00:00.000Z"));
    const chunkSize = 4;
    const artifactCount = chunkSize * 3 + 1;
    const recorder = createArtifactViewRecorder({
      chunkSize,
      clock,
      repository,
    });
    const artifactIds = Array.from(
      {length: artifactCount},
      (_unused, index) => `art_${index}`,
    );
    for (const artifactId of artifactIds) {
      seedArtifact(artifactId, "2026-10-17T00:00:00.000Z");
      recorder.record(artifactId);
      recorder.record(artifactId);
    }

    expect(await recorder.flush()).toEqual({
      failedChunks: 0,
      writtenRows: artifactCount,
    });
    const rows = storedRows(artifactIds);
    expect(rows).toHaveLength(artifactCount);
    expect(rows.every((row) => row.count === 2)).toBe(true);

    // A drain of an empty buffer writes nothing and adds no count.
    expect(await recorder.flush()).toEqual({
      failedChunks: 0,
      writtenRows: 0,
    });
    expect(storedRows(artifactIds).filter((row) => row.count !== 2))
      .toEqual([]);
  });

  test("a view recorded while a drain is in flight lands in the next drain", async () => {
    const clock = movableClock(new Date("2026-10-17T08:00:00.000Z"));
    const recorder = createArtifactViewRecorder({
      chunkSize: defaultArtifactViewDrainChunkSize,
      clock,
      repository,
    });
    seedArtifact("art_one", "2026-10-17T00:00:00.000Z");
    seedArtifact("art_two", "2026-10-17T00:00:00.000Z");
    recorder.record("art_one");

    const inFlight = recorder.flush();
    recorder.record("art_two");
    expect(await inFlight).toEqual({failedChunks: 0, writtenRows: 1});
    expect(storedRows(["art_two"])).toEqual([]);

    expect(await recorder.flush()).toEqual({failedChunks: 0, writtenRows: 1});
    expect(storedRows(["art_one", "art_two"])).toEqual([
      {artifact_id: "art_one", count: 1, day: "2026-10-17"},
      {artifact_id: "art_two", count: 1, day: "2026-10-17"},
    ]);
  });

  test("a chunk the repository rejects is dropped once, never retried", async () => {
    const clock = movableClock(new Date("2026-10-17T08:00:00.000Z"));
    // A repository that rejects the first write and serves the real one
    // afterwards, so a retry would be visible as a duplicate row.
    let remainingRejections = 1;
    const failingOnceRepository = {
      recordArtifactViews: (deltas: readonly ArtifactViewDelta[]) => {
        if (remainingRejections > 0) {
          remainingRejections -= 1;
          return Promise.reject(new ArtifactRepositoryFailure({
            cause: new Error("SQLite is briefly unavailable"),
            operation: "recordArtifactViews",
          }));
        }
        return repository.recordArtifactViews(deltas);
      },
    };
    const recorder = createArtifactViewRecorder({
      chunkSize: defaultArtifactViewDrainChunkSize,
      clock,
      repository: failingOnceRepository,
    });
    seedArtifact("art_one", "2026-10-17T00:00:00.000Z");
    seedArtifact("art_two", "2026-10-17T00:00:00.000Z");
    recorder.record("art_one");

    expect(recorder.pending()).toBe(1);
    expect(await recorder.flush()).toEqual({
      failedChunks: 1,
      writtenRows: 0,
    });
    // The failed drain emptied the buffer: the counts are lost on purpose,
    // not parked for a later drain that might never succeed.
    expect(recorder.pending()).toBe(0);
    expect(storedRows(["art_one"])).toEqual([]);

    // A later flush carries only fresh views, and the dropped chunk's day
    // row never reaches the repository that now succeeds.
    recorder.record("art_two");
    expect(await recorder.flush()).toEqual({failedChunks: 0, writtenRows: 1});
    expect(storedRows(["art_one", "art_two"])).toEqual([
      {artifact_id: "art_two", count: 1, day: "2026-10-17"},
    ]);
  });

  test("every rejected chunk is reported, and an empty later drain writes nothing", async () => {
    const clock = movableClock(new Date("2026-10-17T08:00:00.000Z"));
    const recorder = createArtifactViewRecorder({
      chunkSize: 2,
      clock,
      repository: {
        recordArtifactViews: () =>
          Promise.reject(new ArtifactRepositoryFailure({
            cause: new Error("SQLite is unavailable"),
            operation: "recordArtifactViews",
          })),
      },
    });
    // Three deltas at a chunk size of two span two chunks, both hopeless.
    for (const artifactId of ["art_a", "art_b", "art_c"]) {
      recorder.record(artifactId);
    }

    expect(await recorder.flush()).toEqual({failedChunks: 2, writtenRows: 0});
    expect(recorder.pending()).toBe(0);
    expect(await recorder.flush()).toEqual({
      failedChunks: 0,
      writtenRows: 0,
    });
  });
});

describe("view counts survive a clean shutdown", () => {
  const today = "2026-10-17";
  const todayInstant = new Date(`${today}T09:00:00.000Z`);

  /** A clock whose day the assertion can name. */
  function fixedClock() {
    return {now: () => todayInstant};
  }

  /** Stored rows, read from the installation's database after the server is gone. */
  function storedViewRows(installation: TestInstallation, artifactId: string) {
    const reader = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {allowExtension: false, readOnly: true},
    );
    try {
      return z.array(storedRowSchema).parse(reader.prepare(
        `SELECT artifact_id, day, count FROM artifact_views
         WHERE artifact_id = ? ORDER BY day`,
      ).all(artifactId));
    } finally {
      reader.close();
    }
  }

  test("stopping the server without a manual flush drains the buffered views", async () => {
    const installation = await createTestInstallation();
    // One hour between drains, so only the shutdown close hook could have
    // written the row the assertion below reads.
    const server = await startTestServer(installation, {
      artifactViewCollectionPolicy: {intervalMilliseconds: 3_600_000},
      clock: fixedClock(),
      contentDomain: null,
    });
    try {
      const site = await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Agent console",
        path: "2026/10/agent-console",
      });
      const entryPathUrl = `${server.baseUrl}/2026/10/agent-console/`;
      expect((await fetch(entryPathUrl)).status).toBe(200);
      expect((await fetch(entryPathUrl)).status).toBe(200);

      // No flush here: the normal shutdown is the drain under test.
      await server.stop();
      expect(storedViewRows(installation, site.artifact.id)).toEqual([
        {artifact_id: site.artifact.id, count: 2, day: today},
      ]);
    } finally {
      await removeTestInstallation(installation);
    }
  });
});