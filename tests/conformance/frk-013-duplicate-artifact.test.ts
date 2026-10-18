import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  duplicateArtifact,
  duplicateName,
  type DuplicateProgress,
} from "../../apps/web/src/artifact-actions/duplicate-artifact.js";
import {
  createBearerTransport,
  type ActionTransport,
} from "../../apps/web/src/artifact-actions/transport.js";
import {
  createStagedUpload,
  commitStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const manifestEntrySchema = z.object({
  disposition: z.enum(["attachment", "inline"]),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});
const manifestSchema = z.object({
  digest: z.string(),
  entries: z.array(manifestEntrySchema),
  entryPath: z.string(),
  routingMode: z.enum(["static", "spa"]),
});
const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
});
const detailsSchema = z.object({
  artifact: artifactSchema,
  current: z.object({
    manifest: manifestSchema,
    version: z.object({id: z.string(), number: z.number()}),
  }),
});
const pageSchema = z.object({
  artifacts: z.array(z.object({artifact: artifactSchema})),
});

const binaryBytes = Uint8Array.from({length: 256}, (_, index) => index);
const sourceFiles: readonly TestSiteFile[] = [
  {
    bytes: new TextEncoder().encode("<link rel=\"stylesheet\" href=\"assets/app.css\"><h1>Dashboard</h1>\r\n"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {
    bytes: new TextEncoder().encode("h1 { color: rebeccapurple; }\n"),
    mediaType: "text/css; charset=utf-8",
    path: "assets/app.css",
  },
  {
    bytes: new TextEncoder().encode("{\"rows\": 3}"),
    mediaType: "application/json",
    path: "data/rows.json",
  },
  {bytes: binaryBytes, mediaType: "application/octet-stream", path: "assets/blob.bin"},
];

describe("duplicate artifact", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let transport: ActionTransport;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    transport = createBearerTransport(server.baseUrl, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishSource() {
    const staged = await createStagedUpload(server, installation, "index.html", sourceFiles);
    const uploads = await uploadEveryStagedFile(installation, staged.body, sourceFiles);
    expect(uploads.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const published = await commitStagedUpload(
      installation,
      staged.body,
      "frk-013-source-publish",
      {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Quarterly dashboard",
        tags: ["finance", "q3"],
      },
    );
    return published.body;
  }

  async function readDetails(artifactId: string) {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(response.status).toBe(200);
    return detailsSchema.parse(await response.json());
  }

  async function listArtifacts() {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(response.status).toBe(200);
    return pageSchema.parse(await response.json()).artifacts.map((item) => item.artifact);
  }

  async function readFile(artifactId: string, versionId: string, filePath: string) {
    const query = new URLSearchParams({path: filePath});
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/file?${query}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  }

  test("FRK-013-B: copies every file byte for byte into a new private artifact named '<name> (copy)' with the same tags", async () => {
    const source = await publishSource();
    const details = await readDetails(source.artifact.id);
    const progress: DuplicateProgress[] = [];

    const result = await duplicateArtifact(transport, {
      artifactId: source.artifact.id,
      artifactName: details.artifact.name,
      artifactTags: details.artifact.tags,
      idempotencyKey: "web-duplicate-frk-013-behavior-key",
      manifest: details.current.manifest,
      onProgress: (step) => progress.push(step),
      projectId: source.version.projectId,
      versionId: details.current.version.id,
    });

    expect(result.artifact.name).toBe("Quarterly dashboard (copy)");
    expect(result.artifact.tags).toEqual(["finance", "q3"]);
    expect(result.artifact.accessSetting).toBe("account_required");
    expect(result.artifact.id).not.toBe(source.artifact.id);
    expect(result.version.number).toBe(1);
    expect(result.replayed).toBe(false);

    const copy = await readDetails(result.artifact.id);
    expect(copy.current.manifest.entries.map((entry) => [entry.path, entry.sha256, entry.size]))
      .toEqual(details.current.manifest.entries.map((entry) => [entry.path, entry.sha256, entry.size]));
    expect(copy.current.manifest.entryPath).toBe("index.html");
    const copiedBytes = await Promise.all(sourceFiles.map((file) =>
      readFile(result.artifact.id, copy.current.version.id, file.path)));
    expect(copiedBytes).toEqual(sourceFiles.map((file) => file.bytes));

    // The source keeps its version, access setting, and name.
    const unchanged = await readDetails(source.artifact.id);
    expect(unchanged.current.version.id).toBe(source.version.id);
    expect(unchanged.artifact.accessSetting).toBe("public_link");
    expect(unchanged.artifact.name).toBe("Quarterly dashboard");

    expect(progress[0]).toEqual({copiedFiles: 0, phase: "planning", totalFiles: 4});
    expect(progress.at(-2)).toEqual({copiedFiles: 4, phase: "copying", totalFiles: 4});
    expect(progress.at(-1)).toEqual({copiedFiles: 4, phase: "committing", totalFiles: 4});
  });

  test("retrying the same action with the same idempotency key returns the first copy instead of creating a second", async () => {
    const source = await publishSource();
    const details = await readDetails(source.artifact.id);
    const input = {
      artifactId: source.artifact.id,
      artifactName: details.artifact.name,
      artifactTags: details.artifact.tags,
      idempotencyKey: "web-duplicate-frk-013-retry-key",
      manifest: details.current.manifest,
      projectId: source.version.projectId,
      versionId: details.current.version.id,
    };

    const first = await duplicateArtifact(transport, input);
    const retry = await duplicateArtifact(transport, input);

    expect(retry.artifact.id).toBe(first.artifact.id);
    expect(retry.replayed).toBe(true);
    expect((await listArtifacts()).map((artifact) => artifact.name).toSorted())
      .toEqual(["Quarterly dashboard", "Quarterly dashboard (copy)"]);
  });

  test("FRK-013-F: a source file that does not match its manifest fingerprint creates no artifact", async () => {
    const source = await publishSource();
    const details = await readDetails(source.artifact.id);
    const corrupted = {
      ...details.current.manifest,
      entries: details.current.manifest.entries.map((entry) =>
        entry.path === "data/rows.json"
          ? {...entry, sha256: "0".repeat(64)}
          : entry),
    };

    await expect(duplicateArtifact(transport, {
      artifactId: source.artifact.id,
      artifactName: details.artifact.name,
      artifactTags: details.artifact.tags,
      idempotencyKey: "web-duplicate-frk-013-mismatch-key",
      manifest: corrupted,
      projectId: source.version.projectId,
      versionId: details.current.version.id,
    })).rejects.toMatchObject({code: "SOURCE_FILE_MISMATCH"});

    expect((await listArtifacts()).map((artifact) => artifact.name)).toEqual(["Quarterly dashboard"]);
  });

  test("a manifest entry the source version does not hold fails loudly and creates no artifact", async () => {
    const source = await publishSource();
    const details = await readDetails(source.artifact.id);
    const missing = {
      ...details.current.manifest,
      entries: [
        ...details.current.manifest.entries,
        {
          disposition: "attachment" as const,
          mediaType: "text/plain; charset=utf-8",
          path: "missing/notes.txt",
          sha256: "1".repeat(64),
          size: 3,
        },
      ],
    };

    await expect(duplicateArtifact(transport, {
      artifactId: source.artifact.id,
      artifactName: details.artifact.name,
      artifactTags: details.artifact.tags,
      idempotencyKey: "web-duplicate-frk-013-missing-key",
      manifest: missing,
      projectId: source.version.projectId,
      versionId: details.current.version.id,
    })).rejects.toMatchObject({status: 404});

    expect((await listArtifacts()).map((artifact) => artifact.name)).toEqual(["Quarterly dashboard"]);
  });

  test("the copy name stays inside the 200-character name bound", () => {
    expect(duplicateName("Report")).toBe("Report (copy)");
    const long = duplicateName("x".repeat(250));
    expect(long).toBe(`${"x".repeat(193)} (copy)`);
    expect(Array.from(long)).toHaveLength(200);
  });
});
