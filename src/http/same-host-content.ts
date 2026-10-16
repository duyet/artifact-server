/**
 * Fork-owned knowledge of path mode: content served from the application
 * origin instead of per-version content hosts. Everything that names the `/v/`
 * prefix or the artifact folder shape lives here so upstream files only call in.
 */

import {CapabilityUnavailable} from "../core/errors.js";

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

/** One `/v/<token>/<path>` request, split into the token and the in-version URL. */
export interface SameHostVersionRequest {
  /** The unvalidated second path segment; empty when the request names none. */
  readonly contentToken: string;
  /** The canonical location when the slash after the token is missing. */
  readonly redirectTo: string | null;
  /** The request URL with its pathname relative to the version root. */
  readonly versionUrl: URL;
}

/** Split a request into its `/v/` parts, or null when it is not a content path. */
export function parseSameHostContentRequest(
  requestUrl: URL,
): SameHostVersionRequest | null {
  const segments = requestUrl.pathname.split("/");
  if (segments[1] !== versionPathSegment) return null;
  const contentToken = segments[2] ?? "";
  const versionUrl = new URL(requestUrl);
  versionUrl.pathname = `/${segments.slice(3).join("/")}`;
  return {
    contentToken,
    redirectTo: segments.length === 3 && contentToken !== ""
      ? `${sameHostVersionPath(contentToken)}${requestUrl.search}`
      : null,
    versionUrl,
  };
}

/** The one CSP source that covers every `/v/` response of an application origin. */
export function sameHostContentSource(applicationOrigin: string): string {
  return `${applicationOrigin}/${versionPathSegment}/`;
}

/**
 * Content sessions are cookies, and an artifact opened at top level in path
 * mode runs in an opaque origin whose subresource requests never carry them.
 */
export function assertCookieSessionsAvailable(
  contentDomain: string | null,
): asserts contentDomain is string {
  if (contentDomain === null) {
    throw new CapabilityUnavailable({
      message: "Private artifact content opens in Review on this deployment.",
    });
  }
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
