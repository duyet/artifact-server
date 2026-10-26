/**
 * Fork-owned knowledge of path mode: content served from the application
 * origin instead of per-version content hosts. Everything that names the `/v/`
 * prefix, the artifact folder shape, or the readable artifact path grammar
 * lives here so upstream files only call in.
 */

import {CapabilityUnavailable, InvalidArtifactPath} from "../core/errors.js";
import type {AssetRecord} from "../core/model.js";

const versionPathSegment = "v";
const blobPathSegment = "_blob";
const artifactIdPrefix = "art_";
const uuidSource =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const artifactFolderPattern = new RegExp(
  `^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?(${uuidSource})$`,
);
const artifactIdPattern = new RegExp(`^${artifactIdPrefix}(${uuidSource})$`);
const maxFolderSlugLength = 60;
const artifactPathSegmentPattern = /^[a-z0-9][a-z0-9-]*$/u;
const maxArtifactPathSegments = 6;
const maxArtifactPathLength = 200;

/**
 * First path segments that belong to the application. An artifact path may
 * not start with one, so no artifact can hide an application route.
 */
export const reservedPathRoots: ReadonlySet<string> = new Set([
  "administration",
  "api",
  "artifacts",
  "assets",
  "auth",
  "health",
  "mcp",
  "projects",
  "ready",
  "review",
  "review-frame",
  versionPathSegment,
  "workbench",
]);

/** Whether one path segment fits the readable artifact path grammar. */
export function isArtifactPathSegment(segment: string): boolean {
  return artifactPathSegmentPattern.test(segment);
}

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

/** The path that serves one asset in path mode. */
export function assetBlobPath(assetId: string): string {
  return `/${blobPathSegment}/${encodeURIComponent(assetId)}`;
}

/** One asset as HTTP and MCP return it, with its absolute `/_blob/<id>` URL. */
export function assetProjection(applicationUrl: URL, asset: AssetRecord) {
  return {
    createdAt: asset.createdAt,
    createdBy: {
      displayName: asset.createdByDisplayName,
      principalId: asset.createdByPrincipalId,
    },
    id: asset.id,
    mediaType: asset.mediaType,
    name: asset.name,
    sha256: asset.sha256,
    size: asset.size,
    url: new URL(assetBlobPath(asset.id), applicationUrl).toString(),
  };
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

/** A request split at the root of one artifact's current version. */
export interface ArtifactRootTarget {
  readonly slashMissing: boolean;
  /** The request URL with its pathname relative to the artifact root. */
  readonly versionUrl: URL;
}

/** One `/<folder>/<path>` request for the current version of a public artifact. */
export interface SameHostFolderRequest extends ArtifactRootTarget {
  readonly artifactId: string;
  readonly folder: string;
  readonly kind: "folder";
}

/** A request whose leading segments may name an artifact path. */
export interface SameHostPathRequest {
  /** Prefixes of the request path that are valid artifact paths, shortest first, at most 6. */
  readonly candidates: readonly [string, ...string[]];
  readonly kind: "path";
  readonly requestUrl: URL;
}

/** One `/_blob/<id>` request for a file in an artifact's asset store. */
export interface SameHostBlobRequest {
  /** The unvalidated second path segment. */
  readonly assetId: string;
  readonly kind: "blob";
  /** Whether anything follows the ID, which no asset URL has. */
  readonly trailing: boolean;
}

export type SameHostContentRequest =
  | SameHostBlobRequest
  | SameHostFolderRequest
  | SameHostPathRequest
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
  if (first === blobPathSegment) {
    return {
      assetId: segments[2] ?? "",
      kind: "blob",
      trailing: segments.length > 3,
    };
  }
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
  if (folder !== null) {
    return {...folder, ...artifactRootTarget(requestUrl, 1), kind: "folder"};
  }
  if (reservedPathRoots.has(first) || !isArtifactPathSegment(first)) return null;
  const candidates: [string, ...string[]] = [first];
  let prefix = first;
  for (const segment of segments.slice(2, maxArtifactPathSegments + 1)) {
    if (!isArtifactPathSegment(segment)) break;
    prefix = `${prefix}/${segment}`;
    candidates.push(prefix);
  }
  return {candidates, kind: "path", requestUrl};
}

/** Split a path request at the artifact path that one of its candidates matched. */
export function artifactPathTarget(
  request: SameHostPathRequest,
  path: string,
): ArtifactRootTarget {
  return artifactRootTarget(request.requestUrl, path.split("/").length);
}

function artifactRootTarget(requestUrl: URL, rootSegments: number): ArtifactRootTarget {
  const segments = requestUrl.pathname.split("/");
  const versionUrl = new URL(requestUrl);
  versionUrl.pathname = `/${segments.slice(rootSegments + 1).join("/")}`;
  return {slashMissing: segments.length === rootSegments + 1, versionUrl};
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
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation";

/**
 * Copy a content response with the isolation headers. The sandbox gives the
 * document an opaque origin, which makes its own-folder subresource requests
 * cross-origin, so they need `Access-Control-Allow-Origin`. The copy is
 * needed because fetch and redirect responses have immutable headers.
 */
export function isolateSameHostResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  // Appended, not set: a branch may send a stricter policy of its own, and a
  // browser enforces every policy a response carries.
  headers.append("Content-Security-Policy", sandboxPolicy);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** The query parameter that asks a readable URL for the artifact document itself. */
export const rawDocumentParameter = "raw";

/**
 * The same path and query with `raw=1` set: the URL the viewer frames, and the
 * one an agent that drives a browser tab reads for the page itself.
 */
export function rawDocumentPath(url: URL): string {
  const raw = new URL(url);
  raw.searchParams.set(rawDocumentParameter, "1");
  return `${raw.pathname}${raw.search}`;
}

/**
 * The request headers an HTML answer at a readable URL depends on. Every such
 * answer names them, so no cache hands the viewer to a frame or the document
 * to a tab.
 */
export const readableDeliveryVary = "Sec-Fetch-Dest, Sec-Fetch-Mode";

/** What a readable URL answers for one HTML page of a public artifact. */
export type ReadableDelivery = "document" | "viewer";

/**
 * A tab's own navigation gets the viewer, which frames the page below the
 * bar. A frame, a fetch, a client that sends no Fetch Metadata, and a request
 * with `?raw=1` get the page itself, so agents and link previews read the
 * bytes they always read.
 */
export function readableDelivery(
  request: {readonly headers: Headers; readonly method: string; readonly url: URL},
  mediaType: string,
): ReadableDelivery {
  const isTabNavigation = request.method === "GET" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    request.headers.get("sec-fetch-mode") === "navigate";
  return isTabNavigation &&
      isHtmlMediaType(mediaType) &&
      request.url.searchParams.get(rawDocumentParameter) !== "1"
    ? "viewer"
    : "document";
}

/** Whether a stored media type is an HTML page, the only kind the viewer frames. */
export function isHtmlMediaType(mediaType: string): boolean {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
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

/**
 * Assets are served at `/_blob/<id>` on the application origin, which only
 * path mode isolates with the content sandbox, so host mode refuses to store
 * one it could not serve.
 */
export function assertAssetStoreAvailable(contentDomain: string | null): void {
  if (contentDomain !== null) {
    throw new CapabilityUnavailable({
      message: "The asset store needs a deployment without a content domain.",
    });
  }
}

/**
 * Readable paths are served only from the application origin. Host mode has no
 * route that could serve one, so it refuses the path instead of storing it.
 */
function assertArtifactPathsAvailable(contentDomain: string | null): void {
  if (contentDomain !== null) {
    throw new CapabilityUnavailable({
      message: "Readable artifact paths need a deployment without a content domain.",
    });
  }
}

/**
 * Normalize a publisher's requested path, such as `/2026/10/report/`, to the
 * stored form `2026/10/report`. The only way a path enters the server.
 */
export function parseArtifactPath(raw: string): string {
  const path = raw.replace(/^\//u, "").replace(/\/$/u, "");
  if (path.length > maxArtifactPathLength) {
    throw new InvalidArtifactPath({
      message: `An artifact path has at most ${maxArtifactPathLength} characters.`,
    });
  }
  const segments = path.split("/");
  if (segments.length > maxArtifactPathSegments) {
    throw new InvalidArtifactPath({
      message: `An artifact path has at most ${maxArtifactPathSegments} segments, and "${path}" has ${segments.length}.`,
    });
  }
  for (const segment of segments) {
    if (segment === "") {
      throw new InvalidArtifactPath({
        message: `The artifact path "${path}" has an empty segment.`,
      });
    }
    if (!isArtifactPathSegment(segment)) {
      throw new InvalidArtifactPath({
        message: `The path segment "${segment}" may contain only lowercase letters, digits, and hyphens, and must not start with a hyphen.`,
      });
    }
  }
  const first = segments[0] ?? "";
  if (reservedPathRoots.has(first)) {
    throw new InvalidArtifactPath({
      message: `The first path segment "${first}" is reserved by the application.`,
    });
  }
  if (parseArtifactFolder(first) !== null) {
    throw new InvalidArtifactPath({
      message: `The first path segment "${first}" has the shape of an artifact folder.`,
    });
  }
  return path;
}

/** The stored path for an optional path field of a create request. */
export function requestedArtifactPath(
  raw: string | undefined,
  contentDomain: string | null,
): string | null {
  if (raw === undefined) return null;
  assertArtifactPathsAvailable(contentDomain);
  return parseArtifactPath(raw);
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

/**
 * Where an artifact's current version is served in path mode: its readable
 * path when it has one, else its folder. Null when it has neither.
 */
export function artifactContentRoot(
  artifact: {readonly id: string; readonly name: string; readonly path: string | null},
): string | null {
  if (artifact.path !== null) return `/${artifact.path}/`;
  const folder = artifactFolder(artifact);
  return folder === null ? null : `/${folder}/`;
}

/**
 * The URL paths that serve one version's files on a single origin, the
 * artifact's own root first. With a content domain each version owns its host.
 */
export function versionServedRoots(
  artifact: {readonly id: string; readonly name: string; readonly path: string | null},
  version: {readonly contentToken: string},
  contentDomain: string | null,
): readonly [string, ...string[]] {
  if (contentDomain !== null) return ["/"];
  const root = artifactContentRoot(artifact);
  const exact = sameHostVersionPath(version.contentToken);
  return root === null ? [exact] : [root, exact];
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
