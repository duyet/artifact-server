import {ArtifactPathTaken} from "../core/errors.js";

/**
 * The stored paths that a new path would overlap. `lineage` holds the path
 * and each ancestor. Descendants fill the half-open range `[from, to)`: `0` is
 * the byte right after `/`, so under byte-order comparison the range holds
 * exactly the paths below this one.
 */
export interface ArtifactPathClaim {
  readonly descendants: {readonly from: string; readonly to: string};
  readonly lineage: readonly string[];
}

/** Describe the overlap check for one path already normalized at the boundary. */
export function artifactPathClaim(path: string): ArtifactPathClaim {
  const segments = path.split("/");
  return {
    descendants: {from: `${path}/`, to: `${path}0`},
    lineage: segments.map((_, index) => segments.slice(0, index + 1).join("/")),
  };
}

/** The conflict a claim reports, naming the live path it overlaps. */
export function artifactPathTaken(path: string, existing: string): ArtifactPathTaken {
  return new ArtifactPathTaken({
    message: existing === path
      ? `The path "${path}" already belongs to another artifact.`
      : `The path "${path}" overlaps the existing artifact path "${existing}".`,
  });
}
