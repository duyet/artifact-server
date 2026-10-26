import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  AgentDispatchNotFound,
  ArtifactMutationConflict,
  ArtifactNotFound,
  AssetNotFound,
  CommentNotFound,
  CommentResolved,
  DispatchStateConflict,
  IdempotencyConflict,
  InvalidDispatch,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
  ProjectConflict,
  ProjectArchived,
  ProjectNotFound,
} from "../core/errors.js";
import {principalKinds} from "../core/identity.js";
import {
  normalizeArtifactSearchText,
  unlistedArtifactTag,
} from "../application/artifact-tags.js";
import {
  accessSettings,
  agentBeaconStates,
  agentDispatchStates,
  artifactActionKinds,
  commentThreadStates,
  dispatchHoldsCommentThread,
  dispatchedThreadFilters,
  fileDispositions,
  folderDefaultStates,
  parseStoredAgentCapabilities,
  routingModes,
  uploadStatuses,
  defaultProjectId,
  defaultProjectName,
  type AgentDispatchCreation,
  type AgentDispatchPage,
  type AgentDispatchRecord,
  type ArtifactActionPage,
  type ArtifactActionRecord,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactPathMatch,
  type ArtifactRecord,
  type AssetRecord,
  type AssetUsage,
  type ArtifactState,
  type ArtifactTombstone,
  type ArtifactVersion,
  type ArtifactVersionDay,
  type ArtifactViewDay,
  type ArtifactViewTotal,
  type CommentAuthor,
  type CommentReplyCreation,
  type CommentReplyRecord,
  type CommentThreadClearing,
  type CommentThreadCreation,
  type CommentThreadDeletion,
  type CommentThreadPage,
  type CommentThreadRecord,
  type ContentBootstrapRecord,
  type ContentSessionRecord,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type ProjectActivityDays,
  type ProjectActivityTotals,
  type PublicArtifactSummary,
  type ViewedArtifact,
  type ProjectRecord,
  type RegisteredAgentPresence,
  type RegisteredAgentRecord,
  type StagedUpload,
  type StagedUploadFile,
  type FolderDefaultState,
  type VersionContent,
  type VersionRecord,
} from "../core/model.js";
import type {
  AgentDispatchRepository,
  ArtifactRepository,
  ArtifactViewDelta,
  ArtifactViewRepository,
  CancelAgentDispatch,
  ChangeArtifactAccessSetting,
  CollapsedFolderRepository,
  ChangeArtifactTags,
  ClearCommentThreads,
  CommentRepository,
  CreateAgentDispatch,
  ArtifactAssetRepository,
  CommitArtifactVersion,
  CommitAsset,
  CommitNewArtifact,
  CommittedAsset,
  ContentSessionRepository,
  CreateCommentReply,
  CreateCommentThread,
  CreateContentBootstrap,
  CreatePreviewLease,
  CreateStagedUpload,
  DeleteArtifact,
  DeleteCommentReply,
  DeleteCommentThread,
  ExchangeContentBootstrap,
  ExpiredStagedUpload,
  ListAgentDispatches,
  ListArtifactActions,
  ListArtifacts,
  ListCommentThreads,
  MarkDispatchDelivered,
  MarkDispatchFailed,
  ReadArtifactViewDays,
  ReadMostViewedArtifacts,
  ReadProjectActivityDays,
  RenameArtifact,
  RecordAgentActivity,
  RegisterAgent,
  UpdateCommentReply,
  UpdateCommentThread,
  PublicationSource,
  ProjectRepository,
  RenameProject,
  RestoreArtifactVersion,
  ServedAsset,
  SetProjectArchive,
  StagedUploadRepository,
} from "../core/ports.js";
import {assetQuotaFailure} from "../core/asset-policy.js";
import {
  assetColumns,
  assetReplayRowSchema,
  assetRowSchema,
  assetUsageRowSchema,
  replayedAsset,
  servedAssetRowSchema,
} from "./asset-row.js";
import {
  agentDispatchLeaseMilliseconds,
  agentUnavailableStalenessMilliseconds,
  registeredAgentRetentionMilliseconds,
} from "../core/publishing-limits.js";
import { createManifest } from "../manifest/create-manifest.js";
import {requiredSqliteSchemaVersion} from "./sqlite-schema.js";
import {artifactPathClaim, artifactPathTaken} from "./artifact-path-claim.js";
import {
  artifactOwnerColumns,
  ownerFilterParameters,
  withArtifactOwner,
} from "./artifact-owner-row.js";
import type {
  ListPublicLinks,
  PublicLinkInventoryPage,
} from "../application/public-link-administration.js";
import {
  publicLinkInventoryRowSchema,
  publicLinkPageFromRows,
} from "./public-link-inventory-row.js";

const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const dispositionSchema = z.enum([
  fileDispositions.attachment,
  fileDispositions.inline,
]);
const uploadStatusSchema = z.enum([
  uploadStatuses.committed,
  uploadStatuses.open,
]);
const routingModeSchema = z.enum([routingModes.static, routingModes.spa]);
const artifactActionKindSchema = z.enum([
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeTags,
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentDelete,
  artifactActionKinds.commentReopen,
  artifactActionKinds.commentReply,
  artifactActionKinds.commentResolve,
  artifactActionKinds.commentUpdate,
  artifactActionKinds.delete,
  artifactActionKinds.edited,
  artifactActionKinds.publish,
  artifactActionKinds.renamed,
  artifactActionKinds.restore,
]);
const publishedRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactCreatedAt: z.string(),
  artifactDeletedAt: z.string().nullable(),
  artifactId: z.string(),
  artifactName: z.string(),
  artifactPath: z.string().nullable(),
  contentToken: z.string(),
  currentVersionId: z.string(),
  entryPath: z.string(),
  manifestDigest: z.string(),
  ownerDisplayName: z.string().nullable(),
  ownerPrincipalId: z.string(),
  publisherDisplayName: z.string().nullable(),
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
});
const contentBootstrapRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const contentSessionRowSchema = contentBootstrapRowSchema;
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  artifactName: z.string().nullable(),
  inputDigest: z.string(),
  operation: z.enum([
    "change_access",
    "change_tags",
    "delete",
    "publish",
    "rename",
    "restore",
  ]),
  tagsJson: z.string().nullable(),
  versionId: z.string(),
});
const artifactActionRowSchema = z.object({
  action: artifactActionKindSchema,
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});
const artifactRowColumns = {
  ...artifactOwnerColumns,
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
};
const artifactRowSchema = z.object(artifactRowColumns)
  .transform(withArtifactOwner);
const artifactPathMatchSchema = z.object({id: z.string(), path: z.string()});
const artifactViewDayRowSchema = z.object({
  artifactId: z.string(),
  count: z.number().int().nonnegative(),
  day: z.string(),
});
const artifactViewTotalRowSchema = z.object({
  artifactId: z.string(),
  count: z.number().int().nonnegative(),
});
const publicArtifactSummaryRowSchema = z.object({
  accessSetting: accessSettingSchema,
  currentVersionCreatedAt: z.string(),
  id: z.string(),
  name: z.string(),
  path: z.string().nullable(),
});
const projectActivityTotalsRowSchema = z.object({
  artifacts: z.number().int().nonnegative(),
  artifactsViewedOnDay: z.number().int().nonnegative(),
  pageViews: z.number().int().nonnegative(),
  publicArtifacts: z.number().int().nonnegative(),
  uploads: z.number().int().nonnegative(),
});
const dayCountRowSchema = z.object({
  count: z.number().int().nonnegative(),
  day: z.string(),
});
const viewedArtifactRowSchema = z.object({
  artifactId: z.string(),
  name: z.string(),
  totalViews: z.number().int().nonnegative(),
  windowViews: z.number().int().positive(),
});
const artifactListRowSchema = z.object({
  ...artifactRowColumns,
  commentCount: z.number().int().nonnegative(),
  currentVersionCreatedAt: z.string(),
  currentVersionNumber: z.number().int().positive(),
  versionCount: z.number().int().positive(),
}).transform(withArtifactOwner);
const artifactTagRowSchema = z.object({
  artifactId: z.string(),
  tag: z.string(),
});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  publisherDisplayName: z.string().nullable(),
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const storedManifestEntryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});
const versionContentRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactId: z.string(),
  contentToken: z.string(),
  disposition: dispositionSchema,
  entryPath: z.string(),
  isCurrent: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  mediaType: z.string(),
  path: z.string(),
  projectId: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  versionId: z.string(),
});
const stagedUploadBaseRowSchema = z.object({
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const stagedUploadRowSchema = z.discriminatedUnion("status", [
  stagedUploadBaseRowSchema.extend({
    committedVersionId: z.null(),
    status: z.literal(uploadStatuses.open),
  }),
  stagedUploadBaseRowSchema.extend({
    committedVersionId: z.string(),
    status: z.literal(uploadStatuses.committed),
  }),
]);
const stagedUploadFileRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  storageToken: z.string(),
  uploadedAt: z.string().nullable(),
});
const expiredStagedUploadRowSchema = z.object({
  id: z.string(),
  storageToken: z.string(),
});
const stagedUploadCommitRowSchema = z.object({
  expiresAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  manifestDigest: z.string(),
  readyCount: z.number().int().nonnegative(),
  status: uploadStatusSchema,
});
const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});
const commentPrincipalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);
const commentThreadStateSchema = z.enum([
  commentThreadStates.open,
  commentThreadStates.resolved,
]);
const commentThreadRowSchema = z.object({
  anchorJson: z.string().nullable(),
  artifactId: z.string(),
  authorAuthorizedByPrincipalId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorPrincipalId: z.string(),
  authorPrincipalKind: commentPrincipalKindSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.string().nullable(),
  resolvedByAuthorizedByPrincipalId: z.string().nullable(),
  resolvedByDisplayName: z.string().nullable(),
  resolvedByPrincipalId: z.string().nullable(),
  resolvedByPrincipalKind: commentPrincipalKindSchema.nullable(),
  state: commentThreadStateSchema,
  updatedAt: z.string(),
  versionId: z.string(),
});
const commentReplyRowSchema = z.object({
  authorAuthorizedByPrincipalId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorPrincipalId: z.string(),
  authorPrincipalKind: commentPrincipalKindSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.string(),
});

const agentBeaconStateSchema = z.enum([
  agentBeaconStates.idle,
  agentBeaconStates.replying,
  agentBeaconStates.thinking,
]);
const registeredAgentRowSchema = z.object({
  activityAt: z.string().nullable(),
  activityState: agentBeaconStateSchema.nullable(),
  agentSessionId: z.string().nullable(),
  capabilitiesJson: z.string().nullable(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  installationId: z.string(),
  kind: z.string(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
}).transform(({capabilitiesJson, ...agent}) => ({
  ...agent,
  capabilities: parseStoredAgentCapabilities(capabilitiesJson),
}));
const agentDispatchStateSchema = z.enum([
  agentDispatchStates.addressed,
  agentDispatchStates.canceled,
  agentDispatchStates.claimed,
  agentDispatchStates.delivered,
  agentDispatchStates.failed,
  agentDispatchStates.queued,
]);
const agentDispatchRowSchema = z.object({
  addressedAt: z.string().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  id: z.string(),
  idempotencyKey: z.string(),
  installationId: z.string(),
  leaseExpiresAt: z.string().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  senderAuthorizedByPrincipalId: z.string().nullable(),
  senderDisplayName: z.string(),
  senderPrincipalId: z.string(),
  senderPrincipalKind: commentPrincipalKindSchema,
  state: agentDispatchStateSchema,
  threadIdsJson: z.string(),
  updatedAt: z.string(),
});
const dispatchThreadCheckRowSchema = z.object({
  dispatchId: z.string().nullable(),
  id: z.string(),
  state: commentThreadStateSchema,
});
const threadIdsSchema = z.array(z.string());
const countRowSchema = z.object({resolvedCount: z.number().int().nonnegative()});
const latestDispatchTransitionRowSchema = z.object({
  latestAt: z.string().nullable(),
});
const workingDispatchCandidateRowSchema = z.object({
  id: z.string(),
  threadIdsJson: z.string(),
});
const clearableThreadRowSchema = z.object({
  dispatchState: agentDispatchStateSchema.nullable(),
  id: z.string(),
  versionId: z.string(),
});

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

export class SqliteArtifactRepository implements
  AgentDispatchRepository,
  ArtifactAssetRepository,
  ArtifactRepository,
  ArtifactViewRepository,
  CollapsedFolderRepository,
  CommentRepository,
  ContentSessionRepository,
  ProjectRepository,
  StagedUploadRepository
{
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId = "local") {
    this.#installationId = installationId;
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.enableDefensive(true);
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec("PRAGMA synchronous = FULL;");
    this.#migrate(installationId);
  }

  createProject(command: ProjectRecord): Promise<ProjectRecord> {
    return Promise.resolve().then(() => {
      try {
        this.#database.prepare(`
          INSERT INTO projects (id, installation_id, name, created_at, archived_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          command.id,
          this.#installationId,
          command.name,
          command.createdAt,
          command.archivedAt,
        );
      } catch (cause) {
        if (isSqliteConstraint(cause)) {
          throw new ProjectConflict({message: "The project identity is already in use."});
        }
        throw cause;
      }
      return this.#readProject(command.id);
    });
  }

  findProject(projectId: string): Promise<ProjectRecord | null> {
    return Promise.resolve().then(() => this.#readProjectOrNull(projectId));
  }

  listProjects(): Promise<readonly ProjectRecord[]> {
    return Promise.resolve().then(() => projectRowSchema.array().parse(
      this.#database.prepare(`
        SELECT id, installation_id AS installationId, name,
          created_at AS createdAt, archived_at AS archivedAt
        FROM projects
        ORDER BY created_at, id
      `).all(),
    ));
  }

  renameProject(command: RenameProject): Promise<ProjectRecord> {
    return Promise.resolve().then(() => {
      const result = this.#database.prepare(
        "UPDATE projects SET name = ? WHERE id = ?",
      ).run(command.name, command.projectId);
      if (result.changes !== 1) {
        throw new ProjectNotFound({message: "The project does not exist."});
      }
      return this.#readProject(command.projectId);
    });
  }

  setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord> {
    return Promise.resolve().then(() => {
      const result = this.#database.prepare(
        "UPDATE projects SET archived_at = ? WHERE id = ?",
      ).run(command.archivedAt, command.projectId);
      if (result.changes !== 1) {
        throw new ProjectNotFound({message: "The project does not exist."});
      }
      return this.#readProject(command.projectId);
    });
  }

  close(): void {
    this.#database.close();
  }

  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      this.#assertStagedUploadReady(source, manifestDigest, commitTime);
      return undefined;
    });
  }

  commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => this.#applyNewArtifactCommit(command)),
    );
  }

  commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => this.#applyVersionCommit(command)),
    );
  }

  #applyNewArtifactCommit(command: CommitNewArtifact): PublishedVersion {
    const replayed = this.#findIdempotentResult(
      command.projectId,
      command.idempotencyKey,
      command.inputDigest,
    );
    if (replayed !== null) return replayed;
    this.#assertProjectActive(command.projectId);
    this.#assertStagedUploadReady(
      command.source,
      command.manifest.digest,
      command.createdAt,
    );
    if (command.path !== null) this.#assertArtifactPathFree(command.path);

    this.#database
      .prepare(
        `INSERT INTO artifacts (
          id, project_id, name, search_name, access_setting,
          owner_principal_id, owner_display_name,
          current_version_id, created_at, deleted_at, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .run(
        command.artifactId,
        command.projectId,
        command.name,
        normalizeArtifactSearchText(command.name),
        command.accessSetting,
        command.principalId,
        command.principalDisplayName,
        command.createdAt,
        command.path,
      );

    this.#replaceTags(command.artifactId, command.tags);

    this.#insertVersion(
      command.projectId,
      command.artifactId,
      command.versionId,
      command.contentToken,
      command.createdAt,
      1,
      command.manifest,
      command.principalId,
      command.principalDisplayName,
    );
    this.#database
      .prepare("UPDATE artifacts SET current_version_id = ? WHERE id = ?")
      .run(command.versionId, command.artifactId);
    this.#insertAction(
      command.projectId,
      command.artifactId,
      command.versionId,
      command.idempotencyKey,
      command.createdAt,
      artifactActionKinds.publish,
      command.principalId,
      command.authorizedByPrincipalId,
    );
    this.#insertIdempotency(
      command.projectId,
      command.idempotencyKey,
      command.inputDigest,
      command.artifactId,
      command.versionId,
      command.createdAt,
    );
    this.#sealStagedUpload(command.source, command.versionId);

    return this.#readPublishedVersion(command.projectId, command.versionId, false);
  }

  // The caller's BEGIN IMMEDIATE transaction holds the only writer, so no
  // other claim can land between this check and the insert.
  #assertArtifactPathFree(path: string): void {
    const claim = artifactPathClaim(path);
    const placeholders = claim.lineage.map(() => "?").join(", ");
    const row = this.#database
      .prepare(
        `SELECT path FROM artifacts
         WHERE path IS NOT NULL AND deleted_at IS NULL
           AND (path IN (${placeholders}) OR (path >= ? AND path < ?))
         LIMIT 1`,
      )
      .get(...claim.lineage, claim.descendants.from, claim.descendants.to);
    const existing = z.object({path: z.string()}).nullable().parse(row ?? null);
    if (existing !== null) throw artifactPathTaken(path, existing.path);
  }

  #applyVersionCommit(command: CommitArtifactVersion): PublishedVersion {
    const replayed = this.#findIdempotentResult(
      command.projectId,
      command.idempotencyKey,
      command.inputDigest,
    );
    if (replayed !== null) return replayed;
    this.#assertProjectActive(command.projectId);
    this.#assertStagedUploadReady(
      command.source,
      command.edit?.stagedManifestDigest ?? command.manifest.digest,
      command.createdAt,
    );

    const currentRow = this.#database
      .prepare(
        `SELECT current_version_id AS currentVersionId
         FROM artifacts
         WHERE project_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(command.projectId, command.artifactId);
    const current = z
      .object({currentVersionId: z.string()})
      .nullable()
      .parse(currentRow ?? null);
    if (current === null) {
      throw new ArtifactNotFound({message: "The artifact does not exist."});
    }
    if (current.currentVersionId !== command.expectedCurrentVersionId) {
      throw new PublishConflict({
        message: `The artifact moved to version ${current.currentVersionId}.`,
      });
    }

    const numberRow = this.#database
      .prepare(
        `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
         FROM versions
         WHERE artifact_id = ?`,
      )
      .get(command.artifactId);
    const {nextNumber} = z
      .object({nextNumber: z.number().int().positive()})
      .parse(numberRow);

    this.#insertVersion(
      command.projectId,
      command.artifactId,
      command.versionId,
      command.contentToken,
      command.createdAt,
      nextNumber,
      command.manifest,
      command.principalId,
      command.principalDisplayName,
    );
    const update = this.#database
      .prepare(
        `UPDATE artifacts
         SET current_version_id = ?
         WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
      )
      .run(
        command.versionId,
        command.projectId,
        command.artifactId,
        command.expectedCurrentVersionId,
      );
    if (update.changes !== 1) {
      throw new PublishConflict({
        message: "The artifact changed during publication.",
      });
    }

    this.#insertAction(
      command.projectId,
      command.artifactId,
      command.versionId,
      command.idempotencyKey,
      command.createdAt,
      command.edit === null
        ? artifactActionKinds.publish
        : artifactActionKinds.edited,
      command.principalId,
      command.authorizedByPrincipalId,
    );
    this.#insertIdempotency(
      command.projectId,
      command.idempotencyKey,
      command.inputDigest,
      command.artifactId,
      command.versionId,
      command.createdAt,
    );
    this.#sealStagedUpload(command.source, command.versionId);

    return this.#readPublishedVersion(command.projectId, command.versionId, false);
  }

  changeAccessSetting(
    command: ChangeArtifactAccessSetting,
  ): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentManagementResult(
          command.projectId,
          "change_access",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET access_setting = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.accessSetting,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          "change_access",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_access",
          command.accessSetting,
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.accessSetting,
          false,
        );
      }),
    );
  }

  changeTags(command: ChangeArtifactTags): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentTagResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        this.#replaceTags(command.artifactId, command.tags);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.changeTags,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_tags",
          artifact.accessSetting,
          JSON.stringify(command.tags),
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          command.tags,
        );
      }),
    );
  }

  renameArtifact(command: RenameArtifact): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentRenameResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET name = ?, search_name = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.name,
            normalizeArtifactSearchText(command.name),
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) throw changedDuringManagement();
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.renamed,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "rename",
          artifact.accessSetting,
          null,
          command.name,
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
        );
      }),
    );
  }

  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentDeletion(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;

        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET deleted_at = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.createdAt,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.delete,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "delete",
          artifact.accessSetting,
        );
        return this.#readDeletionResult(command.projectId, command.artifactId, false);
      }),
    );
  }

  commitAsset(command: CommitAsset): Promise<CommittedAsset> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const {asset} = command;
        const replayed = this.#findIdempotentAssetRow(
          asset.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        if (this.#readArtifactOrNull(asset.projectId, asset.artifactId) === null) {
          throw new ArtifactNotFound({message: "The artifact does not exist."});
        }
        const refused = assetQuotaFailure(
          asset.size,
          this.#assetUsage(asset.artifactId),
          command.quota,
        );
        if (refused !== null) throw refused;
        this.#database
          .prepare(
            `INSERT INTO assets (
              id, project_id, artifact_id, media_type, size, sha256, name,
              created_by_principal_id, created_by_display_name,
              idempotency_key, input_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            asset.id,
            asset.projectId,
            asset.artifactId,
            asset.mediaType,
            asset.size,
            asset.sha256,
            asset.name,
            asset.createdByPrincipalId,
            asset.createdByDisplayName,
            command.idempotencyKey,
            command.inputDigest,
            asset.createdAt,
          );
        return {asset, replayed: false};
      }),
    );
  }

  deleteAsset(
    projectId: string,
    artifactId: string,
    assetId: string,
    deletedAt: string,
  ): Promise<AssetRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#database
          .prepare(
            `SELECT ${assetColumns} FROM assets asset
             WHERE asset.id = ? AND asset.project_id = ? AND asset.artifact_id = ?
               AND asset.deleted_at IS NULL`,
          )
          .get(assetId, projectId, artifactId);
        const live = assetRowSchema.nullable().parse(row ?? null);
        if (live === null) {
          throw new AssetNotFound({message: "The asset does not exist."});
        }
        this.#database
          .prepare("UPDATE assets SET deleted_at = ? WHERE id = ?")
          .run(deletedAt, assetId);
        return live;
      }));
  }

  findIdempotentAsset(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<CommittedAsset | null> {
    return Promise.resolve().then(() =>
      this.#findIdempotentAssetRow(projectId, idempotencyKey, inputDigest));
  }

  findServedAsset(assetId: string): Promise<ServedAsset | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT ${assetColumns}, artifact.access_setting AS "accessSetting"
           FROM assets asset
           JOIN artifacts artifact ON artifact.id = asset.artifact_id
           WHERE asset.id = ? AND asset.deleted_at IS NULL
             AND artifact.deleted_at IS NULL`,
        )
        .get(assetId);
      const served = servedAssetRowSchema.nullable().parse(row ?? null);
      if (served === null) return null;
      const {accessSetting, ...asset} = served;
      return {accessSetting, asset};
    });
  }

  listAssets(
    projectId: string,
    artifactId: string,
  ): Promise<{readonly assets: readonly AssetRecord[]; readonly usage: AssetUsage}> {
    return Promise.resolve().then(() => {
      const rows = this.#database
        .prepare(
          `SELECT ${assetColumns}
           FROM assets asset
           WHERE asset.project_id = ? AND asset.artifact_id = ?
             AND asset.deleted_at IS NULL
           ORDER BY asset.created_at, asset.id`,
        )
        .all(projectId, artifactId);
      return {
        assets: z.array(assetRowSchema).parse(rows),
        usage: this.#assetUsage(artifactId),
      };
    });
  }

  #assetUsage(artifactId: string): AssetUsage {
    return assetUsageRowSchema.parse(this.#database
      .prepare(
        `SELECT COUNT(*) AS assetCount, COALESCE(SUM(size), 0) AS byteCount
         FROM assets WHERE artifact_id = ? AND deleted_at IS NULL`,
      )
      .get(artifactId));
  }

  #findIdempotentAssetRow(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): CommittedAsset | null {
    const row = this.#database
      .prepare(
        `SELECT ${assetColumns}, asset.input_digest AS "inputDigest",
           asset.deleted_at AS "deletedAt"
         FROM assets asset
         WHERE asset.project_id = ? AND asset.idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const found = assetReplayRowSchema.nullable().parse(row ?? null);
    return found === null ? null : replayedAsset(found, inputDigest);
  }

  findArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord | null> {
    return Promise.resolve().then(() => this.#readArtifactOrNull(projectId, artifactId));
  }

  findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return Promise.resolve().then(() =>
      this.#readArtifactIncludingDeletedOrNull(projectId, artifactId)
    );
  }

  findArtifactByPath(
    candidates: readonly string[],
  ): Promise<ArtifactPathMatch | null> {
    return Promise.resolve().then(() => {
      const placeholders = candidates.map(() => "?").join(", ");
      const row = this.#database
        .prepare(
          `SELECT id, path FROM artifacts
           WHERE path IN (${placeholders}) AND deleted_at IS NULL`,
        )
        .get(...candidates);
      return artifactPathMatchSchema.nullable().parse(row ?? null);
    });
  }

  listPublicArtifacts(limit: number): Promise<readonly PublicArtifactSummary[]> {
    return Promise.resolve().then(() =>
      z.array(publicArtifactSummaryRowSchema).parse(this.#database
        .prepare(
          `SELECT
             artifacts.id,
             artifacts.name,
             artifacts.path,
             artifacts.access_setting AS accessSetting,
             versions.created_at AS currentVersionCreatedAt
           FROM artifacts
           JOIN versions ON versions.id = artifacts.current_version_id
           WHERE artifacts.deleted_at IS NULL
             AND artifacts.access_setting = 'public_link'
             AND NOT EXISTS (
               SELECT 1 FROM artifact_tags
               WHERE artifact_tags.artifact_id = artifacts.id
                 AND artifact_tags.tag = ?
             )
           ORDER BY artifacts.created_at DESC, artifacts.id DESC
           LIMIT ?`,
        )
        .all(unlistedArtifactTag, limit)));
  }

  readArtifactVersionDays(
    command: ReadArtifactViewDays,
  ): Promise<readonly ArtifactVersionDay[]> {
    if (command.artifactIds.length === 0) return Promise.resolve([]);
    return Promise.resolve().then(() => {
      const placeholders = command.artifactIds.map(() => "?").join(", ");
      // Joining through the artifact keeps the read on the
      // (project_id, artifact_id) version index.
      const rows = this.#database
        .prepare(
          `SELECT
             versions.artifact_id AS artifactId,
             substr(versions.created_at, 1, 10) AS day,
             COUNT(*) AS count
           FROM artifacts
           JOIN versions
             ON versions.project_id = artifacts.project_id
            AND versions.artifact_id = artifacts.id
           WHERE artifacts.id IN (${placeholders})
             AND substr(versions.created_at, 1, 10) BETWEEN ? AND ?
           GROUP BY versions.artifact_id, day
           ORDER BY versions.artifact_id, day`,
        )
        .all(...command.artifactIds, command.sinceDay, command.untilDay);
      return z.array(artifactViewDayRowSchema).parse(rows);
    });
  }

  readArtifactViewDays(
    command: ReadArtifactViewDays,
  ): Promise<readonly ArtifactViewDay[]> {
    if (command.artifactIds.length === 0) return Promise.resolve([]);
    return Promise.resolve().then(() => {
      const placeholders = command.artifactIds.map(() => "?").join(", ");
      const rows = this.#database
        .prepare(
          `SELECT artifact_id AS artifactId, day, count
           FROM artifact_views
           WHERE artifact_id IN (${placeholders}) AND day >= ? AND day <= ?
           ORDER BY artifact_id, day`,
        )
        .all(...command.artifactIds, command.sinceDay, command.untilDay);
      return z.array(artifactViewDayRowSchema).parse(rows);
    });
  }

  readArtifactViewTotals(
    artifactIds: readonly string[],
  ): Promise<readonly ArtifactViewTotal[]> {
    if (artifactIds.length === 0) return Promise.resolve([]);
    return Promise.resolve().then(() => {
      const placeholders = artifactIds.map(() => "?").join(", ");
      const rows = this.#database
        .prepare(
          `SELECT artifact_id AS artifactId, SUM(count) AS count
           FROM artifact_views
           WHERE artifact_id IN (${placeholders})
           GROUP BY artifact_id`,
        )
        .all(...artifactIds);
      return z.array(artifactViewTotalRowSchema).parse(rows);
    });
  }

  readProjectActivityTotals(
    projectId: string,
    day: string,
  ): Promise<ProjectActivityTotals> {
    return Promise.resolve().then(() =>
      projectActivityTotalsRowSchema.parse(this.#database
        .prepare(
          `SELECT
             COUNT(*) AS artifacts,
             COALESCE(SUM(access_setting = 'public_link'), 0) AS publicArtifacts,
             (
               SELECT COUNT(*) FROM versions
               JOIN artifacts live ON live.id = versions.artifact_id
               WHERE live.project_id = ? AND live.deleted_at IS NULL
             ) AS uploads,
             (
               SELECT COALESCE(SUM(artifact_views.count), 0) FROM artifact_views
               JOIN artifacts live ON live.id = artifact_views.artifact_id
               WHERE live.project_id = ? AND live.deleted_at IS NULL
             ) AS pageViews,
             (
               SELECT COUNT(*) FROM artifact_views
               JOIN artifacts live ON live.id = artifact_views.artifact_id
               WHERE live.project_id = ? AND live.deleted_at IS NULL
                 AND artifact_views.day = ? AND artifact_views.count > 0
             ) AS artifactsViewedOnDay
           FROM artifacts
           WHERE project_id = ? AND deleted_at IS NULL`,
        )
        .get(projectId, projectId, projectId, day, projectId)));
  }

  readProjectActivityDays(
    command: ReadProjectActivityDays,
  ): Promise<ProjectActivityDays> {
    return Promise.resolve().then(() => {
      const uploads = this.#database
        .prepare(
          `SELECT substr(versions.created_at, 1, 10) AS day, COUNT(*) AS count
           FROM versions
           JOIN artifacts live ON live.id = versions.artifact_id
           WHERE live.project_id = ? AND live.deleted_at IS NULL
             AND substr(versions.created_at, 1, 10) BETWEEN ? AND ?
           GROUP BY day
           ORDER BY day`,
        )
        .all(command.projectId, command.sinceDay, command.untilDay);
      const views = this.#database
        .prepare(
          `SELECT artifact_views.day AS day, SUM(artifact_views.count) AS count
           FROM artifact_views
           JOIN artifacts live ON live.id = artifact_views.artifact_id
           WHERE live.project_id = ? AND live.deleted_at IS NULL
             AND artifact_views.day BETWEEN ? AND ?
           GROUP BY artifact_views.day
           ORDER BY artifact_views.day`,
        )
        .all(command.projectId, command.sinceDay, command.untilDay);
      return {
        uploads: z.array(dayCountRowSchema).parse(uploads),
        views: z.array(dayCountRowSchema).parse(views),
      };
    });
  }

  readMostViewedArtifacts(
    command: ReadMostViewedArtifacts,
  ): Promise<readonly ViewedArtifact[]> {
    return Promise.resolve().then(() =>
      z.array(viewedArtifactRowSchema).parse(this.#database
        .prepare(
          `SELECT
             live.id AS artifactId,
             live.name AS name,
             SUM(CASE WHEN artifact_views.day BETWEEN ? AND ?
               THEN artifact_views.count ELSE 0 END) AS windowViews,
             SUM(artifact_views.count) AS totalViews
           FROM artifacts live
           JOIN artifact_views ON artifact_views.artifact_id = live.id
           WHERE live.project_id = ? AND live.deleted_at IS NULL
           GROUP BY live.id, live.name
           HAVING windowViews > 0
           ORDER BY windowViews DESC, totalViews DESC, live.id
           LIMIT ?`,
        )
        .all(
          command.sinceDay,
          command.untilDay,
          command.projectId,
          command.limit,
        )));
  }

  recordArtifactViews(
    deltas: readonly ArtifactViewDelta[],
  ): Promise<void> {
    if (deltas.length === 0) return Promise.resolve();
    return Promise.resolve().then(() => {
      const insert = this.#database.prepare(
        `INSERT INTO artifact_views (artifact_id, day, count)
         VALUES (?, ?, ?)
         ON CONFLICT(artifact_id, day) DO UPDATE SET count = count + excluded.count`,
      );
      // One writer acquisition for the whole batch, so a burst is one
      // `BEGIN IMMEDIATE` rather than one per artifact.
      return this.#transaction(() => {
        for (const delta of deltas) {
          insert.run(delta.artifactId, delta.day, delta.count);
        }
      });
    });
  }

  listCollapsedFolders(): Promise<readonly string[]> {
    return Promise.resolve().then(() =>
      z.array(z.object({path: z.string()})).parse(this.#database
        .prepare("SELECT path FROM collapsed_folders")
        .all()).map((row) => row.path));
  }

  setFolderDefaultState(path: string, state: FolderDefaultState): Promise<void> {
    const statement = state === folderDefaultStates.collapsed
      ? "INSERT INTO collapsed_folders (path) VALUES (?) ON CONFLICT DO NOTHING"
      : "DELETE FROM collapsed_folders WHERE path = ?";
    return Promise.resolve().then(() => {
      this.#database.prepare(statement).run(path);
      return undefined;
    });
  }

  findVersionRecord(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null> {
    return Promise.resolve().then(() => {
      const version = this.#readVersionOrNull(projectId, versionId, artifactId);
      if (version === null) return null;
      return {
        manifest: this.#readManifest(version),
        version,
      };
    });
  }

  findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT current_version_id AS currentVersionId
           FROM artifacts
           WHERE (? IS NULL OR project_id = ?) AND id = ? AND deleted_at IS NULL`,
        )
        .get(projectId, projectId, artifactId);
      const result = z
        .object({currentVersionId: z.string()})
        .nullable()
        .parse(row ?? null);
      return result === null
        ? null
        : projectId === null
        ? this.#readPublishedVersionById(result.currentVersionId, false)
        : this.#readPublishedVersion(projectId, result.currentVersionId, false);
    });
  }

  listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]> {
    return Promise.resolve().then(() => {
      if (this.#readArtifactOrNull(projectId, artifactId) === null) return [];
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            project_id AS projectId,
            artifact_id AS artifactId,
            number,
            manifest_digest AS manifestDigest,
            entry_path AS entryPath,
            routing_mode AS routingMode,
            content_token AS contentToken,
            publisher_principal_id AS publisherPrincipalId,
            publisher_display_name AS publisherDisplayName,
            created_at AS createdAt
           FROM versions
           WHERE project_id = ? AND artifact_id = ?
           ORDER BY number DESC`,
        )
        .all(projectId, artifactId);
      return z.array(versionRowSchema).parse(rows);
    });
  }

  listArtifacts(command: ListArtifacts): Promise<ArtifactPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const cursorRank = command.cursor?.rank ?? null;
      const commentFilterSql = command.comments === "with"
        ? "commentCount > 0"
        : command.comments === "without"
          ? "commentCount = 0"
          : "1 = 1";
      const cursorSql = command.sort === "comments"
        ? `(
          ? IS NULL
          OR commentCount < ?
          OR (commentCount = ? AND (
            createdAt < ? OR (createdAt = ? AND id < ?)
          ))
        )`
        : `(
          ? IS NULL
          OR createdAt < ?
          OR (createdAt = ? AND id < ?)
        )`;
      const cursorParameters = command.sort === "comments"
        ? [cursorRank, cursorRank, cursorRank, cursorCreatedAt, cursorCreatedAt, cursorId]
        : [cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorId];
      const orderSql = command.sort === "comments"
        ? "commentCount DESC, createdAt DESC, id DESC"
        : "createdAt DESC, id DESC";
      const tagFilterJson = command.tags.length === 0
        ? null
        : JSON.stringify(command.tags);
      const {notOwnedBy, ownedBy} = ownerFilterParameters(command.owner);
      const rows = this.#database
        .prepare(
          `SELECT * FROM (
            SELECT
              id,
              project_id AS projectId,
              name,
              path,
              access_setting AS accessSetting,
              owner_principal_id AS ownerPrincipalId,
              owner_display_name AS ownerDisplayName,
              current_version_id AS currentVersionId,
              created_at AS createdAt,
              deleted_at AS deletedAt,
              (
                SELECT created_at FROM versions
                WHERE versions.id = artifacts.current_version_id
              ) AS currentVersionCreatedAt,
              (
                SELECT number FROM versions
                WHERE versions.id = artifacts.current_version_id
              ) AS currentVersionNumber,
              (
                SELECT COUNT(*) FROM comment_threads
                WHERE comment_threads.project_id = artifacts.project_id
                  AND comment_threads.artifact_id = artifacts.id
              ) AS commentCount,
              (
                SELECT COUNT(*) FROM versions
                WHERE versions.project_id = artifacts.project_id
                  AND versions.artifact_id = artifacts.id
              ) AS versionCount
            FROM artifacts
            WHERE project_id = ?
              AND deleted_at IS NULL
              AND (? IS NULL OR owner_principal_id = ?)
              AND (? IS NULL OR owner_principal_id <> ?)
              AND (
                ? IS NULL
                OR instr(search_name, ?) > 0
                OR EXISTS (
                  SELECT 1 FROM artifact_tags searched_tags
                  WHERE searched_tags.artifact_id = artifacts.id
                    AND searched_tags.tag = ?
                )
              )
              AND (
                ? IS NULL
                OR EXISTS (
                  SELECT 1 FROM artifact_tags
                  WHERE artifact_tags.artifact_id = artifacts.id
                    AND artifact_tags.tag IN (SELECT value FROM json_each(?))
                )
              )
          ) AS artifact_catalog
          WHERE ${commentFilterSql} AND ${cursorSql}
          ORDER BY ${orderSql}
          LIMIT ?`,
        )
        .all(
          command.projectId,
          ownedBy,
          ownedBy,
          notOwnedBy,
          notOwnedBy,
          command.search ?? null,
          command.search ?? null,
          command.search ?? null,
          tagFilterJson,
          tagFilterJson,
          ...cursorParameters,
          command.limit + 1,
      );
      return pageFromRows(
        this.#withTagsForArtifacts(z.array(artifactListRowSchema).parse(rows)),
        command.limit,
        command.sort === "comments" ? ({commentCount}) => commentCount : null,
      );
    });
  }

  /** List one bounded installation-wide page of active public-link artifacts. */
  listPublicLinks(command: ListPublicLinks): Promise<PublicLinkInventoryPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = this.#database
        .prepare(
          `SELECT
            artifact.id AS artifactId,
            artifact.project_id AS projectId,
            artifact.name AS artifactName,
            artifact.path AS artifactPath,
            artifact.access_setting AS accessSetting,
            artifact.owner_principal_id AS ownerPrincipalId,
            artifact.owner_display_name AS ownerDisplayName,
            artifact.current_version_id AS currentVersionId,
            artifact.created_at AS artifactCreatedAt,
            artifact.deleted_at AS artifactDeletedAt,
            project.installation_id AS installationId,
            project.name AS projectName,
            project.created_at AS projectCreatedAt,
            project.archived_at AS projectArchivedAt,
            version.id AS versionId,
            version.number AS versionNumber,
            version.manifest_digest AS manifestDigest,
            version.entry_path AS entryPath,
            version.routing_mode AS routingMode,
            version.content_token AS contentToken,
            version.publisher_principal_id AS publisherPrincipalId,
            version.publisher_display_name AS publisherDisplayName,
            version.created_at AS versionCreatedAt
           FROM artifacts artifact
           INNER JOIN projects project ON project.id = artifact.project_id
           INNER JOIN versions version
             ON version.project_id = artifact.project_id
             AND version.artifact_id = artifact.id
             AND version.id = artifact.current_version_id
           WHERE artifact.deleted_at IS NULL
             AND artifact.access_setting = 'public_link'
             AND (
               ? IS NULL
               OR artifact.created_at < ?
               OR (artifact.created_at = ? AND artifact.id < ?)
             )
           ORDER BY artifact.created_at DESC, artifact.id DESC
           LIMIT ?`,
        )
        .all(
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      const parsedRows = z.array(publicLinkInventoryRowSchema).parse(rows);
      const artifacts = this.#withTagsForArtifacts(parsedRows.map((row) => ({
        accessSetting: row.accessSetting,
        createdAt: row.artifactCreatedAt,
        currentVersionId: row.currentVersionId,
        deletedAt: row.artifactDeletedAt,
        id: row.artifactId,
        name: row.artifactName,
        owner: {
          displayName: row.ownerDisplayName,
          principalId: row.ownerPrincipalId,
        },
        path: row.artifactPath,
        projectId: row.projectId,
      })));
      return publicLinkPageFromRows(parsedRows, artifacts, command.limit);
    });
  }

  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            project_id AS projectId,
            artifact_id AS artifactId,
            version_id AS versionId,
            action,
            principal_id AS principalId,
            authorized_by_principal_id AS authorizedByPrincipalId,
            idempotency_key AS idempotencyKey,
            created_at AS createdAt
           FROM actions
           WHERE project_id = ? AND artifact_id = ?
             AND (
               ? IS NULL
               OR created_at < ?
               OR (created_at = ? AND id < ?)
             )
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          command.projectId,
          command.artifactId,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      return pageFromRows(
        z.array(artifactActionRowSchema).parse(rows),
        command.limit,
      );
    });
  }

  restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentManagementResult(
          command.projectId,
          "restore",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        if (this.#readVersionOrNull(
          command.projectId,
          command.versionId,
          command.artifactId,
        ) === null) {
          throw new VersionNotFound({
            message: "The saved version does not exist on this artifact.",
          });
        }
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET current_version_id = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.versionId,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "restore",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
          "restore",
          artifact.accessSetting,
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.versionId,
          artifact.accessSetting,
          false,
        );
      }),
    );
  }

  findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> {
    return Promise.resolve().then(() =>
      this.#findIdempotentResult(projectId, idempotencyKey, inputDigest),
    );
  }

  findVersionContent(
    contentToken: string,
    requestedPath: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT
            a.access_setting AS accessSetting,
            a.id AS artifactId,
            a.project_id AS projectId,
            v.content_token AS contentToken,
            v.id AS versionId,
            v.entry_path AS entryPath,
            e.path AS path,
            e.size AS size,
            e.media_type AS mediaType,
            e.sha256 AS sha256,
            e.disposition AS disposition
            , CASE WHEN v.id = a.current_version_id THEN 1 ELSE 0 END AS isCurrent
          FROM versions v
          JOIN artifacts a ON a.id = v.artifact_id
          JOIN manifest_entries e ON e.version_id = v.id
          WHERE v.content_token = ?
            AND e.path = CASE
              WHEN ? = '' THEN v.entry_path
              WHEN EXISTS (
                SELECT 1 FROM manifest_entries exact
                WHERE exact.version_id = v.id AND exact.path = ?
              ) THEN ?
              WHEN ? = 'entry' AND v.routing_mode = 'spa' THEN v.entry_path
              ELSE ?
            END
            AND a.deleted_at IS NULL`,
        )
        .get(
          contentToken,
          requestedPath,
          requestedPath,
          requestedPath,
          fallback,
          requestedPath,
        );
      const parsed = versionContentRowSchema.nullable().parse(row ?? null);
      if (parsed === null) return null;
      const entry: ManifestEntry = {
        disposition: parsed.disposition,
        mediaType: parsed.mediaType,
        path: parsed.path,
        sha256: parsed.sha256,
        size: parsed.size,
      };
      return {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry,
        entryPath: parsed.entryPath,
        isCurrent: parsed.isCurrent,
        projectId: parsed.projectId,
        versionId: parsed.versionId,
      };
    });
  }

  createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord> {
    return Promise.resolve().then(() => {
      this.#database
        .prepare(
          `INSERT INTO content_bootstraps (
            token_digest, principal_id, project_id, artifact_id, version_id,
            content_token, created_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          command.tokenDigest,
          command.principalId,
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          command.expiresAt,
        );
      return command;
    });
  }

  exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#database
          .prepare(
            `SELECT
              b.token_digest AS tokenDigest,
              b.principal_id AS principalId,
              b.project_id AS projectId,
              b.artifact_id AS artifactId,
              b.version_id AS versionId,
              b.content_token AS contentToken,
              b.created_at AS createdAt,
              b.expires_at AS expiresAt
            FROM content_bootstraps b
            JOIN artifacts a ON a.id = b.artifact_id
            WHERE b.token_digest = ?
              AND b.content_token = ?
              AND b.consumed_at IS NULL
              AND b.expires_at > ?
              AND a.deleted_at IS NULL`,
          )
          .get(
            command.bootstrapTokenDigest,
            command.contentToken,
            command.exchangedAt,
          );
        const bootstrap = contentBootstrapRowSchema.nullable().parse(row ?? null);
        if (bootstrap === null) return null;

        const consumed = this.#database
          .prepare(
            `UPDATE content_bootstraps
             SET consumed_at = ?
             WHERE token_digest = ? AND consumed_at IS NULL`,
          )
          .run(command.exchangedAt, command.bootstrapTokenDigest);
        if (consumed.changes !== 1) return null;

        const session: ContentSessionRecord = {
          artifactId: bootstrap.artifactId,
          contentToken: bootstrap.contentToken,
          createdAt: command.session.createdAt,
          expiresAt: command.session.expiresAt,
          principalId: bootstrap.principalId,
          projectId: bootstrap.projectId,
          tokenDigest: command.session.tokenDigest,
          versionId: bootstrap.versionId,
        };
        this.#database
          .prepare(
            `INSERT INTO content_sessions (
              token_digest, principal_id, project_id, artifact_id, version_id,
              content_token, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.tokenDigest,
            session.principalId,
            session.projectId,
            session.artifactId,
            session.versionId,
            session.contentToken,
            session.createdAt,
            session.expiresAt,
          );
        return session;
      }),
    );
  }

  findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT
            s.token_digest AS tokenDigest,
            s.principal_id AS principalId,
            s.project_id AS projectId,
            s.artifact_id AS artifactId,
            s.version_id AS versionId,
            s.content_token AS contentToken,
            s.created_at AS createdAt,
            s.expires_at AS expiresAt
          FROM content_sessions s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.token_digest = ?
            AND s.content_token = ?
            AND s.expires_at > ?
            AND a.deleted_at IS NULL`,
        )
        .get(tokenDigest, contentToken, requestTime);
      return contentSessionRowSchema.nullable().parse(row ?? null);
    });
  }

  createPreviewLease(command: CreatePreviewLease): Promise<ContentSessionRecord> {
    return Promise.resolve().then(() => {
      this.#database.prepare(
        `INSERT INTO content_sessions (
          token_digest, principal_id, project_id, artifact_id, version_id,
          content_token, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        command.tokenDigest,
        command.principalId,
        command.projectId,
        command.artifactId,
        command.versionId,
        command.contentToken,
        command.createdAt,
        command.expiresAt,
      );
      return command;
    });
  }

  findPreviewLease(
    tokenDigest: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#database.prepare(
        `SELECT
          s.token_digest AS tokenDigest,
          s.principal_id AS principalId,
          s.project_id AS projectId,
          s.artifact_id AS artifactId,
          s.version_id AS versionId,
          s.content_token AS contentToken,
          s.created_at AS createdAt,
          s.expires_at AS expiresAt
        FROM content_sessions s
        JOIN artifacts a ON a.id = s.artifact_id
        WHERE s.token_digest = ?
          AND s.expires_at > ?
          AND a.deleted_at IS NULL`,
      ).get(tokenDigest, requestTime);
      return contentSessionRowSchema.nullable().parse(row ?? null);
    });
  }

  createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        this.#assertProjectActive(command.projectId);
        this.#database
          .prepare(
            `INSERT INTO staged_uploads (
              id, project_id, principal_id, status, manifest_digest, entry_path,
              routing_mode, created_at, expires_at, committed_version_id
            ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            command.id,
            command.projectId,
            command.principalId,
            command.manifest.digest,
            command.manifest.entryPath,
            command.manifest.routingMode,
            command.createdAt,
            command.expiresAt,
          );

        const insertFile = this.#database.prepare(
          `INSERT INTO staged_upload_files (
            upload_id, storage_token, path, size, media_type,
            sha256, disposition, uploaded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
        for (const file of command.files) {
          insertFile.run(
            command.id,
            file.storageToken,
            file.entry.path,
            file.entry.size,
            file.entry.mediaType,
            file.entry.sha256,
            file.entry.disposition,
          );
        }
        return this.#readStagedUpload(
          command.projectId,
          command.id,
          command.principalId,
        );
      }),
    );
  }

  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> {
    return Promise.resolve().then(() =>
      this.#readStagedUploadOrNull(projectId, uploadId, principalId),
    );
  }

  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]> {
    return Promise.resolve().then(() => {
      const rows = this.#database.prepare(`
        WITH selected AS (
          SELECT id FROM staged_uploads
          WHERE status = 'open' AND expires_at <= ?
          ORDER BY expires_at, id
          LIMIT ?
        )
        SELECT selected.id, file.storage_token AS storageToken
        FROM selected
        JOIN staged_upload_files file ON file.upload_id = selected.id
        ORDER BY selected.id, file.storage_token
      `).all(expiredBefore, limit);
      const grouped = new Map<string, Array<{readonly storageToken: string}>>();
      for (const row of z.array(expiredStagedUploadRowSchema).parse(rows)) {
        const files = grouped.get(row.id) ?? [];
        files.push({storageToken: row.storageToken});
        grouped.set(row.id, files);
      }
      return [...grouped].map(([id, files]) => ({files, id}));
    });
  }

  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean> {
    return Promise.resolve().then(() => this.#transaction(() => {
      this.#database.prepare(`
        DELETE FROM staged_upload_files
        WHERE upload_id = ? AND EXISTS (
          SELECT 1 FROM staged_uploads upload
          WHERE upload.id = staged_upload_files.upload_id
            AND upload.status = 'open' AND upload.expires_at <= ?
        )
      `).run(uploadId, expiredBefore);
      const deleted = this.#database.prepare(`
        DELETE FROM staged_uploads
        WHERE id = ? AND status = 'open' AND expires_at <= ?
      `).run(uploadId, expiredBefore);
      return deleted.changes === 1;
    }));
  }

  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        this.#assertProjectActive(projectId);
        const update = this.#database
          .prepare(
            `UPDATE staged_upload_files
             SET uploaded_at = ?
             WHERE upload_id = ?
               AND storage_token = ?
               AND EXISTS (
                 SELECT 1 FROM staged_uploads u
                 WHERE u.id = staged_upload_files.upload_id
                   AND u.project_id = ?
                   AND u.principal_id = ?
                   AND u.status = 'open'
                   AND u.expires_at > ?
               )`,
          )
          .run(
            uploadedAt,
            uploadId,
            storageToken,
            projectId,
            principalId,
            uploadedAt,
          );
        if (update.changes !== 1) {
          const upload = this.#readStagedUploadOrNull(
            projectId,
            uploadId,
            principalId,
          );
          if (upload === null) {
            throw new UploadNotFound({
              message: "The staged upload does not exist.",
            });
          }
          if (upload.status !== uploadStatuses.open) {
            throw new UploadClosed({
              message: "The staged upload is already committed.",
            });
          }
          if (upload.expiresAt <= uploadedAt) {
            throw new UploadExpired({message: "The staged upload has expired."});
          }
          throw new UploadFileNotFound({
            message: "The staged upload file does not exist.",
          });
        }
        return this.#readStagedUpload(projectId, uploadId, principalId);
      }),
    );
  }

  #assertExpectedCurrentVersion(
    artifact: ArtifactRecord,
    expectedCurrentVersionId: string,
  ): void {
    if (artifact.currentVersionId !== expectedCurrentVersionId) {
      throw new ArtifactMutationConflict({
        message: `The artifact moved to version ${artifact.currentVersionId}.`,
      });
    }
  }

  #assertProjectActive(projectId: string): void {
    const row = this.#database.prepare(
      "SELECT archived_at AS archivedAt FROM projects WHERE id = ?",
    ).get(projectId);
    const project = z.object({archivedAt: z.string().nullable()})
      .nullable()
      .parse(row ?? null);
    if (project === null || project.archivedAt !== null) {
      throw new ProjectArchived({
        message: "The project is archived and cannot accept new work.",
      });
    }
  }

  #findIdempotentManagementResult(
    projectId: string,
    operation: "change_access" | "restore",
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          artifact_name AS artifactName,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== operation ||
      parsed.accessSetting === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readArtifactState(
      projectId,
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
    );
  }

  #findIdempotentTagResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          artifact_name AS artifactName,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== "change_tags" ||
      parsed.accessSetting === null ||
      parsed.tagsJson === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    const decoded: unknown = JSON.parse(parsed.tagsJson);
    const tags = z.array(z.string()).parse(decoded);
    return this.#readArtifactState(
      projectId,
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
      tags,
    );
  }

  #findIdempotentRenameResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          artifact_name AS artifactName,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== "rename" ||
      parsed.accessSetting === null ||
      parsed.artifactName === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readArtifactState(
      projectId,
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
      null,
      parsed.artifactName,
    );
  }

  #findIdempotentDeletion(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactDeletion | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          artifact_name AS artifactName,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest || parsed.operation !== "delete") {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readDeletionResult(projectId, parsed.artifactId, true);
  }

  #readArtifact(projectId: string, artifactId: string): ArtifactRecord {
    const artifact = this.#readArtifactOrNull(projectId, artifactId);
    if (artifact === null) {
      throw new ArtifactNotFound({message: "The artifact does not exist."});
    }
    return artifact;
  }

  #readArtifactOrNull(projectId: string, artifactId: string): ArtifactRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          name,
          path,
          access_setting AS accessSetting,
          owner_principal_id AS ownerPrincipalId,
          owner_display_name AS ownerDisplayName,
          current_version_id AS currentVersionId,
          created_at AS createdAt,
          deleted_at AS deletedAt
         FROM artifacts
         WHERE project_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(projectId, artifactId);
    const artifact = artifactRowSchema.nullable().parse(row ?? null);
    return artifact === null ? null : this.#withTags(artifact);
  }

  #readArtifactIncludingDeletedOrNull(
    projectId: string,
    artifactId: string,
  ): ArtifactRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          name,
          path,
          access_setting AS accessSetting,
          owner_principal_id AS ownerPrincipalId,
          owner_display_name AS ownerDisplayName,
          current_version_id AS currentVersionId,
          created_at AS createdAt,
          deleted_at AS deletedAt
         FROM artifacts
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, artifactId);
    const artifact = artifactRowSchema.nullable().parse(row ?? null);
    return artifact === null ? null : this.#withTags(artifact);
  }

  #withTags(artifact: z.infer<typeof artifactRowSchema>): ArtifactRecord {
    return {...artifact, tags: this.#readTags(artifact.id)};
  }

  #withTagsForArtifacts<Artifact extends z.infer<typeof artifactRowSchema>>(
    artifacts: readonly Artifact[],
  ): readonly (Artifact & Pick<ArtifactRecord, "tags">)[] {
    if (artifacts.length === 0) return [];
    const tagsByArtifact = new Map<string, string[]>();
    for (const artifact of artifacts) tagsByArtifact.set(artifact.id, []);
    const placeholders = artifacts.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT artifact_id AS artifactId, tag
         FROM artifact_tags
         WHERE artifact_id IN (${placeholders})
         ORDER BY artifact_id, tag`,
      )
      .all(...artifacts.map((artifact) => artifact.id));
    for (const row of z.array(artifactTagRowSchema).parse(rows)) {
      tagsByArtifact.get(row.artifactId)?.push(row.tag);
    }
    return artifacts.map((artifact) => ({
      ...artifact,
      tags: tagsByArtifact.get(artifact.id) ?? [],
    }));
  }

  #readTags(artifactId: string): readonly string[] {
    const rows = this.#database
      .prepare(
        `SELECT artifact_id AS artifactId, tag
         FROM artifact_tags
         WHERE artifact_id = ?
         ORDER BY tag`,
      )
      .all(artifactId);
    return z.array(artifactTagRowSchema).parse(rows).map((row) => row.tag);
  }

  #replaceTags(artifactId: string, tags: readonly string[]): void {
    this.#database.prepare("DELETE FROM artifact_tags WHERE artifact_id = ?")
      .run(artifactId);
    const insert = this.#database.prepare(
      "INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) insert.run(artifactId, tag);
  }

  #readDeletionResult(
    projectId: string,
    artifactId: string,
    replayed: boolean,
  ): ArtifactDeletion {
    const artifact = this.#readArtifactIncludingDeletedOrNull(projectId, artifactId);
    if (artifact === null || artifact.deletedAt === null) {
      throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
    }
    const tombstone: ArtifactTombstone = {
      ...artifact,
      deletedAt: artifact.deletedAt,
    };
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS retainedVersionCount
         FROM versions
         WHERE project_id = ? AND artifact_id = ?`,
      )
      .get(projectId, artifactId);
    const {retainedVersionCount} = z.object({
      retainedVersionCount: z.number().int().nonnegative(),
    }).parse(row);
    return {artifact: tombstone, replayed, retainedVersionCount};
  }

  #readArtifactState(
    projectId: string,
    artifactId: string,
    versionId: string,
    accessSetting: ArtifactRecord["accessSetting"],
    replayed: boolean,
    tags: readonly string[] | null = null,
    name: string | null = null,
  ): ArtifactState {
    const artifact = this.#readArtifact(projectId, artifactId);
    const version = this.#readVersionOrNull(projectId, versionId, artifactId);
    if (version === null) {
      throw new Error(`Artifact state references missing version ${versionId}.`);
    }
    return {
      artifact: {
        ...artifact,
        accessSetting,
        currentVersionId: versionId,
        name: name ?? artifact.name,
        tags: tags ?? artifact.tags,
      },
      replayed,
      version,
    };
  }

  #readManifest(version: VersionRecord) {
    const rows = this.#database
      .prepare(
        `SELECT
          path,
          size,
          media_type AS mediaType,
          sha256,
          disposition
         FROM manifest_entries
         WHERE version_id = ?
         ORDER BY path`,
      )
      .all(version.id);
    const storedEntries = z.array(storedManifestEntryRowSchema).parse(rows);
    const manifest = createManifest({
      entryPath: version.entryPath,
      files: storedEntries.map((entry) => ({
        mediaType: entry.mediaType,
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
      })),
      routingMode: version.routingMode,
    });
    if (manifest.digest !== version.manifestDigest) {
      throw new Error(`Saved version ${version.id} has an invalid manifest digest.`);
    }
    const canonicalByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    for (const stored of storedEntries) {
      const canonical = canonicalByPath.get(stored.path);
      if (canonical?.disposition !== stored.disposition) {
        throw new Error(`Saved version ${version.id} has invalid serving metadata.`);
      }
    }
    return manifest;
  }

  #readVersionOrNull(
    projectId: string,
    versionId: string,
    artifactId: string,
  ): VersionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          artifact_id AS artifactId,
          number,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode,
          content_token AS contentToken,
          publisher_principal_id AS publisherPrincipalId,
          publisher_display_name AS publisherDisplayName,
          created_at AS createdAt
         FROM versions
         WHERE project_id = ? AND id = ? AND artifact_id = ?`,
      )
      .get(projectId, versionId, artifactId);
    return versionRowSchema.nullable().parse(row ?? null);
  }

  #findIdempotentResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): PublishedVersion | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          artifact_name AS artifactName,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest || parsed.operation !== "publish") {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readPublishedVersion(projectId, parsed.versionId, true);
  }

  #insertAction(
    projectId: string,
    artifactId: string,
    versionId: string,
    idempotencyKey: string,
    createdAt: string,
    action: ArtifactActionRecord["action"],
    principalId: string,
    authorizedByPrincipalId: string | null,
    actionId: string | null = null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO actions (
          id, project_id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at
        ) VALUES (
          COALESCE(?, lower(hex(randomblob(16)))), ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        actionId,
        projectId,
        artifactId,
        versionId,
        action,
        principalId,
        authorizedByPrincipalId,
        idempotencyKey,
        createdAt,
      );
  }

  #assertStagedUploadReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT
          u.status AS status,
          u.expires_at AS expiresAt,
          u.manifest_digest AS manifestDigest,
          COUNT(f.storage_token) AS fileCount,
          COALESCE(SUM(CASE WHEN f.uploaded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS readyCount
        FROM staged_uploads u
        LEFT JOIN staged_upload_files f ON f.upload_id = u.id
        WHERE u.project_id = ? AND u.id = ? AND u.principal_id = ?
        GROUP BY u.id`,
      )
      .get(source.projectId, source.uploadId, source.principalId);
    const upload = stagedUploadCommitRowSchema.nullable().parse(row ?? null);
    if (upload === null) {
      throw new UploadNotFound({message: "The staged upload does not exist."});
    }
    if (upload.status !== uploadStatuses.open) {
      throw new UploadClosed({
        message: "The staged upload is already committed.",
      });
    }
    if (upload.expiresAt <= commitTime) {
      throw new UploadExpired({message: "The staged upload has expired."});
    }
    if (
      upload.fileCount === 0 ||
      upload.readyCount !== upload.fileCount ||
      upload.manifestDigest !== manifestDigest
    ) {
      throw new UploadIncomplete({
        message: "Every declared upload file must be verified before commit.",
      });
    }
  }

  #sealStagedUpload(source: PublicationSource, versionId: string): void {
    const update = this.#database
      .prepare(
        `UPDATE staged_uploads
         SET status = 'committed', committed_version_id = ?
         WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'`,
      )
      .run(versionId, source.projectId, source.uploadId, source.principalId);
    if (update.changes !== 1) {
      throw new UploadClosed({
        message: "The staged upload changed during commit.",
      });
    }
  }

  #insertIdempotency(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
    artifactId: string,
    versionId: string,
    createdAt: string,
    operation:
      | "change_access"
      | "change_tags"
      | "delete"
      | "publish"
      | "rename"
      | "restore" = "publish",
    accessSetting: ArtifactRecord["accessSetting"] | null = null,
    tagsJson: string | null = null,
    artifactName: string | null = null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO idempotency_records (
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, artifact_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        idempotencyKey,
        inputDigest,
        artifactId,
        versionId,
        operation,
        accessSetting,
        tagsJson,
        artifactName,
        createdAt,
      );
  }

  #insertVersion(
    projectId: string,
    artifactId: string,
    versionId: string,
    contentToken: string,
    createdAt: string,
    number: number,
    manifest: CommitNewArtifact["manifest"],
    publisherPrincipalId: string,
    publisherDisplayName: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id,
          publisher_display_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        projectId,
        artifactId,
        number,
        manifest.digest,
        manifest.entryPath,
        manifest.routingMode,
        contentToken,
        publisherPrincipalId,
        publisherDisplayName,
        createdAt,
      );

    const insertEntry = this.#database.prepare(
      `INSERT INTO manifest_entries (
        version_id, path, size, media_type, sha256, disposition
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of manifest.entries) {
      insertEntry.run(
        versionId,
        entry.path,
        entry.size,
        entry.mediaType,
        entry.sha256,
        entry.disposition,
      );
    }
  }

  createThread(command: CreateCommentThread): Promise<CommentThreadCreation> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const anchorJson = serializeCommentAnchor(command);
        const replayed = this.#readIdempotentThreadRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (replayed !== null) {
          if (
            replayed.artifactId !== command.artifactId ||
            replayed.versionId !== command.versionId ||
            replayed.path !== command.path ||
            replayed.body !== command.body ||
            replayed.anchorJson !== anchorJson
          ) {
            throw new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return {replayed: true, thread: commentThreadFromRow(replayed)};
        }
        this.#database
          .prepare(
            `INSERT INTO comment_threads (
              id, installation_id, project_id, artifact_id, version_id, path,
              anchor_json, body, state, author_principal_id,
              author_principal_kind, author_display_name,
              author_authorized_by_principal_id, resolved_at,
              resolved_by_principal_id, resolved_by_principal_kind,
              resolved_by_display_name, resolved_by_authorized_by_principal_id,
              idempotency_key, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?,
              NULL, NULL, NULL, NULL, NULL, ?, ?, ?
            )`,
          )
          .run(
            command.id,
            command.installationId,
            command.projectId,
            command.artifactId,
            command.versionId,
            command.path,
            anchorJson,
            command.body,
            command.author.principalId,
            command.author.principalKind,
            command.author.displayName,
            command.author.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.createdAt,
          );
        const createAction = commentActionIdentity(command.id);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.versionId,
          createAction.idempotencyKey,
          command.createdAt,
          artifactActionKinds.commentCreate,
          command.author.principalId,
          command.author.authorizedByPrincipalId,
          createAction.actionId,
        );
        return {
          replayed: false,
          thread: commentThreadFromRow(this.#readThreadRow(
            command.projectId,
            command.artifactId,
            command.id,
          )),
        };
      }),
    );
  }

  findThread(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<CommentThreadRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#readThreadRowOrNull(projectId, artifactId, threadId);
      return row === null ? null : commentThreadFromRow(row);
    });
  }

  findIdempotentThread(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentThreadRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#readIdempotentThreadRowOrNull(projectId, idempotencyKey);
      return row === null ? null : commentThreadFromRow(row);
    });
  }

  listThreads(command: ListCommentThreads): Promise<CommentThreadPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      // Excluding actively dispatched threads by default is what makes a
      // send consumptive on every listing surface.
      const dispatchedPredicate =
        command.dispatched === dispatchedThreadFilters.include
          ? "1 = 1"
          : command.dispatched === dispatchedThreadFilters.only
          ? "t.dispatch_id IS NOT NULL"
          : "t.dispatch_id IS NULL";
      const rows = this.#database
        .prepare(
          `${commentThreadColumns}
           WHERE t.project_id = ? AND t.artifact_id = ?
             AND ${dispatchedPredicate}
             AND (? IS NULL OR t.version_id = ?)
             AND (? IS NULL OR t.state = ?)
             AND (? IS NULL OR t.updated_at >= ?)
             AND (
               ? IS NULL
               OR t.created_at < ?
               OR (t.created_at = ? AND t.id < ?)
             )
           ORDER BY t.created_at DESC, t.id DESC
           LIMIT ?`,
        )
        .all(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.versionId,
          command.state,
          command.state,
          command.since,
          command.since,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      return pageFromRows(
        z.array(commentThreadRowSchema).parse(rows).map(commentThreadFromRow),
        command.limit,
      );
    });
  }

  updateThread(command: UpdateCommentThread): Promise<CommentThreadRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (row === null) throw missingComment();
        const resolution = command.state?.resolvedBy ?? null;
        this.#database
          .prepare(
            `UPDATE comment_threads
             SET body = ?,
               anchor_json = ?,
               state = ?,
               resolved_at = ?,
               resolved_by_principal_id = ?,
               resolved_by_principal_kind = ?,
               resolved_by_display_name = ?,
               resolved_by_authorized_by_principal_id = ?,
               updated_at = ?
             WHERE id = ? AND project_id = ? AND artifact_id = ?`,
          )
          .run(
            command.body ?? row.body,
            command.anchor === null
              ? row.anchorJson
              : serializeCommentAnchor(command.anchor),
            command.state?.state ?? row.state,
            command.state === null ? row.resolvedAt : command.state.resolvedAt,
            command.state === null
              ? row.resolvedByPrincipalId
              : resolution?.principalId ?? null,
            command.state === null
              ? row.resolvedByPrincipalKind
              : resolution?.principalKind ?? null,
            command.state === null
              ? row.resolvedByDisplayName
              : resolution?.displayName ?? null,
            command.state === null
              ? row.resolvedByAuthorizedByPrincipalId
              : resolution?.authorizedByPrincipalId ?? null,
            command.updatedAt,
            command.threadId,
            command.projectId,
            command.artifactId,
          );
        if (command.state?.state === commentThreadStates.open) {
          this.#releaseSpentDispatchMarker(command.threadId);
        }
        const commentAction = commentActionIdentity(command.threadId);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          row.versionId,
          commentAction.idempotencyKey,
          command.updatedAt,
          commentUpdateActionKind(command),
          command.principalId,
          command.authorizedByPrincipalId,
          commentAction.actionId,
        );
        return commentThreadFromRow(this.#readThreadRow(
          command.projectId,
          command.artifactId,
          command.threadId,
        ));
      }),
    );
  }

  deleteThread(command: DeleteCommentThread): Promise<CommentThreadDeletion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (row === null) throw missingComment();
        const dispatchState = z.object({
          state: agentDispatchStateSchema.nullable(),
        }).parse(
          this.#database.prepare(
            `SELECT d.state AS state
             FROM comment_threads t
             LEFT JOIN agent_dispatches d ON d.id = t.dispatch_id
             WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?`,
          ).get(command.threadId, command.projectId, command.artifactId),
        ).state;
        if (dispatchHoldsCommentThread(dispatchState)) {
          throw dispatchedCommentDeletionConflict();
        }
        const removedReplies = this.#database
          .prepare("DELETE FROM comment_replies WHERE thread_id = ?")
          .run(command.threadId);
        this.#database
          .prepare(
            `DELETE FROM comment_threads
             WHERE id = ? AND project_id = ? AND artifact_id = ?`,
          )
          .run(command.threadId, command.projectId, command.artifactId);
        const commentAction = commentActionIdentity(command.threadId);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          row.versionId,
          commentAction.idempotencyKey,
          command.deletedAt,
          artifactActionKinds.commentDelete,
          command.principalId,
          command.authorizedByPrincipalId,
          commentAction.actionId,
        );
        return {
          deletedReplyCount: Number(removedReplies.changes),
          thread: commentThreadFromRow(row),
        };
      }),
    );
  }

  clearThreads(command: ClearCommentThreads): Promise<CommentThreadClearing> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const rows = z.array(clearableThreadRowSchema).parse(
          this.#database
            .prepare(
              `SELECT t.id AS id, t.version_id AS versionId,
                 d.state AS dispatchState
               FROM comment_threads t
               LEFT JOIN agent_dispatches d ON d.id = t.dispatch_id
               WHERE t.project_id = ? AND t.artifact_id = ?
                 AND (? IS NULL OR t.version_id = ?)
                 AND (? = 'all' OR t.state = 'resolved')
               ORDER BY t.created_at ASC, t.id ASC`,
            )
            .all(
              command.projectId,
              command.artifactId,
              command.versionId,
              command.versionId,
              command.scope,
            ),
        );
        let deleted = 0;
        let skippedDispatched = 0;
        for (const row of rows) {
          // Clearing never yanks work out from under an agent: a thread held
          // by a queued, claimed, or delivered dispatch stays, and the caller
          // learns how many did.
          if (dispatchHoldsCommentThread(row.dispatchState)) {
            skippedDispatched += 1;
            continue;
          }
          this.#database
            .prepare("DELETE FROM comment_replies WHERE thread_id = ?")
            .run(row.id);
          this.#database
            .prepare(
              `DELETE FROM comment_threads
               WHERE id = ? AND project_id = ? AND artifact_id = ?`,
            )
            .run(row.id, command.projectId, command.artifactId);
          const commentAction = commentActionIdentity(row.id);
          this.#insertAction(
            command.projectId,
            command.artifactId,
            row.versionId,
            commentAction.idempotencyKey,
            command.clearedAt,
            artifactActionKinds.commentDelete,
            command.principalId,
            command.authorizedByPrincipalId,
            commentAction.actionId,
          );
          deleted += 1;
        }
        return {deleted, skippedDispatched};
      }),
    );
  }

  createReply(command: CreateCommentReply): Promise<CommentReplyCreation> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#readIdempotentReplyRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (replayed !== null) {
          if (
            replayed.threadId !== command.threadId ||
            replayed.body !== command.body
          ) {
            throw new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return {replayed: true, reply: commentReplyFromRow(replayed)};
        }
        const inserted = this.#database
          .prepare(
            `INSERT INTO comment_replies (
              id, thread_id, project_id, body, author_principal_id,
              author_principal_kind, author_display_name,
              author_authorized_by_principal_id, idempotency_key,
              created_at, updated_at
            )
            SELECT ?, t.id, t.project_id, ?, ?, ?, ?, ?, ?, ?, ?
            FROM comment_threads t
            WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?
              AND t.state = 'open'`,
          )
          .run(
            command.id,
            command.body,
            command.author.principalId,
            command.author.principalKind,
            command.author.displayName,
            command.author.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.createdAt,
            command.threadId,
            command.projectId,
            command.artifactId,
          );
        const thread = this.#readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (thread === null) throw missingComment();
        if (inserted.changes !== 1) {
          throw new CommentResolved({
            message: "The comment thread is resolved and cannot accept replies.",
          });
        }
        this.#touchThread(command.threadId, command.createdAt);
        const replyAction = commentActionIdentity(command.threadId);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          thread.versionId,
          replyAction.idempotencyKey,
          command.createdAt,
          artifactActionKinds.commentReply,
          command.author.principalId,
          command.author.authorizedByPrincipalId,
          replyAction.actionId,
        );
        return {
          replayed: false,
          reply: commentReplyFromRow(this.#readReplyRow(command.id)),
        };
      }),
    );
  }

  findIdempotentReply(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentReplyRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#readIdempotentReplyRowOrNull(projectId, idempotencyKey);
      return row === null ? null : commentReplyFromRow(row);
    });
  }

  listReplies(threadId: string): Promise<readonly CommentReplyRecord[]> {
    return Promise.resolve().then(() =>
      z.array(commentReplyRowSchema).parse(
        this.#database
          .prepare(
            `${commentReplyColumns}
             WHERE r.thread_id = ?
             ORDER BY r.created_at ASC, r.id ASC`,
          )
          .all(threadId),
      ).map(commentReplyFromRow),
    );
  }

  updateReply(command: UpdateCommentReply): Promise<CommentReplyRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const thread = this.#requireReplyThread(command);
        this.#database
          .prepare(
            `UPDATE comment_replies
             SET body = ?, updated_at = ?
             WHERE id = ? AND thread_id = ?`,
          )
          .run(command.body, command.updatedAt, command.replyId, command.threadId);
        this.#touchThread(command.threadId, command.updatedAt);
        const commentAction = commentActionIdentity(command.threadId);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          thread.versionId,
          commentAction.idempotencyKey,
          command.updatedAt,
          artifactActionKinds.commentUpdate,
          command.principalId,
          command.authorizedByPrincipalId,
          commentAction.actionId,
        );
        return commentReplyFromRow(this.#readReplyRow(command.replyId));
      }),
    );
  }

  deleteReply(command: DeleteCommentReply): Promise<void> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const thread = this.#requireReplyThread(command);
        this.#database
          .prepare("DELETE FROM comment_replies WHERE id = ? AND thread_id = ?")
          .run(command.replyId, command.threadId);
        this.#touchThread(command.threadId, command.deletedAt);
        const commentAction = commentActionIdentity(command.threadId);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          thread.versionId,
          commentAction.idempotencyKey,
          command.deletedAt,
          artifactActionKinds.commentDelete,
          command.principalId,
          command.authorizedByPrincipalId,
          commentAction.actionId,
        );
      }),
    );
  }

  versionContainsPath(
    projectId: string,
    versionId: string,
    path: string,
  ): Promise<boolean> {
    return Promise.resolve().then(() =>
      this.#database
        .prepare(
          `SELECT 1 AS found
           FROM manifest_entries entry
           INNER JOIN versions version ON version.id = entry.version_id
           WHERE version.project_id = ? AND entry.version_id = ? AND entry.path = ?`,
        )
        .get(projectId, versionId, path) !== undefined
    );
  }

  registerAgent(command: RegisterAgent): Promise<RegisteredAgentRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        // The connection key is scoped to the registering principal: one
        // principal never reclaims another's row, and with it another's
        // queued dispatches.
        const existing = this.#database
          .prepare(
            `SELECT id AS id FROM registered_agents
             WHERE installation_id = ? AND principal_id = ?
               AND connection_key = ?`,
          )
          .get(
            command.installationId,
            command.principalId,
            command.connectionKey,
          );
        const found = z.object({id: z.string()}).nullable().parse(
          existing ?? null,
        );
        if (found === null) {
          this.#database
            .prepare(
              `INSERT INTO registered_agents (
                id, installation_id, connection_key, display_name, kind,
                working_directory, agent_session_id, principal_id,
                created_at, last_seen_at, capabilities_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.id,
              command.installationId,
              command.connectionKey,
              command.displayName,
              command.kind,
              command.workingDirectory,
              command.agentSessionId,
              command.principalId,
              command.registeredAt,
              command.registeredAt,
              JSON.stringify(command.capabilities),
            );
          return this.#readRegisteredAgentRow(command.installationId, command.id);
        }
        // The id survives re-registration so pending dispatches stay queued
        // for the same agent across restarts and session replacements.
        this.#database
          .prepare(
            `UPDATE registered_agents
             SET display_name = ?, kind = ?, working_directory = ?,
               agent_session_id = ?, last_seen_at = ?, capabilities_json = ?
             WHERE installation_id = ? AND id = ?`,
          )
          .run(
            command.displayName,
            command.kind,
            command.workingDirectory,
            command.agentSessionId,
            command.registeredAt,
            JSON.stringify(command.capabilities),
            command.installationId,
            found.id,
          );
        return this.#readRegisteredAgentRow(command.installationId, found.id);
      }),
    );
  }

  disconnectAgent(installationId: string, agentId: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.#database
        .prepare(
          "DELETE FROM registered_agents WHERE installation_id = ? AND id = ?",
        )
        .run(installationId, agentId);
      return undefined;
    });
  }

  listAgents(
    installationId: string,
    now: string,
  ): Promise<readonly RegisteredAgentPresence[]> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        // Rows are disposable liveness records: reap what stopped polling.
        this.#database
          .prepare(
            `DELETE FROM registered_agents
             WHERE installation_id = ? AND last_seen_at < ?`,
          )
          .run(
            installationId,
            isoBefore(now, registeredAgentRetentionMilliseconds),
          );
        const rows = this.#database
          .prepare(
            `${registeredAgentColumns}
             WHERE installation_id = ?
             ORDER BY created_at ASC, id ASC`,
          )
          .all(installationId);
        return z.array(registeredAgentRowSchema).parse(rows)
          .map((agent) => this.#agentPresence(agent));
      }),
    );
  }

  /**
   * Presence facts per spec §3.2, joined lazily at read: the working
   * dispatch is the newest claimed/delivered one whose bundle threads are
   * not all resolved, and no activity state is ever written here.
   */
  #agentPresence(agent: RegisteredAgentRecord): RegisteredAgentPresence {
    const latest = latestDispatchTransitionRowSchema.parse(
      this.#database
        .prepare(
          `SELECT MAX(updated_at) AS latestAt FROM agent_dispatches
           WHERE agent_id = ?`,
        )
        .get(agent.id),
    );
    const candidates = z.array(workingDispatchCandidateRowSchema).parse(
      this.#database
        .prepare(
          `SELECT id AS id, thread_ids_json AS threadIdsJson
           FROM agent_dispatches
           WHERE agent_id = ? AND state IN ('claimed', 'delivered')
           ORDER BY updated_at DESC, id DESC`,
        )
        .all(agent.id),
    );
    const active = candidates.find((candidate) =>
      this.#holdsUnresolvedThread(candidate.threadIdsJson)
    );
    return {
      activeDispatchId: active?.id ?? null,
      agent,
      latestDispatchTransitionAt: latest.latestAt,
    };
  }

  #holdsUnresolvedThread(threadIdsJson: string): boolean {
    const threadIds = threadIdsSchema.parse(JSON.parse(threadIdsJson));
    if (threadIds.length === 0) return false;
    const placeholders = threadIds.map(() => "?").join(", ");
    const counted = countRowSchema.parse(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS resolvedCount FROM comment_threads
           WHERE state = 'resolved' AND id IN (${placeholders})`,
        )
        .get(...threadIds),
    );
    return counted.resolvedCount !== threadIds.length;
  }

  recordActivity(command: RecordAgentActivity): Promise<void> {
    return Promise.resolve().then(() => {
      // Beacons are display metadata: the newest write wins unconditionally,
      // and the read side applies TTL decay and the liveness gate.
      this.#database
        .prepare(
          `UPDATE registered_agents SET activity_state = ?, activity_at = ?
           WHERE installation_id = ? AND id = ?`,
        )
        .run(
          command.state,
          command.observedAt,
          command.installationId,
          command.agentId,
        );
      return undefined;
    });
  }

  findAgent(
    installationId: string,
    agentId: string,
  ): Promise<RegisteredAgentRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `${registeredAgentColumns} WHERE installation_id = ? AND id = ?`,
        )
        .get(installationId, agentId);
      return registeredAgentRowSchema.nullable().parse(row ?? null);
    });
  }

  createDispatch(command: CreateAgentDispatch): Promise<AgentDispatchCreation> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const threadIdsJson = JSON.stringify(command.threadIds);
        const replayed = this.#readIdempotentDispatchRowOrNull(
          command.installationId,
          command.projectId,
          command.idempotencyKey,
        );
        if (replayed !== null) {
          if (
            replayed.agentId !== command.agentId ||
            replayed.threadIdsJson !== threadIdsJson ||
            replayed.note !== command.note
          ) {
            throw new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return {dispatch: agentDispatchFromRow(replayed), replayed: true};
        }
        // Every thread must be open and unclaimed by another dispatch inside
        // the same transaction that stamps the markers, so two concurrent
        // sends can never double-book a thread and a rejected bundle leaves
        // no partial markers behind.
        const checkThread = this.#database.prepare(
          `SELECT id AS id, state AS state, dispatch_id AS dispatchId
           FROM comment_threads
           WHERE id = ? AND installation_id = ? AND project_id = ?`,
        );
        for (const threadId of command.threadIds) {
          const row = dispatchThreadCheckRowSchema.nullable().parse(
            checkThread.get(
              threadId,
              command.installationId,
              command.projectId,
            ) ?? null,
          );
          if (row === null) {
            throw new InvalidDispatch({
              message:
                "The bundle references a comment thread that does not exist in this project.",
            });
          }
          if (row.state !== commentThreadStates.open) {
            throw new InvalidDispatch({
              message: "The bundle references a comment thread that is not open.",
            });
          }
          if (row.dispatchId !== null) {
            throw new InvalidDispatch({
              message:
                "The bundle references a comment thread that is already dispatched.",
            });
          }
        }
        this.#database
          .prepare(
            `INSERT INTO agent_dispatches (
              id, installation_id, project_id, agent_id, agent_display_name,
              thread_ids_json, note, state, sender_principal_id,
              sender_principal_kind, sender_display_name,
              sender_authorized_by_principal_id, idempotency_key,
              claimed_at, lease_expires_at, delivered_at, addressed_at,
              failed_at, failure_reason, canceled_at, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
            )`,
          )
          .run(
            command.id,
            command.installationId,
            command.projectId,
            command.agentId,
            command.agentDisplayName,
            threadIdsJson,
            command.note,
            command.sender.principalId,
            command.sender.principalKind,
            command.sender.displayName,
            command.sender.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.createdAt,
          );
        // The marker moves the thread off the default listings, so it counts
        // as a thread edit: an incremental `since` poller must see it leave.
        const markThread = this.#database.prepare(
          `UPDATE comment_threads SET dispatch_id = ?, updated_at = ?
           WHERE id = ? AND project_id = ? AND state = 'open'
             AND dispatch_id IS NULL`,
        );
        for (const threadId of command.threadIds) {
          const marked = markThread.run(
            command.id,
            command.createdAt,
            threadId,
            command.projectId,
          );
          if (marked.changes !== 1) {
            throw new Error(
              `Comment thread ${threadId} could not be marked dispatched inside its validating transaction.`,
            );
          }
        }
        return {
          dispatch: agentDispatchFromRow(
            this.#readDispatchRow(command.installationId, command.id),
          ),
          replayed: false,
        };
      }),
    );
  }

  claimNextDispatch(
    agentId: string,
    now: string,
    bumpHeartbeat: boolean,
  ): Promise<AgentDispatchRecord | null> {
    return Promise.resolve().then(() => {
      // A re-check inside one held poll is a pure read while nothing is
      // claimable: the request's first attempt already stamped the heartbeat,
      // so an empty mailbox must not open a write transaction every second.
      if (!bumpHeartbeat && !this.#claimAttemptHasWork(agentId, now)) {
        return null;
      }
      return this.#transaction(() => {
        // The poll request is the heartbeat, and every attempt that reaches
        // the write path — heartbeat or successful claim — refreshes it.
        this.#database
          .prepare("UPDATE registered_agents SET last_seen_at = ? WHERE id = ?")
          .run(now, agentId);
        // An expired lease returns its dispatch to the queue before the
        // oldest-queued selection, so a dead claimer never wedges the FIFO.
        this.#database
          .prepare(
            `UPDATE agent_dispatches
             SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
               updated_at = ?
             WHERE agent_id = ? AND state = 'claimed' AND lease_expires_at < ?`,
          )
          .run(now, agentId, now);
        const active = this.#database
          .prepare(
            `SELECT id AS id FROM agent_dispatches
             WHERE agent_id = ? AND state = 'claimed' LIMIT 1`,
          )
          .get(agentId);
        // One-active-claim: while a claim is held, the next claim waits.
        if (active !== undefined) return null;
        const candidate = this.#database
          .prepare(
            `SELECT id AS id, installation_id AS installationId
             FROM agent_dispatches
             WHERE agent_id = ? AND state = 'queued'
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
          )
          .get(agentId);
        const oldest = z.object({id: z.string(), installationId: z.string()})
          .nullable().parse(candidate ?? null);
        if (oldest === null) return null;
        const claimed = this.#database
          .prepare(
            `UPDATE agent_dispatches
             SET state = 'claimed', claimed_at = ?, lease_expires_at = ?,
               updated_at = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(
            now,
            isoAfter(now, agentDispatchLeaseMilliseconds),
            now,
            oldest.id,
          );
        if (claimed.changes !== 1) return null;
        return agentDispatchFromRow(
          this.#readDispatchRow(oldest.installationId, oldest.id),
        );
      });
    });
  }

  /**
   * Whether a claim re-check would change anything: an expired lease needs
   * the sweep before the FIFO, an unexpired active claim blocks the poll
   * outright, and otherwise only a queued dispatch is worth a transaction.
   */
  #claimAttemptHasWork(agentId: string, now: string): boolean {
    const expired = this.#database
      .prepare(
        `SELECT id AS id FROM agent_dispatches
         WHERE agent_id = ? AND state = 'claimed' AND lease_expires_at < ?
         LIMIT 1`,
      )
      .get(agentId, now);
    if (expired !== undefined) return true;
    const active = this.#database
      .prepare(
        `SELECT id AS id FROM agent_dispatches
         WHERE agent_id = ? AND state = 'claimed' LIMIT 1`,
      )
      .get(agentId);
    if (active !== undefined) return false;
    const queued = this.#database
      .prepare(
        `SELECT id AS id FROM agent_dispatches
         WHERE agent_id = ? AND state = 'queued' LIMIT 1`,
      )
      .get(agentId);
    return queued !== undefined;
  }

  markDelivered(command: MarkDispatchDelivered): Promise<AgentDispatchRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readDispatchRowOrNull(
          command.installationId,
          command.dispatchId,
        );
        if (row === null) throw missingDispatch();
        this.#requireClaimHolder(row, command.agentId);
        if (row.state !== agentDispatchStates.claimed) {
          throw new DispatchStateConflict({
            message: `A ${row.state} dispatch cannot be reported delivered.`,
          });
        }
        this.#database
          .prepare(
            `UPDATE agent_dispatches
             SET state = 'delivered', delivered_at = ?, updated_at = ?
             WHERE id = ? AND state = 'claimed'`,
          )
          .run(command.deliveredAt, command.deliveredAt, row.id);
        return agentDispatchFromRow(
          this.#readDispatchRow(command.installationId, row.id),
        );
      }),
    );
  }

  markFailed(command: MarkDispatchFailed): Promise<AgentDispatchRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readDispatchRowOrNull(
          command.installationId,
          command.dispatchId,
        );
        if (row === null) throw missingDispatch();
        this.#requireClaimHolder(row, command.agentId);
        if (
          row.state !== agentDispatchStates.claimed &&
          row.state !== agentDispatchStates.delivered
        ) {
          throw new DispatchStateConflict({
            message: `A ${row.state} dispatch cannot be reported failed.`,
          });
        }
        this.#failDispatch(row.id, command.reason, command.failedAt);
        return agentDispatchFromRow(
          this.#readDispatchRow(command.installationId, row.id),
        );
      }),
    );
  }

  cancelDispatch(command: CancelAgentDispatch): Promise<AgentDispatchRecord> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readDispatchRowOrNull(
          command.installationId,
          command.dispatchId,
        );
        if (row === null || row.projectId !== command.projectId) {
          throw missingDispatch();
        }
        if (
          row.state !== agentDispatchStates.queued &&
          row.state !== agentDispatchStates.claimed
        ) {
          throw new DispatchStateConflict({
            message: `A ${row.state} dispatch cannot be canceled.`,
          });
        }
        // Cancellation clears the markers so the threads reappear in the
        // default listings: work is never silently lost.
        this.#database
          .prepare(
            `UPDATE agent_dispatches
             SET state = 'canceled', canceled_at = ?, updated_at = ?,
               claimed_at = NULL, lease_expires_at = NULL
             WHERE id = ?`,
          )
          .run(command.canceledAt, command.canceledAt, row.id);
        this.#clearDispatchMarkers(row.id, command.canceledAt);
        return agentDispatchFromRow(
          this.#readDispatchRow(command.installationId, row.id),
        );
      }),
    );
  }

  listDispatches(command: ListAgentDispatches): Promise<AgentDispatchPage> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        this.#applyLazyProjectTransitions(
          command.installationId,
          command.projectId,
          command.now,
        );
        const cursorCreatedAt = command.cursor?.createdAt ?? null;
        const cursorId = command.cursor?.id ?? null;
        const rows = this.#database
          .prepare(
            `${agentDispatchColumns}
             WHERE d.installation_id = ? AND d.project_id = ?
               AND (? IS NULL OR d.state = ?)
               AND (? IS NULL OR d.agent_id = ?)
               AND (
                 ? IS NULL
                 OR d.created_at < ?
                 OR (d.created_at = ? AND d.id < ?)
               )
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT ?`,
          )
          .all(
            command.installationId,
            command.projectId,
            command.state,
            command.state,
            command.agentId,
            command.agentId,
            cursorCreatedAt,
            cursorCreatedAt,
            cursorCreatedAt,
            cursorId,
            command.limit + 1,
          );
        return pageFromRows(
          z.array(agentDispatchRowSchema).parse(rows).map(agentDispatchFromRow),
          command.limit,
        );
      }),
    );
  }

  findDispatch(
    installationId: string,
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readDispatchRowOrNull(installationId, dispatchId);
        if (row === null) return null;
        this.#applyLazyDispatchTransitions(row, now);
        return agentDispatchFromRow(
          this.#readDispatchRow(installationId, dispatchId),
        );
      }),
    );
  }

  observeAddressed(
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#readAnyDispatchRowOrNull(dispatchId);
        if (row === null) return null;
        this.#stampAddressedWhenResolved(row, now);
        return agentDispatchFromRow(
          this.#readDispatchRow(row.installationId, dispatchId),
        );
      }),
    );
  }

  #requireClaimHolder(
    row: z.infer<typeof agentDispatchRowSchema>,
    agentId: string,
  ): void {
    if (row.agentId === agentId) return;
    throw new DispatchStateConflict({
      message: "The reporting agent does not hold this dispatch.",
    });
  }

  #failDispatch(dispatchId: string, reason: string, failedAt: string): void {
    this.#database
      .prepare(
        `UPDATE agent_dispatches
         SET state = 'failed', failed_at = ?, failure_reason = ?,
           updated_at = ?, claimed_at = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(failedAt, reason, failedAt, dispatchId);
    // A permanent failure returns the annotations to the artifact surfaces.
    this.#clearDispatchMarkers(dispatchId, failedAt);
  }

  #clearDispatchMarkers(dispatchId: string, clearedAt: string): void {
    // Releasing the marker returns the thread to the default listings, so it
    // counts as a thread edit: an incremental `since` poller must see it back.
    this.#database
      .prepare(
        `UPDATE comment_threads SET dispatch_id = NULL, updated_at = ?
         WHERE dispatch_id = ?`,
      )
      .run(clearedAt, dispatchId);
  }

  /**
   * Reopening a thread returns it to the artifact surfaces. A marker whose
   * bundle already reached the agent has nothing left to hold: keeping it
   * would strand the reopened thread off every default listing and refuse
   * every later send, with no route that clears it.
   */
  #releaseSpentDispatchMarker(threadId: string): void {
    this.#database
      .prepare(
        `UPDATE comment_threads SET dispatch_id = NULL
         WHERE id = ? AND state = 'open' AND dispatch_id IN (
           SELECT id FROM agent_dispatches
           WHERE state IN ('delivered', 'addressed', 'failed', 'canceled')
         )`,
      )
      .run(threadId);
  }

  /**
   * The lazy transition set applied on the read path, in machine order:
   * an expired claim lease returns to queued, a queued dispatch whose agent
   * stopped polling fails as agent_unavailable, and a delivered dispatch
   * whose every bundle thread is resolved is stamped addressed once.
   */
  #applyLazyDispatchTransitions(
    row: z.infer<typeof agentDispatchRowSchema>,
    now: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE agent_dispatches
         SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
           updated_at = ?
         WHERE id = ? AND state = 'claimed' AND lease_expires_at < ?`,
      )
      .run(now, row.id, now);
    const failed = this.#database
      .prepare(
        `UPDATE agent_dispatches
         SET state = 'failed', failed_at = ?, failure_reason = 'agent_unavailable',
           updated_at = ?, claimed_at = NULL, lease_expires_at = NULL
         WHERE id = ? AND state = 'queued' AND NOT EXISTS (
           SELECT 1 FROM registered_agents a
           WHERE a.id = agent_dispatches.agent_id AND a.last_seen_at >= ?
         )`,
      )
      .run(
        now,
        now,
        row.id,
        isoBefore(now, agentUnavailableStalenessMilliseconds),
      );
    if (failed.changes === 1) {
      this.#clearDispatchMarkers(row.id, now);
      return;
    }
    this.#stampAddressedWhenResolved(row, now);
  }

  #applyLazyProjectTransitions(
    installationId: string,
    projectId: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE agent_dispatches
         SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
           updated_at = ?
         WHERE installation_id = ? AND project_id = ?
           AND state = 'claimed' AND lease_expires_at < ?`,
      )
      .run(now, installationId, projectId, now);
    const staleRows = this.#database
      .prepare(
        `SELECT d.id AS id FROM agent_dispatches d
         WHERE d.installation_id = ? AND d.project_id = ? AND d.state = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM registered_agents a
             WHERE a.id = d.agent_id AND a.last_seen_at >= ?
           )`,
      )
      .all(
        installationId,
        projectId,
        isoBefore(now, agentUnavailableStalenessMilliseconds),
      );
    for (const stale of z.array(z.object({id: z.string()})).parse(staleRows)) {
      this.#failDispatch(stale.id, "agent_unavailable", now);
    }
    const deliveredRows = this.#database
      .prepare(
        `${agentDispatchColumns}
         WHERE d.installation_id = ? AND d.project_id = ? AND d.state = 'delivered'`,
      )
      .all(installationId, projectId);
    for (const delivered of z.array(agentDispatchRowSchema).parse(deliveredRows)) {
      this.#stampAddressedWhenResolved(delivered, now);
    }
  }

  #stampAddressedWhenResolved(
    row: z.infer<typeof agentDispatchRowSchema>,
    now: string,
  ): void {
    if (row.state !== agentDispatchStates.delivered) return;
    const threadIds = threadIdsSchema.parse(JSON.parse(row.threadIdsJson));
    if (threadIds.length === 0) return;
    const placeholders = threadIds.map(() => "?").join(", ");
    const counted = countRowSchema.parse(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS resolvedCount FROM comment_threads
           WHERE state = 'resolved' AND id IN (${placeholders})`,
        )
        .get(...threadIds),
    );
    if (counted.resolvedCount !== threadIds.length) return;
    // Thread resolution is the ground truth; the markers stay in place
    // because the threads are resolved and already invisible.
    this.#database
      .prepare(
        `UPDATE agent_dispatches
         SET state = 'addressed', addressed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'delivered'`,
      )
      .run(now, now, row.id);
  }

  #readRegisteredAgentRow(
    installationId: string,
    agentId: string,
  ): RegisteredAgentRecord {
    const row = this.#database
      .prepare(
        `${registeredAgentColumns} WHERE installation_id = ? AND id = ?`,
      )
      .get(installationId, agentId);
    const agent = registeredAgentRowSchema.nullable().parse(row ?? null);
    if (agent === null) {
      throw new Error(
        `Registered agent ${agentId} was not found after a successful write.`,
      );
    }
    return agent;
  }

  #readDispatchRow(
    installationId: string,
    dispatchId: string,
  ): z.infer<typeof agentDispatchRowSchema> {
    const row = this.#readDispatchRowOrNull(installationId, dispatchId);
    if (row === null) {
      throw new Error(
        `Agent dispatch ${dispatchId} was not found after a successful write.`,
      );
    }
    return row;
  }

  #readDispatchRowOrNull(
    installationId: string,
    dispatchId: string,
  ): z.infer<typeof agentDispatchRowSchema> | null {
    const row = this.#database
      .prepare(
        `${agentDispatchColumns} WHERE d.installation_id = ? AND d.id = ?`,
      )
      .get(installationId, dispatchId);
    return agentDispatchRowSchema.nullable().parse(row ?? null);
  }

  #readAnyDispatchRowOrNull(
    dispatchId: string,
  ): z.infer<typeof agentDispatchRowSchema> | null {
    const row = this.#database
      .prepare(`${agentDispatchColumns} WHERE d.id = ?`)
      .get(dispatchId);
    return agentDispatchRowSchema.nullable().parse(row ?? null);
  }

  #readIdempotentDispatchRowOrNull(
    installationId: string,
    projectId: string,
    idempotencyKey: string,
  ): z.infer<typeof agentDispatchRowSchema> | null {
    const row = this.#database
      .prepare(
        `${agentDispatchColumns}
         WHERE d.installation_id = ? AND d.project_id = ?
           AND d.idempotency_key = ?`,
      )
      .get(installationId, projectId, idempotencyKey);
    return agentDispatchRowSchema.nullable().parse(row ?? null);
  }

  #requireReplyThread(
    command: DeleteCommentReply | UpdateCommentReply,
  ): z.infer<typeof commentThreadRowSchema> {
    const thread = this.#readThreadRowOrNull(
      command.projectId,
      command.artifactId,
      command.threadId,
    );
    if (thread === null) throw missingComment();
    const reply = this.#database
      .prepare("SELECT id FROM comment_replies WHERE id = ? AND thread_id = ?")
      .get(command.replyId, command.threadId);
    if (reply === undefined) throw missingComment();
    return thread;
  }

  #touchThread(threadId: string, updatedAt: string): void {
    this.#database
      .prepare("UPDATE comment_threads SET updated_at = ? WHERE id = ?")
      .run(updatedAt, threadId);
  }

  #readThreadRow(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): z.infer<typeof commentThreadRowSchema> {
    const row = this.#readThreadRowOrNull(projectId, artifactId, threadId);
    if (row === null) {
      throw new Error(
        `Comment thread ${threadId} was not found after a successful write.`,
      );
    }
    return row;
  }

  #readThreadRowOrNull(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): z.infer<typeof commentThreadRowSchema> | null {
    const row = this.#database
      .prepare(
        `${commentThreadColumns}
         WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?`,
      )
      .get(threadId, projectId, artifactId);
    return commentThreadRowSchema.nullable().parse(row ?? null);
  }

  #readIdempotentThreadRowOrNull(
    projectId: string,
    idempotencyKey: string,
  ): z.infer<typeof commentThreadRowSchema> | null {
    const row = this.#database
      .prepare(
        `${commentThreadColumns}
         WHERE t.project_id = ? AND t.idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    return commentThreadRowSchema.nullable().parse(row ?? null);
  }

  #readReplyRow(replyId: string): z.infer<typeof commentReplyRowSchema> {
    const row = this.#database
      .prepare(`${commentReplyColumns} WHERE r.id = ?`)
      .get(replyId);
    const reply = commentReplyRowSchema.nullable().parse(row ?? null);
    if (reply === null) {
      throw new Error(
        `Comment reply ${replyId} was not found after a successful write.`,
      );
    }
    return reply;
  }

  #readIdempotentReplyRowOrNull(
    projectId: string,
    idempotencyKey: string,
  ): z.infer<typeof commentReplyRowSchema> | null {
    const row = this.#database
      .prepare(
        `${commentReplyColumns}
         WHERE r.project_id = ? AND r.idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    return commentReplyRowSchema.nullable().parse(row ?? null);
  }

  #addCommentTablesIfMissing(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS comment_threads (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        path TEXT,
        anchor_json TEXT,
        body TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        author_principal_id TEXT NOT NULL,
        author_principal_kind TEXT NOT NULL
          CHECK (author_principal_kind IN ('human', 'service')),
        author_display_name TEXT NOT NULL,
        author_authorized_by_principal_id TEXT,
        resolved_at TEXT,
        resolved_by_principal_id TEXT,
        resolved_by_principal_kind TEXT
          CHECK (
            resolved_by_principal_kind IS NULL
            OR resolved_by_principal_kind IN ('human', 'service')
          ),
        resolved_by_display_name TEXT,
        resolved_by_authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS comment_replies (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        body TEXT NOT NULL,
        author_principal_id TEXT NOT NULL,
        author_principal_kind TEXT NOT NULL
          CHECK (author_principal_kind IN ('human', 'service')),
        author_display_name TEXT NOT NULL,
        author_authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, idempotency_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS comment_threads_artifact_created
        ON comment_threads (artifact_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS comment_threads_version_created
        ON comment_threads (version_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS comment_threads_updated
        ON comment_threads (artifact_id, updated_at);
      CREATE INDEX IF NOT EXISTS comment_replies_thread_created
        ON comment_replies (thread_id, created_at, id);
    `);
  }

  #addAgentDispatchTablesIfMissing(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS registered_agents (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        connection_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        agent_session_id TEXT,
        principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        capabilities_json TEXT,
        activity_state TEXT,
        activity_at TEXT,
        UNIQUE (installation_id, principal_id, connection_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_dispatches (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        agent_id TEXT NOT NULL,
        agent_display_name TEXT NOT NULL,
        thread_ids_json TEXT NOT NULL,
        note TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('queued', 'claimed', 'delivered', 'addressed', 'failed', 'canceled')
        ),
        sender_principal_id TEXT NOT NULL,
        sender_principal_kind TEXT NOT NULL
          CHECK (sender_principal_kind IN ('human', 'service')),
        sender_display_name TEXT NOT NULL,
        sender_authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        claimed_at TEXT,
        lease_expires_at TEXT,
        delivered_at TEXT,
        addressed_at TEXT,
        failed_at TEXT,
        failure_reason TEXT,
        canceled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (installation_id, project_id, idempotency_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS agent_dispatches_claim
        ON agent_dispatches (agent_id, state, created_at, id);
      CREATE INDEX IF NOT EXISTS agent_dispatches_project_created
        ON agent_dispatches (project_id, created_at DESC, id DESC);
    `);
    if (!this.#tableColumns("comment_threads").includes("dispatch_id")) {
      this.#database.exec(
        "ALTER TABLE comment_threads ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id)",
      );
    }
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS comment_threads_dispatch
        ON comment_threads (dispatch_id);
    `);
  }

  /**
   * Rebuild `registered_agents` without the closed-set kind CHECK and with
   * the capability and activity columns. The kind is validated as a slug in
   * the application layer; the schema stops constraining it. Rows are
   * disposable liveness records, but they still copy across so a live agent
   * keeps its queued dispatches through the upgrade.
   */
  #widenRegisteredAgentsIfNeeded(): void {
    const row = this.#database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'registered_agents'",
      )
      .get();
    const {sql} = z.object({sql: z.string()}).parse(row);
    if (sql.includes("capabilities_json")) return;
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE registered_agents_next (
          id TEXT PRIMARY KEY,
          installation_id TEXT NOT NULL,
          connection_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          agent_session_id TEXT,
          principal_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          capabilities_json TEXT,
          activity_state TEXT,
          activity_at TEXT,
          UNIQUE (installation_id, principal_id, connection_key)
        ) STRICT;
        INSERT INTO registered_agents_next (
          id, installation_id, connection_key, display_name, kind,
          working_directory, agent_session_id, principal_id,
          created_at, last_seen_at
        ) SELECT
          id, installation_id, connection_key, display_name, kind,
          working_directory, agent_session_id, principal_id,
          created_at, last_seen_at
        FROM registered_agents;
        DROP TABLE registered_agents;
        ALTER TABLE registered_agents_next RENAME TO registered_agents;
      `);
    });
  }

  #migrate(installationId: string): void {
    const previousSchemaVersion = z.object({
      user_version: z.number().int().nonnegative(),
    }).parse(this.#database.prepare("PRAGMA user_version").get()).user_version;
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        search_name TEXT NOT NULL,
        access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        number INTEGER NOT NULL CHECK (number > 0),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
        content_token TEXT NOT NULL UNIQUE,
        publisher_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (artifact_id, number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS manifest_entries (
        version_id TEXT NOT NULL REFERENCES versions(id),
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
        PRIMARY KEY (version_id, path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_tags (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (artifact_id, tag)
      ) STRICT;

      -- One row is one artifact on one UTC day. Nothing here names a viewer.
      CREATE TABLE IF NOT EXISTS artifact_views (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        day TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        PRIMARY KEY (artifact_id, day)
      ) STRICT;

      -- One row is one folder of the public tree that starts collapsed.
      CREATE TABLE IF NOT EXISTS collapsed_folders (
        path TEXT PRIMARY KEY
      ) STRICT;

      -- One row is one file in an artifact's asset store, outside every
      -- version. The bytes are the shared content-addressed blob. Deletion is
      -- a tombstone, so a replayed key still finds the row it wrote.
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        sha256 TEXT NOT NULL,
        name TEXT NOT NULL,
        created_by_principal_id TEXT NOT NULL,
        created_by_display_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE (project_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assets_live_by_artifact
        ON assets (artifact_id, created_at) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS idempotency_records (
        project_id TEXT NOT NULL REFERENCES projects(id),
        idempotency_key TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'rename', 'delete')),
        access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
        tags_json TEXT,
        artifact_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS staged_uploads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        committed_version_id TEXT REFERENCES versions(id),
        CHECK (
          (status = 'open' AND committed_version_id IS NULL)
          OR (status = 'committed' AND committed_version_id IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS staged_upload_files (
        upload_id TEXT NOT NULL REFERENCES staged_uploads(id),
        storage_token TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
        uploaded_at TEXT,
        PRIMARY KEY (upload_id, path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS content_bootstraps (
        token_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        content_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS content_sessions (
        token_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        content_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS versions_artifact_id
        ON versions (artifact_id, number);
      CREATE INDEX IF NOT EXISTS artifacts_active_created
        ON artifacts (deleted_at, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS artifact_tags_tag_artifact
        ON artifact_tags (tag, artifact_id);
      CREATE INDEX IF NOT EXISTS actions_artifact_created
        ON actions (artifact_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS manifest_entries_sha256
        ON manifest_entries (sha256);
      CREATE INDEX IF NOT EXISTS staged_uploads_expiry
        ON staged_uploads (status, expires_at);
      CREATE INDEX IF NOT EXISTS content_bootstraps_expiry
        ON content_bootstraps (expires_at, consumed_at);
      CREATE INDEX IF NOT EXISTS content_sessions_expiry
        ON content_sessions (expires_at);
    `);
    this.#addVersionPublisherColumnIfMissing();
    this.#addActionAuthorizerColumnIfMissing();
    this.#addIdempotencyOperationColumnsIfMissing();
    this.#addTagIdempotencyOperationIfMissing();
    this.#addProjectScopeIfMissing(installationId);
    if (previousSchemaVersion < 12) {
      this.#addArtifactSearchNameIfMissing();
    }
    this.#addSpaRoutingModeIfMissing();
    this.#addCommentTablesIfMissing();
    this.#addAgentDispatchTablesIfMissing();
    this.#widenRegisteredAgentsIfNeeded();
    this.#dropSourceBindingColumnsIfPresent();
    this.#dropGitHistoryTables();
    this.#addArtifactPathIfMissing();
    this.#addArtifactOwnerIfMissing();
    this.#addRenameIdempotencyIfMissing();
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS projects_active_created
        ON projects (archived_at, created_at, id);
    `);
    this.#database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion};`);
  }

  #addArtifactSearchNameIfMissing(): void {
    if (!this.#tableColumns("artifacts").includes("search_name")) {
      this.#database.exec("ALTER TABLE artifacts ADD COLUMN search_name TEXT");
    }
    const rows = z.array(z.object({id: z.string(), name: z.string()})).parse(
      this.#database.prepare(
        "SELECT id, name FROM artifacts WHERE search_name IS NULL",
      ).all(),
    );
    const update = this.#database.prepare(
      "UPDATE artifacts SET search_name = ? WHERE id = ?",
    );
    this.#transaction(() => {
      for (const row of rows) {
        update.run(normalizeArtifactSearchText(row.name), row.id);
      }
    });
  }

  // Git history was removed. Its tables only described copies of versions in
  // an external provider, so they are dropped, children before parents.
  #dropGitHistoryTables(): void {
    this.#database.exec(`
      DROP TABLE IF EXISTS git_history_budget_reservations;
      DROP TABLE IF EXISTS git_history_jobs;
      DROP TABLE IF EXISTS git_history_mappings;
      DROP TABLE IF EXISTS git_history_repositories;
      DROP TABLE IF EXISTS git_history_project_settings;
      DROP TABLE IF EXISTS git_history_provider_identity;
    `);
  }

  // `path` is the readable URL path an artifact claims at creation.
  // The index is created on every start rather than behind user_version,
  // because the identity repository stamps the same version.
  #addArtifactPathIfMissing(): void {
    if (!this.#tableColumns("artifacts").includes("path")) {
      this.#database.exec("ALTER TABLE artifacts ADD COLUMN path TEXT");
    }
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_live_path
        ON artifacts (path) WHERE path IS NOT NULL AND deleted_at IS NULL
    `);
  }

  // A rename replays the name it set, so its idempotency record keeps that
  // name. SQLite cannot widen a CHECK in place, so an older table is rebuilt;
  // dropping it drops its triggers, which the same transaction recreates.
  #addRenameIdempotencyIfMissing(): void {
    const row = this.#database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'idempotency_records'",
      )
      .get();
    const {sql} = z.object({sql: z.string()}).parse(row);
    if (sql.includes("'rename'")) return;
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE idempotency_records_next (
          project_id TEXT NOT NULL REFERENCES projects(id),
          idempotency_key TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'rename', 'delete')),
          access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          artifact_name TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, idempotency_key)
        ) STRICT;

        INSERT INTO idempotency_records_next (
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        )
        SELECT
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        FROM idempotency_records;

        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_next RENAME TO idempotency_records;

        CREATE TRIGGER idempotency_project_insert
        BEFORE INSERT ON idempotency_records
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'idempotency project mismatch');
        END;

        CREATE TRIGGER idempotency_project_update
        BEFORE UPDATE OF project_id ON idempotency_records
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'idempotency project cannot change');
        END;
      `);
    });
  }

  // An artifact's owner is the principal who created it. Artifacts created
  // before owners were recorded take the publisher of their first version and
  // keep a null name, because nobody recorded the name that publisher had then.
  #addArtifactOwnerIfMissing(): void {
    const artifactColumns = this.#tableColumns("artifacts");
    const versionColumns = this.#tableColumns("versions");
    this.#transaction(() => {
      if (!artifactColumns.includes("owner_principal_id")) {
        this.#database.exec(`
          ALTER TABLE artifacts ADD COLUMN owner_principal_id TEXT;
          ALTER TABLE artifacts ADD COLUMN owner_display_name TEXT;
          UPDATE artifacts SET owner_principal_id = (
            SELECT publisher_principal_id FROM versions
            WHERE versions.artifact_id = artifacts.id AND versions.number = 1
          );
        `);
      }
      if (!versionColumns.includes("publisher_display_name")) {
        this.#database.exec(
          "ALTER TABLE versions ADD COLUMN publisher_display_name TEXT",
        );
      }
      this.#database.exec(`
        CREATE INDEX IF NOT EXISTS artifacts_owner_created
          ON artifacts (project_id, owner_principal_id, deleted_at, created_at DESC, id DESC)
      `);
    });
  }

  // Linked artifacts were removed. Their versions were ordinary publishes, so
  // link and capture actions become publish actions; a relink created no
  // version and has no remaining meaning. Columns go in reverse order because
  // the last one carried the check that names the other three.
  #dropSourceBindingColumnsIfPresent(): void {
    if (!this.#tableColumns("artifacts").includes("source_path")) return;
    this.#transaction(() => {
      this.#database.exec(`
        UPDATE actions SET action = 'publish' WHERE action IN ('link', 'capture');
        DELETE FROM actions WHERE action = 'relink';
        ALTER TABLE artifacts DROP COLUMN source_verified_at;
        ALTER TABLE artifacts DROP COLUMN source_status;
        ALTER TABLE artifacts DROP COLUMN source_fingerprint;
        ALTER TABLE artifacts DROP COLUMN source_path;
      `);
    });
  }

  #addSpaRoutingModeIfMissing(): void {
    const rows = this.#database.prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table' AND name IN ('versions', 'staged_uploads')`,
    ).all();
    const schemas = z.array(z.object({name: z.string(), sql: z.string()})).parse(rows);
    if (schemas.every(({sql}) => sql.includes("'spa'"))) return;

    this.#database.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.#database.exec(`
        BEGIN IMMEDIATE;

        DROP TRIGGER IF EXISTS artifacts_project_insert;
        DROP TRIGGER IF EXISTS artifacts_project_update;
        DROP TRIGGER IF EXISTS artifacts_current_version_update;
        DROP TRIGGER IF EXISTS staged_uploads_project_insert;
        DROP TRIGGER IF EXISTS staged_uploads_project_update;
        DROP TRIGGER IF EXISTS versions_project_insert;
        DROP TRIGGER IF EXISTS versions_project_update;
        DROP TRIGGER IF EXISTS actions_project_insert;
        DROP TRIGGER IF EXISTS actions_project_update;
        DROP TRIGGER IF EXISTS idempotency_project_insert;
        DROP TRIGGER IF EXISTS idempotency_project_update;
        DROP TRIGGER IF EXISTS content_bootstrap_project_insert;
        DROP TRIGGER IF EXISTS content_bootstrap_project_update;
        DROP TRIGGER IF EXISTS content_session_project_insert;
        DROP TRIGGER IF EXISTS content_session_project_update;

        CREATE TABLE versions_next (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          number INTEGER NOT NULL CHECK (number > 0),
          manifest_digest TEXT NOT NULL,
          entry_path TEXT NOT NULL,
          routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
          content_token TEXT NOT NULL UNIQUE,
          publisher_principal_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (artifact_id, number)
        ) STRICT;
        INSERT INTO versions_next (
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        ) SELECT
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        FROM versions;
        DROP TABLE versions;
        ALTER TABLE versions_next RENAME TO versions;

        CREATE TABLE staged_uploads_next (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          principal_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
          manifest_digest TEXT NOT NULL,
          entry_path TEXT NOT NULL,
          routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          committed_version_id TEXT REFERENCES versions(id),
          CHECK (
            (status = 'open' AND committed_version_id IS NULL)
            OR (status = 'committed' AND committed_version_id IS NOT NULL)
          )
        ) STRICT;
        INSERT INTO staged_uploads_next (
          id, project_id, principal_id, status, manifest_digest, entry_path,
          routing_mode, created_at, expires_at, committed_version_id
        ) SELECT
          id, project_id, principal_id, status, manifest_digest, entry_path,
          routing_mode, created_at, expires_at, committed_version_id
        FROM staged_uploads;
        DROP TABLE staged_uploads;
        ALTER TABLE staged_uploads_next RENAME TO staged_uploads;

        COMMIT;
      `);
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
    const failures = this.#database.prepare("PRAGMA foreign_key_check").all();
    if (failures.length > 0) {
      throw new Error("SQLite routing migration produced invalid foreign keys.");
    }
  }

  #addTagIdempotencyOperationIfMissing(): void {
    const row = this.#database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'idempotency_records'",
      )
      .get();
    const {sql} = z.object({sql: z.string()}).parse(row);
    if (sql.includes("'change_tags'")) return;
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE idempotency_records_next (
          idempotency_key TEXT PRIMARY KEY,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
          access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO idempotency_records_next (
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        )
        SELECT
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        FROM idempotency_records;

        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_next RENAME TO idempotency_records;
      `);
    });
  }

  #addProjectScopeIfMissing(installationId: string): void {
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT OR IGNORE INTO projects (
          id, installation_id, name, created_at, archived_at
        )
        SELECT ?, ?, ?,
          COALESCE(MIN(created_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          NULL
        FROM artifacts
      `).run(defaultProjectId, installationId, defaultProjectName);

      if (!this.#tableColumns("artifacts").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE artifacts ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("versions").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE versions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("actions").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE actions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("staged_uploads").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE staged_uploads ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("content_bootstraps").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE content_bootstraps ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("content_sessions").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE content_sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("idempotency_records").includes("project_id")) {
        this.#database.exec(`
          CREATE TABLE idempotency_records_projected (
            project_id TEXT NOT NULL REFERENCES projects(id),
            idempotency_key TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            artifact_id TEXT NOT NULL REFERENCES artifacts(id),
            version_id TEXT NOT NULL REFERENCES versions(id),
            operation TEXT NOT NULL DEFAULT 'publish'
              CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
            access_setting TEXT
              CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
            tags_json TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, idempotency_key)
          ) STRICT;

          INSERT INTO idempotency_records_projected (
            project_id, idempotency_key, input_digest, artifact_id, version_id,
            operation, access_setting, tags_json, created_at
          )
          SELECT
            '${defaultProjectId}', idempotency_key, input_digest, artifact_id,
            version_id, operation, access_setting, tags_json, created_at
          FROM idempotency_records;

          DROP TABLE idempotency_records;
          ALTER TABLE idempotency_records_projected
            RENAME TO idempotency_records;
        `);
      }

      this.#database.exec(`
        DROP INDEX IF EXISTS versions_artifact_id;
        DROP INDEX IF EXISTS artifacts_active_created;
        DROP INDEX IF EXISTS actions_artifact_created;
        DROP INDEX IF EXISTS staged_uploads_expiry;

        CREATE INDEX versions_artifact_id
          ON versions (project_id, artifact_id, number);
        CREATE INDEX artifacts_active_created
          ON artifacts (project_id, deleted_at, created_at DESC, id DESC);
        CREATE INDEX actions_artifact_created
          ON actions (project_id, artifact_id, created_at DESC, id DESC);
        CREATE INDEX staged_uploads_expiry
          ON staged_uploads (project_id, status, expires_at);

        CREATE TRIGGER IF NOT EXISTS artifacts_project_insert
        BEFORE INSERT ON artifacts
        WHEN NOT EXISTS (
          SELECT 1 FROM projects WHERE id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'artifact project not found');
        END;

        CREATE TRIGGER IF NOT EXISTS artifacts_project_update
        BEFORE UPDATE OF project_id ON artifacts
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'artifact project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS artifacts_current_version_update
        BEFORE UPDATE OF current_version_id ON artifacts
        WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.current_version_id
            AND artifact_id = NEW.id
            AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'artifact current version project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS staged_uploads_project_insert
        BEFORE INSERT ON staged_uploads
        WHEN NOT EXISTS (
          SELECT 1 FROM projects WHERE id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged upload project not found');
        END;

        CREATE TRIGGER IF NOT EXISTS staged_uploads_project_update
        BEFORE UPDATE OF project_id ON staged_uploads
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'staged upload project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS versions_project_insert
        BEFORE INSERT ON versions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'version project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS versions_project_update
        BEFORE UPDATE OF project_id ON versions
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'version project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS actions_project_insert
        BEFORE INSERT ON actions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'action project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS actions_project_update
        BEFORE UPDATE OF project_id ON actions
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'action project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS idempotency_project_insert
        BEFORE INSERT ON idempotency_records
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'idempotency project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS idempotency_project_update
        BEFORE UPDATE OF project_id ON idempotency_records
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'idempotency project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS content_bootstrap_project_insert
        BEFORE INSERT ON content_bootstraps
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'content bootstrap project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS content_bootstrap_project_update
        BEFORE UPDATE OF project_id ON content_bootstraps
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'content bootstrap project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS content_session_project_insert
        BEFORE INSERT ON content_sessions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'content session project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS content_session_project_update
        BEFORE UPDATE OF project_id ON content_sessions
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'content session project cannot change');
        END;
      `);
    });
    this.#database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion};`);
  }

  #addActionAuthorizerColumnIfMissing(): void {
    const columns = this.#tableColumns("actions");
    if (columns.includes("authorized_by_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE actions ADD COLUMN authorized_by_principal_id TEXT",
    );
  }

  #addIdempotencyOperationColumnsIfMissing(): void {
    const columns = this.#tableColumns("idempotency_records");
    if (!columns.includes("operation")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'delete'))",
      );
    }
    if (!columns.includes("access_setting")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link'))",
      );
    }
    if (!columns.includes("tags_json")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN tags_json TEXT",
      );
    }
  }

  #addVersionPublisherColumnIfMissing(): void {
    const columns = this.#tableColumns("versions");
    if (columns.includes("publisher_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE versions ADD COLUMN publisher_principal_id TEXT NOT NULL DEFAULT 'local-api-token'",
    );
  }

  #tableColumns(
    table:
      | "actions"
      | "artifacts"
      | "comment_threads"
      | "content_bootstraps"
      | "content_sessions"
      | "idempotency_records"
      | "staged_uploads"
      | "versions",
  ): readonly string[] {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all();
    const columns = z.array(z.object({name: z.string()})).parse(rows);
    return columns.map((column) => column.name);
  }

  #readStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): StagedUpload {
    const upload = this.#readStagedUploadOrNull(projectId, uploadId, principalId);
    if (upload === null) {
      throw new Error(`Staged upload ${uploadId} was not found after a successful write.`);
    }
    return upload;
  }

  #readStagedUploadOrNull(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): StagedUpload | null {
    const row = this.#database
      .prepare(
        `SELECT
          id AS id,
          project_id AS projectId,
          principal_id AS principalId,
          status AS status,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode,
          created_at AS createdAt,
          expires_at AS expiresAt,
          committed_version_id AS committedVersionId
        FROM staged_uploads
        WHERE project_id = ? AND id = ? AND principal_id = ?`,
      )
      .get(projectId, uploadId, principalId);
    const header = stagedUploadRowSchema.nullable().parse(row ?? null);
    if (header === null) return null;

    const fileRows = this.#database
      .prepare(
        `SELECT
          storage_token AS storageToken,
          path AS path,
          size AS size,
          media_type AS mediaType,
          sha256 AS sha256,
          disposition AS disposition,
          uploaded_at AS uploadedAt
        FROM staged_upload_files
        WHERE upload_id = ?
        ORDER BY path`,
      )
      .all(uploadId);
    const parsedFiles = z.array(stagedUploadFileRowSchema).parse(fileRows);
    const manifest = createManifest({
      entryPath: header.entryPath,
      files: parsedFiles.map((file) => ({
        mediaType: file.mediaType,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
      routingMode: header.routingMode,
    });
    if (manifest.digest !== header.manifestDigest) {
      throw new Error(`Staged upload ${uploadId} has an invalid persisted manifest digest.`);
    }
    const manifestByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    const files: readonly StagedUploadFile[] = parsedFiles.map((file) => {
      const entry = manifestByPath.get(file.path);
      if (entry === undefined || entry.disposition !== file.disposition) {
        throw new Error(`Staged upload ${uploadId} has invalid persisted file metadata.`);
      }
      return {
        entry,
        storageToken: file.storageToken,
        uploadedAt: file.uploadedAt,
      };
    });
    const commonUpload = {
      createdAt: header.createdAt,
      expiresAt: header.expiresAt,
      files,
      id: header.id,
      manifest,
      principalId: header.principalId,
      projectId: header.projectId,
    };
    if (header.status === uploadStatuses.open) {
      return {
        ...commonUpload,
        committedVersionId: header.committedVersionId,
        status: header.status,
      };
    }
    return {
      ...commonUpload,
      committedVersionId: header.committedVersionId,
      status: header.status,
    };
  }

  #readPublishedVersion(
    projectId: string,
    versionId: string,
    replayed: boolean,
  ): PublishedVersion {
    const row = this.#database
      .prepare(
        `SELECT
          a.id AS artifactId,
          a.project_id AS projectId,
          a.name AS artifactName,
          a.path AS artifactPath,
          a.access_setting AS accessSetting,
          a.owner_principal_id AS ownerPrincipalId,
          a.owner_display_name AS ownerDisplayName,
          a.current_version_id AS currentVersionId,
          a.created_at AS artifactCreatedAt,
          a.deleted_at AS artifactDeletedAt,
          v.id AS versionId,
          v.number AS versionNumber,
          v.manifest_digest AS manifestDigest,
          v.entry_path AS entryPath,
          v.routing_mode AS routingMode,
          v.content_token AS contentToken,
          v.publisher_principal_id AS publisherPrincipalId,
          v.publisher_display_name AS publisherDisplayName,
          v.created_at AS versionCreatedAt
        FROM versions v
        JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.project_id = ? AND v.id = ? AND a.deleted_at IS NULL`,
      )
      .get(projectId, versionId);
    const parsed = publishedRowSchema.parse(row);
    const artifact: ArtifactRecord = {
      accessSetting: parsed.accessSetting,
      createdAt: parsed.artifactCreatedAt,
      currentVersionId: parsed.currentVersionId,
      deletedAt: parsed.artifactDeletedAt,
      id: parsed.artifactId,
      name: parsed.artifactName,
      owner: {
        displayName: parsed.ownerDisplayName,
        principalId: parsed.ownerPrincipalId,
      },
      path: parsed.artifactPath,
      projectId: parsed.projectId,
      tags: this.#readTags(parsed.artifactId),
    };
    const version: VersionRecord = {
      artifactId: parsed.artifactId,
      contentToken: parsed.contentToken,
      createdAt: parsed.versionCreatedAt,
      entryPath: parsed.entryPath,
      id: parsed.versionId,
      manifestDigest: parsed.manifestDigest,
      number: parsed.versionNumber,
      publisherDisplayName: parsed.publisherDisplayName,
      publisherPrincipalId: parsed.publisherPrincipalId,
      projectId: parsed.projectId,
      routingMode: parsed.routingMode,
    };
    return {artifact, replayed, version};
  }

  #readPublishedVersionById(
    versionId: string,
    replayed: boolean,
  ): PublishedVersion {
    const row = this.#database.prepare(
      "SELECT project_id AS projectId FROM versions WHERE id = ?",
    ).get(versionId);
    const {projectId} = z.object({projectId: z.string()}).parse(row);
    return this.#readPublishedVersion(projectId, versionId, replayed);
  }

  #readProject(projectId: string): ProjectRecord {
    const project = this.#readProjectOrNull(projectId);
    if (project === null) {
      throw new ProjectNotFound({message: "The project does not exist."});
    }
    return project;
  }

  #readProjectOrNull(projectId: string): ProjectRecord | null {
    const row = this.#database.prepare(`
      SELECT id, installation_id AS installationId, name,
        created_at AS createdAt, archived_at AS archivedAt
      FROM projects
      WHERE id = ?
    `).get(projectId);
    return projectRowSchema.nullable().parse(row ?? null);
  }

  #transaction<Result>(operation: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}

const commentThreadColumns = `SELECT
    t.id AS id,
    t.installation_id AS installationId,
    t.project_id AS projectId,
    t.artifact_id AS artifactId,
    t.version_id AS versionId,
    t.path AS path,
    t.anchor_json AS anchorJson,
    t.body AS body,
    t.state AS state,
    t.author_principal_id AS authorPrincipalId,
    t.author_principal_kind AS authorPrincipalKind,
    t.author_display_name AS authorDisplayName,
    t.author_authorized_by_principal_id AS authorAuthorizedByPrincipalId,
    t.resolved_at AS resolvedAt,
    t.resolved_by_principal_id AS resolvedByPrincipalId,
    t.resolved_by_principal_kind AS resolvedByPrincipalKind,
    t.resolved_by_display_name AS resolvedByDisplayName,
    t.resolved_by_authorized_by_principal_id AS resolvedByAuthorizedByPrincipalId,
    t.created_at AS createdAt,
    t.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM comment_replies r WHERE r.thread_id = t.id) AS replyCount
  FROM comment_threads t`;

const registeredAgentColumns = `SELECT
    id AS id,
    installation_id AS installationId,
    connection_key AS connectionKey,
    display_name AS displayName,
    kind AS kind,
    working_directory AS workingDirectory,
    agent_session_id AS agentSessionId,
    principal_id AS principalId,
    created_at AS createdAt,
    last_seen_at AS lastSeenAt,
    capabilities_json AS capabilitiesJson,
    activity_state AS activityState,
    activity_at AS activityAt
  FROM registered_agents`;

const agentDispatchColumns = `SELECT
    d.id AS id,
    d.installation_id AS installationId,
    d.project_id AS projectId,
    d.agent_id AS agentId,
    d.agent_display_name AS agentDisplayName,
    d.thread_ids_json AS threadIdsJson,
    d.note AS note,
    d.state AS state,
    d.sender_principal_id AS senderPrincipalId,
    d.sender_principal_kind AS senderPrincipalKind,
    d.sender_display_name AS senderDisplayName,
    d.sender_authorized_by_principal_id AS senderAuthorizedByPrincipalId,
    d.idempotency_key AS idempotencyKey,
    d.claimed_at AS claimedAt,
    d.lease_expires_at AS leaseExpiresAt,
    d.delivered_at AS deliveredAt,
    d.addressed_at AS addressedAt,
    d.failed_at AS failedAt,
    d.failure_reason AS failureReason,
    d.canceled_at AS canceledAt,
    d.created_at AS createdAt,
    d.updated_at AS updatedAt
  FROM agent_dispatches d`;

const commentReplyColumns = `SELECT
    r.id AS id,
    r.thread_id AS threadId,
    r.project_id AS projectId,
    r.body AS body,
    r.author_principal_id AS authorPrincipalId,
    r.author_principal_kind AS authorPrincipalKind,
    r.author_display_name AS authorDisplayName,
    r.author_authorized_by_principal_id AS authorAuthorizedByPrincipalId,
    r.created_at AS createdAt,
    r.updated_at AS updatedAt
  FROM comment_replies r`;

function serializeCommentAnchor(carrier: {readonly anchor: unknown}): string | null {
  return carrier.anchor === null || carrier.anchor === undefined
    ? null
    : JSON.stringify(carrier.anchor);
}

// A comment action never carries the caller's idempotency key: that key already
// belongs to a publish, a restore, or another comment write in the same project.
// Derived keys must also stay unique when two mutations on one thread land in
// the same millisecond, so the key carries the action row id rather than the
// changed-at timestamp.
function commentActionIdentity(threadId: string) {
  const actionId = crypto.randomUUID();
  return {actionId, idempotencyKey: `comment:${threadId}:${actionId}`};
}

function commentUpdateActionKind(
  command: UpdateCommentThread,
): ArtifactActionRecord["action"] {
  if (command.state === null) return artifactActionKinds.commentUpdate;
  return command.state.state === commentThreadStates.resolved
    ? artifactActionKinds.commentResolve
    : artifactActionKinds.commentReopen;
}

function commentAuthorFromRow(
  row: z.infer<typeof commentThreadRowSchema> | z.infer<typeof commentReplyRowSchema>,
): CommentAuthor {
  return {
    authorizedByPrincipalId: row.authorAuthorizedByPrincipalId,
    displayName: row.authorDisplayName,
    principalId: row.authorPrincipalId,
    principalKind: row.authorPrincipalKind,
  };
}

function commentThreadFromRow(
  row: z.infer<typeof commentThreadRowSchema>,
): CommentThreadRecord {
  return {
    anchor: row.anchorJson === null ? null : JSON.parse(row.anchorJson),
    artifactId: row.artifactId,
    author: commentAuthorFromRow(row),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    installationId: row.installationId,
    path: row.path,
    projectId: row.projectId,
    replyCount: row.replyCount,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedByPrincipalId === null ||
        row.resolvedByPrincipalKind === null ||
        row.resolvedByDisplayName === null
      ? null
      : {
        authorizedByPrincipalId: row.resolvedByAuthorizedByPrincipalId,
        displayName: row.resolvedByDisplayName,
        principalId: row.resolvedByPrincipalId,
        principalKind: row.resolvedByPrincipalKind,
      },
    state: row.state,
    updatedAt: row.updatedAt,
    versionId: row.versionId,
  };
}

function commentReplyFromRow(
  row: z.infer<typeof commentReplyRowSchema>,
): CommentReplyRecord {
  return {
    author: commentAuthorFromRow(row),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId,
    updatedAt: row.updatedAt,
  };
}

function missingComment(): CommentNotFound {
  return new CommentNotFound({
    message: "The comment thread or reply does not exist.",
  });
}

function missingDispatch(): AgentDispatchNotFound {
  return new AgentDispatchNotFound({message: "The dispatch does not exist."});
}

function dispatchedCommentDeletionConflict(): DispatchStateConflict {
  return new DispatchStateConflict({
    message:
      "This comment has been sent to an agent and cannot be deleted until the dispatch is complete.",
  });
}

function agentDispatchFromRow(
  row: z.infer<typeof agentDispatchRowSchema>,
): AgentDispatchRecord {
  return {
    addressedAt: row.addressedAt,
    agentDisplayName: row.agentDisplayName,
    agentId: row.agentId,
    canceledAt: row.canceledAt,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    installationId: row.installationId,
    leaseExpiresAt: row.leaseExpiresAt,
    note: row.note,
    projectId: row.projectId,
    sender: {
      authorizedByPrincipalId: row.senderAuthorizedByPrincipalId,
      displayName: row.senderDisplayName,
      principalId: row.senderPrincipalId,
      principalKind: row.senderPrincipalKind,
    },
    state: row.state,
    threadIds: threadIdsSchema.parse(JSON.parse(row.threadIdsJson)),
    updatedAt: row.updatedAt,
  };
}

// Stored timestamps are canonical millisecond ISO text, so offsets computed
// through Date round-trip into the same lexicographically comparable format.
function isoAfter(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

function isoBefore(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) - milliseconds).toISOString();
}

function isSqliteConstraint(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("constraint failed");
}

function changedDuringManagement(): ArtifactMutationConflict {
  return new ArtifactMutationConflict({
    message: "The artifact changed during the management operation.",
  });
}

function pageFromRows<Item extends PageCursor>(
  rows: readonly Item[],
  limit: number,
  rankOf: ((item: Item) => number) | null = null,
): PageResult<Item> {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && lastItem !== undefined
      ? rankOf === null
        ? {createdAt: lastItem.createdAt, id: lastItem.id}
        : {createdAt: lastItem.createdAt, id: lastItem.id, rank: rankOf(lastItem)}
      : null,
  };
}
