import {ArtifactPathTaken} from "../core/errors.js";
import type {CanonicalManifest} from "../core/model.js";

/**
 * The stored paths that a new path relates to. A path may nest inside another
 * artifact's path, so `ancestors` holds each folder above it that may serve as
 * its index page. Descendants fill the half-open range `[from, to)`: `0` is
 * the byte right after `/`, so under byte-order comparison the range holds
 * exactly the paths below this one.
 */
export interface ArtifactPathClaim {
  readonly ancestors: readonly string[];
  readonly descendants: {readonly from: string; readonly to: string};
}

/** Describe the overlap check for one path already normalized at the boundary. */
export function artifactPathClaim(path: string): ArtifactPathClaim {
  const segments = path.split("/");
  return {
    ancestors: segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/")),
    descendants: {from: `${path}/`, to: `${path}0`},
  };
}

/**
 * Where a nested artifact at `child` sits inside the folder artifact at
 * `holder`, as a manifest path prefix: the holder's file at that prefix, and
 * every file below it, can never be reached because the child wins routing.
 */
export function shadowedPrefix(holder: string, child: string): string {
  return child.slice(holder.length + 1);
}

/** The file paths a manifest would serve. */
export function manifestPaths(manifest: CanonicalManifest): readonly string[] {
  return manifest.entries.map((entry) => entry.path);
}

/** The first of `files` that a child at `prefix` would hide, or null. */
export function firstShadowedFile(
  prefix: string,
  files: Iterable<string>,
): string | null {
  for (const file of files) {
    if (file === prefix || file.startsWith(`${prefix}/`)) return file;
  }
  return null;
}

/** The conflict a claim reports when the exact path is already live. */
export function artifactPathTaken(path: string): ArtifactPathTaken {
  return new ArtifactPathTaken({
    message: `The path "${path}" already belongs to another artifact.`,
  });
}

/** The conflict a commit reports when a nested path would hide a file. */
export function artifactPathShadowed(
  holder: string,
  file: string,
  child: string,
): ArtifactPathTaken {
  return new ArtifactPathTaken({
    message: `The file "${file}" in the artifact path "${holder}" would be hidden by the artifact path "${child}".`,
  });
}
