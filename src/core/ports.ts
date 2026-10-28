import type {
  AccessSetting,
  AgentDispatchCreation,
  AgentDispatchPage,
  AgentDispatchRecord,
  AgentDispatchState,
  ArtifactActionPage,
  ArtifactDeletion,
  ArtifactPage,
  ArtifactPathMatch,
  ArtifactState,
  ArtifactVersion,
  ArtifactRecord,
  ArtifactVersionDay,
  ArtifactViewDay,
  ArtifactViewTotal,
  AssetRecord,
  AssetUsage,
  CanonicalManifest,
  CommentAuthor,
  DispatchedThreadFilter,
  FolderDefaultState,
  CommentReplyCreation,
  CommentReplyRecord,
  CommentThreadCreation,
  CommentThreadDeletion,
  CommentThreadPage,
  CommentThreadRecord,
  CommentThreadState,
  ContentBootstrapRecord,
  ContentSessionRecord,
  AgentBeaconState,
  AgentCapabilities,
  CatalogScope,
  CommentClearScope,
  CommentThreadClearing,
  PageCursor,
  PublishedVersion,
  InstallationActor,
  ProjectRecord,
  ProjectActivityDays,
  ProjectActivityTotals,
  PublicArtifactSummary,
  RegisteredAgentKind,
  RegisteredAgentPresence,
  RegisteredAgentRecord,
  StagedUpload,
  VersionRecord,
  VersionContent,
  ViewedArtifact,
} from "./model.js";
import type {AssetQuota} from "./asset-policy.js";

export interface StoredBlob {
  readonly sha256: string;
  readonly size: number;
}

export interface OpenedBlob extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
}

/** One inclusive byte range inside a stored blob. */
export interface BlobByteRange {
  readonly endInclusive: number;
  readonly start: number;
}

/** A ranged blob read whose size remains the complete stored-object size. */
export interface OpenedBlobRange extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly range: BlobByteRange;
}

export interface BlobWrite extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface BlobStore {
  inspect(sha256: string): Promise<StoredBlob>;
  open(sha256: string): Promise<OpenedBlob>;
  openRange(sha256: string, range: BlobByteRange): Promise<OpenedBlobRange>;
  put(write: BlobWrite): Promise<StoredBlob>;
}

export interface StagedFileWrite extends BlobWrite {
  readonly storageToken: string;
  readonly uploadId: string;
}

export interface OpenedStagedFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface StagingStore {
  open(uploadId: string, storageToken: string): Promise<OpenedStagedFile>;
  put(write: StagedFileWrite): Promise<StoredBlob>;
  remove(uploadId: string, storageToken: string): Promise<void>;
}

/** Exact staging objects selected from one expired, uncommitted upload. */
export interface ExpiredStagedUpload {
  readonly files: readonly {readonly storageToken: string}[];
  readonly id: string;
}

export interface PublicationSource {
  readonly kind: "staged_upload";
  readonly principalId: string;
  readonly projectId: string;
  readonly uploadId: string;
}

export interface CommitNewArtifact {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly manifest: CanonicalManifest;
  readonly name: string;
  /** A readable path already normalized at the boundary, or null. */
  readonly path: string | null;
  /** The publisher's display name, recorded as the artifact owner's name. */
  readonly principalDisplayName: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly source: PublicationSource;
  readonly tags: readonly string[];
  readonly versionId: string;
}

/**
 * Marks a version commit as an edit: the committed manifest is the base
 * version's with one entry replaced, so it differs from the staged upload's
 * manifest, which holds only the replacement file.
 */
export interface ArtifactEditCommit {
  readonly stagedManifestDigest: string;
}

export interface CommitArtifactVersion {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  /** Null for an ordinary publish. */
  readonly edit: ArtifactEditCommit | null;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly manifest: CanonicalManifest;
  /** The publisher's display name, recorded on the new version. */
  readonly principalDisplayName: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly source: PublicationSource;
  readonly versionId: string;
}

/** Values used to atomically restore one existing saved version. */
export interface RestoreArtifactVersion {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** Values used to atomically change one artifact's read setting. */
export interface ChangeArtifactAccessSetting {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** Values used to atomically replace one artifact's complete tag set. */
export interface ChangeArtifactTags {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tags: readonly string[];
}

/** Values used to atomically change one artifact's display name. */
export interface RenameArtifact {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  /** A name already trimmed and length-checked at the boundary. */
  readonly name: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** Values used to atomically tombstone one artifact. */
export interface DeleteArtifact {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** Which artifacts a listing keeps, judged by the principal who created them. */
export type ArtifactOwnerFilter =
  | {readonly kind: "any"}
  | {readonly kind: "owned_by"; readonly principalId: string}
  | {readonly kind: "not_owned_by"; readonly principalId: string};

/** Values used to read one bounded page of active artifacts. */
export interface ListArtifacts {
  readonly comments: "all" | "with" | "without";
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly owner: ArtifactOwnerFilter;
  readonly projectId: string;
  /** Normalized name-substring or exact-tag search, when supplied. */
  readonly search?: string | null;
  readonly sort: "comments" | "newest";
  /** Exact normalized tag filters. An artifact matches when it has any selected tag. */
  readonly tags: readonly string[];
}

/** Values used to read one bounded page of artifact actions. */
export interface ListArtifactActions {
  readonly artifactId: string;
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectId: string;
}

/** Values used to create one comment thread on one exact saved version. */
export interface CreateCommentThread {
  /** Opaque client-owned anchor value, or null for an unanchored thread. */
  readonly anchor: unknown;
  readonly artifactId: string;
  readonly author: CommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly installationId: string;
  readonly path: string | null;
  readonly projectId: string;
  readonly versionId: string;
}

/** Values used to read one bounded page of comment threads on one artifact. */
export interface ListCommentThreads {
  readonly artifactId: string;
  readonly cursor: PageCursor | null;
  /** Visibility of threads referenced by an active dispatch. */
  readonly dispatched: DispatchedThreadFilter;
  readonly limit: number;
  readonly projectId: string;
  /** Inclusive lower bound on updatedAt, or null for no lower bound. */
  readonly since: string | null;
  readonly state: CommentThreadState | null;
  readonly versionId: string | null;
}

/** One requested anchor replacement; a null anchor clears the stored value. */
export interface CommentAnchorChange {
  readonly anchor: unknown;
}

/** One requested comment state transition together with its attribution. */
export interface CommentStateChange {
  readonly resolvedAt: string | null;
  readonly resolvedBy: CommentAuthor | null;
  readonly state: CommentThreadState;
}

/**
 * Values used to change one comment thread. A null field is left unchanged.
 * The recorded action kind is `comment_resolve` or `comment_reopen` when the
 * command carries a state change, and `comment_update` otherwise.
 */
export interface UpdateCommentThread {
  readonly anchor: CommentAnchorChange | null;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly body: string | null;
  readonly principalId: string;
  readonly projectId: string;
  readonly state: CommentStateChange | null;
  readonly threadId: string;
  readonly updatedAt: string;
}

/** Values used to delete one comment thread together with its replies. */
export interface DeleteCommentThread {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly deletedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly threadId: string;
}

/** Values used to append one reply to one open comment thread. */
export interface CreateCommentReply {
  readonly artifactId: string;
  readonly author: CommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly threadId: string;
}

/** Values used to change one reply's body. */
export interface UpdateCommentReply {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly body: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly replyId: string;
  readonly threadId: string;
  readonly updatedAt: string;
}

/**
 * Values used to clear one artifact's matching comment threads in bulk.
 * Deletion semantics per thread match {@link DeleteCommentThread}: replies
 * cascade and one `comment_delete` action lands in the ledger. Threads held
 * by a queued, claimed, or delivered dispatch are skipped and counted.
 */
export interface ClearCommentThreads {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly clearedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly scope: CommentClearScope;
  /** Restricts the clear to threads on one saved version when present. */
  readonly versionId: string | null;
}

/** Values used to delete one reply from one comment thread. */
export interface DeleteCommentReply {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly deletedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly replyId: string;
  readonly threadId: string;
}

/**
 * Persistent comment operations required by the comment application service.
 * Every mutation appends its attributed action record in the same transaction.
 */
export interface CommentRepository {
  clearThreads(command: ClearCommentThreads): Promise<CommentThreadClearing>;
  createReply(command: CreateCommentReply): Promise<CommentReplyCreation>;
  createThread(command: CreateCommentThread): Promise<CommentThreadCreation>;
  deleteReply(command: DeleteCommentReply): Promise<void>;
  deleteThread(command: DeleteCommentThread): Promise<CommentThreadDeletion>;
  findIdempotentReply(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentReplyRecord | null>;
  findIdempotentThread(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentThreadRecord | null>;
  findThread(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<CommentThreadRecord | null>;
  listReplies(threadId: string): Promise<readonly CommentReplyRecord[]>;
  listThreads(command: ListCommentThreads): Promise<CommentThreadPage>;
  updateReply(command: UpdateCommentReply): Promise<CommentReplyRecord>;
  updateThread(command: UpdateCommentThread): Promise<CommentThreadRecord>;
  /** Determine whether one saved version's manifest declares one exact path. */
  versionContainsPath(
    projectId: string,
    versionId: string,
    path: string,
  ): Promise<boolean>;
}

/** Values used to register or refresh one live agent connection. */
export interface RegisterAgent {
  readonly agentSessionId: string | null;
  /** Already normalized: known keys only, defaults applied. */
  readonly capabilities: AgentCapabilities;
  readonly connectionKey: string;
  readonly displayName: string;
  /** Identity used only when the connection key inserts a new row. */
  readonly id: string;
  readonly installationId: string;
  readonly kind: RegisteredAgentKind;
  readonly principalId: string;
  readonly registeredAt: string;
  readonly workingDirectory: string;
}

/** Values used to create one dispatch and mark its threads atomically. */
export interface CreateAgentDispatch {
  readonly agentDisplayName: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly installationId: string;
  readonly note: string | null;
  readonly projectId: string;
  readonly sender: CommentAuthor;
  readonly threadIds: readonly string[];
}

/** Values used to report one claimed dispatch as delivered. */
export interface MarkDispatchDelivered {
  /** The reporting agent; a non-holder report is a state conflict. */
  readonly agentId: string;
  readonly deliveredAt: string;
  readonly dispatchId: string;
  readonly installationId: string;
}

/** Values used to report one dispatch as permanently failed. */
export interface MarkDispatchFailed {
  /** The reporting agent; a non-holder report is a state conflict. */
  readonly agentId: string;
  readonly dispatchId: string;
  readonly failedAt: string;
  readonly installationId: string;
  readonly reason: string;
}

/**
 * Values used to store one activity beacon on one registered agent. Display
 * metadata only: the write always lands, and the read side decays it.
 */
export interface RecordAgentActivity {
  readonly agentId: string;
  readonly installationId: string;
  readonly observedAt: string;
  readonly state: AgentBeaconState;
}

/** Values used to cancel one queued or claimed dispatch. */
export interface CancelAgentDispatch {
  readonly canceledAt: string;
  readonly dispatchId: string;
  readonly installationId: string;
  readonly projectId: string;
}

/** Values used to read one bounded page of dispatches, newest first. */
export interface ListAgentDispatches {
  readonly agentId: string | null;
  readonly cursor: PageCursor | null;
  readonly installationId: string;
  readonly limit: number;
  /** Read time used to apply lazy dispatch transitions before shaping. */
  readonly now: string;
  readonly projectId: string;
  readonly state: AgentDispatchState | null;
}

/**
 * Persistent agent-registry and dispatch-mailbox operations. Dispatch
 * creation validates and marks its threads in one transaction; claim,
 * failure, and cancellation apply their state checks and thread markers in
 * one transaction; reads apply the lazy transitions (lease reclaim,
 * agent_unavailable failure, addressed inference) before shaping.
 */
export interface AgentDispatchRepository {
  cancelDispatch(command: CancelAgentDispatch): Promise<AgentDispatchRecord>;
  /**
   * Claim the oldest queued dispatch. A heartbeat attempt (the first attempt
   * of one held poll request) refreshes the agent's liveness and sweeps
   * expired leases unconditionally; a re-check attempt inside the same held
   * request stays a pure read while nothing is claimable, and only opens the
   * write path — which also refreshes liveness — when it finds an expired
   * lease to reclaim or a queued dispatch to claim.
   */
  claimNextDispatch(
    agentId: string,
    now: string,
    bumpHeartbeat: boolean,
  ): Promise<AgentDispatchRecord | null>;
  createDispatch(command: CreateAgentDispatch): Promise<AgentDispatchCreation>;
  disconnectAgent(installationId: string, agentId: string): Promise<void>;
  findAgent(
    installationId: string,
    agentId: string,
  ): Promise<RegisteredAgentRecord | null>;
  findDispatch(
    installationId: string,
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null>;
  /**
   * List live agents with their dispatch-derived presence, lazily deleting
   * rows past their polling retention.
   */
  listAgents(
    installationId: string,
    now: string,
  ): Promise<readonly RegisteredAgentPresence[]>;
  listDispatches(command: ListAgentDispatches): Promise<AgentDispatchPage>;
  markDelivered(command: MarkDispatchDelivered): Promise<AgentDispatchRecord>;
  markFailed(command: MarkDispatchFailed): Promise<AgentDispatchRecord>;
  /** Stamp addressed when every bundle thread is resolved, exactly once. */
  observeAddressed(
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null>;
  /** Store one activity beacon; overwrites the previous one regardless. */
  recordActivity(command: RecordAgentActivity): Promise<void>;
  registerAgent(command: RegisterAgent): Promise<RegisteredAgentRecord>;
}

/** Values persisted when issuing a one-time private-content bootstrap. */
export type CreateContentBootstrap = ContentBootstrapRecord;

/** Values persisted for one short-lived exact-version Review preview lease. */
export type CreatePreviewLease = ContentSessionRecord;

/** Values used to atomically exchange a bootstrap for a browser session. */
export interface ExchangeContentBootstrap {
  readonly bootstrapTokenDigest: string;
  readonly contentToken: string;
  readonly exchangedAt: string;
  readonly session: {
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly tokenDigest: string;
  };
}

export interface CreateStagedUpload {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly files: readonly {
    readonly entry: CanonicalManifest["entries"][number];
    readonly storageToken: string;
  }[];
  readonly id: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly projectId: string;
}

/** Values persisted when creating one project. */
export interface CreateProject extends ProjectRecord {
  readonly actor: InstallationActor;
}

/** Values used to change one project's label. */
export interface RenameProject {
  readonly actor: InstallationActor;
  readonly name: string;
  readonly projectId: string;
  readonly changedAt: string;
}

/** Values used to archive or unarchive one project. */
export interface SetProjectArchive {
  readonly actor: InstallationActor;
  readonly archivedAt: string | null;
  readonly changedAt: string;
  readonly projectId: string;
}

/** Persistent project operations required by the project application service. */
export interface ProjectRepository {
  createProject(command: CreateProject): Promise<ProjectRecord>;
  findProject(projectId: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<readonly ProjectRecord[]>;
  renameProject(command: RenameProject): Promise<ProjectRecord>;
  setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord>;
}

export interface ArtifactRepository {
  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void>;
  close(): void;
  commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion>;
  commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion>;
  changeAccessSetting(command: ChangeArtifactAccessSetting): Promise<ArtifactState>;
  changeTags(command: ChangeArtifactTags): Promise<ArtifactState>;
  renameArtifact(command: RenameArtifact): Promise<ArtifactState>;
  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion>;
  findArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord | null>;
  findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null>;
  /** Find the live artifact, in any project, whose path is one of the candidates. */
  findArtifactByPath(
    candidates: readonly string[],
  ): Promise<ArtifactPathMatch | null>;
  /**
   * Read one saved version and its manifest without re-reading the artifact.
   * Callers must have already established the artifact exists and is live.
   */
  findVersionRecord(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null>;
  findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null>;
  findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null>;
  findIdempotentAccessChange(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<ArtifactState | null>;
  findVersionContent(
    contentToken: string,
    path: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null>;
  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage>;
  listArtifacts(command: ListArtifacts): Promise<ArtifactPage>;
  listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]>;
  /**
   * Read the newest live artifacts across every project, with the facts the
   * home page tree shows. The public scope keeps only public-link artifacts
   * not tagged unlisted; the all scope keeps every live artifact. Callers
   * build the links, so this never returns a URL that a credential could
   * change.
   */
  listCatalogArtifacts(
    command: ListCatalogArtifacts,
  ): Promise<readonly PublicArtifactSummary[]>;
  /**
   * Count the versions each listed artifact published per UTC day inside one
   * inclusive window, ascending. A day with no version is absent.
   */
  readArtifactVersionDays(
    command: ReadArtifactViewDays,
  ): Promise<readonly ArtifactVersionDay[]>;
  restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState>;
}

/** Write one new asset row once its blob is stored. */
export interface CommitAsset {
  readonly asset: AssetRecord;
  /** The human who authorized the asset's creator, or null. */
  readonly authorizedByPrincipalId: string | null;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly quota: AssetQuota;
  /** The open staged upload the bytes came from, or null for a copy. */
  readonly upload: StagedUploadClaim | null;
}

/** An open staged upload as the committer read it, ended by the commit. */
export interface StagedUploadClaim {
  /** The deadline the committer read; the commit fails if it changed. */
  readonly expiresAt: string;
  readonly id: string;
  readonly principalId: string;
}

/** Tombstone one live asset of one artifact. */
export interface DeleteAsset {
  readonly artifactId: string;
  readonly assetId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly deletedAt: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** One asset row together with whether an idempotent retry returned it. */
export interface CommittedAsset {
  readonly asset: AssetRecord;
  readonly replayed: boolean;
}

/** One live asset and the access of the live artifact that holds it. */
export interface ServedAsset {
  readonly accessSetting: AccessSetting;
  readonly asset: AssetRecord;
}

/** Durable per-artifact asset rows. Bytes live in the blob store. */
export interface ArtifactAssetRepository {
  /**
   * Insert the asset unless the key already committed one. The quota is
   * checked again under the same lock as the insert, so two concurrent
   * commits cannot both pass it. A named upload's deadline moves to the
   * commit time in the same transaction, so it commits at most once and
   * expiry cleanup reclaims its staging bytes. Throws AssetLimitExceeded,
   * ArtifactNotFound, IdempotencyConflict, UploadClosed when the upload is no
   * longer open, or AssetNotFound for a replayed key whose asset was deleted.
   * A new asset records an asset_added action against the artifact's current
   * version in the same transaction; a replay records nothing.
   */
  commitAsset(command: CommitAsset): Promise<CommittedAsset>;
  /**
   * Tombstone one live asset of a live artifact, record an asset_deleted
   * action in the same transaction, and return the asset. Throws
   * AssetNotFound.
   */
  deleteAsset(command: DeleteAsset): Promise<AssetRecord>;
  /** The asset an earlier commit with this key wrote, or null when none did. */
  findIdempotentAsset(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<CommittedAsset | null>;
  /** One live asset of a live artifact, in any project. */
  findServedAsset(assetId: string): Promise<ServedAsset | null>;
  /** The live assets of one artifact, oldest first, and their usage. */
  listAssets(
    projectId: string,
    artifactId: string,
  ): Promise<{readonly assets: readonly AssetRecord[]; readonly usage: AssetUsage}>;
  /** What the live assets of one artifact use of its quota. */
  readAssetUsage(artifactId: string): Promise<AssetUsage>;
}

/** One coalesced group of view counts for one artifact on one UTC day. */
export interface ArtifactViewDelta {
  readonly artifactId: string;
  /** The UTC calendar day the views were served on, as `YYYY-MM-DD`. */
  readonly day: string;
  readonly count: number;
}

/** Values used to read the newest live artifacts the home page tree lists. */
export interface ListCatalogArtifacts {
  readonly limit: number;
  readonly scope: CatalogScope;
}

/** Values used to read the stored daily rows inside one day window. */
export interface ReadArtifactViewDays {
  readonly artifactIds: readonly string[];
  /** Inclusive first day of the window, as `YYYY-MM-DD`. */
  readonly sinceDay: string;
  /** Inclusive last day of the window, as `YYYY-MM-DD`. */
  readonly untilDay: string;
}

/**
 * Durable per-artifact view counters. One row is one artifact on one UTC day,
 * and the table holds no other fact about a viewer: no address, no session, no
 * referrer, no user agent.
 */
export interface ArtifactViewRepository {
  /** Read each requested artifact's all-time total. */
  readArtifactViewTotals(
    artifactIds: readonly string[],
  ): Promise<readonly ArtifactViewTotal[]>;
  /** Read the daily rows inside one inclusive day window. */
  readArtifactViewDays(
    command: ReadArtifactViewDays,
  ): Promise<readonly ArtifactViewDay[]>;
  /**
   * Add each coalesced delta to its artifact's row for that day. Two calls with
   * equal deltas add twice, because they are two batches of served views.
   */
  recordArtifactViews(
    deltas: readonly ArtifactViewDelta[],
  ): Promise<void>;
}

/**
 * The folders of the public tree that start collapsed, across every project,
 * because readable paths are unique across the installation. A folder with no
 * row starts expanded, so expanding a folder deletes its row.
 */
export interface CollapsedFolderRepository {
  /** Every collapsed folder path, in no particular order. */
  listCollapsedFolders(): Promise<readonly string[]>;
  /** Store one folder's state. Repeating a call changes nothing. */
  setFolderDefaultState(path: string, state: FolderDefaultState): Promise<void>;
}

/** Values used to read one project's activity inside one inclusive day window. */
export interface ReadProjectActivityDays {
  readonly projectId: string;
  /** Inclusive first day of the window, as `YYYY-MM-DD`. */
  readonly sinceDay: string;
  /** Inclusive last day of the window, as `YYYY-MM-DD`. */
  readonly untilDay: string;
}

/** Values used to rank one project's most viewed live artifacts. */
export interface ReadMostViewedArtifacts extends ReadProjectActivityDays {
  readonly limit: number;
}

/**
 * Read-only aggregates over one project's live artifacts, their versions, and
 * their stored view rows. Deleted artifacts never count.
 */
export interface ProjectActivityRepository {
  readProjectActivityTotals(
    projectId: string,
    day: string,
  ): Promise<ProjectActivityTotals>;
  readProjectActivityDays(
    command: ReadProjectActivityDays,
  ): Promise<ProjectActivityDays>;
  /** Artifacts with at least one view in the window, most viewed first. */
  readMostViewedArtifacts(
    command: ReadMostViewedArtifacts,
  ): Promise<readonly ViewedArtifact[]>;
}

/** Persistent capabilities required by private browser content sessions. */
export interface ContentSessionRepository {
  createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord>;
  exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null>;
  findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null>;
  createPreviewLease(command: CreatePreviewLease): Promise<ContentSessionRecord>;
  findPreviewLease(
    tokenDigest: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null>;
}

export interface StagedUploadRepository {
  createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload>;
  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null>;
  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload>;
  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]>;
  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  agentDispatchId(): string;
  artifactId(): string;
  assetId(): string;
  commentReplyId(): string;
  commentThreadId(): string;
  contentToken(): string;
  projectId(): string;
  registeredAgentId(): string;
  stagedFileToken(): string;
  uploadId(): string;
  versionId(): string;
}
