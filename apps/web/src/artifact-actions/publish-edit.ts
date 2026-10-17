import {ApiError} from "../api/client.js";
import type {Bytes} from "./bytes.js";
import {maximumEditableBytes} from "./editable-entries.js";
import {
  commitUpload,
  createUpload,
  putUploadFile,
  type ActionTransport,
  type ArtifactActionResult,
} from "./transport.js";
import {buildUploadPlan} from "./upload-plan.js";

export interface PublishEditInput {
  readonly artifactId: string;
  /** The version whose manifest the edit starts from. */
  readonly baseVersionId: string;
  /** The edited file's exact bytes, BOM and line endings included. */
  readonly bytes: Bytes;
  /** The artifact's current version as the editor last saw it. */
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  /** The base entry's media type, kept so the edit does not retype the file. */
  readonly mediaType: string;
  readonly path: string;
  readonly projectId: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Publishes one edited text file as a new version (EDT-001): stages the bytes
 * through the verified upload flow, then commits an edit target that the server
 * compares against the artifact's current version. A stale save surfaces as a
 * conflict ApiError and writes nothing.
 */
export async function publishEdit(
  transport: ActionTransport,
  input: PublishEditInput,
): Promise<ArtifactActionResult> {
  if (input.bytes.byteLength > maximumEditableBytes) {
    throw new ApiError(
      "EDIT_TOO_LARGE",
      `Edited files are limited to ${maximumEditableBytes} bytes.`,
      413,
    );
  }
  const plan = await buildUploadPlan({
    entryPath: input.path,
    files: [{bytes: input.bytes, mediaType: input.mediaType, path: input.path}],
    routingMode: "static",
  });
  const upload = await createUpload(transport, plan, input.projectId, input.signal);
  await putUploadFile(
    transport,
    upload,
    {bytes: input.bytes, mediaType: input.mediaType, path: input.path},
    input.signal,
  );
  return await commitUpload(transport, upload, {
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    target: {
      artifactId: input.artifactId,
      baseVersionId: input.baseVersionId,
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      kind: "edit",
      path: input.path,
    },
  });
}

/** True when the server refused because the artifact moved past the expected version. */
export function isVersionConflict(error: Error): error is ApiError {
  return error instanceof ApiError
    && (error.code === "PUBLISH_CONFLICT" || error.code === "ARTIFACT_MUTATION_CONFLICT");
}
