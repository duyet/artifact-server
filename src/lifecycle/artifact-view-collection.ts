import {Effect, Fiber, Schedule} from "effect";

import type {ApplicationRuntime} from
  "../application/application-runtime.js";
import type {ArtifactViewRecorder} from
  "../application/artifact-view-recorder.js";

/** How often the buffered view counters reach storage. */
export interface ArtifactViewCollectionPolicy {
  readonly intervalMilliseconds: number;
}

/** Five seconds keeps the home page close to live without a write per view. */
export const defaultArtifactViewCollectionPolicy:
  ArtifactViewCollectionPolicy = {
    intervalMilliseconds: 5_000,
  };

/**
 * Start the drain loop and return a close hook that stops it and writes what
 * is still buffered. A clean shutdown therefore loses nothing; an unclean one
 * loses at most one interval of counts.
 */
export function startArtifactViewCollection(
  runtime: ApplicationRuntime,
  recorder: ArtifactViewRecorder,
  policy: ArtifactViewCollectionPolicy,
): () => Promise<void> {
  const drain = drainOnce(recorder);
  const fiber = runtime.runFork(Effect.repeat(
    drain,
    Schedule.spaced(policy.intervalMilliseconds),
  ));
  return async () => {
    await runtime.runPromise(Fiber.interrupt(fiber));
    await runtime.runPromise(drain);
  };
}

function drainOnce(recorder: ArtifactViewRecorder) {
  return Effect.promise(() => recorder.flush()).pipe(
    Effect.tap((report) =>
      report.failedChunks === 0
        ? Effect.void
        : Effect.logWarning("Artifact view drain lost a chunk of counts.")),
  );
}