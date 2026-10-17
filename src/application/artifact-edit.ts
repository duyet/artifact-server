import {Effect} from "effect";

import {InvalidArtifactEdit} from "../core/errors.js";
import type {CanonicalManifest, ManifestEntry} from "../core/model.js";
import {maximumEditableTextBytes} from "../core/publishing-limits.js";
import type {ManifestInput} from "../manifest/create-manifest.js";

const textApplicationMediaTypes = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/x-yaml",
  "application/xhtml+xml",
  "application/xml",
  "application/yaml",
]);

/**
 * Whether a media type names text an editor can round-trip: any `text/*`, the
 * JSON, JavaScript, YAML, and XML application types, and `+json` or `+xml`
 * suffixes.
 */
export function isEditableTextMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence.startsWith("text/") ||
    textApplicationMediaTypes.has(essence) ||
    essence.endsWith("+json") ||
    essence.endsWith("+xml");
}

/**
 * The manifest input for one edit: the base version's files with the entry at
 * `path` replaced by the staged upload's single file. Every rule an edit
 * carries is checked here, before any byte is stored.
 */
export function editedManifestInput(
  base: CanonicalManifest,
  staged: CanonicalManifest,
  path: string,
): Effect.Effect<ManifestInput, InvalidArtifactEdit> {
  const [replacement, ...extra] = staged.entries;
  if (replacement === undefined || extra.length > 0 || replacement.path !== path) {
    return new InvalidArtifactEdit({
      message: "An edit upload must hold exactly one file at the edited path.",
    });
  }
  const original = base.entries.find((entry) => entry.path === path);
  if (original === undefined) {
    return new InvalidArtifactEdit({
      message: "The edited path is not a file of the base version.",
    });
  }
  if (
    !isEditableTextMediaType(original.mediaType) ||
    !isEditableTextMediaType(replacement.mediaType)
  ) {
    return new InvalidArtifactEdit({
      message: "Only text files can be edited.",
    });
  }
  if (replacement.size > maximumEditableTextBytes) {
    return new InvalidArtifactEdit({
      message:
        `An edited file can hold at most ${maximumEditableTextBytes} bytes.`,
    });
  }
  return Effect.succeed({
    entryPath: base.entryPath,
    files: base.entries.map((entry) =>
      declaredFile(entry.path === path ? replacement : entry)),
    routingMode: base.routingMode,
  });
}

function declaredFile(entry: ManifestEntry) {
  return {
    mediaType: entry.mediaType,
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
  };
}
