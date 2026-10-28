import {createHash} from "node:crypto";

import {Effect, Schema} from "effect";

import type {EntryRow, IntegrityCatalog} from "../core/integrity-catalog.js";
import type {BlobStore} from "../core/ports.js";
import {createManifest} from "../manifest/create-manifest.js";
import {objectStorageProviderKinds} from
  "../storage/object-storage-provider.js";

/** One concrete inconsistency found without changing installation state. */
export interface IntegrityProblem {
  readonly artifactId: string;
  readonly code:
    | "blob_digest_mismatch"
    | "blob_missing"
    | "blob_size_mismatch"
    | "blob_unreadable"
    | "current_pointer_missing"
    | "manifest_invalid"
    | "orphan_project"
    | "orphan_entry"
    | "orphan_version"
    | "project_scope_mismatch";
  readonly message: string;
  readonly path: string | null;
  readonly versionId: string | null;
}

/** Complete result of one read-only integrity scan. */
export interface IntegrityReport {
  readonly artifactsChecked: number;
  readonly blobsChecked: number;
  readonly bytesChecked: number;
  readonly manifestsChecked: number;
  readonly problems: readonly IntegrityProblem[];
  readonly status: "healthy" | "corrupt";
  readonly versionsChecked: number;
}

/** The integrity scanner could not inspect a required provider. */
export class IntegrityCheckError extends Schema.TaggedError<IntegrityCheckError>()(
  "IntegrityCheckError",
  {
    message: Schema.String,
    provider: Schema.Literals([
      ...objectStorageProviderKinds,
      "filesystem",
      "postgres",
      "sqlite",
    ]),
  },
) {}

/** Check a parsed provider catalog and its immutable blob store together. */
export const checkIntegrityCatalog = Effect.fn("checkIntegrityCatalog")(function*(
  catalog: IntegrityCatalog,
  blobs: BlobStore,
): Effect.fn.Return<IntegrityReport> {
  const problems: IntegrityProblem[] = [];
  const artifacts = new Map(catalog.artifacts.map((artifact) => [artifact.id, artifact]));
  const projects = new Set(catalog.projects.map((project) => project.id));
  const versions = new Map(catalog.versions.map((version) => [version.id, version]));
  const entriesByVersion = new Map<string, EntryRow[]>();

  for (const version of catalog.versions) {
    const artifact = artifacts.get(version.artifactId);
    if (artifact === undefined) {
      problems.push({
        artifactId: version.artifactId,
        code: "orphan_version",
        message: "A saved version refers to an artifact that does not exist.",
        path: null,
        versionId: version.id,
      });
    } else if (artifact.projectId !== version.projectId) {
      problems.push({
        artifactId: version.artifactId,
        code: "project_scope_mismatch",
        message: "A saved version belongs to a different project than its artifact.",
        path: null,
        versionId: version.id,
      });
    }
  }
  for (const artifact of catalog.artifacts) {
    if (projects.has(artifact.projectId)) continue;
    problems.push({
      artifactId: artifact.id,
      code: "orphan_project",
      message: "An artifact refers to a project that does not exist.",
      path: null,
      versionId: artifact.currentVersionId,
    });
  }
  for (const reference of catalog.projectReferences) {
    const artifact = reference.artifactId === null
      ? undefined
      : artifacts.get(reference.artifactId);
    const version = reference.versionId === null
      ? undefined
      : versions.get(reference.versionId);
    const projectMissing = !projects.has(reference.projectId);
    const artifactMismatch = reference.artifactId !== null &&
      (artifact === undefined || artifact.projectId !== reference.projectId);
    const versionMismatch = reference.versionId !== null &&
      (version === undefined ||
        version.projectId !== reference.projectId ||
        (reference.artifactId !== null &&
          version.artifactId !== reference.artifactId));
    if (!projectMissing && !artifactMismatch && !versionMismatch) continue;
    problems.push({
      artifactId: reference.artifactId ?? version?.artifactId ?? "unknown",
      code: projectMissing ? "orphan_project" : "project_scope_mismatch",
      message: projectMissing
        ? `A ${reference.kind} record refers to a project that does not exist.`
        : `A ${reference.kind} record crosses an artifact project boundary.`,
      path: null,
      versionId: reference.versionId,
    });
  }
  for (const entry of catalog.entries) {
    const version = versions.get(entry.versionId);
    if (version === undefined) {
      problems.push({
        artifactId: "unknown",
        code: "orphan_entry",
        message: "A manifest entry refers to a version that does not exist.",
        path: entry.path,
        versionId: entry.versionId,
      });
      continue;
    }
    const entries = entriesByVersion.get(entry.versionId) ?? [];
    entries.push(entry);
    entriesByVersion.set(entry.versionId, entries);
  }
  for (const artifact of catalog.artifacts) {
    const current = artifact.currentVersionId;
    const currentVersion = current === null ? undefined : versions.get(current);
    if (
      current !== null &&
      (currentVersion?.artifactId !== artifact.id ||
        currentVersion.projectId !== artifact.projectId)
    ) {
      problems.push({
        artifactId: artifact.id,
        code: "current_pointer_missing",
        message: "The artifact's current version does not exist for this artifact.",
        path: null,
        versionId: current,
      });
    }
  }

  for (const version of catalog.versions) {
    const entries = entriesByVersion.get(version.id) ?? [];
    try {
      const manifest = createManifest({
        entryPath: version.entryPath,
        files: entries.map((entry) => ({
          mediaType: entry.mediaType,
          path: entry.path,
          sha256: entry.sha256,
          size: entry.size,
        })),
        routingMode: version.routingMode,
      });
      const dispositionByPath = new Map(
        manifest.entries.map((entry) => [entry.path, entry.disposition] as const),
      );
      if (
        manifest.digest !== version.manifestDigest ||
        entries.some((entry) =>
          dispositionByPath.get(entry.path) !== entry.disposition
        )
      ) {
        throw new Error("Stored manifest metadata differs.");
      }
    } catch {
      problems.push({
        artifactId: version.artifactId,
        code: "manifest_invalid",
        message: "The saved manifest does not match its stored entries.",
        path: null,
        versionId: version.id,
      });
    }
  }

  const blobReferences: BlobReference[] = [
    ...catalog.entries.map((entry) => ({
      artifactId: versions.get(entry.versionId)?.artifactId ?? "unknown",
      assetId: null,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
      versionId: entry.versionId,
    })),
    ...catalog.assets.map((asset) => ({
      artifactId: asset.artifactId,
      assetId: asset.id,
      path: null,
      sha256: asset.sha256,
      size: asset.size,
      versionId: null,
    })),
  ];
  const uniqueBlobs = new Map<string, BlobReference>();
  for (const reference of blobReferences) {
    const existing = uniqueBlobs.get(reference.sha256);
    if (existing !== undefined && existing.size !== reference.size) {
      problems.push({
        artifactId: reference.artifactId,
        code: "blob_size_mismatch",
        message: blobReferenceMessage(
          "The same blob fingerprint is recorded with conflicting sizes.",
          reference,
        ),
        path: reference.path,
        versionId: reference.versionId,
      });
    } else if (existing === undefined) {
      uniqueBlobs.set(reference.sha256, reference);
    }
  }
  const blobVerifications = yield* Effect.forEach(
    [...uniqueBlobs.values()],
    (reference) => Effect.promise(() => verifyBlob(blobs, reference)).pipe(
      Effect.map((verification) => ({reference, verification})),
    ),
    {concurrency: 4},
  );
  let blobsChecked = 0;
  let bytesChecked = 0;
  for (const {reference, verification} of blobVerifications) {
    if (verification.opened) blobsChecked += 1;
    bytesChecked += verification.bytesRead;
    if (verification.problem !== null) {
      problems.push({
        artifactId: reference.artifactId,
        code: verification.problem,
        message: blobReferenceMessage(
          blobProblemMessage(verification.problem),
          reference,
        ),
        path: reference.path,
        versionId: reference.versionId,
      });
    }
  }
  return {
    artifactsChecked: catalog.artifacts.length,
    blobsChecked,
    bytesChecked,
    manifestsChecked: catalog.versions.length,
    problems,
    status: problems.length === 0 ? "healthy" : "corrupt",
    versionsChecked: catalog.versions.length,
  };
});

/** One stored fingerprint that a manifest entry or a live asset depends on. */
interface BlobReference {
  readonly artifactId: string;
  readonly assetId: string | null;
  readonly path: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly versionId: string | null;
}

interface BlobVerification {
  readonly bytesRead: number;
  readonly opened: boolean;
  readonly problem:
    | "blob_digest_mismatch"
    | "blob_missing"
    | "blob_size_mismatch"
    | "blob_unreadable"
    | null;
}

async function verifyBlob(
  blobs: BlobStore,
  entry: Pick<BlobReference, "sha256" | "size">,
): Promise<BlobVerification> {
  let opened: Awaited<ReturnType<BlobStore["open"]>>;
  try {
    opened = await blobs.open(entry.sha256);
  } catch {
    return {bytesRead: 0, opened: false, problem: "blob_missing"};
  }
  const fingerprint = createHash("sha256");
  let bytesRead = 0;
  try {
    await opened.body.pipeTo(new WritableStream<Uint8Array>({
      write(chunk) {
        bytesRead += chunk.byteLength;
        fingerprint.update(chunk);
      },
    }));
    const digest = fingerprint.digest("hex");
    return {
      bytesRead,
      opened: true,
      problem: opened.size !== entry.size || bytesRead !== entry.size
        ? "blob_size_mismatch"
        : digest !== entry.sha256
        ? "blob_digest_mismatch"
        : null,
    };
  } catch {
    return {bytesRead, opened: true, problem: "blob_unreadable"};
  }
}

function blobReferenceMessage(message: string, reference: BlobReference): string {
  return reference.assetId === null
    ? message
    : `${message} It backs asset ${reference.assetId}.`;
}

function blobProblemMessage(
  code: Exclude<BlobVerification["problem"], null>,
): string {
  switch (code) {
    case "blob_digest_mismatch":
      return "A referenced blob does not match its fingerprint.";
    case "blob_missing":
      return "A referenced blob could not be opened.";
    case "blob_size_mismatch":
      return "A referenced blob has the wrong size.";
    case "blob_unreadable":
      return "A referenced blob could not be read completely.";
  }
  throw new Error("Unknown blob integrity problem.");
}
