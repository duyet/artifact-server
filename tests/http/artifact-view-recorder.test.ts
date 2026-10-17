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
import {defaultProjectId} from "../../src/core/model.js";

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
});