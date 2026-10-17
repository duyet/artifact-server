import type {ManifestEntry} from "../api/client.js";
import type {Bytes} from "./bytes.js";

/** One file as the upload-plan request declares it. */
export interface DeclaredFile {
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface UploadPlanRequest {
  readonly entryPath: string;
  readonly files: readonly DeclaredFile[];
  readonly routingMode: "spa" | "static";
}

/** Lowercase hexadecimal SHA-256 of the bytes, as the server verifies it. */
export async function sha256Hex(bytes: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Declares in-memory files, fingerprinting each one. */
export async function buildUploadPlan(input: {
  readonly entryPath: string;
  readonly files: readonly {
    readonly bytes: Bytes;
    readonly mediaType: string;
    readonly path: string;
  }[];
  readonly routingMode: "spa" | "static";
}): Promise<UploadPlanRequest> {
  const files = await Promise.all(input.files.map(async (file) => ({
    mediaType: file.mediaType,
    path: file.path,
    sha256: await sha256Hex(file.bytes),
    size: file.bytes.byteLength,
  })));
  return {entryPath: input.entryPath, files, routingMode: input.routingMode};
}

/**
 * Declares an existing version's files from its manifest. The manifest already
 * carries each entry's verified fingerprint, so no bytes are read to plan.
 */
export function planFromManifest(manifest: {
  readonly entries: readonly ManifestEntry[];
  readonly entryPath: string;
  readonly routingMode: "spa" | "static";
}): UploadPlanRequest {
  return {
    entryPath: manifest.entryPath,
    files: manifest.entries.map((entry) => ({
      mediaType: entry.mediaType,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
    })),
    routingMode: manifest.routingMode,
  };
}
