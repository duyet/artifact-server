import {Effect} from "effect";

import {
  ArtifactManagementService,
  type ReadArtifactCommand,
} from "./artifact-management.js";
import {artifactVisibility, type ArtifactVisibility} from "./artifact-tags.js";
import {AuthorizationService} from "./authorization.js";
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
