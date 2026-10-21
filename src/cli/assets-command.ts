import {Option, type Command} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {
  resolveCliServerConnection,
  type CliServerConnection,
} from "./cli-server-connection.js";

interface AssetsCheckOptions {
  readonly all: boolean;
  readonly data: string;
  readonly profile?: string;
  readonly profileData: string;
  readonly project?: string;
  readonly server?: string;
  readonly tokenFile?: string;
  readonly versionId?: string;
}

/** User-local configuration shared with the other remote commands. */
export interface AssetsCommandOptions {
  readonly defaultProfileDirectory: string;
}

// Loose, so the printed report keeps every field the server sends.
const assetCheckSchema = z.object({
  artifactId: z.string(),
  references: z.array(z.object({
    confidence: z.enum(["certain", "heuristic"]),
    file: z.string(),
    kind: z.string(),
    line: z.number().int().nullable(),
    raw: z.string(),
    resolvedPath: z.string(),
  })),
  summary: z.object({
    broken: z.number().int(),
    checkedFiles: z.number().int(),
    heuristic: z.number().int(),
    truncated: z.boolean(),
  }).loose(),
}).loose();
const projectListSchema = z.object({
  projects: z.array(z.object({id: z.string()})),
});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), name: z.string(), path: z.string().nullable()}),
  })),
  nextCursor: z.string().nullable(),
});

/** Add `assets check`, which reports references a published version cannot satisfy. */
export function configureAssetsCommand(
  program: Command,
  commandOptions: AssetsCommandOptions,
): void {
  program
    .command("assets")
    .description("Inspect the files of published artifacts.")
    .command("check")
    .description("List references to files a published version does not contain.")
    .argument("[artifact-id]", "artifact to check")
    .addOption(new Option("--all", "check every artifact this key can read").default(false))
    .addOption(new Option("--version-id <id>", "exact version ID; defaults to the current version"))
    .addOption(new Option("--project <id>", "project ID; optional when one active project exists"))
    .addOption(
      new Option("--server <origin>", "Artifact Server origin")
        .env("ARTIFACT_SERVER_URL"),
    )
    .addOption(
      new Option("--data <directory>", "local Artifact Server data directory")
        .default(".artifact-server"),
    )
    .addOption(
      new Option("--token-file <path>", "file containing an Artifact Server API token"),
    )
    .addOption(new Option("--profile <name>", "saved Artifact Server profile"))
    .addOption(
      new Option("--profile-data <directory>", "user-local CLI profile directory")
        .default(commandOptions.defaultProfileDirectory)
        .env("ARTIFACT_SERVER_HOME"),
    )
    .action(async (artifactId: string | undefined, options: AssetsCheckOptions) => {
      if ((artifactId === undefined) === !options.all) {
        throw new Error("Name one artifact ID or pass --all.");
      }
      if (options.all && options.versionId !== undefined) {
        throw new Error("--version-id applies to one artifact, not --all.");
      }
      const connection = await resolveCliServerConnection(options);
      if (artifactId !== undefined) {
        const report = await readAssetCheck(connection, artifactId, options.project, options.versionId);
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const rows: string[][] = [["artifact", "path", "broken", "heuristic"]];
      const projectIds = options.project === undefined
        ? (await getJson(connection, "/api/v1/projects", projectListSchema)).projects
          .map((project) => project.id)
        : [options.project];
      for await (const {artifact, projectId} of listArtifacts(connection, projectIds)) {
        // One check at a time keeps a large installation's blob reads bounded.
        // eslint-disable-next-line no-await-in-loop
        const report = await readAssetCheck(connection, artifact.id, projectId, undefined);
        rows.push([
          artifact.id,
          artifact.path ?? artifact.name,
          String(report.summary.broken),
          String(report.summary.heuristic),
        ]);
      }
      console.log(renderTable(rows));
    });
}

async function readAssetCheck(
  connection: CliServerConnection,
  artifactId: string,
  projectId: string | undefined,
  versionId: string | undefined,
) {
  const artifact = encodeURIComponent(artifactId);
  const route = versionId === undefined
    ? `/api/v1/artifacts/${artifact}/asset-check`
    : `/api/v1/artifacts/${artifact}/versions/${encodeURIComponent(versionId)}/asset-check`;
  const query = projectId === undefined ? "" : `?${new URLSearchParams({projectId})}`;
  return getJson(connection, `${route}${query}`, assetCheckSchema);
}

async function* listArtifacts(
  connection: CliServerConnection,
  projectIds: readonly string[],
) {
  for (const projectId of projectIds) {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({limit: "100", projectId});
      if (cursor !== null) query.set("cursor", cursor);
      // Each page needs the previous page's cursor.
      // eslint-disable-next-line no-await-in-loop
      const page = await getJson(connection, `/api/v1/artifacts?${query}`, artifactPageSchema);
      for (const entry of page.artifacts) yield {artifact: entry.artifact, projectId};
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
}

async function getJson<Schema extends z.ZodType>(
  connection: CliServerConnection,
  route: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const response = await fetch(new URL(route, connection.origin), {
    headers: {Authorization: `Bearer ${Redacted.value(connection.apiToken)}`},
    redirect: "error",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = z.object({error: z.object({code: z.string(), message: z.string()})})
      .safeParse(body);
    throw new Error(failure.success
      ? `${failure.data.error.code}: ${failure.data.error.message}`
      : `The server answered HTTP ${response.status}.`);
  }
  return schema.parse(body);
}

function renderTable(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0))
  ) ?? [];
  return rows.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()
  ).join("\n");
}
