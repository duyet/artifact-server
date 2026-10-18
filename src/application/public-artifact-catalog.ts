import {Context, DateTime, Duration, Effect, Layer} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  ArtifactRepositoryFailure,
  InvalidPagination,
} from "../core/errors.js";
import type {
  ArtifactRepository,
  ArtifactViewRepository,
} from "../core/ports.js";
import type {
  ArtifactViewCounts,
  ArtifactViewDay,
  ArtifactViewTotal,
  PublicArtifactCatalog,
  PublicArtifactSummary,
} from "../core/model.js";

/** Days of history the public catalog reports as its rolling window. */
export const publicCatalogWindowDays = 30;

/** Days of history the public catalog also reports as a shorter window. */
export const publicCatalogRecentDays = 7;

/** Artifacts one public catalog read returns before it reports truncation. */
export const publicCatalogLimit = 500;

/** Values used to read one public catalog. */
export interface ListPublicArtifactCatalogCommand {
  readonly limit: number;
}

/** Repository reads the public catalog needs. */
export interface PublicArtifactCatalogRepository {
  readonly listPublicArtifacts: ArtifactRepository["listPublicArtifacts"];
  readonly readArtifactViewDays: ArtifactViewRepository["readArtifactViewDays"];
  readonly readArtifactViewTotals: ArtifactViewRepository["readArtifactViewTotals"];
}

/** Dependencies and windows for the public artifact catalog. */
export interface PublicArtifactCatalogDependencies {
  readonly clock: ApplicationClock;
  readonly recentDays: number;
  readonly repository: PublicArtifactCatalogRepository;
  readonly windowDays: number;
}

interface PublicArtifactCatalogOperations {
  readonly listCatalog: (
    command: ListPublicArtifactCatalogCommand,
  ) => Effect.Effect<
    PublicArtifactCatalog,
    ArtifactRepositoryFailure | InvalidPagination
  >;
}

/**
 * Reads the live public catalog with its view counts. It returns a flat,
 * newest-first list rather than folders: grouping is display order, and the
 * page that draws the tree owns that order rather than this read.
 */
export class PublicArtifactCatalogService extends Context.Service<
  PublicArtifactCatalogService,
  PublicArtifactCatalogOperations
>()("artifact-server/application/PublicArtifactCatalogService") {
  /** Construct the catalog from deployment-neutral repository ports. */
  static readonly layer = (
    dependencies: PublicArtifactCatalogDependencies,
  ): Layer.Layer<PublicArtifactCatalogService> =>
    Layer.succeed(
      PublicArtifactCatalogService,
      makePublicArtifactCatalogService(dependencies),
    );
}

function makePublicArtifactCatalogService(
  dependencies: PublicArtifactCatalogDependencies,
): PublicArtifactCatalogOperations {
  const listCatalog = Effect.fn("PublicArtifactCatalogService.listCatalog")(
    function*(command: ListPublicArtifactCatalogCommand) {
      if (
        !Number.isSafeInteger(command.limit) ||
        command.limit < 1 ||
        command.limit > publicCatalogLimit
      ) {
        return yield* new InvalidPagination({
          message: "The catalog limit must be an integer from 1 through 500.",
        });
      }
      const now = yield* dependencies.clock.now;
      const summaries = yield* readSummaries(dependencies.repository, command.limit);
      const artifactIds = summaries.map((summary) => summary.id);
      const untilDay = dayOf(now);
      const sinceDay = dayOf(
        DateTime.subtractDuration(now, Duration.days(dependencies.windowDays - 1)),
      );
      const recentSinceDay = dayOf(
        DateTime.subtractDuration(now, Duration.days(dependencies.recentDays - 1)),
      );
      const [days, totals] = yield* readCounts(
        dependencies.repository,
        artifactIds,
        sinceDay,
        untilDay,
      );
      return {
        artifacts: summaries.map((artifact) => {
          const series = days.filter((day) => day.artifactId === artifact.id);
          const total = totals.find(
            (row) => row.artifactId === artifact.id,
          );
          return {
            artifact,
            series,
            views: countViews(series, total, recentSinceDay),
          };
        }),
        generatedAt: DateTime.formatIso(now),
        // An exactly-full read is treated as possibly capped. Reporting
        // truncation one artifact early costs a line of prose; reporting a
        // partial list as complete costs the reader a missing artifact.
        truncated: summaries.length === command.limit,
        windowDays: dependencies.windowDays,
      } satisfies PublicArtifactCatalog;
    },
  );

  return {listCatalog};
}

function readSummaries(
  repository: PublicArtifactCatalogRepository,
  limit: number,
): Effect.Effect<
  readonly PublicArtifactSummary[],
  ArtifactRepositoryFailure
> {
  return Effect.tryPromise({
    catch: (cause) => repositoryFailure("listPublicArtifacts", cause),
    try: () => repository.listPublicArtifacts(limit),
  });
}

function readCounts(
  repository: PublicArtifactCatalogRepository,
  artifactIds: readonly string[],
  sinceDay: string,
  untilDay: string,
): Effect.Effect<
  [readonly ArtifactViewDay[], readonly ArtifactViewTotal[]],
  ArtifactRepositoryFailure
> {
  // The window is read in one pass. An empty catalog reads nothing, so an
  // installation with no public artifacts issues no view queries at all.
  return Effect.gen(function*() {
    if (artifactIds.length === 0) return [[], []] as const;
    const days = yield* Effect.tryPromise({
      catch: (cause) => repositoryFailure("readArtifactViewDays", cause),
      try: () => repository.readArtifactViewDays({
        artifactIds,
        sinceDay,
        untilDay,
      }),
    });
    const totals = yield* Effect.tryPromise({
      catch: (cause) => repositoryFailure("readArtifactViewTotals", cause),
      try: () => repository.readArtifactViewTotals(artifactIds),
    });
    return [days, totals] as const;
  });
}

export function countViews(
  series: readonly ArtifactViewDay[],
  total: ArtifactViewTotal | undefined,
  recentSinceDay: string,
): ArtifactViewCounts {
  const counts = {last7Days: 0, last30Days: 0, total: total?.count ?? 0};
  for (const day of series) {
    counts.last30Days += day.count;
    if (day.day >= recentSinceDay) counts.last7Days += day.count;
  }
  return counts;
}

/** The UTC calendar day an application instant belongs to, as stored. */
export function dayOf(instant: DateTime.Utc): string {
  return DateTime.formatIso(instant).slice(0, 10);
}

function repositoryFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): ArtifactRepositoryFailure {
  return new ArtifactRepositoryFailure({cause, operation});
}