import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  localOwnerBrowserAccess,
  privateTeamBrowserAccess,
  type BrowserAccess,
} from "../../src/core/browser-access.js";
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

type AccessSetting = "account_required" | "public_link";

interface Deployment {
  readonly installation: TestInstallation;
  readonly server: RunningTestServer;
  readonly workDirectory: string;
}

type JsonValue =
  | boolean
  | null
  | number
  | string
  | {readonly [key: string]: JsonValue}
  | readonly JsonValue[];

type NewArtifactTarget = {
  accessSetting?: AccessSetting;
  readonly kind: "new_artifact";
  readonly name: string;
};

interface Published {
  readonly accessSetting: AccessSetting;
  readonly folderUrl: string;
  readonly name: string;
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const protocolVersion = "2026-07-28";
const accessSettingSchema = z.enum(["account_required", "public_link"]);
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const toolCallResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    structuredContent: z.unknown(),
  }).loose(),
});
const mcpUploadSchema = z.object({
  files: z.array(z.object({
    method: z.literal("PUT"),
    path: z.string(),
    uploadUrl: z.url(),
  })).min(1),
  uploadId: z.string(),
});
const publicationSchema = z.object({
  artifact: z.object({accessSetting: accessSettingSchema}).loose(),
  links: z.object({artifact: z.url()}).loose(),
});

function pageFor(name: string): string {
  return `<!doctype html><title>${name}</title>`;
}

function newArtifactTarget(
  name: string,
  accessSetting: AccessSetting | undefined,
): NewArtifactTarget {
  const target: NewArtifactTarget = {kind: "new_artifact", name};
  if (accessSetting !== undefined) target.accessSetting = accessSetting;
  return target;
}

/** Start a path-mode server and tear it down, with its data and scratch directories, afterwards. */
async function withDeployment(
  browserAccess: BrowserAccess,
  run: (deployment: Deployment) => Promise<void>,
): Promise<void> {
  const installation = await createTestInstallation();
  const workDirectory = await mkdtemp(path.join(tmpdir(), "frk-005-"));
  const server = await startTestServer(installation, {
    browserAccess,
    contentDomain: null,
  });
  try {
    await run({installation, server, workDirectory});
  } finally {
    await server.stop();
    await rm(workDirectory, {force: true, recursive: true});
    await removeTestInstallation(installation);
  }
}

async function publishOverHttp(
  {installation, server}: Deployment,
  name: string,
  accessSetting?: AccessSetting,
): Promise<Published> {
  const file = {
    bytes: new TextEncoder().encode(pageFor(name)),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  };
  const planned = await createStagedUpload(server, installation, file.path, [file]);
  await uploadEveryStagedFile(installation, planned.body, [file]);
  const committed = await commitStagedUpload(
    installation,
    planned.body,
    `frk-005-${randomUUID()}`,
    newArtifactTarget(name, accessSetting),
  );
  return {
    accessSetting: committed.body.artifact.accessSetting,
    folderUrl: committed.body.links.artifact,
    name,
  };
}

async function publishOverMcp(
  {installation, server}: Deployment,
  name: string,
  accessSetting?: AccessSetting,
): Promise<Published> {
  const bytes = new TextEncoder().encode(pageFor(name));
  const upload = await callMcpTool(
    server,
    installation.apiToken,
    "artifact_create_upload",
    {
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    },
    mcpUploadSchema,
  );
  const plan = upload.files[0];
  if (plan === undefined) throw new Error("The MCP upload plan has no file.");
  const uploaded = await fetch(plan.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${installation.apiToken}`},
    method: plan.method,
  });
  expect(uploaded.status).toBe(200);
  const committed = await callMcpTool(
    server,
    installation.apiToken,
    "artifact_commit_upload",
    {
      idempotencyKey: `frk-005-${randomUUID()}`,
      target: newArtifactTarget(name, accessSetting),
      uploadId: upload.uploadId,
    },
    publicationSchema,
  );
  return {
    accessSetting: committed.artifact.accessSetting,
    folderUrl: committed.links.artifact,
    name,
  };
}

async function callMcpTool<Result extends z.ZodType>(
  server: RunningTestServer,
  token: string,
  toolName: string,
  toolArguments: {readonly [key: string]: JsonValue},
  resultSchema: Result,
): Promise<z.output<Result>> {
  const response = await fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: toolArguments,
        name: toolName,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": toolName,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  return resultSchema.parse(
    toolCallResultSchema.parse(await response.json()).result.structuredContent,
  );
}

/** Run the real CLI, so the flag-to-request mapping in `publish` is part of the proof. */
async function publishOverCli(
  {installation, server, workDirectory}: Deployment,
  name: string,
  accessFlag?: "--private" | "--public",
): Promise<Published> {
  const siteDirectory = path.join(workDirectory, randomUUID());
  await mkdir(siteDirectory);
  const entry = path.join(siteDirectory, "index.html");
  await writeFile(entry, pageFor(name));
  const output = await runCli([
    "publish",
    entry,
    "--name",
    name,
    "--profile-data",
    path.join(workDirectory, "profiles"),
    ...(accessFlag === undefined ? [] : [accessFlag]),
  ], {
    ...process.env,
    ARTIFACT_SERVER_API_TOKEN: installation.apiToken,
    ARTIFACT_SERVER_URL: server.baseUrl,
  });
  expect({exitCode: output.exitCode, stderr: output.stderr}).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const published = publicationSchema.parse(JSON.parse(output.stdout));
  return {
    accessSetting: published.artifact.accessSetting,
    folderUrl: published.links.artifact,
    name,
  };
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

/** Publish over HTTP, MCP, and the CLI, naming an access setting only when `explicit` is given. */
async function publishThreeWays(
  deployment: Deployment,
  label: string,
  explicit?: "public_link",
): Promise<readonly Published[]> {
  const http = await publishOverHttp(deployment, `${label} over HTTP`, explicit);
  const mcp = await publishOverMcp(deployment, `${label} over MCP`, explicit);
  const cli = await publishOverCli(
    deployment,
    `${label} over CLI`,
    explicit === undefined ? undefined : "--public",
  );
  return [http, mcp, cli];
}

async function readWithoutCredentials(
  published: Published,
): Promise<{readonly body: string; readonly status: number}> {
  const response = await fetch(published.folderUrl);
  return {body: await response.text(), status: response.status};
}

describe("the default access setting of a new artifact", () => {
  test("FRK-005-B: HTTP, MCP, and the CLI publish public links when no access setting is named and browser login is off", async () => {
    await withDeployment(privateTeamBrowserAccess(browserLoginKinds.none), async (deployment) => {
      const published = await publishThreeWays(deployment, "No login default");

      expect(published.map((artifact) => artifact.accessSetting)).toEqual([
        "public_link",
        "public_link",
        "public_link",
      ]);
      const reads = await Promise.all(published.map(readWithoutCredentials));
      expect(reads).toEqual(published.map((artifact) => ({
        body: pageFor(artifact.name),
        status: 200,
      })));
    });
  });

  test("FRK-005-F: with browser login on the same publishes stay account_required, and an explicit setting always wins", async () => {
    await withDeployment(localOwnerBrowserAccess, async (deployment) => {
      const defaults = await publishThreeWays(deployment, "Login on default");
      expect(defaults.map((artifact) => artifact.accessSetting)).toEqual([
        "account_required",
        "account_required",
        "account_required",
      ]);
      const refused = await Promise.all(defaults.map(readWithoutCredentials));
      expect(refused.map(({body, status}) => ({
        code: errorBodySchema.parse(JSON.parse(body)).error.code,
        status,
      }))).toEqual(Array.from({length: 3}, () => ({
        code: "CONTENT_NOT_PUBLIC",
        status: 401,
      })));

      const explicit = await publishThreeWays(deployment, "Login on public", "public_link");
      expect(explicit.map((artifact) => artifact.accessSetting)).toEqual([
        "public_link",
        "public_link",
        "public_link",
      ]);
    });

    await withDeployment(privateTeamBrowserAccess(browserLoginKinds.none), async (deployment) => {
      const http = await publishOverHttp(deployment, "No login private over HTTP", "account_required");
      const mcp = await publishOverMcp(deployment, "No login private over MCP", "account_required");
      const cli = await publishOverCli(deployment, "No login private over CLI", "--private");
      expect([http.accessSetting, mcp.accessSetting, cli.accessSetting]).toEqual([
        "account_required",
        "account_required",
        "account_required",
      ]);
      const refused = await Promise.all([http, mcp, cli].map(readWithoutCredentials));
      expect(refused.map(({status}) => status)).toEqual([401, 401, 401]);

      const conflicting = await runCli([
        "publish",
        path.join(deployment.workDirectory, "unused.html"),
        "--public",
        "--private",
      ], {
        ...process.env,
        ARTIFACT_SERVER_API_TOKEN: deployment.installation.apiToken,
        ARTIFACT_SERVER_URL: deployment.server.baseUrl,
      });
      expect({
        exitCode: conflicting.exitCode,
        refusesBoth: conflicting.stderr.includes("--private") && conflicting.stderr.includes("--public"),
      }).toEqual({exitCode: 1, refusesBoth: true});
    });
  });
});
