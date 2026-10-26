import {Context, DateTime, Duration, Effect, Layer} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  ArtifactRepositoryFailure,
  type AuthorizationDenied,
  InvalidPagination,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import type {
  ArtifactRepository,
  ArtifactViewRepository,
  CollapsedFolderRepository,
} from "../core/ports.js";
import type {
  ArtifactViewCounts,
  ArtifactViewDay,
  ArtifactViewTotal,
  FolderDefaultState,
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

/** Values used to store how one folder of the public tree starts. */
export interface SetFolderDefaultStateCommand {
  /** A path already normalized by `parseArtifactPath`. */
  readonly path: string;
  readonly principal: Principal;
  readonly state: FolderDefaultState;
}

/** Repository reads and writes the public catalog needs. */
export interface PublicArtifactCatalogRepository {
  readonly listCollapsedFolders: CollapsedFolderRepository["listCollapsedFolders"];
  readonly listPublicArtifacts: ArtifactRepository["listPublicArtifacts"];
  readonly readArtifactViewDays: ArtifactViewRepository["readArtifactViewDays"];
  readonly readArtifactViewTotals: ArtifactViewRepository["readArtifactViewTotals"];
  readonly setFolderDefaultState: CollapsedFolderRepository["setFolderDefaultState"];
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
  readonly setFolderDefaultState: (
    command: SetFolderDefaultStateCommand,
  ) => Effect.Effect<void, ArtifactRepositoryFailure | AuthorizationDenied>;
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
  ): Layer.Layer<PublicArtifactCatalogService, never, AuthorizationService> =>
    Layer.effect(
      PublicArtifactCatalogService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makePublicArtifactCatalogService(dependencies, authorization);
      }),
    );
}

function makePublicArtifactCatalogService(
  dependencies: PublicArtifactCatalogDependencies,
  authorization: AuthorizationOperations,
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
      const collapsed = yield* Effect.tryPromise({
        catch: (cause) => repositoryFailure("listCollapsedFolders", cause),
        try: () => dependencies.repository.listCollapsedFolders(),
      });
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
        collapsedFolders: revealedFolders(collapsed, summaries),
        generatedAt: DateTime.formatIso(now),
        // An exactly-full read is treated as possibly capped. Reporting
        // truncation one artifact early costs a line of prose; reporting a
        // partial list as complete costs the reader a missing artifact.
        truncated: summaries.length === command.limit,
        windowDays: dependencies.windowDays,
      } satisfies PublicArtifactCatalog;
    },
  );

  // Folders are not owned by anyone, so the gate is the one that guards
  // every artifact setting. Whoever may tag an artifact unlisted can already
  // hide it from the tree, which is more than collapsing its folder does.
  const setFolderDefaultState = Effect.fn(
    "PublicArtifactCatalogService.setFolderDefaultState",
  )(function*(command: SetFolderDefaultStateCommand) {
    yield* authorization.requireArtifactManagement(command.principal);
    yield* Effect.tryPromise({
      catch: (cause) => repositoryFailure("setFolderDefaultState", cause),
      try: () => dependencies.repository.setFolderDefaultState(
        command.path,
        command.state,
      ),
    });
  });

  return {listCatalog, setFolderDefaultState};
}

/**
 * The collapsed folders the listed artifacts already reveal: a folder is
 * named only when a listed path is that folder or sits inside it. An
 * anonymous reader never learns a folder that holds only private or unlisted
 * artifacts.
 */
function revealedFolders(
  collapsed: readonly string[],
  artifacts: readonly PublicArtifactSummary[],
): readonly string[] {
  const paths = artifacts.flatMap((artifact) =>
    artifact.path === null ? [] : [artifact.path]
  );
  return collapsed
    .filter((folder) =>
      paths.some((path) => path === folder || path.startsWith(`${folder}/`))
    )
    .toSorted();
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