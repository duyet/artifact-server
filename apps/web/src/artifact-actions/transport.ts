import {z} from "zod";

import {ApiError} from "../api/client.js";
import type {Bytes} from "./bytes.js";
import type {UploadPlanRequest} from "./upload-plan.js";

/** How requests reach the server and prove who sends them. */
export interface ActionTransport {
  /** Adds credentials; `mutating` requests also carry the browser CSRF proof. */
  authorize(headers: Headers, mutating: boolean): void;
  readonly origin: string;
  /** Called when the server answers 401, so the app can ask for a new sign-in. */
  onUnauthorized(): void;
}

const uploadsPathPrefix = "/api/v1/uploads/";

function readBrowserCsrfToken(): string {
  for (const candidate of document.cookie.split(";")) {
    const [rawName, ...rawValue] = candidate.trim().split("=");
    if (rawName === "artifact_csrf" || rawName === "__Host-artifact_csrf") {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  throw new ApiError(
    "CSRF_TOKEN_MISSING",
    "Your browser session cannot authorize changes. Sign in again.",
    403,
  );
}

/** Same-origin requests under the signed-in browser session. */
export function createBrowserTransport(): ActionTransport {
  return {
    authorize(headers, mutating) {
      if (mutating) headers.set("X-CSRF-Token", readBrowserCsrfToken());
    },
    onUnauthorized() {
      window.dispatchEvent(new Event("artifact-session-expired"));
    },
    origin: window.location.origin,
  };
}

/** Requests under an API key, for programmatic callers and tests. */
export function createBearerTransport(
  origin: string,
  token: string,
): ActionTransport {
  return {
    authorize(headers) {
      headers.set("Authorization", `Bearer ${token}`);
    },
    onUnauthorized() {},
    origin,
  };
}

const artifactSummarySchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
});

/**
 * What an artifact action answers with. Only the fields the actions rely on
 * are declared, so the shape survives the artifact record gaining new fields.
 * `review` is present on a publish and absent on a metadata change.
 */
const actionResultSchema = z.object({
  artifact: artifactSummarySchema,
  links: z.object({
    artifact: z.string(),
    review: z.string().optional(),
    version: z.string(),
  }),
  replayed: z.boolean(),
  version: z.object({
    artifactId: z.string(),
    id: z.string(),
    number: z.number().int().positive(),
  }),
});

export type ArtifactActionResult = z.infer<typeof actionResultSchema>;

const uploadPlanResponseSchema = z.object({
  commitUrl: z.string(),
  files: z.array(z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    uploadUrl: z.string(),
  })),
  projectId: z.string(),
  uploadId: z.string(),
});

const uploadedFileResponseSchema = z.object({
  path: z.string(),
  status: z.literal("verified"),
  uploadId: z.string(),
});

/** A planned upload with every URL pinned to the transport's own origin. */
export interface StagedUpload {
  readonly commitUrl: string;
  readonly files: ReadonlyMap<string, {readonly size: number; readonly uploadUrl: string}>;
  readonly projectId: string;
  readonly uploadId: string;
}

async function parseFailure(response: Response): Promise<ApiError> {
  try {
    const parsed = z.object({
      error: z.object({code: z.string(), message: z.string()}),
    }).safeParse(await response.json());
    if (parsed.success) {
      return new ApiError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
      );
    }
  } catch {
    return new ApiError(
      "INVALID_ERROR_RESPONSE",
      "Artifact Server returned an unreadable error response.",
      response.status,
    );
  }
  return new ApiError(
    "UNEXPECTED_ERROR_RESPONSE",
    "Artifact Server could not complete the request.",
    response.status,
  );
}

interface RequestSpec {
  readonly body: BodyInit | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "GET" | "PATCH" | "POST" | "PUT";
  readonly signal: AbortSignal | null;
}

async function send(
  transport: ActionTransport,
  url: string,
  spec: RequestSpec,
): Promise<Response> {
  const headers = new Headers(spec.headers);
  transport.authorize(headers, spec.method !== "GET");
  const response = await fetch(url, {
    body: spec.body,
    credentials: "same-origin",
    headers,
    method: spec.method,
    signal: spec.signal,
  });
  if (response.status === 401) transport.onUnauthorized();
  if (!response.ok) throw await parseFailure(response);
  return response;
}

async function sendJson<T>(
  schema: z.ZodType<T>,
  transport: ActionTransport,
  url: string,
  spec: RequestSpec,
): Promise<T> {
  const response = await send(transport, url, spec);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      "INVALID_SUCCESS_RESPONSE",
      "Artifact Server returned data that does not match the expected contract.",
      response.status,
    );
  }
  return parsed.data;
}

function absolute(transport: ActionTransport, path: string): string {
  return new URL(path, transport.origin).toString();
}

/**
 * Re-roots a server-issued URL onto the transport's origin. A plan that points
 * outside the upload routes is refused, so credentials never leave this server.
 */
function pinUploadUrl(transport: ActionTransport, issued: string): string {
  const parsed = new URL(issued, transport.origin);
  if (!parsed.pathname.startsWith(uploadsPathPrefix)) {
    throw new ApiError(
      "UNSAFE_UPLOAD_PLAN",
      "The server returned an upload URL outside the upload routes. Nothing was sent.",
      502,
    );
  }
  return absolute(transport, `${parsed.pathname}${parsed.search}`);
}

/** Downloads one file of a version as bytes. */
export async function fetchVersionFile(
  transport: ActionTransport,
  input: {
    readonly artifactId: string;
    readonly path: string;
    readonly projectId: string;
    readonly signal?: AbortSignal | undefined;
    readonly versionId: string;
  },
): Promise<Bytes> {
  const query = new URLSearchParams({path: input.path, projectId: input.projectId});
  const response = await send(
    transport,
    absolute(
      transport,
      `/api/v1/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.versionId)}/file?${query}`,
    ),
    {body: null, headers: {}, method: "GET", signal: input.signal ?? null},
  );
  return new Uint8Array(await response.arrayBuffer());
}

/** Declares the files to stage and returns the pinned upload plan. */
export async function createUpload(
  transport: ActionTransport,
  plan: UploadPlanRequest,
  projectId: string,
  signal?: AbortSignal,
): Promise<StagedUpload> {
  const planned = await sendJson(
    uploadPlanResponseSchema,
    transport,
    absolute(transport, "/api/v1/uploads"),
    {
      body: JSON.stringify({...plan, projectId}),
      headers: {"Content-Type": "application/json"},
      method: "POST",
      signal: signal ?? null,
    },
  );
  const files = new Map<string, {size: number; uploadUrl: string}>();
  for (const file of planned.files) {
    files.set(file.path, {
      size: file.size,
      uploadUrl: pinUploadUrl(transport, file.uploadUrl),
    });
  }
  const declared = new Map(plan.files.map((file) => [file.path, file.size]));
  const matches = files.size === declared.size
    && [...files].every(([path, file]) => declared.get(path) === file.size);
  if (!matches) {
    throw new ApiError(
      "UNSAFE_UPLOAD_PLAN",
      "The server returned an upload plan that does not match the declared files.",
      502,
    );
  }
  return {
    commitUrl: pinUploadUrl(transport, planned.commitUrl),
    files,
    projectId: planned.projectId,
    uploadId: planned.uploadId,
  };
}

/** Sends one file's bytes to its planned upload URL and awaits verification. */
export async function putUploadFile(
  transport: ActionTransport,
  upload: StagedUpload,
  file: {
    readonly bytes: Bytes;
    readonly mediaType: string;
    readonly path: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  const planned = upload.files.get(file.path);
  if (planned === undefined) {
    throw new ApiError(
      "UNSAFE_UPLOAD_PLAN",
      "The upload plan has no slot for a file that was about to be sent.",
      502,
    );
  }
  const verified = await sendJson(
    uploadedFileResponseSchema,
    transport,
    planned.uploadUrl,
    {
      body: file.bytes,
      headers: {"Content-Type": file.mediaType},
      method: "PUT",
      signal: signal ?? null,
    },
  );
  if (verified.path !== file.path || verified.uploadId !== upload.uploadId) {
    throw new ApiError(
      "UPLOAD_MISMATCH",
      "Artifact Server verified a different file than the one that was sent.",
      502,
    );
  }
}

export type CommitTarget =
  | {
    readonly accessSetting: "account_required" | "public_link";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly baseVersionId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "edit";
    readonly path: string;
  };

/** Commits the staged upload as a new artifact or an edited version. */
export function commitUpload(
  transport: ActionTransport,
  upload: StagedUpload,
  input: {
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal | undefined;
    readonly target: CommitTarget;
  },
): Promise<ArtifactActionResult> {
  return sendJson(actionResultSchema, transport, upload.commitUrl, {
    body: JSON.stringify({target: input.target}),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    method: "POST",
    signal: input.signal ?? null,
  });
}

/** Renames an artifact without publishing a new version. */
export function renameArtifact(
  transport: ActionTransport,
  input: {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly projectId: string;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<ArtifactActionResult> {
  const query = new URLSearchParams({projectId: input.projectId});
  return sendJson(
    actionResultSchema,
    transport,
    absolute(
      transport,
      `/api/v1/artifacts/${encodeURIComponent(input.artifactId)}/name?${query}`,
    ),
    {
      body: JSON.stringify({
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        name: input.name,
      }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      method: "PATCH",
      signal: input.signal ?? null,
    },
  );
}
