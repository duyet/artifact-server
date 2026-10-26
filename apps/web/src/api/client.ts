import { z } from "zod";

const accessSettingSchema = z.enum(["account_required", "public_link"]);
const membershipRoleSchema = z.enum(["administrator", "member"]);
const principalKindSchema = z.enum(["human", "service"]);
const capabilitySchema = z.enum([
  "agent:connect",
  "artifact:create",
  "comment:write",
  "content-session:issue",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "project:manage",
]);

const principalSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  capabilities: z.array(capabilitySchema),
  displayName: z.string().optional(),
  id: z.string(),
  installationId: z.string(),
  kind: principalKindSchema,
  membershipRole: membershipRoleSchema,
});

/** What this deployment offers beyond the shared surface. */
const deploymentCapabilitiesSchema = z.object({
  /** The largest text file one edit may save, as the server enforces it. */
  editing: z.object({maximumTextFileBytes: z.number().int().positive()}),
});

const sessionSchema = z.object({
  authenticationMethod: z.enum(["bearer", "session"]),
  capabilities: deploymentCapabilitiesSchema,
  principal: principalSchema,
});

const accessContextSchema = z.discriminatedUnion("accessMode", [
  z.object({
    accessMode: z.literal("local_owner"),
    login: z.object({kind: z.literal("local_owner")}),
  }),
  z.object({
    accessMode: z.literal("private_team"),
    login: z.object({
      directory: z.boolean(),
      kind: z.enum(["none", "oidc", "workos"]),
    }),
  }),
]);

const projectSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});
/** The principal who created an artifact; the name is null for old artifacts. */
const artifactOwnerSchema = z.object({
  displayName: z.string().nullable(),
  principalId: z.string(),
});

const artifactSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  owner: artifactOwnerSchema,
  /** The readable path claimed at creation, or null. */
  path: z.string().nullable(),
  projectId: z.string(),
  tags: z.array(z.string()),
});

const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const versionSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number(),
  projectId: z.string(),
  publisherDisplayName: z.string().nullable(),
  publisherPrincipalId: z.string(),
  routingMode: z.enum(["static", "spa"]),
});

const manifestSchema = z.object({
  digest: z.string(),
  entries: z.array(manifestEntrySchema),
  entryPath: z.string(),
  routingMode: z.enum(["static", "spa"]),
});

const artifactVersionSchema = z.object({
  links: z.object({ review: z.url(), version: z.url() }),
  manifest: manifestSchema,
  version: versionSchema,
});

const artifactStateSchema = z.object({
  artifact: artifactSchema,
  links: z.object({ artifact: z.url(), version: z.url() }),
  replayed: z.boolean(),
  version: versionSchema,
});

const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const noContentStatuses = new Set([204, 205]);

export type AccessSetting = z.infer<typeof accessSettingSchema>;
export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>;
export type PrincipalCapability = z.infer<typeof capabilitySchema>;
export type Principal = z.infer<typeof principalSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type AccessContext = z.infer<typeof accessContextSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactOwner = z.infer<typeof artifactOwnerSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type Version = z.infer<typeof versionSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type ArtifactState = z.infer<typeof artifactStateSchema>;

const publicLinkItemSchema = z.object({
  artifact: artifactSchema,
  currentVersion: versionSchema,
  links: z.object({ public: z.url() }),
  project: projectSchema,
});

const publicLinkPageSchema = z.object({
  nextCursor: z.string().nullable(),
  publicLinks: z.array(publicLinkItemSchema),
});

const makePublicLinkPrivateItemSchema = z.object({
  artifactId: z.string(),
  expectedCurrentVersionId: z.string(),
  idempotencyKey: z.string(),
  projectId: z.string(),
});

const publicLinkMutationResultSchema = z.discriminatedUnion("status", [
  z.object({
    artifactId: z.string(),
    currentVersionId: z.string(),
    projectId: z.string(),
    replayed: z.boolean(),
    status: z.literal("made_private"),
  }),
  z.object({
    artifactId: z.string(),
    error: z.object({code: z.string(), message: z.string()}),
    expectedCurrentVersionId: z.string(),
    projectId: z.string(),
    retry: z.enum(["not_retryable", "refresh_current_version", "same_command"]),
    status: z.literal("failed"),
  }),
]);

const publicLinkMutationResponseSchema = z.object({
  results: z.array(publicLinkMutationResultSchema),
  summary: z.object({
    failed: z.number().int().nonnegative(),
    requested: z.number().int().positive(),
    succeeded: z.number().int().nonnegative(),
  }),
  warning: z.string(),
});

export type PublicLinkItem = z.infer<typeof publicLinkItemSchema>;
export type PublicLinkPage = z.infer<typeof publicLinkPageSchema>;
export type MakePublicLinkPrivateItem = z.infer<
  typeof makePublicLinkPrivateItemSchema
>;
export type PublicLinkMutationResult = z.infer<
  typeof publicLinkMutationResultSchema
>;
export type PublicLinkMutationResponse = z.infer<
  typeof publicLinkMutationResponseSchema
>;

/** Whose artifacts a listing keeps, relative to the signed-in principal. */
export type ArtifactOwnerScope = "all" | "me" | "others";

export interface ArtifactPage {
  readonly artifacts: readonly {
    readonly artifact: Artifact;
    readonly commentCount: number;
    readonly currentVersionNumber: number;
    readonly links: {
      readonly artifact: string;
      readonly management: string;
    };
    readonly owner: ArtifactOwner;
    /** The current version's creation time. */
    readonly updatedAt: string;
    readonly versionCount: number;
    readonly views: {readonly last30Days: number; readonly total: number};
  }[];
  readonly nextCursor: string | null;
}

export interface ArtifactDetails {
  readonly artifact: Artifact;
  readonly current: ArtifactVersion;
  readonly links: {
    readonly artifact: string;
    readonly management: string;
  };
}

export interface ArtifactAction {
  readonly action:
    | "change_access"
    | "change_tags"
    | "comment_create"
    | "comment_delete"
    | "comment_reopen"
    | "comment_reply"
    | "comment_resolve"
    | "comment_update"
    | "delete"
    | "edited"
    | "publish"
    | "renamed"
    | "restore";
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly versionId: string;
}

export interface ArtifactComparison {
  readonly added: readonly ManifestEntry[];
  readonly artifact: Artifact;
  readonly changed: readonly ComparedFile[];
  readonly from: Version;
  readonly links: { readonly from: string; readonly to: string };
  readonly removed: readonly ManifestEntry[];
  readonly renamed: readonly {
    readonly from: ManifestEntry;
    readonly to: ManifestEntry;
  }[];
  readonly to: Version;
  readonly unchangedCount: number;
}

export interface ComparedFile {
  readonly after: ManifestEntry;
  readonly before: ManifestEntry;
  readonly detail:
    | {
      readonly afterLineCount: number;
      readonly beforeLineCount: number;
      readonly change: {
        readonly after: readonly string[];
        readonly afterStartLine: number;
        readonly before: readonly string[];
        readonly beforeStartLine: number;
      } | null;
      readonly kind: "text";
    }
    | {
      readonly kind: "binary";
      readonly reason: "binary_or_invalid_utf8" | "text_limit_exceeded";
    };
  readonly links: { readonly after: string; readonly before: string };
}

const artifactPageSchema: z.ZodType<ArtifactPage> = z.object({
  artifacts: z.array(z.object({
    artifact: artifactSchema,
    commentCount: z.number().int().nonnegative(),
    currentVersionNumber: z.number().int().positive(),
    links: z.object({ artifact: z.url(), management: z.url() }),
    owner: artifactOwnerSchema,
    updatedAt: z.string(),
    versionCount: z.number().int().positive(),
    views: z.object({
      last30Days: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  })),
  nextCursor: z.string().nullable(),
});

const dayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const viewCountSchema = z.number().int().nonnegative();

const projectAnalyticsSchema = z.object({
  daily: z.array(z.object({
    day: dayStringSchema,
    uploads: viewCountSchema,
    views: viewCountSchema,
  })),
  generatedAt: z.string(),
  today: dayStringSchema,
  topArtifacts: z.array(z.object({
    artifactId: z.string(),
    name: z.string(),
    total: viewCountSchema,
    views30d: viewCountSchema,
  })),
  totals: z.object({
    artifacts: viewCountSchema,
    artifactsViewedToday: viewCountSchema,
    averageViewsPerArtifact: z.number().nonnegative(),
    pageViews: viewCountSchema,
    publicArtifacts: viewCountSchema,
    uploadedToday: viewCountSchema,
    uploads: viewCountSchema,
  }),
  windowDays: z.number().int().positive(),
});

const artifactAnalyticsSchema = z.object({
  artifactId: z.string(),
  daily: z.array(z.object({day: dayStringSchema, views: viewCountSchema})),
  today: dayStringSchema,
  views: z.object({
    last7Days: viewCountSchema,
    last30Days: viewCountSchema,
    total: viewCountSchema,
  }),
  windowDays: z.number().int().positive(),
});

const artifactInfoSchema = z.object({
  artifactId: z.string(),
  canManage: z.boolean(),
  name: z.string(),
  owner: z.object({displayName: z.string().nullable()}).strict(),
  updatedAt: z.string(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).strict(),
  views: z.object({
    daily: z.array(z.object({day: dayStringSchema, views: viewCountSchema}).strict()),
    last30Days: viewCountSchema,
    total: viewCountSchema,
  }).strict(),
  visibility: z.enum(["private", "public", "unlisted"]),
  windowDays: z.number().int().positive(),
}).strict();

const brandingSchema = z.object({
  logo: z.object({
    alt: z.string(),
    href: z.string().nullable(),
    src: z.string(),
  }).strict().nullable(),
}).strict();

/** One project's activity: totals, a sparse yearly series, its most viewed. */
export type ProjectAnalytics = z.infer<typeof projectAnalyticsSchema>;
/** One artifact's 7-day, 30-day, and all-time views with a sparse series. */
export type ArtifactAnalytics = z.infer<typeof artifactAnalyticsSchema>;
/** What the viewer's info popover shows about one artifact. */
export type ArtifactInfo = z.infer<typeof artifactInfoSchema>;
/** The installation's logo for the viewer bar, or null for the product mark. */
export type Branding = z.infer<typeof brandingSchema>;

const artifactDetailsSchema: z.ZodType<ArtifactDetails> = z.object({
  artifact: artifactSchema,
  current: artifactVersionSchema,
  links: z.object({
    artifact: z.url(),
    management: z.url(),
  }),
});

const actionSchema: z.ZodType<ArtifactAction> = z.object({
  action: z.enum([
    "change_access",
    "change_tags",
    "comment_create",
    "comment_delete",
    "comment_reopen",
    "comment_reply",
    "comment_resolve",
    "comment_update",
    "delete",
    "edited",
    "publish",
    "renamed",
    "restore",
  ]),
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});

const comparedFileSchema: z.ZodType<ComparedFile> = z.object({
  after: manifestEntrySchema,
  before: manifestEntrySchema,
  detail: z.discriminatedUnion("kind", [
    z.object({
      afterLineCount: z.number(),
      beforeLineCount: z.number(),
      change: z.object({
        after: z.array(z.string()),
        afterStartLine: z.number(),
        before: z.array(z.string()),
        beforeStartLine: z.number(),
      }).nullable(),
      kind: z.literal("text"),
    }),
    z.object({
      kind: z.literal("binary"),
      reason: z.enum(["binary_or_invalid_utf8", "text_limit_exceeded"]),
    }),
  ]),
  links: z.object({ after: z.url(), before: z.url() }),
});

const comparisonSchema: z.ZodType<ArtifactComparison> = z.object({
  added: z.array(manifestEntrySchema),
  artifact: artifactSchema,
  changed: z.array(comparedFileSchema),
  from: versionSchema,
  links: z.object({ from: z.url(), to: z.url() }),
  removed: z.array(manifestEntrySchema),
  renamed: z.array(z.object({
    from: manifestEntrySchema,
    to: manifestEntrySchema,
  })),
  to: versionSchema,
  unchangedCount: z.number(),
});

const commentAnchorSchema = z.json();
const commentThreadStateSchema = z.enum(["open", "resolved"]);

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
});

const commentThreadSchema = z.object({
  anchor: commentAnchorSchema,
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  links: z.object({ self: z.url(), version: z.url() }),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number(),
  resolvedAt: z.string().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: commentThreadStateSchema,
  updatedAt: z.string(),
  versionId: z.string(),
});

const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.string(),
});

const commentThreadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
});

const commentThreadDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
});

const createdCommentThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
});

const createdCommentReplySchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
});

/** Client-owned anchor JSON; Artifact Server stores and returns it unread. */
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CommentThreadState = z.infer<typeof commentThreadStateSchema>;
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
export type CommentReply = z.infer<typeof commentReplySchema>;
export type CommentThreadPage = z.infer<typeof commentThreadPageSchema>;
export type CommentThreadDetails = z.infer<typeof commentThreadDetailsSchema>;
export type CreatedCommentThread = z.infer<typeof createdCommentThreadSchema>;
export type CreatedCommentReply = z.infer<typeof createdCommentReplySchema>;

/** Every filter the comment listing route accepts, with null meaning unset. */
export interface CommentThreadQuery {
  readonly cursor: string | null;
  /** Dispatched-thread visibility; unset leaves the server's own exclusion. */
  readonly dispatched: DispatchedThreadFilter | null;
  readonly limit: number | null;
  readonly since: string | null;
  readonly state: CommentThreadState | null;
  readonly versionId: string | null;
}

/** One composed thread, ready to be created on one exact saved version. */
export interface CommentDraft {
  readonly anchor: CommentAnchor;
  readonly body: string;
  /** One manifest entry path, or null to anchor the whole version. */
  readonly path: string | null;
}

/** One thread edit; omit a field to leave that part of the thread unchanged. */
export interface CommentThreadEdit {
  readonly anchor?: CommentAnchor;
  readonly body?: string;
  readonly state?: CommentThreadState;
}

const registeredAgentSchema = z.object({
  agentSessionId: z.string().nullable(),
  /** Derived from the agent's own claim polling; the poll is the heartbeat. */
  connected: z.boolean(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  /** Open slug, matching the server (`registeredAgentKindPattern`): nothing branches on it. */
  kind: z.string(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
});

const agentDispatchStateSchema = z.enum([
  "addressed",
  "canceled",
  "claimed",
  "delivered",
  "failed",
  "queued",
]);

const agentDispatchSchema = z.object({
  addressedAt: z.string().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  id: z.string(),
  idempotencyKey: z.string(),
  leaseExpiresAt: z.string().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  sender: commentAuthorSchema,
  state: agentDispatchStateSchema,
  threadIds: z.array(z.string()),
  updatedAt: z.string(),
});

const agentDispatchPageSchema = z.object({
  items: z.array(agentDispatchSchema),
  nextCursor: z.string().nullable(),
});

const createdAgentDispatchSchema = z.object({
  dispatch: agentDispatchSchema,
  replayed: z.boolean(),
});

export type RegisteredAgent = z.infer<typeof registeredAgentSchema>;
export type AgentDispatchState = z.infer<typeof agentDispatchStateSchema>;
export type AgentDispatch = z.infer<typeof agentDispatchSchema>;
export type AgentDispatchPage = z.infer<typeof agentDispatchPageSchema>;
export type CreatedAgentDispatch = z.infer<typeof createdAgentDispatchSchema>;

/**
 * Whether a comment listing hides, includes, or shows only the threads an
 * active dispatch carries. Leaving it unset keeps the server default, which
 * hides them: that is what makes a send consumptive.
 */
export type DispatchedThreadFilter = "exclude" | "include" | "only";

/** One bundle of comment threads, sent to one agent as a single message. */
export interface AgentDispatchDraft {
  readonly agentId: string;
  readonly note: string | null;
  /** Ordered thread ids, all open and undispatched at send time. */
  readonly threadIds: readonly string[];
}

/** Every filter the dispatch listing route accepts, with null meaning unset. */
export interface AgentDispatchQuery {
  readonly agentId: string | null;
  readonly cursor: string | null;
  readonly limit: number | null;
  readonly state: AgentDispatchState | null;
}

const agentActivitySchema = z.enum(["disconnected", "idle", "working"]);
const agentBeaconSchema = z.enum(["thinking", "replying"]);

/**
 * One registered agent with its derived presence. The activity fields ship
 * with the presence-capable server; they stay optional so a panel pointed at
 * an older deployment still renders liveness from `connected` alone.
 */
const agentPresenceSchema = z.object({
  activeDispatchId: z.string().nullable().optional(),
  activity: agentActivitySchema.optional(),
  agentSessionId: z.string().nullable(),
  beacon: agentBeaconSchema.nullable().optional(),
  capabilities: z.object({
    beacon: z.boolean(),
    evidence: z.enum(["channel", "mailbox", "native"]),
  }).optional(),
  /** Derived from the agent's own claim polling; the poll is the heartbeat. */
  connected: z.boolean(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  /** A validated slug; display metadata only, nothing branches on it. */
  kind: z.string(),
  lastActivityAt: z.string().optional(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
});

export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type AgentBeacon = z.infer<typeof agentBeaconSchema>;
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

/** What one bulk clear removed, and what an active send kept out of reach. */
const commentClearResultSchema = z.object({
  deleted: z.number().int().nonnegative(),
  skippedDispatched: z.number().int().nonnegative(),
});

export type CommentClearResult = z.infer<typeof commentClearResultSchema>;

const memberSchema = z.object({
  createdAt: z.string(),
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  installationId: z.string(),
  role: membershipRoleSchema,
  status: z.enum(["active", "inactive"]),
  updatedAt: z.string(),
});

const apiKeySchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilities: z.array(capabilitySchema),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  prefix: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
  revokedAt: z.string().nullable(),
  rotatedFromId: z.string().nullable(),
});

export type InstallationMember = z.infer<typeof memberSchema>;
export type ManagedApiKey = z.infer<typeof apiKeySchema>;

const issuedKeySchema = z.object({
  apiKey: apiKeySchema,
  token: z.string(),
});

export type IssuedApiKey = z.infer<typeof issuedKeySchema>;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Outcome of presenting an API key or a directory password at a sign-in form. */
export type SignInOutcome =
  | {readonly kind: "signed_in"}
  | {readonly kind: "rejected"; readonly message: string}
  | {readonly kind: "rate_limited"; readonly retryAfterSeconds: number};

type SignInRequest =
  | {readonly apiKey: string}
  | {readonly password: string; readonly username: string};

async function signIn(path: string, body: SignInRequest): Promise<SignInOutcome> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: {"Content-Type": "application/json"},
    method: "POST",
  });
  if (response.status === 204) return {kind: "signed_in"};
  const failure = await parseFailure(response);
  if (response.status === 401) return {kind: "rejected", message: failure.message};
  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    return {
      kind: "rate_limited",
      retryAfterSeconds: Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : 60,
    };
  }
  throw failure;
}

function readCsrfToken(): string {
  for (const candidate of document.cookie.split(";")) {
    const [rawName, ...rawValue] = candidate.trim().split("=");
    if (
      rawName === "artifact_csrf"
      || rawName === "__Host-artifact_csrf"
    ) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  throw new ApiError(
    "CSRF_TOKEN_MISSING",
    "Your browser session cannot authorize changes. Sign in again.",
    403,
  );
}

async function parseFailure(response: Response): Promise<ApiError> {
  try {
    const parsed = apiErrorBodySchema.safeParse(await response.json());
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

function mutationHeaders(idempotencyKey?: string): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-CSRF-Token": readCsrfToken(),
  });
  if (idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  return headers;
}

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
  if (noContentStatuses.has(response.status)) {
    throw new ApiError(
      "EMPTY_RESPONSE",
      "Artifact Server returned no response data.",
      response.status,
    );
  }
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

async function requestText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: "same-origin" });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
  return await response.text();
}

async function requestHead(path: string): Promise<void> {
  const response = await fetch(path, {
    credentials: "same-origin",
    method: "HEAD",
  });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
}

async function requestNoContent(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  notifySessionExpiry(response);
  if (!response.ok) throw await parseFailure(response);
  if (!noContentStatuses.has(response.status)) {
    throw new ApiError(
      "UNEXPECTED_RESPONSE",
      "Artifact Server returned unexpected response data.",
      response.status,
    );
  }
}

function projectQuery(projectId: string): string {
  return `projectId=${encodeURIComponent(projectId)}`;
}

function versionAssetUrl(
  route: "file" | "media",
  projectId: string,
  artifactId: string,
  versionId: string,
  path: string,
): string {
  return `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/${route}?${new URLSearchParams({
    path,
    projectId,
  })}`;
}

function notifySessionExpiry(response: Response): void {
  if (response.status === 401) {
    window.dispatchEvent(new Event("artifact-session-expired"));
  }
}

export const api = {
  accessContext: () => request(accessContextSchema, "/auth/context"),
  localOwnerSession: () => requestNoContent("/auth/local-owner", {
    method: "POST",
  }),
  session: () => request(sessionSchema, "/api/v1/session"),
  signInWithApiKey: (apiKey: string): Promise<SignInOutcome> =>
    signIn("/auth/api-key", {apiKey}),
  signInWithDirectory: (username: string, password: string): Promise<SignInOutcome> =>
    signIn("/auth/ldap", {password, username}),
  logout: async () => {
    await requestNoContent("/api/v1/session/logout", {
      headers: mutationHeaders(),
      method: "POST",
    });
    // Drafts and other departing-principal state listen for this.
    window.dispatchEvent(new Event("artifact-session-logout"));
  },
  publicLinks: (cursor: string | null) => {
    const query = new URLSearchParams({ limit: "25" });
    if (cursor !== null) query.set("cursor", cursor);
    return request(
      publicLinkPageSchema,
      `/api/v1/administration/public-links?${query}`,
    );
  },
  makePublicLinksPrivate: (
    items: readonly MakePublicLinkPrivateItem[],
  ) => request(
    publicLinkMutationResponseSchema,
    "/api/v1/administration/public-links/make-private",
    {
      body: JSON.stringify({ items }),
      headers: mutationHeaders(),
      method: "POST",
    },
  ),
  projects: () => request(
    z.object({ projects: z.array(projectSchema) }),
    "/api/v1/projects",
  ).then(({ projects }) => projects),
  createProject: (name: string) => request(
    z.object({ project: projectSchema }),
    "/api/v1/projects",
    {
      body: JSON.stringify({ name }),
      headers: mutationHeaders(),
      method: "POST",
    },
  ).then(({ project }) => project),
  renameProject: (projectId: string, name: string) => request(
    z.object({ project: projectSchema }),
    `/api/v1/projects/${encodeURIComponent(projectId)}`,
    {
      body: JSON.stringify({ name }),
      headers: mutationHeaders(),
      method: "PATCH",
    },
  ).then(({ project }) => project),
  archiveProject: (projectId: string) => request(
    z.object({ project: projectSchema }),
    `/api/v1/projects/${encodeURIComponent(projectId)}/archive`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ project }) => project),
  unarchiveProject: (projectId: string) => request(
    z.object({ project: projectSchema }),
    `/api/v1/projects/${encodeURIComponent(projectId)}/unarchive`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ project }) => project),
  artifacts: (
    projectId: string,
    cursor: string | null,
    tags: readonly string[],
    search = "",
    options: {
      readonly comments?: "all" | "with" | "without";
      readonly owner?: ArtifactOwnerScope;
      readonly sort?: "comments" | "newest";
    } = {},
  ) => {
    const query = new URLSearchParams({ limit: "25", projectId });
    query.set("comments", options.comments ?? "all");
    query.set("owner", options.owner ?? "all");
    query.set("sort", options.sort ?? "newest");
    if (cursor !== null) query.set("cursor", cursor);
    for (const tag of tags) query.append("tag", tag);
    if (search.trim() !== "") query.set("search", search.trim());
    return request(artifactPageSchema, `/api/v1/artifacts?${query}`);
  },
  artifact: (projectId: string, artifactId: string) => request(
    artifactDetailsSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}?${projectQuery(projectId)}`,
  ),
  versions: (projectId: string, artifactId: string) => request(
    z.object({
      artifactId: z.string(),
      versions: z.array(z.object({
        links: z.object({ review: z.url(), version: z.url() }),
        version: versionSchema,
      })),
    }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions?${projectQuery(projectId)}`,
  ).then(({ versions }) => versions),
  version: (projectId: string, artifactId: string, versionId: string) => request(
    artifactVersionSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}?${projectQuery(projectId)}`,
  ),
  actions: (projectId: string, artifactId: string, cursor: string | null) => {
    const query = new URLSearchParams({ limit: "50", projectId });
    if (cursor !== null) query.set("cursor", cursor);
    return request(
      z.object({
        actions: z.array(actionSchema),
        nextCursor: z.string().nullable(),
      }),
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/actions?${query}`,
    );
  },
  comparison: (
    projectId: string,
    artifactId: string,
    fromVersionId: string,
    toVersionId: string,
  ) => request(
    comparisonSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comparisons?${new URLSearchParams({
      fromVersionId,
      projectId,
      toVersionId,
    })}`,
  ),
  restore: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    versionId: string,
    idempotencyKey: string,
  ) => request(
    artifactStateSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/restore?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId, versionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  changeAccess: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    accessSetting: AccessSetting,
    idempotencyKey: string,
  ) => request(
    artifactStateSchema.extend({ warning: z.string().nullable() }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/access?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ accessSetting, expectedCurrentVersionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "PATCH",
    },
  ),
  analytics: (projectId: string) => request(
    projectAnalyticsSchema,
    `/api/v1/analytics?${projectQuery(projectId)}`,
  ),
  artifactAnalytics: (artifactId: string, projectId: string) => request(
    artifactAnalyticsSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/analytics?${projectQuery(projectId)}`,
  ),
  artifactInfo: (projectId: string, artifactId: string) => request(
    artifactInfoSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/info?${projectQuery(projectId)}`,
  ),
  branding: () => request(brandingSchema, "/api/v1/public/branding"),
  /** Change the display name; no version is saved and links stay the same. */
  rename: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    name: string,
    idempotencyKey: string,
  ) => request(
    artifactStateSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/name?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId, name }),
      headers: mutationHeaders(idempotencyKey),
      method: "PATCH",
    },
  ),
  changeTags: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    tags: readonly string[],
    idempotencyKey: string,
  ) => request(
    artifactStateSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/tags?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId, tags }),
      headers: mutationHeaders(idempotencyKey),
      method: "PATCH",
    },
  ),
  deleteArtifact: (
    projectId: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
  ) => request(
    z.object({
      artifact: artifactSchema.extend({ deletedAt: z.string() }),
      replayed: z.boolean(),
      retainedVersionCount: z.number(),
    }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ expectedCurrentVersionId }),
      headers: mutationHeaders(idempotencyKey),
      method: "DELETE",
    },
  ),
  contentSession: (
    projectId: string,
    artifactId: string,
    versionId?: string,
    path?: string,
  ) => {
    const versionPath = versionId === undefined
      ? ""
      : `/versions/${encodeURIComponent(versionId)}`;
    const query = new URLSearchParams({ projectId });
    if (path !== undefined) query.set("path", path);
    return request(
      z.object({
        bootstrapUrl: z.url(),
        expiresAt: z.string(),
        versionId: z.string(),
      }),
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}${versionPath}/content-sessions?${query}`,
      { headers: mutationHeaders(), method: "POST" },
    );
  },
  previewLease: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => request(
    z.object({
      baseUrl: z.url(),
      expiresAt: z.string(),
      versionId: z.string(),
    }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/preview-leases?${projectQuery(projectId)}`,
    {headers: mutationHeaders(), method: "POST"},
  ),
  versionFile: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => requestText(versionAssetUrl(
    "file",
    projectId,
    artifactId,
    versionId,
    path,
  )),
  versionFileUrl: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => versionAssetUrl("file", projectId, artifactId, versionId, path),
  versionArchiveUrl: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/archive?${projectQuery(projectId)}`,
  versionMediaUrl: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => versionAssetUrl("media", projectId, artifactId, versionId, path),
  probeVersionMedia: (
    projectId: string,
    artifactId: string,
    versionId: string,
    path: string,
  ) => requestHead(versionAssetUrl(
    "media",
    projectId,
    artifactId,
    versionId,
    path,
  )),
  comments: (
    projectId: string,
    artifactId: string,
    query: CommentThreadQuery,
  ) => {
    const search = new URLSearchParams({ projectId });
    if (query.cursor !== null) search.set("cursor", query.cursor);
    if (query.dispatched !== null) search.set("dispatched", query.dispatched);
    if (query.limit !== null) search.set("limit", String(query.limit));
    if (query.since !== null) search.set("since", query.since);
    if (query.state !== null) search.set("state", query.state);
    if (query.versionId !== null) search.set("versionId", query.versionId);
    return request(
      commentThreadPageSchema,
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments?${search}`,
    );
  },
  comment: (projectId: string, artifactId: string, threadId: string) => request(
    commentThreadDetailsSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}?${projectQuery(projectId)}`,
  ),
  createComment: (
    projectId: string,
    artifactId: string,
    versionId: string,
    draft: CommentDraft,
    idempotencyKey: string,
  ) => request(
    createdCommentThreadSchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/comments?${projectQuery(projectId)}`,
    {
      body: JSON.stringify(
        draft.path === null
          ? { anchor: draft.anchor, body: draft.body }
          : { anchor: draft.anchor, body: draft.body, path: draft.path },
      ),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  updateComment: (
    projectId: string,
    artifactId: string,
    threadId: string,
    edit: CommentThreadEdit,
  ) => request(
    z.object({ thread: commentThreadSchema }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}?${projectQuery(projectId)}`,
    {
      body: JSON.stringify(edit),
      headers: mutationHeaders(),
      method: "PATCH",
    },
  ).then(({ thread }) => thread),
  deleteComment: (projectId: string, artifactId: string, threadId: string) =>
    requestNoContent(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}?${projectQuery(projectId)}`,
      { headers: mutationHeaders(), method: "DELETE" },
    ),
  createCommentReply: (
    projectId: string,
    artifactId: string,
    threadId: string,
    body: string,
    idempotencyKey: string,
  ) => request(
    createdCommentReplySchema,
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}/replies?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ body }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  updateCommentReply: (
    projectId: string,
    artifactId: string,
    threadId: string,
    replyId: string,
    body: string,
  ) => request(
    z.object({ reply: commentReplySchema }),
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({ body }),
      headers: mutationHeaders(),
      method: "PATCH",
    },
  ).then(({ reply }) => reply),
  deleteCommentReply: (
    projectId: string,
    artifactId: string,
    threadId: string,
    replyId: string,
  ) => requestNoContent(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}?${projectQuery(projectId)}`,
    { headers: mutationHeaders(), method: "DELETE" },
  ),
  agents: () => request(
    z.object({ items: z.array(registeredAgentSchema) }),
    "/api/v1/agents",
  ).then(({ items }) => items),
  agentDispatches: (projectId: string, query: AgentDispatchQuery) => {
    const search = new URLSearchParams({ projectId });
    if (query.agentId !== null) search.set("agentId", query.agentId);
    if (query.cursor !== null) search.set("cursor", query.cursor);
    if (query.limit !== null) search.set("limit", String(query.limit));
    if (query.state !== null) search.set("state", query.state);
    return request(agentDispatchPageSchema, `/api/v1/agent-dispatches?${search}`);
  },
  createAgentDispatch: (
    projectId: string,
    draft: AgentDispatchDraft,
    idempotencyKey: string,
  ) => request(
    createdAgentDispatchSchema,
    `/api/v1/agent-dispatches?${projectQuery(projectId)}`,
    {
      body: JSON.stringify({
        agentId: draft.agentId,
        note: draft.note,
        threadIds: draft.threadIds,
      }),
      headers: mutationHeaders(idempotencyKey),
      method: "POST",
    },
  ),
  cancelAgentDispatch: (projectId: string, dispatchId: string) => request(
    z.object({ dispatch: agentDispatchSchema }),
    `/api/v1/agent-dispatches/${encodeURIComponent(dispatchId)}/cancel?${projectQuery(projectId)}`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ dispatch }) => dispatch),
  members: () => request(
    z.object({ members: z.array(memberSchema) }),
    "/api/v1/members",
  ).then(({ members }) => members),
  admitMember: (
    displayName: string,
    email: string,
    role: "administrator" | "member",
  ) => request(
    z.object({ member: memberSchema }),
    "/api/v1/members",
    {
      body: JSON.stringify({ displayName, email, role }),
      headers: mutationHeaders(),
      method: "POST",
    },
  ).then(({ member }) => member),
  deactivateMember: (memberId: string) => request(
    z.object({ member: memberSchema }),
    `/api/v1/members/${encodeURIComponent(memberId)}/deactivate`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ member }) => member),
  apiKeys: () => request(
    z.object({ apiKeys: z.array(apiKeySchema) }),
    "/api/v1/api-keys",
  ).then(({ apiKeys }) => apiKeys),
  issueApiKey: (
    name: string,
    expiresAt: string,
    capabilities: readonly PrincipalCapability[],
    memberId?: string,
  ) => request(
    issuedKeySchema,
    "/api/v1/api-keys",
    {
      body: JSON.stringify(
        memberId === undefined
          ? { capabilities, expiresAt, name }
          : { capabilities, expiresAt, memberId, name },
      ),
      headers: mutationHeaders(),
      method: "POST",
    },
  ),
  rotateApiKey: (keyId: string) => request(
    issuedKeySchema,
    `/api/v1/api-keys/${encodeURIComponent(keyId)}/rotate`,
    { headers: mutationHeaders(), method: "POST" },
  ),
  revokeApiKey: (keyId: string) => request(
    z.object({ apiKey: apiKeySchema }),
    `/api/v1/api-keys/${encodeURIComponent(keyId)}/revoke`,
    { headers: mutationHeaders(), method: "POST" },
  ).then(({ apiKey }) => apiKey),
  /** The registered agents with their derived presence, for live surfaces. */
  agentPresence: () => request(
    z.object({ items: z.array(agentPresenceSchema) }),
    "/api/v1/agents",
  ).then(({ items }) => items),
  /**
   * Delete this artifact's resolved (or all) comment threads in one action.
   * Threads an active send carries are skipped and counted, never deleted.
   */
  clearComments: (
    projectId: string,
    artifactId: string,
    state: "all" | "resolved",
    versionId: string | null,
  ) => request(
    commentClearResultSchema,
    `/api/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/comments/clear`,
    {
      body: JSON.stringify(
        versionId === null ? { state } : { state, versionId },
      ),
      headers: mutationHeaders(),
      method: "POST",
    },
  ),
};
