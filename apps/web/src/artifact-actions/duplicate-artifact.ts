import {ApiError, type Manifest, type ManifestEntry} from "../api/client.js";
import {
  commitUpload,
  createUpload,
  fetchVersionFile,
  putUploadFile,
  type ActionTransport,
  type ArtifactActionResult,
} from "./transport.js";
import {planFromManifest, sha256Hex} from "./upload-plan.js";

const copySuffix = " (copy)";
const maximumNameLength = 200;
const transferConcurrency = 4;

export interface DuplicateProgress {
  /** Files fully copied so far (downloaded and verified by the server). */
  readonly copiedFiles: number;
  readonly phase: "committing" | "copying" | "planning";
  readonly totalFiles: number;
}

export interface DuplicateArtifactInput {
  readonly artifactId: string;
  readonly artifactName: string;
  readonly artifactTags: readonly string[];
  readonly idempotencyKey: string;
  readonly manifest: Manifest;
  readonly onProgress?: ((progress: DuplicateProgress) => void) | undefined;
  readonly projectId: string;
  readonly signal?: AbortSignal | undefined;
  readonly versionId: string;
}

/** Name of the duplicate, kept inside the server's 200-character bound. */
export function duplicateName(name: string): string {
  return `${Array.from(name).slice(0, maximumNameLength - copySuffix.length).join("")}${copySuffix}`;
}

/**
 * Duplicates an artifact through the existing publish pipeline (FRK-013):
 * every file of the source version is downloaded, checked against the
 * manifest fingerprint, staged, and committed as a new private artifact owned
 * by the caller. The source is never touched.
 */
export async function duplicateArtifact(
  transport: ActionTransport,
  input: DuplicateArtifactInput,
): Promise<ArtifactActionResult> {
  const report = (progress: DuplicateProgress): void => input.onProgress?.(progress);
  const totalFiles = input.manifest.entries.length;
  report({copiedFiles: 0, phase: "planning", totalFiles});
  const upload = await createUpload(
    transport,
    planFromManifest(input.manifest),
    input.projectId,
    input.signal,
  );

  let copiedFiles = 0;
  report({copiedFiles, phase: "copying", totalFiles});
  // One failed transfer stops the others instead of letting them run on.
  const transfers = new AbortController();
  input.signal?.addEventListener("abort", () => transfers.abort(), {once: true});
  const copyEntry = async (entry: ManifestEntry): Promise<void> => {
    const bytes = await fetchVersionFile(transport, {
      artifactId: input.artifactId,
      path: entry.path,
      projectId: input.projectId,
      signal: transfers.signal,
      versionId: input.versionId,
    });
    if (bytes.byteLength !== entry.size || await sha256Hex(bytes) !== entry.sha256) {
      throw new ApiError(
        "SOURCE_FILE_MISMATCH",
        `The stored bytes of ${entry.path} do not match its manifest fingerprint. Nothing was copied.`,
        502,
      );
    }
    await putUploadFile(
      transport,
      upload,
      {bytes, mediaType: entry.mediaType, path: entry.path},
      transfers.signal,
    );
    copiedFiles += 1;
    report({copiedFiles, phase: "copying", totalFiles});
  };
  // Each lane copies its share one file at a time; lanes run side by side.
  const lanes = Array.from(
    {length: Math.min(transferConcurrency, totalFiles)},
    (_, lane) => input.manifest.entries.filter((_entry, index) => index % transferConcurrency === lane),
  );
  await Promise.all(lanes.map((lane) =>
    lane.reduce(
      (previous, entry) => previous.then(() => copyEntry(entry)),
      Promise.resolve(),
    ).catch((failure: Error) => {
      transfers.abort();
      throw failure;
    })));

  report({copiedFiles, phase: "committing", totalFiles});
  return await commitUpload(transport, upload, {
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: duplicateName(input.artifactName),
      tags: input.artifactTags,
    },
  });
}
