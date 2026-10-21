import { Effect, type ManagedRuntime, Result, type Tracer } from "effect";

import type { AgentDispatchService } from "./agent-dispatch.js";
import type { PublishArtifactService } from "./publish-artifact.js";
import type { StagedUploadService } from "./staged-upload.js";
import type { AuthenticationService } from "./authentication.js";
import type { AuthorizationService } from "./authorization.js";
import type { ContentAccessService } from "./content-access.js";
import type { ArtifactCommentService } from "./artifact-comments.js";
import type { ArtifactManagementService } from "./artifact-management.js";
import type { CheckArtifactAssetsService } from "./check-artifact-assets.js";
import type { CompareArtifactService } from "./compare-artifact.js";
import type { InstallationAccessService } from "./installation-access.js";
import type {ProjectManagementService} from "./project-management.js";
import type {ExpiredStagingCleanupService} from "./expired-staging-cleanup.js";
import type {PublicLinkAdministrationService} from
  "./public-link-administration.js";
import type {PublicArtifactCatalogService} from
  "./public-artifact-catalog.js";
import type {ProjectAnalyticsService} from "./project-analytics.js";

/** Application services shared by every Artifact Server entry point. */
export type ApplicationServices =
  | AgentDispatchService
  | ArtifactCommentService
  | ArtifactManagementService
  | AuthenticationService
  | AuthorizationService
  | CheckArtifactAssetsService
  | CompareArtifactService
  | ContentAccessService
  | ExpiredStagingCleanupService
  | InstallationAccessService
  | PublishArtifactService
  | ProjectManagementService
  | ProjectAnalyticsService
  | PublicArtifactCatalogService
  | PublicLinkAdministrationService
  | StagedUploadService;

/** One reusable runtime for an Artifact Server installation. */
export type ApplicationRuntime = ManagedRuntime.ManagedRuntime<
  ApplicationServices,
  never
>;

/** Run an application effect and rethrow only at the protocol adapter boundary. */
export async function runApplicationEffect<A, E>(
  runtime: ApplicationRuntime,
  effect: Effect.Effect<A, E, ApplicationServices>,
  observation?: ApplicationEffectObservation,
): Promise<A> {
  const observed = observation === undefined
    ? effect
    : effect.pipe(
      Effect.annotateLogs({request_id: observation.requestId}),
      Effect.withSpan(observation.spanName, {
        attributes: {"request.id": observation.requestId},
        ...(observation.parent === undefined
          ? {root: true as const}
          : {parent: observation.parent}),
      }),
    );
  const result = await runtime.runPromise(Effect.result(observed));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

/** Request context attached to a root application Effect span. */
export interface ApplicationEffectObservation {
  readonly parent?: Tracer.AnySpan;
  readonly requestId: string;
  readonly spanName: string;
}
