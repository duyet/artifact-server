import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  createStagedUpload,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const publishedSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    path: z.string().nullable(),
  }).loose(),
  replayed: z.boolean(),
}).loose();
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const mcpUploadSchema = z.object({
  files: z.array(z.object({method: z.literal("PUT"), uploadUrl: z.url()})).min(1),
  uploadId: z.string(),
});
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const mcpProtocolVersion = "2026-07-28";
const newVersionGuard =
  "--name, --path, --public, --private, and --tag apply only when creating a new artifact.";

type CommitTarget =
  | {
    readonly accessSetting: "public_link";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly path?: string;
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
    readonly path?: string;
  };

interface Attempt {
  readonly body: unknown;
  readonly commitUrl: string;
  readonly status: number;
}

/** Stage a one-file site and commit it, returning the raw response so refusals stay visible. */
async function commit(
  server: RunningTestServer,
  installation: TestInstallation,
  target: CommitTarget,
  idempotencyKey = `frk-006-${randomUUID()}`,
): Promise<Attempt> {
  const file = {
    bytes: new TextEncoder().encode(`<!doctype html><title>${randomUUID()}</title>`),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  };
  const planned = await createStagedUpload(server, installation, file.path, [file]);
  await uploadEveryStagedFile(installation, planned.body, [file]);
  return commitAt(installation, planned.body.commitUrl, target, idempotencyKey);
}

async function commitAt(
  installation: TestInstallation,
  commitUrl: string,
  target: CommitTarget,
  idempotencyKey: string,
): Promise<Attempt> {
  const response = await fetch(commitUrl, {
    body: JSON.stringify({target}),
    headers: apiHeaders(installation, idempotencyKey),
    method: "POST",
  });
  return {body: await response.json(), commitUrl, status: response.status};
}

function newArtifact(artifactPath?: string): CommitTarget {
  const target = {
    accessSetting: "public_link" as const,
    kind: "new_artifact" as const,
    name: `Report ${randomUUID()}`,
  };
  return artifactPath === undefined ? target : {...target, path: artifactPath};
}

function refusal(attempt: Attempt) {
  return {...errorBodySchema.parse(attempt.body).error, status: attempt.status};
}

/** Stage and commit one page through the MCP tools an agent uses. */
async function commitOverMcp(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactPath: string,
): Promise<{readonly isError: boolean; readonly structuredContent: unknown}> {
  const client = new Client(
    {name: "frk-006-artifact-path-client", version: "1"},
    {versionNegotiation: {mode: {pin: mcpProtocolVersion}}},
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
        authProvider: {token: async () => installation.apiToken},
      }),
    );
    const bytes = new TextEncoder().encode(`<!doctype html><title>${randomUUID()}</title>`);
    const planned = await client.callTool({
      arguments: {
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
      },
      name: "artifact_create_upload",
    });
    const upload = mcpUploadSchema.parse(planned.structuredContent);
    const [plannedFile] = upload.files;
    if (plannedFile === undefined) throw new Error("The MCP upload plan has no file.");
    const uploaded = await fetch(plannedFile.uploadUrl, {
      body: bytes,
      headers: {Authorization: `Bearer ${installation.apiToken}`},
      method: plannedFile.method,
    });
    expect(uploaded.status).toBe(200);
    const committed = await client.callTool({
      arguments: {
        idempotencyKey: `frk-006-${randomUUID()}`,
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: `MCP report ${randomUUID()}`,
          path: artifactPath,
        },
        uploadId: upload.uploadId,
      },
      name: "artifact_commit_upload",
    });
    return {
      isError: committed.isError === true,
      structuredContent: committed.structuredContent,
    };
  } finally {
    await client.close();
  }
}

/** Run the real CLI `publish` on one page, so its flag-to-request mapping is part of the proof. */
async function publishOverCli(
  server: RunningTestServer,
  installation: TestInstallation,
  cliArguments: readonly string[],
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  const workDirectory = await mkdtemp(path.join(tmpdir(), "frk-006-"));
  try {
    const entry = path.join(workDirectory, "index.html");
    await writeFile(entry, `<!doctype html><title>${randomUUID()}</title>`);
    return await runCli([
      "publish",
      entry,
      "--profile-data",
      path.join(workDirectory, "profiles"),
      ...cliArguments,
    ], {
      ...process.env,
      ARTIFACT_SERVER_API_TOKEN: installation.apiToken,
      ARTIFACT_SERVER_URL: server.baseUrl,
    });
  } finally {
    await rm(workDirectory, {force: true, recursive: true});
  }
}

function runCli(
  cliArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(repositoryRoot, "node_modules/.bin/tsx"),
      [path.join(repositoryRoot, "src/cli/main.ts"), ...cliArguments],
      {cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"]},
    );
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({
      exitCode: exitCode ?? -1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
  });
}

describe("readable artifact paths at creation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {contentDomain: null});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("FRK-006-B: HTTP, MCP, and CLI creates store their normalized paths, a new version keeps one, and a retried create replays", async () => {
    const idempotencyKey = `frk-006-${randomUUID()}`;
    const target = newArtifact("/2026/10/agent-console/");
    const created = await commit(server, installation, target, idempotencyKey);
    expect(created.status).toBe(201);
    const first = publishedSchema.parse(created.body);
    expect(first.artifact.path).toBe("2026/10/agent-console");

    const retried = await commitAt(installation, created.commitUrl, target, idempotencyKey);
    expect(retried.status).toBe(200);
    expect(publishedSchema.parse(retried.body)).toMatchObject({
      artifact: {id: first.artifact.id, path: "2026/10/agent-console"},
      replayed: true,
    });

    const versioned = await commit(server, installation, {
      artifactId: first.artifact.id,
      expectedCurrentVersionId: first.artifact.currentVersionId,
      kind: "new_version",
    });
    expect(versioned.status).toBe(201);
    expect(publishedSchema.parse(versioned.body).artifact).toMatchObject({
      id: first.artifact.id,
      path: "2026/10/agent-console",
    });

    const sibling = await commit(
      server,
      installation,
      newArtifact("2026/10/agent-console-v2"),
    );
    expect(sibling.status).toBe(201);
    expect(publishedSchema.parse(sibling.body).artifact.path)
      .toBe("2026/10/agent-console-v2");

    const pathless = await commit(server, installation, newArtifact());
    expect(pathless.status).toBe(201);
    expect(publishedSchema.parse(pathless.body).artifact.path).toBeNull();

    const overMcp = await commitOverMcp(server, installation, "2026/10/mcp-report/");
    expect(overMcp.isError).toBe(false);
    expect(publishedSchema.parse(overMcp.structuredContent).artifact.path)
      .toBe("2026/10/mcp-report");

    const overCli = await publishOverCli(server, installation, [
      "--name",
      "CLI report",
      "--path",
      "2026/10/cli-report",
      "--public",
    ]);
    expect({exitCode: overCli.exitCode, stderr: overCli.stderr}).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(publishedSchema.parse(JSON.parse(overCli.stdout)).artifact.path)
      .toBe("2026/10/cli-report");
  });

  test("FRK-006-F: duplicate, malformed, version-scoped, and host-mode paths are refused, and a deleted artifact frees its path", async () => {
    const held = await commit(server, installation, newArtifact("2026/10/agent-console"));
    expect(held.status).toBe(201);
    const holder = publishedSchema.parse(held.body);

    expect(refusal(await commit(server, installation, newArtifact("2026/10/agent-console"))))
      .toEqual({
        code: "ARTIFACT_PATH_TAKEN",
        message: 'The path "2026/10/agent-console" already belongs to another artifact.',
        status: 409,
      });
    // A folder above or below a live path may hold its own artifact.
    const nested = await Promise.all([
      "2026/10",
      "2026/10/agent-console/shots",
    ].map(async (artifactPath) =>
      (await commit(server, installation, newArtifact(artifactPath))).status));
    expect(nested).toEqual([201, 201]);

    const raced = await Promise.all([
      commit(server, installation, newArtifact("2026/11/raced")),
      commit(server, installation, newArtifact("2026/11/raced")),
    ]);
    expect(
      raced.map(({status}) => status).toSorted((left, right) => left - right),
    ).toEqual([201, 409]);

    const malformed = await Promise.all([
      "api/report",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6/report",
      "2026/Oct",
      "2026//report",
      "a/b/c/d/e/f/g",
    ].map(async (artifactPath) =>
      refusal(await commit(server, installation, newArtifact(artifactPath)))));
    expect(malformed).toEqual([
      {
        code: "INVALID_INPUT",
        message: 'The first path segment "api" is reserved by the application.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'The first path segment "3fa85f64-5717-4562-b3fc-2c963f66afa6" has the shape of an artifact folder.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'The path segment "Oct" may contain only lowercase letters, digits, and hyphens, and must not start with a hyphen.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'The artifact path "2026//report" has an empty segment.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'An artifact path has at most 6 segments, and "a/b/c/d/e/f/g" has 7.',
        status: 422,
      },
    ]);

    const onVersion = await commit(server, installation, {
      artifactId: holder.artifact.id,
      expectedCurrentVersionId: holder.artifact.currentVersionId,
      kind: "new_version",
      path: "2026/12/elsewhere",
    });
    expect(refusal(onVersion)).toMatchObject({code: "INVALID_INPUT", status: 422});

    const reservedOverMcp = await commitOverMcp(server, installation, "api/report");
    expect(reservedOverMcp).toEqual({
      isError: true,
      structuredContent: {
        error: {
          code: "INVALID_INPUT",
          message: 'The first path segment "api" is reserved by the application.',
        },
      },
    });
    const versionOverCli = await publishOverCli(server, installation, [
      "--artifact",
      holder.artifact.id,
      "--expected-version",
      holder.artifact.currentVersionId,
      "--path",
      "2026/12/elsewhere",
    ]);
    expect(versionOverCli.exitCode).not.toBe(0);
    expect(versionOverCli.stderr).toContain(newVersionGuard);

    const reusedKey = `frk-006-${randomUUID()}`;
    const keyedTarget = newArtifact("2026/12/keyed");
    const keyed = await commit(server, installation, keyedTarget, reusedKey);
    expect(keyed.status).toBe(201);
    const rekeyed = await commitAt(
      installation,
      keyed.commitUrl,
      {...keyedTarget, path: "2026/12/rekeyed"},
      reusedKey,
    );
    expect(refusal(rekeyed)).toMatchObject({code: "IDEMPOTENCY_CONFLICT", status: 409});

    const deleted = await fetch(`${server.baseUrl}/api/v1/artifacts/${holder.artifact.id}`, {
      body: JSON.stringify({expectedCurrentVersionId: holder.artifact.currentVersionId}),
      headers: apiHeaders(installation, `frk-006-${randomUUID()}`),
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const reclaimed = await commit(server, installation, newArtifact("2026/10/agent-console"));
    expect(reclaimed.status).toBe(201);
    expect(publishedSchema.parse(reclaimed.body).artifact.path).toBe("2026/10/agent-console");

    const hostInstallation = await createTestInstallation();
    const hostServer = await startTestServer(hostInstallation);
    try {
      const hostMode = await commit(hostServer, hostInstallation, newArtifact("2026/10/report"));
      expect(refusal(hostMode)).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Readable artifact paths need a deployment without a content domain.",
        status: 501,
      });
    } finally {
      await hostServer.stop();
      await removeTestInstallation(hostInstallation);
    }
  });
});
