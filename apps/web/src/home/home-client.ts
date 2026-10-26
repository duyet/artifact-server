import {z} from "zod";

import type {PublicArtifactTreeEntry} from "./home-tree.js";

const dailyCountSchema = z.object({
  count: z.number().int().nonnegative(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

const publicArtifactSchema = z.object({
  access: z.literal("public_link"),
  name: z.string().min(1).max(200),
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
  readonly windowDays: number;
}

/** Read the anonymous public catalog. */
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
      name: artifact.name,
      path: artifact.path,
      series: artifact.series,
      updatedAt: artifact.updatedAt,
      updates: artifact.updates,
      url: artifact.url,
      views: artifact.views,
    })),
    collapsedFolders: catalog.collapsedFolders,
    generatedAt: catalog.generatedAt,
    loginKind: catalog.loginKind,
    truncated: catalog.truncated,
    windowDays: catalog.windowDays,
  };
}