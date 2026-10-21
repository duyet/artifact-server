import { Context, Effect, Layer } from "effect";

import {
  type ArtifactManagementFailure,
  ArtifactManagementService,
} from "./artifact-management.js";
import {
  type AssetCheckReport,
  checkAssetReferences,
  planAssetSources,
  scanAssetSource,
} from "../asset-check/check-asset-references.js";
import type { BlobStorageFailure } from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import type {
  ArtifactRecord,
  ManifestEntry,
  VersionRecord,
} from "../core/model.js";

/** Input for checking one saved version's file references. */
export interface CheckArtifactAssetsCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  /**
   * The URL paths that serve this version on one origin. Serving layout is a
   * deployment concern, so the protocol adapter supplies it.
   */
  readonly servedRoots: (
    artifact: ArtifactRecord,
    version: VersionRecord,
  ) => readonly [string, ...string[]];
  /** The version to check; null checks the current version. */
  readonly versionId: string | null;
}

/** One version's asset check together with the records it was taken from. */
export interface ArtifactAssetCheck {
  readonly artifact: ArtifactRecord;
  readonly report: AssetCheckReport;
  readonly version: VersionRecord;
}

/** Immutable byte reads required to scan HTML, CSS, and JavaScript files. */
export interface AssetCheckBlobStorage {
  readonly readBytes: (
    entry: ManifestEntry,
  ) => Effect.Effect<Uint8Array, BlobStorageFailure>;
}

/** Expected failures produced by an asset check. */
export type CheckArtifactAssetsFailure =
  | ArtifactManagementFailure
  | BlobStorageFailure;

interface CheckArtifactAssetsOperations {
  readonly checkVersion: (
    command: CheckArtifactAssetsCommand,
  ) => Effect.Effect<ArtifactAssetCheck, CheckArtifactAssetsFailure>;
}

/** Finds references in a saved version that its own files do not satisfy. */
export class CheckArtifactAssetsService extends Context.Service<
  CheckArtifactAssetsService,
  CheckArtifactAssetsOperations
>()("artifact-server/application/CheckArtifactAssetsService") {
  /** Construct asset checks over the read policy of artifact management. */
  static readonly layer = (
    blobs: AssetCheckBlobStorage,
  ): Layer.Layer<
    CheckArtifactAssetsService,
    never,
    ArtifactManagementService
  > =>
    Layer.effect(
      CheckArtifactAssetsService,
      Effect.gen(function*() {
        const management = yield* ArtifactManagementService;
        const checkVersion = Effect.fn("CheckArtifactAssetsService.checkVersion")(
          function*(command: CheckArtifactAssetsCommand) {
            const read = {
              artifactId: command.artifactId,
              principal: command.principal,
              projectId: command.projectId,
            };
            const {artifact, saved} = command.versionId === null
              ? yield* management.getArtifact(read).pipe(
                Effect.map((details) => ({artifact: details.artifact, saved: details.current})),
              )
              : yield* management.getVersionDetails({...read, versionId: command.versionId});
            const plan = planAssetSources(saved.manifest.entries);
            const decoder = new TextDecoder("utf-8");
            // Each file is scanned as its read completes, so other requests run
            // between files and one scan blocks only for its own bounded size.
            const sources = yield* Effect.forEach(
              plan.sources,
              (source) =>
                blobs.readBytes(source.entry).pipe(Effect.map((bytes) =>
                  scanAssetSource({
                    language: source.language,
                    path: source.entry.path,
                    text: decoder.decode(bytes),
                  })
                )),
              {concurrency: 4},
            );
            const report = checkAssetReferences({
              entryPath: saved.version.entryPath,
              manifestPaths: saved.manifest.entries.map((entry) => entry.path),
              routingMode: saved.version.routingMode,
              servedRoots: command.servedRoots(artifact, saved.version),
              sources,
              truncated: plan.truncated,
            });
            return {artifact, report, version: saved.version};
          },
        );
        return CheckArtifactAssetsService.of({checkVersion});
      }),
    );
}
