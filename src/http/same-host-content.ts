/**
 * Fork-owned knowledge of path mode: content served from the application
 * origin instead of per-version content hosts. Everything that names the `/v/`
 * prefix or the artifact folder shape lives here so upstream files only call in.
 */

const versionPathSegment = "v";
const artifactIdPrefix = "art_";
const uuidSource =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const artifactFolderPattern = new RegExp(
  `^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?(${uuidSource})$`,
);
const artifactIdPattern = new RegExp(`^${artifactIdPrefix}(${uuidSource})$`);
const maxFolderSlugLength = 60;

/** The path of one immutable version, or of one file inside it, in path mode. */
export function sameHostVersionPath(
  contentToken: string,
  manifestPath?: string,
): string {
  const prefix = `/${versionPathSegment}/${contentToken}/`;
  return manifestPath === undefined
    ? prefix
    : `${prefix}${manifestPath.split("/").map(encodeURIComponent).join("/")}`;
}

function folderSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // NFKD leaves the Vietnamese "đ" whole, so fold it by hand.
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxFolderSlugLength)
    .replace(/-+$/, "");
}

/**
 * The readable folder of an artifact: a pure function of its name and ID, both
 * fixed at creation. Null when the ID is not `art_<uuid>`, so no folder is
 * invented for an ID that parseArtifactFolder could never resolve.
 */
export function artifactFolder(
  artifact: {readonly id: string; readonly name: string},
): string | null {
  const uuid = artifactIdPattern.exec(artifact.id)?.[1];
  if (uuid === undefined) return null;
  const slug = folderSlug(artifact.name);
  return slug === "" ? uuid : `${slug}-${uuid}`;
}

/** Read an artifact ID out of a path segment shaped like an artifact folder. */
export function parseArtifactFolder(
  segment: string,
): {readonly artifactId: string; readonly folder: string} | null {
  const uuid = artifactFolderPattern.exec(segment)?.[1];
  return uuid === undefined
    ? null
    : {artifactId: `${artifactIdPrefix}${uuid}`, folder: segment};
}
