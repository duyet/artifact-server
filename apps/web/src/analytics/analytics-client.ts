import {z} from "zod";

const countSchema = z.number().int().nonnegative();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const analyticsSchema = z.object({
  daily: z.array(z.object({
    day: daySchema,
    uploads: countSchema,
    views: countSchema,
  })),
  generatedAt: z.iso.datetime(),
  today: daySchema,
  topArtifacts: z.array(z.object({
    artifactId: z.string(),
    name: z.string(),
    total: countSchema,
    views30d: countSchema,
  })),
  totals: z.object({
    artifacts: countSchema,
    artifactsViewedToday: countSchema,
    averageViewsPerArtifact: z.number().nonnegative(),
    pageViews: countSchema,
    publicArtifacts: countSchema,
    uploadedToday: countSchema,
    uploads: countSchema,
  }),
  windowDays: z.number().int().positive(),
});

/** The project analytics the server reports, parsed against the contract. */
export type AnalyticsReport = z.infer<typeof analyticsSchema>;

/** Read one project's analytics, or throw with the server's own message. */
export async function readAnalytics(projectId: string): Promise<AnalyticsReport> {
  const response = await fetch(
    `/api/v1/analytics?${new URLSearchParams({project: projectId})}`,
    {credentials: "same-origin", headers: {Accept: "application/json"}},
  );
  if (!response.ok) {
    throw new Error(`The analytics request returned HTTP ${response.status}.`);
  }
  const parsed = analyticsSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      "Artifact Server returned analytics that do not match the expected contract.",
    );
  }
  return parsed.data;
}
