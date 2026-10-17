import type {Clock} from "../core/ports.js";
import type {
  ArtifactViewDelta,
  ArtifactViewRepository,
} from "../core/ports.js";

/**
 * Rows one drain writes in one transaction. SQLite binds a parameter per
 * column value, and `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds, so a
 * chunk stays well under it on every build.
 */
export const defaultArtifactViewDrainChunkSize = 500;

/** What one drain of the view buffer achieved. */
export interface ArtifactViewDrainReport {
  /** Chunks whose write failed. Their counts are dropped, not retried. */
  readonly failedChunks: number;
  /** Rows the database accepted. */
  readonly writtenRows: number;
}

/** Dependencies for the buffered view counter. */
export interface ArtifactViewRecorderDependencies {
  readonly clock: Clock;
  readonly chunkSize: number;
  readonly repository: Pick<
    ArtifactViewRepository,
    "recordArtifactViews"
  >;
}

/** A process-local counter that drains to storage in the background. */
export interface ArtifactViewRecorder {
  /**
   * Count one served entry document. Synchronous and total: the content
   * response never waits, and a full buffer never rejects the request.
   */
  record(artifactId: string): void;
  /** How many coalesced deltas are waiting for a drain. */
  pending(): number;
  /** Write everything pending in bounded chunks. Never rejects. */
  flush(): Promise<ArtifactViewDrainReport>;
}

class BufferedArtifactViewRecorder implements ArtifactViewRecorder {
  readonly #chunkSize: number;
  readonly #clock: Clock;
  readonly #pending = new Map<string, ArtifactViewDelta>();
  readonly #repository: ArtifactViewRecorderDependencies["repository"];

  constructor(dependencies: ArtifactViewRecorderDependencies) {
    this.#chunkSize = dependencies.chunkSize;
    this.#clock = dependencies.clock;
    this.#repository = dependencies.repository;
  }

  record(artifactId: string): void {
    const day = dayOfDate(this.#clock.now());
    // Neither an artifact ID nor a calendar day can hold a NUL, so this key
    // cannot be ambiguous the way a plain space or a slash would be.
    const key = `${artifactId}\u0000${day}`;
    const existing = this.#pending.get(key);
    if (existing === undefined) {
      this.#pending.set(key, {artifactId, count: 1, day});
      return;
    }
    this.#pending.set(key, {...existing, count: existing.count + 1});
  }

  pending(): number {
    return this.#pending.size;
  }

  async flush(): Promise<ArtifactViewDrainReport> {
    // The buffer is swapped synchronously, so a record that arrives while the
    // chunks are in flight lands in the fresh map and drains on the next pass.
    const batch = [...this.#pending.values()];
    this.#pending.clear();
    const chunks: ArtifactViewDelta[][] = [];
    for (let index = 0; index < batch.length; index += this.#chunkSize) {
      chunks.push(batch.slice(index, index + this.#chunkSize));
    }
    // Chunks drain one after another, never together: each one is its own
    // transaction, and SQLite has one writer. `reduce` over a resolved promise
    // is how that sequence is written without a bare `await` in a loop.
    return chunks.reduce(
      (previous: Promise<ArtifactViewDrainReport>, chunk) =>
        previous.then(async (settled: ArtifactViewDrainReport) => {
          try {
            await this.#repository.recordArtifactViews(chunk);
            return {
              failedChunks: settled.failedChunks,
              writtenRows: settled.writtenRows + chunk.length,
            };
          } catch {
            // A counter is not worth failing a drain over, and retrying a
            // chunk that keeps failing would grow the buffer without bound.
            // The lost counts are bounded by one drain interval.
            return {
              failedChunks: settled.failedChunks + 1,
              writtenRows: settled.writtenRows,
            };
          }
        }),
      Promise.resolve<ArtifactViewDrainReport>({
        failedChunks: 0,
        writtenRows: 0,
      }),
    );
  }
}

/** The UTC calendar day a served view is counted on, as stored. */
export function dayOfDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** Create the buffered counter the content path calls synchronously. */
export function createArtifactViewRecorder(
  dependencies: ArtifactViewRecorderDependencies,
): ArtifactViewRecorder {
  return new BufferedArtifactViewRecorder(dependencies);
}