import type {ManifestEntry} from "../api/client.js";

/**
 * Mirrors the server's editing size bound (EDT-003). The capabilities endpoint
 * does not expose it yet; the server stays authoritative and rejects an
 * oversize edit regardless of this constant.
 */
export const maximumEditableBytes = 1_048_576;

const editableApplicationTypes = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/xhtml+xml",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "image/svg+xml",
]);

function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

/** True for media types whose bytes are text the editor may rewrite. */
export function isEditableMediaType(mediaType: string): boolean {
  const base = baseMediaType(mediaType);
  return base.startsWith("text/")
    || editableApplicationTypes.has(base)
    || base.endsWith("+json")
    || base.endsWith("+xml");
}

/** Manifest entries of a version that the editor can open, in manifest order. */
export function editableEntries(
  entries: readonly ManifestEntry[],
): readonly ManifestEntry[] {
  return entries.filter((entry) => isEditableMediaType(entry.mediaType));
}

/** Picks the entry the editor opens first: the entry page when editable. */
export function defaultEditablePath(
  entries: readonly ManifestEntry[],
  entryPath: string,
): string | null {
  const editable = editableEntries(entries);
  return editable.find((entry) => entry.path === entryPath)?.path
    ?? editable[0]?.path
    ?? null;
}
