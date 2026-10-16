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
  readonly kind: "version";
  /** The canonical location when the slash after the token is missing. */
  readonly redirectTo: string | null;
  /** The request URL with its pathname relative to the version root. */
  readonly versionUrl: URL;
}

/** One `/<folder>/<path>` request for the current version of a public artifact. */
export interface SameHostFolderRequest {
  readonly artifactId: string;
  readonly folder: string;
  readonly kind: "folder";
  readonly slashMissing: boolean;
  /** The request URL with its pathname relative to the folder. */
  readonly versionUrl: URL;
}

export type SameHostContentRequest =
  | SameHostFolderRequest
  | SameHostVersionRequest;

/**
 * Tell a content request from an application request by its first path
 * segment. Both the isolation middleware and the content router use this one
 * predicate, so no content form can reach a response without the headers.
 */
export function parseSameHostContentRequest(
  requestUrl: URL,
): SameHostContentRequest | null {
  const segments = requestUrl.pathname.split("/");
  const first = segments[1] ?? "";
  if (first === versionPathSegment) {
    const contentToken = segments[2] ?? "";
    const versionUrl = new URL(requestUrl);
    versionUrl.pathname = `/${segments.slice(3).join("/")}`;
    return {
      contentToken,
      kind: "version",
      redirectTo: segments.length === 3 && contentToken !== ""
        ? `${sameHostVersionPath(contentToken)}${requestUrl.search}`
        : null,
      versionUrl,
    };
  }
  const folder = parseArtifactFolder(first);
  if (folder === null) return null;
  const versionUrl = new URL(requestUrl);
  versionUrl.pathname = `/${segments.slice(2).join("/")}`;
  return {
    ...folder,
    kind: "folder",
    slashMissing: segments.length === 2,
    versionUrl,
  };
}

/**
 * Where a folder request must go to reach its canonical form, or null when it
 * already is. A stale name part and a missing trailing slash both redirect, so
 * relative URLs resolve inside the folder.
 */
export function canonicalFolderLocation(
  request: SameHostFolderRequest,
  artifact: {readonly id: string; readonly name: string},
): string | null {
  const canonical = artifactFolder(artifact);
  if (canonical === null) return null;
  if (canonical === request.folder && !request.slashMissing) return null;
  return `/${canonical}${request.versionUrl.pathname}${request.versionUrl.search}`;
}

const sandboxPolicy =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * Copy a content response with the isolation headers. The sandbox gives the
 * document an opaque origin, which makes its own-folder subresource requests
 * cross-origin, so they need `Access-Control-Allow-Origin`. The copy is
 * needed because fetch and redirect responses have immutable headers.
 */
export function isolateSameHostResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", sandboxPolicy);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
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
