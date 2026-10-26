import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer } from "effect";

import {
  type AssetQuota,
  acceptedAssetMediaType,
  assetLimitFailure,
} from "../core/asset-policy.js";
import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  type AssetLimitExceeded,
  AssetNotFound,
  AssetTypeUnsupported,
  type AuthorizationDenied,
  type BlobStorageFailure,
  ContentSessionRequired,
  type IdempotencyConflict,
  InvalidManifestFile,
  type InvalidIdempotencyKey,
  StagingStorageFailure,
  UploadClosed,
  UploadExpired,
  UploadIncomplete,
  UploadNotFound,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {
  accessSettings,
  type ArtifactRecord,
  type AssetRecord,
  type AssetUsage,
  type StagedUpload,
  uploadStatuses,
} from "../core/model.js";
import type {
  CommitAsset,
  CommittedAsset,
  IdGenerator,
  ServedAsset,
} from "../core/ports.js";
import type { ApplicationClock } from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import { parseIdempotencyKey } from "./idempotency-key.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import type { PublishBlobStorage } from "./publish-artifact.js";
import {
  type StagedUploadFailure,
  type StagedUploadRepositoryPort,
  StagedUploadService,
  type StagingStoragePort,
} from "./staged-upload.js";

/** Input for planning the upload of one asset. */
export interface CreateAssetUploadCommand {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly name: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly sha256: string;
  readonly size: number;
}

/** Input for turning one uploaded asset plan into an asset. */
export interface CommitAssetUploadCommand {
  readonly artifactId: string;
  readonly idempotencyKey: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly uploadId: string;
}

/** Input for adding another artifact's asset to this one without new bytes. */
export interface CopyAssetCommand {
  readonly artifactId: string;
  readonly idempotencyKey: string;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly sourceArtifactId: string;
  readonly sourceAssetId: string;
}

/** Input naming one artifact, or one asset of it. */
export interface ArtifactAssetCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** One artifact's live assets with its quota and what they use of it. */
export interface ArtifactAssetListing {
  readonly assets: readonly AssetRecord[];
  readonly quota: AssetQuota;
  readonly usage: AssetUsage;
}

/** Asset persistence capabilities, already lifted into Effect. */
export interface ArtifactAssetRepositoryPort {
  commitAsset(command: CommitAsset): Effect.Effect<
    CommittedAsset,
    | ArtifactNotFound
    | AssetLimitExceeded
    | AssetNotFound
    | IdempotencyConflict
    | UploadClosed
    | ArtifactRepositoryFailure
  >;
  deleteAsset(
    projectId: string,
    artifactId: string,
    assetId: string,
    deletedAt: string,
  ): Effect.Effect<AssetRecord, AssetNotFound | ArtifactRepositoryFailure>;
  findArtifact(
    projectId: string,
    artifactId: string,
  ): Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  findIdempotentAsset(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<
    CommittedAsset | null,
    AssetNotFound | IdempotencyConflict | ArtifactRepositoryFailure
  >;
  findServedAsset(
    assetId: string,
  ): Effect.Effect<ServedAsset | null, ArtifactRepositoryFailure>;
  listAssets(
    projectId: string,
    artifactId: string,
  ): Effect.Effect<
    {readonly assets: readonly AssetRecord[]; readonly usage: AssetUsage},
    ArtifactRepositoryFailure
  >;
  readAssetUsage(
    artifactId: string,
  ): Effect.Effect<AssetUsage, ArtifactRepositoryFailure>;
}

/** Dependencies used to construct the asset store service. */
export interface ArtifactAssetDependencies {
  readonly blobs: PublishBlobStorage;
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly quota: AssetQuota;
  readonly repository: ArtifactAssetRepositoryPort;
  readonly staging: StagingStoragePort;
  readonly uploads: StagedUploadRepositoryPort;
}

/** Expected failures produced by the asset store service. */
export type ArtifactAssetFailure =
  | ArtifactNotFound
  | ArtifactRepositoryFailure
  | AssetLimitExceeded
  | AssetNotFound
  | AssetTypeUnsupported
  | AuthorizationDenied
  | BlobStorageFailure
  | ContentSessionRequired
  | IdempotencyConflict
  | InvalidIdempotencyKey
  | InvalidManifestFile
  | ProjectManagementFailure
  | StagedUploadFailure
  | StagingStorageFailure
  | UploadClosed
  | UploadExpired
  | UploadIncomplete
  | UploadNotFound;

interface ArtifactAssetOperations {
  readonly commitUpload: (
    command: CommitAssetUploadCommand,
  ) => Effect.Effect<CommittedAsset, ArtifactAssetFailure>;
  readonly copyAsset: (
    command: CopyAssetCommand,
  ) => Effect.Effect<CommittedAsset, ArtifactAssetFailure>;
  readonly createUpload: (
    command: CreateAssetUploadCommand,
  ) => Effect.Effect<StagedUpload, ArtifactAssetFailure>;
  readonly deleteAsset: (
    command: ArtifactAssetCommand & {readonly assetId: string},
  ) => Effect.Effect<AssetRecord, ArtifactAssetFailure>;
  readonly listAssets: (
    command: ArtifactAssetCommand,
  ) => Effect.Effect<ArtifactAssetListing, ArtifactAssetFailure>;
  readonly resolvePublicAsset: (
    assetId: string,
  ) => Effect.Effect<AssetRecord, ArtifactAssetFailure>;
}

/**
 * Owns the per-artifact asset store: files a page or an agent adds without
 * saving a version. Uploads reuse the staged upload plan and PUT; only the
 * commit differs, because it writes an asset row instead of a version.
 */
export class ArtifactAssetService extends Context.Service<
  ArtifactAssetService,
  ArtifactAssetOperations
>()("artifact-server/application/ArtifactAssetService") {
  /** Construct the asset store over the shared upload, project, and policy services. */
  static readonly layer = (
    dependencies: ArtifactAssetDependencies,
  ): Layer.Layer<
    ArtifactAssetService,
    never,
    AuthorizationService | ProjectManagementService | StagedUploadService
  > =>
    Layer.effect(
      ArtifactAssetService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        const stagedUploads = yield* StagedUploadService;
        return makeArtifactAssetService(
          dependencies,
          authorization,
          projects,
          stagedUploads,
        );
      }),
    );
}

function makeArtifactAssetService(
  dependencies: ArtifactAssetDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
  stagedUploads: StagedUploadService["Service"],
): ArtifactAssetOperations {
  const requireArtifact = Effect.fn("ArtifactAssetService.requireArtifact")(
    function*(projectId: string, artifactId: string) {
      const artifact = yield* dependencies.repository.findArtifact(
        projectId,
        artifactId,
      );
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      return artifact;
    },
  );

  /** The live artifact a write names, once the principal may publish it. */
  const writableArtifact = Effect.fn("ArtifactAssetService.writableArtifact")(
    function*(command: ArtifactAssetCommand) {
      const project = yield* projects.resolveActiveProject({
        principal: command.principal,
        projectId: command.projectId,
      });
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* authorization.requireVersionPublication(command.principal, artifact);
      return artifact;
    },
  );

  const readableArtifact = Effect.fn("ArtifactAssetService.readableArtifact")(
    function*(command: ArtifactAssetCommand) {
      const project = command.projectId === null
        ? yield* projects.resolveActiveProject({
          principal: command.principal,
          projectId: null,
        })
        : yield* projects.getProject({
          principal: command.principal,
          projectId: command.projectId,
        });
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* authorization.requireArtifactRead(command.principal);
      return artifact;
    },
  );

  /** Refuse an asset the allowlist, its type cap, or the quota does not admit. */
  const admit = Effect.fn("ArtifactAssetService.admit")(
    function*(artifact: ArtifactRecord, mediaType: string, size: number) {
      const accepted = acceptedAssetMediaType(mediaType);
      if (accepted instanceof AssetTypeUnsupported) return yield* accepted;
      const usage = yield* dependencies.repository.readAssetUsage(artifact.id);
      const refused = assetLimitFailure(accepted, size, usage, dependencies.quota);
      if (refused !== null) return yield* refused;
      return accepted.mediaType;
    },
  );

  const commit = Effect.fn("ArtifactAssetService.commit")(
    function*(
      artifact: ArtifactRecord,
      principal: Principal,
      idempotencyKey: string,
      inputDigest: string,
      file: {
        readonly mediaType: string;
        readonly name: string;
        readonly sha256: string;
        readonly size: number;
      },
      upload: StagedUpload | null,
    ) {
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.commitAsset({
        asset: {
          artifactId: artifact.id,
          createdAt,
          createdByDisplayName: principal.displayName,
          createdByPrincipalId: principal.id,
          id: dependencies.ids.assetId(),
          mediaType: file.mediaType,
          name: file.name,
          projectId: artifact.projectId,
          sha256: file.sha256,
          size: file.size,
        },
        idempotencyKey,
        inputDigest,
        quota: dependencies.quota,
        upload: upload === null
          ? null
          : {expiresAt: upload.expiresAt, id: upload.id, principalId: upload.principalId},
      });
    },
  );

  const createUpload = Effect.fn("ArtifactAssetService.createUpload")(
    function*(command: CreateAssetUploadCommand) {
      const artifact = yield* writableArtifact(command);
      const mediaType = yield* admit(artifact, command.mediaType, command.size);
      // The name is the plan's one path, so the manifest parser validates it.
      return yield* stagedUploads.createUpload({
        entryPath: command.name,
        files: [{
          mediaType,
          path: command.name,
          sha256: command.sha256,
          size: command.size,
        }],
        principal: command.principal,
        projectId: artifact.projectId,
      });
    },
  );

  const commitUpload = Effect.fn("ArtifactAssetService.commitUpload")(
    function*(command: CommitAssetUploadCommand) {
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const artifact = yield* writableArtifact(command);
      const inputDigest = assetInputDigest({
        artifactId: artifact.id,
        kind: "upload",
        uploadId: command.uploadId,
      });
      const replayed = yield* dependencies.repository.findIdempotentAsset(
        artifact.projectId,
        idempotencyKey,
        inputDigest,
      );
      if (replayed !== null) return replayed;

      const upload = yield* dependencies.uploads.findStagedUpload(
        artifact.projectId,
        command.uploadId,
        command.principal.id,
      );
      if (upload === null) {
        return yield* new UploadNotFound({message: "The staged upload does not exist."});
      }
      if (upload.status !== uploadStatuses.open) {
        return yield* new UploadClosed({message: "The staged upload is already committed."});
      }
      const now = yield* dependencies.clock.now;
      if (DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(upload.expiresAt), now)) {
        return yield* new UploadExpired({message: "The staged upload has expired."});
      }
      const [file, ...others] = upload.files;
      if (file === undefined || others.length > 0) {
        return yield* new InvalidManifestFile({
          message: "An asset upload holds exactly one file.",
        });
      }
      if (file.uploadedAt === null) {
        return yield* new UploadIncomplete({
          message: "The asset bytes must be uploaded before commit.",
        });
      }
      // A plan made for a version skipped the allowlist, so check it again
      // here, before the bytes reach the blob store.
      const mediaType = yield* admit(artifact, file.entry.mediaType, file.entry.size);
      const opened = yield* dependencies.staging.open(upload.id, file.storageToken);
      if (opened.size !== file.entry.size) {
        yield* Effect.tryPromise({
          try: () => opened.body.cancel(),
          catch: (cause) => new StagingStorageFailure({cause, operation: "open"}),
        });
        return yield* new StagingStorageFailure({
          cause: new Error("A verified staged file changed before commit."),
          operation: "open",
        });
      }
      yield* dependencies.blobs.put({
        body: opened.body,
        sha256: file.entry.sha256,
        size: file.entry.size,
      });
      return yield* commit(
        artifact,
        command.principal,
        idempotencyKey,
        inputDigest,
        {
          mediaType,
          name: file.entry.path,
          sha256: file.entry.sha256,
          size: file.entry.size,
        },
        upload,
      );
    },
  );

  const copyAsset = Effect.fn("ArtifactAssetService.copyAsset")(
    function*(command: CopyAssetCommand) {
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const artifact = yield* writableArtifact(command);
      const source = yield* requireArtifact(artifact.projectId, command.sourceArtifactId);
      yield* authorization.requireArtifactRead(command.principal);
      const inputDigest = assetInputDigest({
        artifactId: artifact.id,
        kind: "copy",
        sourceArtifactId: source.id,
        sourceAssetId: command.sourceAssetId,
      });
      const replayed = yield* dependencies.repository.findIdempotentAsset(
        artifact.projectId,
        idempotencyKey,
        inputDigest,
      );
      if (replayed !== null) return replayed;
      const {assets} = yield* dependencies.repository.listAssets(
        source.projectId,
        source.id,
      );
      const original = assets.find((asset) => asset.id === command.sourceAssetId);
      if (original === undefined) {
        return yield* new AssetNotFound({message: "The source asset does not exist."});
      }
      // The blob is content-addressed and already stored, so a copy is a row.
      const mediaType = yield* admit(artifact, original.mediaType, original.size);
      return yield* commit(artifact, command.principal, idempotencyKey, inputDigest, {
        mediaType,
        name: original.name,
        sha256: original.sha256,
        size: original.size,
      }, null);
    },
  );

  const listAssets = Effect.fn("ArtifactAssetService.listAssets")(
    function*(command: ArtifactAssetCommand) {
      const artifact = yield* readableArtifact(command);
      const listed = yield* dependencies.repository.listAssets(
        artifact.projectId,
        artifact.id,
      );
      return {...listed, quota: dependencies.quota};
    },
  );

  const deleteAsset = Effect.fn("ArtifactAssetService.deleteAsset")(
    function*(command: ArtifactAssetCommand & {readonly assetId: string}) {
      const artifact = yield* writableArtifact(command);
      const deletedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.deleteAsset(
        artifact.projectId,
        artifact.id,
        command.assetId,
        deletedAt,
      );
    },
  );

  const resolvePublicAsset = Effect.fn("ArtifactAssetService.resolvePublicAsset")(
    function*(assetId: string) {
      const served = yield* dependencies.repository.findServedAsset(assetId);
      if (served === null) {
        return yield* new AssetNotFound({message: "The asset does not exist."});
      }
      if (served.accessSetting !== accessSettings.publicLink) {
        return yield* new ContentSessionRequired({
          message: "The asset belongs to an artifact that is not public.",
        });
      }
      return served.asset;
    },
  );

  return ArtifactAssetService.of({
    commitUpload,
    copyAsset,
    createUpload,
    deleteAsset,
    listAssets,
    resolvePublicAsset,
  });
}

function assetInputDigest(input: Readonly<Record<string, string>>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
