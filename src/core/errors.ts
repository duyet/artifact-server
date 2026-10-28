import { Schema } from "effect";

/** Stable error codes exposed by Artifact Server protocols. */
export const errorCodes = {
  agentNotFound: "AGENT_NOT_FOUND",
  artifactNotFound: "ARTIFACT_NOT_FOUND",
  artifactMutationConflict: "ARTIFACT_MUTATION_CONFLICT",
  artifactPathTaken: "ARTIFACT_PATH_TAKEN",
  assetLimitExceeded: "ASSET_LIMIT_EXCEEDED",
  assetNotFound: "ASSET_NOT_FOUND",
  assetTypeUnsupported: "ASSET_TYPE_UNSUPPORTED",
  authorizationDenied: "AUTHORIZATION_DENIED",
  authenticationRequired: "AUTHENTICATION_REQUIRED",
  commentNotFound: "COMMENT_NOT_FOUND",
  commentResolved: "COMMENT_RESOLVED",
  dispatchNotFound: "DISPATCH_NOT_FOUND",
  dispatchStateConflict: "DISPATCH_STATE_CONFLICT",
  contentBootstrapRejected: "CONTENT_BOOTSTRAP_REJECTED",
  contentNotPublic: "CONTENT_NOT_PUBLIC",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
  identityConflict: "IDENTITY_CONFLICT",
  identityNotFound: "IDENTITY_NOT_FOUND",
  invalidComment: "INVALID_COMMENT",
  invalidDispatch: "INVALID_DISPATCH",
  invalidInput: "INVALID_INPUT",
  invalidManifestPath: "INVALID_MANIFEST_PATH",
  methodNotAllowed: "METHOD_NOT_ALLOWED",
  mediaPreviewContextRequired: "MEDIA_PREVIEW_CONTEXT_REQUIRED",
  mediaPreviewTypeUnsupported: "MEDIA_PREVIEW_TYPE_UNSUPPORTED",
  capabilityUnavailable: "CAPABILITY_UNAVAILABLE",
  publishConflict: "PUBLISH_CONFLICT",
  rateLimited: "RATE_LIMITED",
  projectArchived: "PROJECT_ARCHIVED",
  projectConflict: "PROJECT_CONFLICT",
  projectNotFound: "PROJECT_NOT_FOUND",
  projectSelectionRequired: "PROJECT_SELECTION_REQUIRED",
  uploadClosed: "UPLOAD_CLOSED",
  uploadExpired: "UPLOAD_EXPIRED",
  uploadFileNotFound: "UPLOAD_FILE_NOT_FOUND",
  uploadIncomplete: "UPLOAD_INCOMPLETE",
  uploadNotFound: "UPLOAD_NOT_FOUND",
  uploadTooLarge: "UPLOAD_TOO_LARGE",
  versionNotFound: "VERSION_NOT_FOUND",
} as const;

const messageField = {message: Schema.String};

/** The requested artifact does not exist in the installation. */
export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()(
  "ArtifactNotFound",
  messageField,
) {}

/** The artifact changed after a management client read its current state. */
export class ArtifactMutationConflict extends Schema.TaggedError<ArtifactMutationConflict>()(
  "ArtifactMutationConflict",
  messageField,
) {}

/** A live artifact already holds the requested path, an ancestor, or a descendant. */
export class ArtifactPathTaken extends Schema.TaggedError<ArtifactPathTaken>()(
  "ArtifactPathTaken",
  messageField,
) {}

/** The requested asset does not exist on the artifact, or was deleted. */
export class AssetNotFound extends Schema.TaggedError<AssetNotFound>()(
  "AssetNotFound",
  messageField,
) {}

/** An asset would exceed its type's byte cap or its artifact's quota. */
export class AssetLimitExceeded extends Schema.TaggedError<AssetLimitExceeded>()(
  "AssetLimitExceeded",
  messageField,
) {}

/** An asset's media type is not on the asset store allowlist. */
export class AssetTypeUnsupported extends Schema.TaggedError<AssetTypeUnsupported>()(
  "AssetTypeUnsupported",
  messageField,
) {}

/** The request did not contain a valid supported credential. */
export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  "AuthenticationRequired",
  messageField,
) {}

/** An identity-management command conflicts with current installation state. */
export class IdentityConflict extends Schema.TaggedError<IdentityConflict>()(
  "IdentityConflict",
  messageField,
) {}

/** A requested member, session, or API key does not exist. */
export class IdentityNotFound extends Schema.TaggedError<IdentityNotFound>()(
  "IdentityNotFound",
  messageField,
) {}

/** A local browser login attempt is invalid, expired, or already consumed. */
export class LoginAttemptRejected extends Schema.TaggedError<LoginAttemptRejected>()(
  "LoginAttemptRejected",
  messageField,
) {}

/** The requested comment thread or reply does not exist on the artifact. */
export class CommentNotFound extends Schema.TaggedError<CommentNotFound>()(
  "CommentNotFound",
  messageField,
) {}

/** A reply was attempted on a comment thread that is already resolved. */
export class CommentResolved extends Schema.TaggedError<CommentResolved>()(
  "CommentResolved",
  messageField,
) {}

/** A comment body, anchor, or file path does not meet the comment contract. */
export class InvalidComment extends Schema.TaggedError<InvalidComment>()(
  "InvalidComment",
  messageField,
) {}

/** The requested registered agent does not exist in this installation. */
export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  messageField,
) {}

/** The requested agent dispatch does not exist in this project. */
export class AgentDispatchNotFound extends Schema.TaggedError<AgentDispatchNotFound>()(
  "AgentDispatchNotFound",
  messageField,
) {}

/** A dispatch registration or bundle does not meet the dispatch contract. */
export class InvalidDispatch extends Schema.TaggedError<InvalidDispatch>()(
  "InvalidDispatch",
  messageField,
) {}

/** A dispatch report, claim, or cancellation conflicts with its state. */
export class DispatchStateConflict extends Schema.TaggedError<DispatchStateConflict>()(
  "DispatchStateConflict",
  messageField,
) {}

/** The authenticated principal is not permitted to perform the operation. */
export class AuthorizationDenied extends Schema.TaggedError<AuthorizationDenied>()(
  "AuthorizationDenied",
  messageField,
) {}

/** A private-content bootstrap cannot be exchanged. */
export class ContentBootstrapRejected extends Schema.TaggedError<ContentBootstrapRejected>()(
  "ContentBootstrapRejected",
  messageField,
) {}

/** A private version request lacks its exact version-scoped browser session. */
export class ContentSessionRequired extends Schema.TaggedError<ContentSessionRequired>()(
  "ContentSessionRequired",
  messageField,
) {}

/** The requested saved version does not exist on the named artifact. */
export class VersionNotFound extends Schema.TaggedError<VersionNotFound>()(
  "VersionNotFound",
  messageField,
) {}

/** An artifact name cannot be parsed into the supported domain value. */
export class InvalidArtifactName extends Schema.TaggedError<InvalidArtifactName>()(
  "InvalidArtifactName",
  messageField,
) {}

/** An edit commit does not name one editable text file of its base version. */
export class InvalidArtifactEdit extends Schema.TaggedError<InvalidArtifactEdit>()(
  "InvalidArtifactEdit",
  messageField,
) {}

/** A requested artifact path does not meet the readable path grammar. */
export class InvalidArtifactPath extends Schema.TaggedError<InvalidArtifactPath>()(
  "InvalidArtifactPath",
  messageField,
) {}

/** A project name cannot be parsed into the supported domain value. */
export class InvalidProjectName extends Schema.TaggedError<InvalidProjectName>()(
  "InvalidProjectName",
  messageField,
) {}

/** The requested project does not exist in this installation. */
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "ProjectNotFound",
  messageField,
) {}

/** The selected project is archived and cannot accept new work. */
export class ProjectArchived extends Schema.TaggedError<ProjectArchived>()(
  "ProjectArchived",
  messageField,
) {}

/** A project management command conflicts with its current lifecycle state. */
export class ProjectConflict extends Schema.TaggedError<ProjectConflict>()(
  "ProjectConflict",
  messageField,
) {}

/** More than one active project exists and the caller must choose one. */
export class ProjectSelectionRequired extends Schema.TaggedError<ProjectSelectionRequired>()(
  "ProjectSelectionRequired",
  {message: Schema.String, projects: Schema.Array(Schema.Struct({id: Schema.String, name: Schema.String}))},
) {}

/** Artifact tags cannot be normalized into the supported metadata contract. */
export class InvalidArtifactTags extends Schema.TaggedError<InvalidArtifactTags>()(
  "InvalidArtifactTags",
  messageField,
) {}

/** An idempotency key does not meet the publishing contract. */
export class InvalidIdempotencyKey extends Schema.TaggedError<InvalidIdempotencyKey>()(
  "InvalidIdempotencyKey",
  messageField,
) {}

/** A bounded list request contains an invalid page size or cursor. */
export class InvalidPagination extends Schema.TaggedError<InvalidPagination>()(
  "InvalidPagination",
  messageField,
) {}

/** A manifest contains no files. */
export class EmptyManifest extends Schema.TaggedError<EmptyManifest>()(
  "EmptyManifest",
  messageField,
) {}

/** A manifest's entry path does not name one of its files. */
export class MissingManifestEntry extends Schema.TaggedError<MissingManifestEntry>()(
  "MissingManifestEntry",
  messageField,
) {}

/** A manifest file declaration cannot be parsed safely. */
export class InvalidManifestFile extends Schema.TaggedError<InvalidManifestFile>()(
  "InvalidManifestFile",
  messageField,
) {}

/** A manifest path is unsafe or not portable. */
export class InvalidManifestPath extends Schema.TaggedError<InvalidManifestPath>()(
  "InvalidManifestPath",
  messageField,
) {}

/** Uploaded bytes do not match their declared length or fingerprint. */
export class UploadedFileMismatch extends Schema.TaggedError<UploadedFileMismatch>()(
  "UploadedFileMismatch",
  messageField,
) {}

/** An upload request announces more bytes than its file declared. */
export class UploadTooLarge extends Schema.TaggedError<UploadTooLarge>()(
  "UploadTooLarge",
  messageField,
) {}

/** An idempotency key was already bound to different publication input. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  messageField,
) {}

/** The artifact's current version changed before the publication committed. */
export class PublishConflict extends Schema.TaggedError<PublishConflict>()(
  "PublishConflict",
  messageField,
) {}

/** The requested staged upload has already committed. */
export class UploadClosed extends Schema.TaggedError<UploadClosed>()(
  "UploadClosed",
  messageField,
) {}

/** The requested staged upload is no longer open for publication. */
export class UploadExpired extends Schema.TaggedError<UploadExpired>()(
  "UploadExpired",
  messageField,
) {}

/** The requested file slot does not exist in the staged upload. */
export class UploadFileNotFound extends Schema.TaggedError<UploadFileNotFound>()(
  "UploadFileNotFound",
  messageField,
) {}

/** A staged upload does not yet contain every verified file. */
export class UploadIncomplete extends Schema.TaggedError<UploadIncomplete>()(
  "UploadIncomplete",
  messageField,
) {}

/** The requested staged upload does not exist for the principal. */
export class UploadNotFound extends Schema.TaggedError<UploadNotFound>()(
  "UploadNotFound",
  messageField,
) {}

/** The requested artifact cannot be opened without an authorized session. */
export class ContentNotPublic extends Schema.TaggedError<ContentNotPublic>()(
  "ContentNotPublic",
  messageField,
) {}

/** A deployment-gated capability is not available on this installation. */
export class CapabilityUnavailable extends Schema.TaggedError<CapabilityUnavailable>()(
  "CapabilityUnavailable",
  messageField,
) {}

/** An outbound repository operation failed unexpectedly. */
export class ArtifactRepositoryFailure extends Schema.TaggedError<ArtifactRepositoryFailure>()(
  "ArtifactRepositoryFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals([
      "assertPublicationSourceReady",
      "cancelAgentDispatch",
      "changeAccessSetting",
      "changeTags",
      "claimAgentDispatch",
      "clearCommentThreads",
      "commitAsset",
      "commitNewArtifact",
      "commitVersion",
      "createAgentDispatch",
      "createCommentReply",
      "createCommentThread",
      "createContentBootstrap",
      "createPreviewLease",
      "createStagedUpload",
      "exchangeContentBootstrap",
      "deleteCommentReply",
      "deleteCommentThread",
      "disconnectRegisteredAgent",
      "findAgentDispatch",
      "findArtifact",
      "findArtifactByPath",
      "findArtifactForAdministration",
      "findVersionRecord",
      "findCommentThread",
      "findRegisteredAgent",
      "findContentSession",
      "findCurrentVersion",
      "findIdempotentAccessChange",
      "findIdempotentCommentReply",
      "findIdempotentCommentThread",
      "findIdempotentPublication",
      "findPreviewLease",
      "findStagedUpload",
      "findVersionContent",
      "deleteArtifact",
      "deleteAsset",
      "findIdempotentAsset",
      "findServedAsset",
      "listAgentDispatches",
      "listArtifactActions",
      "listArtifacts",
      "listCommentReplies",
      "listCollapsedFolders",
      "listCommentThreads",
      "listArtifactVersions",
      "listAssets",
      "listPublicLinks",
      "listExpiredStagedUploads",
      "listCatalogArtifacts",
      "listRegisteredAgents",
      "markAgentDispatchDelivered",
      "markAgentDispatchFailed",
      "markStagedFileUploaded",
      "readAssetUsage",
      "observeAgentDispatchAddressed",
      "recordAgentActivity",
      "registerAgent",
      "removeExpiredStagedUpload",
      "restoreVersion",
      "updateCommentReply",
      "updateCommentThread",
      "versionContainsPath",
      "createProject",
      "findProject",
      "listProjects",
      "readArtifactVersionDays",
      "readArtifactViewDays",
      "readMostViewedArtifacts",
      "readProjectActivityDays",
      "readProjectActivityTotals",
      "renameArtifact",
      "readArtifactViewTotals",
      "recordArtifactViews",
      "renameProject",
      "setFolderDefaultState",
      "setProjectArchive",
    ]),
  },
) {}

/** An outbound installation-identity operation failed unexpectedly. */
export class IdentityRepositoryFailure extends Schema.TaggedError<IdentityRepositoryFailure>()(
  "IdentityRepositoryFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals([
      "admitMember",
      "consumeLoginAttempt",
      "createApiKey",
      "createApplicationSession",
      "createLoginAttempt",
      "deactivateMember",
      "findActiveMemberByEmail",
      "findMember",
      "findApiKey",
      "findApplicationSession",
      "hasMembers",
      "listApiKeys",
      "listInstallationActions",
      "listMembers",
      "revokeApiKey",
      "revokeApplicationSession",
      "rotateApiKey",
    ]),
  },
) {}

/** An outbound immutable-blob operation failed unexpectedly. */
export class BlobStorageFailure extends Schema.TaggedError<BlobStorageFailure>()(
  "BlobStorageFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["inspect", "open", "put"]),
  },
) {}

/** An outbound staging-storage operation failed unexpectedly. */
export class StagingStorageFailure extends Schema.TaggedError<StagingStorageFailure>()(
  "StagingStorageFailure",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["open", "put", "remove"]),
  },
) {}

const artifactServerFailureSchema = Schema.Union([
  AgentDispatchNotFound,
  AgentNotFound,
  ArtifactNotFound,
  ArtifactMutationConflict,
  ArtifactPathTaken,
  AssetLimitExceeded,
  AssetNotFound,
  AssetTypeUnsupported,
  AuthenticationRequired,
  CommentNotFound,
  CommentResolved,
  DispatchStateConflict,
  InvalidComment,
  InvalidDispatch,
  IdentityConflict,
  IdentityNotFound,
  LoginAttemptRejected,
  AuthorizationDenied,
  ContentBootstrapRejected,
  ContentSessionRequired,
  InvalidArtifactEdit,
  InvalidArtifactName,
  InvalidArtifactPath,
  InvalidProjectName,
  InvalidArtifactTags,
  InvalidIdempotencyKey,
  InvalidPagination,
  EmptyManifest,
  MissingManifestEntry,
  InvalidManifestFile,
  InvalidManifestPath,
  UploadedFileMismatch,
  IdempotencyConflict,
  PublishConflict,
  ProjectArchived,
  ProjectConflict,
  ProjectNotFound,
  ProjectSelectionRequired,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  UploadTooLarge,
  VersionNotFound,
  ContentNotPublic,
  CapabilityUnavailable,
  ArtifactRepositoryFailure,
  IdentityRepositoryFailure,
  BlobStorageFailure,
  StagingStorageFailure,
]);

/** Every expected product or outbound-adapter failure handled by an entry point. */
export type ArtifactServerFailure = typeof artifactServerFailureSchema.Type;

const failureGuard = Schema.is(artifactServerFailureSchema);

/** Determine whether an unknown boundary failure is an Artifact Server failure value. */
export function isArtifactServerFailure(
  input: Error,
): input is ArtifactServerFailure {
  return failureGuard(input);
}
