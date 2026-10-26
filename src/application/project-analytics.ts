import {Context, DateTime, Duration, Effect, Layer} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {countViews, dayOf} from "./public-artifact-catalog.js";
import {
  ArtifactNotFound,
  ArtifactRepositoryFailure,
  type AuthorizationDenied,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import {
  accessSettings,
  type ArtifactRecord,
  type ArtifactViewCounts,
  type ArtifactViewDay,
  type ArtifactViewTotal,
  type DayCount,
  type ProjectActivityDays,
  type ProjectActivityTotals,
  type ViewedArtifact,
} from "../core/model.js";
import type {
  ArtifactViewRepository,
  ProjectActivityRepository,
} from "../core/ports.js";

/** Days of history a project's activity report covers. */
export const projectActivityWindowDays = 365;

/** Days of history one artifact's view report covers. */
export const artifactActivityWindowDays = 30;

/** Days the shorter artifact view count covers. */
const artifactRecentDays = 7;

/** Artifacts a project's activity report ranks by recent views. */
export const mostViewedArtifactLimit = 10;

/** One project's uploads and views on one UTC day. */
export interface ProjectActivityDay {
  readonly day: string;
  readonly uploads: number;
  readonly views: number;
}

/** One ranked artifact in a project's activity report. */
export interface MostViewedArtifact {
  readonly artifactId: string;
  readonly name: string;
  readonly total: number;
  readonly views30d: number;
}

/** A project's activity: totals, a sparse daily series, and its most viewed. */
export interface ProjectActivityReport {
  readonly daily: readonly ProjectActivityDay[];
  readonly generatedAt: string;
  readonly today: string;
  readonly topArtifacts: readonly MostViewedArtifact[];
  readonly totals: {
    readonly artifacts: number;
    readonly artifactsViewedToday: number;
    /** Views per live artifact, rounded to one decimal place. */
    readonly averageViewsPerArtifact: number;
    readonly pageViews: number;
    readonly publicArtifacts: number;
    readonly uploadedToday: number;
    readonly uploads: number;
  };
  readonly windowDays: number;
}

/** One artifact's view counts and its sparse daily series. */
export interface ArtifactActivityReport {
  readonly artifactId: string;
  readonly daily: readonly {readonly day: string; readonly views: number}[];
  readonly today: string;
  readonly views: ArtifactViewCounts;
  readonly windowDays: number;
}

/** Input for reading one project's activity. */
export interface ReadProjectActivityCommand {
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for reading one artifact's activity. */
export interface ReadArtifactActivityCommand extends ReadProjectActivityCommand {
  readonly artifactId: string;
}

/** Repository reads the activity reports need. */
export interface ProjectAnalyticsRepository {
  readonly findArtifact: (
    projectId: string,
    artifactId: string,
  ) => Promise<ArtifactRecord | null>;
  readonly readArtifactViewDays: ArtifactViewRepository["readArtifactViewDays"];
  readonly readArtifactViewTotals: ArtifactViewRepository["readArtifactViewTotals"];
  readonly readMostViewedArtifacts: ProjectActivityRepository["readMostViewedArtifacts"];
  readonly readProjectActivityDays: ProjectActivityRepository["readProjectActivityDays"];
  readonly readProjectActivityTotals: ProjectActivityRepository["readProjectActivityTotals"];
}

/** Dependencies for the activity reports. */
export interface ProjectAnalyticsDependencies {
  readonly clock: ApplicationClock;
  readonly repository: ProjectAnalyticsRepository;
}

/** Expected failures produced by the activity reports. */
export type ProjectAnalyticsFailure =
  | ArtifactNotFound
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | ProjectManagementFailure;

interface ProjectAnalyticsOperations {
  readonly readArtifactActivity: (
    command: ReadArtifactActivityCommand,
  ) => Effect.Effect<ArtifactActivityReport, ProjectAnalyticsFailure>;
  readonly readProjectActivity: (
    command: ReadProjectActivityCommand,
  ) => Effect.Effect<ProjectActivityReport, ProjectAnalyticsFailure>;
  /**
   * One public-link artifact's views, for a reader with no credential. Any
   * other artifact is not found, so the read never confirms that one exists.
   */
  readonly readPublicArtifactActivity: (
    artifact: ArtifactRecord,
  ) => Effect.Effect<
    ArtifactActivityReport,
    ArtifactNotFound | ArtifactRepositoryFailure
  >;
}

/**
 * Read-only activity reports built from versions and stored view rows. Nothing
 * here writes; every count comes from tables other features already keep.
 */
export class ProjectAnalyticsService extends Context.Service<
  ProjectAnalyticsService,
  ProjectAnalyticsOperations
>()("artifact-server/application/ProjectAnalyticsService") {
  /** Construct the reports from deployment-neutral repository ports. */
  static readonly layer = (
    dependencies: ProjectAnalyticsDependencies,
  ): Layer.Layer<
    ProjectAnalyticsService,
    never,
    AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      ProjectAnalyticsService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        return makeProjectAnalyticsService(dependencies, authorization, projects);
      }),
    );
}

function makeProjectAnalyticsService(
  dependencies: ProjectAnalyticsDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): ProjectAnalyticsOperations {
  const resolveProject = Effect.fn("ProjectAnalyticsService.resolveProject")(
    function*(principal: Principal, projectId: string | null) {
      return projectId === null
        ? yield* projects.resolveActiveProject({principal, projectId})
        : yield* projects.getProject({principal, projectId});
    },
  );

  const readProjectActivity = Effect.fn(
    "ProjectAnalyticsService.readProjectActivity",
  )(function*(command: ReadProjectActivityCommand) {
    yield* authorization.requireArtifactListing(command.principal);
    const project = yield* resolveProject(command.principal, command.projectId);
    const now = yield* dependencies.clock.now;
    const today = dayOf(now);
    const window = {
      projectId: project.id,
      sinceDay: daysBefore(now, projectActivityWindowDays),
      untilDay: today,
    };
    const [totals, days, viewed] = yield* Effect.all([
      read("readProjectActivityTotals", () =>
        dependencies.repository.readProjectActivityTotals(project.id, today)),
      read("readProjectActivityDays", () =>
        dependencies.repository.readProjectActivityDays(window)),
      read("readMostViewedArtifacts", () =>
        dependencies.repository.readMostViewedArtifacts({
          limit: mostViewedArtifactLimit,
          projectId: project.id,
          sinceDay: daysBefore(now, artifactActivityWindowDays),
          untilDay: today,
        })),
    ], {concurrency: 3});
    return buildProjectActivityReport({
      days,
      generatedAt: DateTime.formatIso(now),
      today,
      totals,
      viewed,
    });
  });

  const readArtifactActivity = Effect.fn(
    "ProjectAnalyticsService.readArtifactActivity",
  )(function*(command: ReadArtifactActivityCommand) {
    const project = yield* resolveProject(command.principal, command.projectId);
    const artifact = yield* read("findArtifact", () =>
      dependencies.repository.findArtifact(project.id, command.artifactId));
    if (artifact === null) {
      return yield* new ArtifactNotFound({message: "The artifact does not exist."});
    }
    yield* authorization.requireArtifactRead(command.principal);
    return yield* readViews(artifact.id);
  });

  const readPublicArtifactActivity = Effect.fn(
    "ProjectAnalyticsService.readPublicArtifactActivity",
  )(function*(artifact: ArtifactRecord) {
    if (artifact.accessSetting !== accessSettings.publicLink) {
      return yield* new ArtifactNotFound({message: "The artifact does not exist."});
    }
    return yield* readViews(artifact.id);
  });

  const readViews = Effect.fn("ProjectAnalyticsService.readViews")(
    function*(artifactId: string) {
      const now = yield* dependencies.clock.now;
      const today = dayOf(now);
      const [days, totals] = yield* Effect.all([
        read("readArtifactViewDays", () =>
          dependencies.repository.readArtifactViewDays({
            artifactIds: [artifactId],
            sinceDay: daysBefore(now, artifactActivityWindowDays),
            untilDay: today,
          })),
        read("readArtifactViewTotals", () =>
          dependencies.repository.readArtifactViewTotals([artifactId])),
      ], {concurrency: 2});
      return buildArtifactActivityReport({
        artifactId,
        days,
        today,
        totals,
        recentSinceDay: daysBefore(now, artifactRecentDays),
      });
    },
  );

  return ProjectAnalyticsService.of({
    readArtifactActivity,
    readProjectActivity,
    readPublicArtifactActivity,
  });
}

function read<Result>(
  operation: ArtifactRepositoryFailure["operation"],
  run: () => Promise<Result>,
): Effect.Effect<Result, ArtifactRepositoryFailure> {
  return Effect.tryPromise({
    catch: (cause) => new ArtifactRepositoryFailure({cause, operation}),
    try: run,
  });
}

/** The first day of a window of `days` days that ends on the day of `now`. */
function daysBefore(now: DateTime.Utc, days: number): string {
  return dayOf(DateTime.subtractDuration(now, Duration.days(days - 1)));
}

/** Combine a project's stored aggregates into its activity report. */
export function buildProjectActivityReport(facts: {
  readonly days: ProjectActivityDays;
  readonly generatedAt: string;
  readonly today: string;
  readonly totals: ProjectActivityTotals;
  readonly viewed: readonly ViewedArtifact[];
}): ProjectActivityReport {
  const daily = new Map<string, {uploads: number; views: number}>();
  const dayOfSeries = (day: string) => {
    const existing = daily.get(day);
    if (existing !== undefined) return existing;
    const created = {uploads: 0, views: 0};
    daily.set(day, created);
    return created;
  };
  for (const {count, day} of facts.days.uploads) dayOfSeries(day).uploads += count;
  for (const {count, day} of facts.days.views) dayOfSeries(day).views += count;
  const {artifacts, pageViews} = facts.totals;
  return {
    daily: [...daily]
      .filter(([, counts]) => counts.uploads > 0 || counts.views > 0)
      .map(([day, counts]) => ({
        day,
        uploads: counts.uploads,
        views: counts.views,
      }))
      .toSorted((left, right) => left.day.localeCompare(right.day)),
    generatedAt: facts.generatedAt,
    today: facts.today,
    topArtifacts: facts.viewed.map((artifact) => ({
      artifactId: artifact.artifactId,
      name: artifact.name,
      total: artifact.totalViews,
      views30d: artifact.windowViews,
    })),
    totals: {
      artifacts,
      artifactsViewedToday: facts.totals.artifactsViewedOnDay,
      averageViewsPerArtifact: artifacts === 0
        ? 0
        : Math.round((pageViews / artifacts) * 10) / 10,
      pageViews,
      publicArtifacts: facts.totals.publicArtifacts,
      uploadedToday: countOn(facts.days.uploads, facts.today),
      uploads: facts.totals.uploads,
    },
    windowDays: projectActivityWindowDays,
  };
}

/** Combine one artifact's stored view rows into its activity report. */
export function buildArtifactActivityReport(facts: {
  readonly artifactId: string;
  readonly days: readonly ArtifactViewDay[];
  readonly recentSinceDay: string;
  readonly today: string;
  readonly totals: readonly ArtifactViewTotal[];
}): ArtifactActivityReport {
  return {
    artifactId: facts.artifactId,
    daily: facts.days
      .filter((day) => day.count > 0)
      .map((day) => ({day: day.day, views: day.count})),
    today: facts.today,
    views: countViews(facts.days, facts.totals[0], facts.recentSinceDay),
    windowDays: artifactActivityWindowDays,
  };
}

function countOn(days: readonly DayCount[], day: string): number {
  return days.find((candidate) => candidate.day === day)?.count ?? 0;
}
