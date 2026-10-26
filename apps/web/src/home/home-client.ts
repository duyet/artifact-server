import {z} from "zod";

import type {PublicArtifactTreeEntry} from "./home-tree.js";

const dailyCountSchema = z.object({
  count: z.number().int().nonnegative(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

const publicArtifactSchema = z.object({
  manage: z.object({
    artifactId: z.string().min(1),
    currentVersionId: z.string().min(1),
    projectId: z.string().min(1),
    tags: z.array(z.string()),
  }).nullable(),
  mine: z.boolean(),
  name: z.string().min(1).max(200),
  owner: z.string().nullable(),
  path: z.string().min(1).max(200).nullable(),
  series: z.array(dailyCountSchema),
  updatedAt: z.iso.datetime(),
  updates: z.array(dailyCountSchema),
  url: z.url(),
  views: z.object({
    last7Days: z.number().int().nonnegative(),
    last30Days: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  visibility: z.enum(["private", "public", "unlisted"]),
}).loose();

/**
 * The public catalog. A deployment older than this page answers 404 for the
 * endpoint, which the shell turns into an explicit message rather than an
 * empty list, so a reader never mistakes "no data yet" for "nothing here".
 */
const publicCatalogSchema = z.object({
  artifacts: z.array(publicArtifactSchema),
  collapsedFolders: z.array(z.string().min(1).max(200)),
  generatedAt: z.iso.datetime(),
  loginKind: z.enum(["local_owner", "none", "oidc", "workos"]),
  truncated: z.boolean(),
  viewer: z.object({name: z.string()}).nullable(),
  windowDays: z.number().int().positive(),
});

/** Everything the home page draws, after the server's own shaping. */
export interface PublicCatalog {
  readonly artifacts: readonly PublicArtifactTreeEntry[];
  /** Folder paths that start collapsed. Every other folder starts expanded. */
  readonly collapsedFolders: readonly string[];
  readonly generatedAt: string;
  readonly loginKind: z.infer<typeof publicCatalogSchema>["loginKind"];
  readonly truncated: boolean;
  /** The signed-in member, or null for an anonymous reader. */
  readonly viewer: {readonly name: string} | null;
  readonly windowDays: number;
}

const signInContextSchema = z.object({
  helpUrl: z.url({protocol: /^https$/u}).nullable(),
  login: z.object({oidc: z.boolean().optional()}),
});

/** What the header's account control needs before anyone signs in. */
export interface SignInContext {
  /** The operator's Help link, or null for no Help item. */
  readonly helpUrl: string | null;
  /** Where Sign in goes: SSO when it is configured, otherwise Review's gate. */
  readonly signInHref: string;
}

/** Read the sign-in route and Help link without loading the API client. */
export async function readSignInContext(
  fetchImplementation: typeof fetch = fetch,
): Promise<SignInContext> {
  const response = await fetchImplementation("/auth/context", {
    headers: {Accept: "application/json"},
  });
  if (!response.ok) {
    throw new Error(`The sign-in context request returned HTTP ${response.status}.`);
  }
  const context = signInContextSchema.parse(await response.json());
  return {
    helpUrl: context.helpUrl,
    signInHref: context.login.oidc === true ? "/auth/oidc/start?returnTo=%2F" : "/review",
  };
}

/**
 * Read the catalog. The browser sends its session cookie, so a signed-in
 * member reads every artifact with what they may change; anyone else reads
 * the public ones.
 */
export async function readPublicCatalog(
  fetchImplementation: typeof fetch = fetch,
): Promise<PublicCatalog> {
  const response = await fetchImplementation("/api/v1/public/tree", {
    headers: {Accept: "application/json"},
  });
  if (!response.ok) {
    throw new Error(
      `The public catalog request returned HTTP ${response.status}.`,
    );
  }
  const catalog = publicCatalogSchema.parse(await response.json());
  return {
    artifacts: catalog.artifacts.map((artifact) => ({
      manage: artifact.manage,
      mine: artifact.mine,
      name: artifact.name,
      owner: artifact.owner,
      path: artifact.path,
      series: artifact.series,
      updatedAt: artifact.updatedAt,
      updates: artifact.updates,
      url: artifact.url,
      views: artifact.views,
      visibility: artifact.visibility,
    })),
    collapsedFolders: catalog.collapsedFolders,
    generatedAt: catalog.generatedAt,
    loginKind: catalog.loginKind,
    truncated: catalog.truncated,
    viewer: catalog.viewer,
    windowDays: catalog.windowDays,
  };
}