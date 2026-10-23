import {
  type ArtifactServerFailure,
  errorCodes,
} from "../core/errors.js";

/** Stable protocol-safe projection shared by HTTP and MCP adapters. */
export function artifactServerFailureResponse(failure: ArtifactServerFailure) {
  switch (failure._tag) {
    case "AgentNotFound":
      return {code: errorCodes.agentNotFound, message: failure.message, status: 404};
    case "AgentDispatchNotFound":
      return {code: errorCodes.dispatchNotFound, message: failure.message, status: 404};
    case "InvalidDispatch":
      return {code: errorCodes.invalidDispatch, message: failure.message, status: 422};
    case "DispatchStateConflict":
      return {code: errorCodes.dispatchStateConflict, message: failure.message, status: 409};
    case "ArtifactNotFound":
      return {code: errorCodes.artifactNotFound, message: failure.message, status: 404};
    case "ArtifactMutationConflict":
      return {code: errorCodes.artifactMutationConflict, message: failure.message, status: 409};
    case "ArtifactPathTaken":
      return {code: errorCodes.artifactPathTaken, message: failure.message, status: 409};
    case "AssetLimitExceeded":
      return {code: errorCodes.assetLimitExceeded, message: failure.message, status: 413};
    case "AssetNotFound":
      return {code: errorCodes.assetNotFound, message: failure.message, status: 404};
    case "AssetTypeUnsupported":
      return {code: errorCodes.assetTypeUnsupported, message: failure.message, status: 415};
    case "AuthenticationRequired":
      return {code: errorCodes.authenticationRequired, message: failure.message, status: 401};
    case "IdentityConflict":
      return {code: errorCodes.identityConflict, message: failure.message, status: 409};
    case "IdentityNotFound":
      return {code: errorCodes.identityNotFound, message: failure.message, status: 404};
    case "LoginAttemptRejected":
      return {code: errorCodes.authenticationRequired, message: failure.message, status: 401};
    case "AuthorizationDenied":
      return {code: errorCodes.authorizationDenied, message: failure.message, status: 403};
    case "CommentNotFound":
      return {code: errorCodes.commentNotFound, message: failure.message, status: 404};
    case "CommentResolved":
      return {code: errorCodes.commentResolved, message: failure.message, status: 409};
    case "InvalidComment":
      return {code: errorCodes.invalidComment, message: failure.message, status: 422};
    case "ContentBootstrapRejected":
      return {code: errorCodes.contentBootstrapRejected, message: failure.message, status: 401};
    case "ContentSessionRequired":
    case "ContentNotPublic":
      return {code: errorCodes.contentNotPublic, message: failure.message, status: 401};
    case "InvalidArtifactEdit":
    case "InvalidArtifactName":
    case "InvalidArtifactPath":
    case "InvalidProjectName":
    case "InvalidArtifactTags":
    case "InvalidIdempotencyKey":
    case "InvalidPagination":
    case "EmptyManifest":
    case "MissingManifestEntry":
    case "InvalidManifestFile":
    case "UploadedFileMismatch":
      return {code: errorCodes.invalidInput, message: failure.message, status: 422};
    case "InvalidManifestPath":
      return {code: errorCodes.invalidManifestPath, message: failure.message, status: 422};
    case "IdempotencyConflict":
      return {code: errorCodes.idempotencyConflict, message: failure.message, status: 409};
    case "PublishConflict":
      return {code: errorCodes.publishConflict, message: failure.message, status: 409};
    case "ProjectArchived":
      return {code: errorCodes.projectArchived, message: failure.message, status: 409};
    case "ProjectConflict":
      return {code: errorCodes.projectConflict, message: failure.message, status: 409};
    case "ProjectNotFound":
      return {code: errorCodes.projectNotFound, message: failure.message, status: 404};
    case "ProjectSelectionRequired":
      return {
        code: errorCodes.projectSelectionRequired,
        message: failure.message,
        status: 409,
      };
    case "UploadClosed":
      return {code: errorCodes.uploadClosed, message: failure.message, status: 409};
    case "UploadExpired":
      return {code: errorCodes.uploadExpired, message: failure.message, status: 410};
    case "UploadFileNotFound":
      return {code: errorCodes.uploadFileNotFound, message: failure.message, status: 404};
    case "UploadIncomplete":
      return {code: errorCodes.uploadIncomplete, message: failure.message, status: 409};
    case "UploadNotFound":
      return {code: errorCodes.uploadNotFound, message: failure.message, status: 404};
    case "UploadTooLarge":
      return {code: errorCodes.uploadTooLarge, message: failure.message, status: 413};
    case "VersionNotFound":
      return {code: errorCodes.versionNotFound, message: failure.message, status: 404};
    case "CapabilityUnavailable":
      return {
        code: errorCodes.capabilityUnavailable,
        message: failure.message,
        status: 501,
      };
    case "ArtifactRepositoryFailure":
    case "IdentityRepositoryFailure":
    case "BlobStorageFailure":
    case "StagingStorageFailure":
      return {
        code: "INTERNAL_ERROR" as const,
        message: "The server could not complete the request.",
        status: 500,
      };
  }
  return casesHandled(failure);
}

function casesHandled(value: never): never {
  throw new Error(`Unhandled Artifact Server failure: ${String(value)}`);
}
