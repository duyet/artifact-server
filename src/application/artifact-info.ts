import {Effect} from "effect";

import {
  ArtifactManagementService,
  type ReadArtifactCommand,
} from "./artifact-management.js";
import {artifactVisibility, type ArtifactVisibility} from "./artifact-tags.js";
import {AuthorizationService} from "./authorization.js";
import {ContentAccessService} from "./content-access.js";
import {
  type ArtifactActivityReport,
  ProjectAnalyticsService,
} from "./project-analytics.js";
import type {ArtifactRecord, VersionRecord} from "../core/model.js";

/** What the viewer's info popover shows about one artifact. */
export interface ArtifactInfo {
  readonly activity: ArtifactActivityReport;
  readonly artifact: ArtifactRecord;
  /** Whether the reader may change the artifact's visibility. */
  readonly canManage: boolean;
  readonly current: VersionRecord;
  readonly visibility: ArtifactVisibility;
}

/**
 * Read one artifact, its current version, and its views for a reader who may
 * read the artifact, and say whether that reader may change its visibility.
 */
export const readArtifactInfo = Effect.fn("readArtifactInfo")(
  function*(command: ReadArtifactCommand) {
    const management = yield* ArtifactManagementService;
    const analytics = yield* ProjectAnalyticsService;
    const authorization = yield* AuthorizationService;
    const details = yield* management.getArtifact(command);
    const activity = yield* analytics.readArtifactActivity({
      artifactId: details.artifact.id,
      principal: command.principal,
      projectId: details.artifact.projectId,
    });
    const info: ArtifactInfo = {
      activity,
      artifact: details.artifact,
      canManage: authorization.canManageArtifact(
        command.principal,
        details.artifact,
      ),
      current: details.current.version,
      visibility: artifactVisibility(details.artifact),
    };
    return info;
  },
);

/** The artifact a readable URL names: a folder's artifact ID, or path candidates. */
export type ReadableArtifactTarget =
  | {readonly artifactId: string; readonly kind: "folder"}
  | {readonly candidates: readonly string[]; readonly kind: "path"};

/**
 * Read the public-link artifact a readable URL serves, for a reader with no
 * credential, who may never manage it. Null when no live public-link artifact
 * answers there, so a private artifact reads the same as a missing one.
 */
export const readPublicArtifactInfo = Effect.fn("readPublicArtifactInfo")(
  function*(target: ReadableArtifactTarget) {
    const content = yield* ContentAccessService;
    const analytics = yield* ProjectAnalyticsService;
    const published = yield* (target.kind === "folder"
      ? content.resolvePublicArtifact(target.artifactId)
      : content.resolvePublicArtifactPath(target.candidates).pipe(
        Effect.map((resolved) => resolved?.current ?? null),
      )
    ).pipe(
      Effect.catchTags({
        ArtifactNotFound: () => Effect.succeed(null),
        ContentSessionRequired: () => Effect.succeed(null),
      }),
    );
    if (published === null) return null;
    const activity = yield* analytics.readPublicArtifactActivity(published.artifact);
    const info: ArtifactInfo = {
      activity,
      artifact: published.artifact,
      canManage: false,
      current: published.version,
      visibility: artifactVisibility(published.artifact),
    };
    return info;
  },
);
