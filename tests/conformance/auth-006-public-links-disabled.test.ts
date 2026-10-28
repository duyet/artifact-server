import {createHash, randomUUID} from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import type {PublicLinkPolicy} from "../../src/core/model.js";
import {
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
} from "../../src/lifecycle/runtime-configuration.js";
import {addAsset} from "../support/assets.js";
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const disabledMessage = "An administrator has disabled public links on this installation.";
const protocolVersion = "2026-07-28";
const noLogin = privateTeamBrowserAccess(browserLoginKinds.none);
const refusal = {code: "AUTHORIZATION_DENIED", message: disabledMessage};
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const artifactSchema = z.object({artifact: z.object({accessSetting: z.string()})});
const treeSchema = z.object({artifacts: z.array(z.object({name: z.string()}))});
const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
});
const mcpErrorSchema = z.object({error: z.object({code: z.string(), message: z.string()})});
const mcpUploadSchema = z.object({
  files: z.array(z.object({uploadUrl: z.url()})).length(1),
  uploadId: z.string(),
});
const mcpPublishSchema = z.object({
  artifact: z.object({accessSetting: z.string(), currentVersionId: z.string(), id: z.string()}),
});
const bootstrapSchema = z.object({bootstrapUrl: z.url()});
const externalEnvironment: NodeJS.ProcessEnv = {
  ARTIFACT_SERVER_API_TOKEN: `as_key_key_${randomUUID()}_${"a".repeat(40)}`,
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
  ARTIFACT_SERVER_DATABASE_URL: "postgres://user:secret@localhost/artifacts",
  ARTIFACT_SERVER_INSTALLATION_ID: "test-installation",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
  ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "access-id",
  ARTIFACT_SERVER_S3_BUCKET: "artifact-test-bucket",
  ARTIFACT_SERVER_S3_REGION: "us-east-1",
  ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: "secret-access",
};
const page = "<!doctype html><title>Disabled policy page</title>";
const pageBytes = new TextEncoder().encode(page);
const pageFile: TestSiteFile = {
  bytes: pageBytes,
  mediaType: "text/html; charset=utf-8",
  path: "index.html",
};

type JsonValue =
  | boolean
  | null
  | number
  | string
  | {readonly [key: string]: JsonValue}
  | readonly JsonValue[];

interface NewArtifactTarget {
  readonly accessSetting?: "account_required" | "public_link";
  readonly name: string;
}

async function callMcpTool(
  server: RunningTestServer,
  token: string,
  name: string,
  toolArguments: {readonly [key: string]: JsonValue},
): Promise<{readonly isError: boolean; readonly structured: unknown}> {
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
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const {result} = toolResultSchema.parse(await response.json());
  return {isError: result.isError === true, structured: result.structuredContent};
}

/** Stage one page over MCP and commit it as a new artifact with the given target fields. */
async function commitOverMcp(
  server: RunningTestServer,
  installation: TestInstallation,
  target: NewArtifactTarget,
): Promise<{readonly isError: boolean; readonly structured: unknown}> {
  const planned = await callMcpTool(server, installation.apiToken, "artifact_create_upload", {
    entryPath: "index.html",
    files: [{
      mediaType: pageFile.mediaType,
      path: pageFile.path,
      sha256: createHash("sha256").update(pageFile.bytes).digest("hex"),
      size: pageFile.bytes.byteLength,
    }],
  });
  const upload = mcpUploadSchema.parse(planned.structured);
  const put = await fetch(upload.files[0]?.uploadUrl ?? "", {
    body: pageBytes,
    headers: {Authorization: `Bearer ${installation.apiToken}`},
    method: "PUT",
  });
  expect(put.status).toBe(200);
  return callMcpTool(server, installation.apiToken, "artifact_commit_upload", {
    idempotencyKey: `auth-006-${randomUUID()}`,
    target: {kind: "new_artifact", ...target},
    uploadId: upload.uploadId,
  });
}

/** Stage one page over HTTP and commit it, returning the raw commit response. */
async function commitOverHttp(
  server: RunningTestServer,
  installation: TestInstallation,
  target: NewArtifactTarget,
): Promise<Response> {
  const planned = await createStagedUpload(server, installation, "index.html", [pageFile]);
  await uploadEveryStagedFile(installation, planned.body, [pageFile]);
  return fetch(planned.body.commitUrl, {
    body: JSON.stringify({target: {kind: "new_artifact", ...target}}),
    headers: apiHeaders(installation, `auth-006-${randomUUID()}`),
    method: "POST",
  });
}

async function changeAccess(
  server: RunningTestServer,
  installation: TestInstallation,
  artifact: {readonly id: string; readonly currentVersionId: string},
  accessSetting: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/artifacts/${artifact.id}/access`, {
    body: JSON.stringify({accessSetting, expectedCurrentVersionId: artifact.currentVersionId}),
    headers: apiHeaders(installation, `auth-006-${randomUUID()}`),
    method: "PATCH",
  });
}

function parsedPolicy(value: string | undefined) {
  const environment = value === undefined
    ? externalEnvironment
    : {...externalEnvironment, ARTIFACT_SERVER_PUBLIC_LINKS: value};
  return Effect.runPromise(parseExternalStorageRuntimeConfiguration({
    environment,
    hostname: "127.0.0.1",
    port: "8787",
  }).pipe(
    Effect.map((configuration) => summarizeRuntimeConfiguration(configuration).publicLinks),
    Effect.catchTag("RuntimeConfigurationError", (failure) =>
      Effect.succeed({field: failure.field, reason: failure.reason})),
  ));
}

async function errorOf(response: Response): Promise<{status: number; code: string; message: string}> {
  const {error} = errorBodySchema.parse(await response.json());
  return {code: error.code, message: error.message, status: response.status};
}

describe("administrators can disable public links for an installation", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function restart(
    publicLinks: PublicLinkPolicy,
    contentDomain: string | null,
  ): Promise<void> {
    const port = server.port;
    await server.stop();
    server = await startTestServer(installation, {
      browserAccess: noLogin,
      contentDomain,
      port,
      publicLinks,
    });
  }

  test("AUTH-006-B: disabling public links stops serving existing public artifacts without rewriting them, refuses new ones, and makes the no-login default account_required", async () => {
    expect(await Promise.all([undefined, "", "allowed", "disabled", "off"].map(parsedPolicy)))
      .toEqual([
        "allowed",
        "allowed",
        "allowed",
        "disabled",
        {field: "ARTIFACT_SERVER_PUBLIC_LINKS", reason: "invalid_value"},
      ]);

    server = await startTestServer(installation, {browserAccess: noLogin, contentDomain: null});
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Launch notes",
      path: "2026/10/launch-notes",
    });
    const asset = await addAsset(server, installation.apiToken, site.artifact.id, {
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 6, 0, 0, 6]),
      mediaType: "image/png",
      name: "chart.png",
    }, "auth-006-b-asset");
    const publicUrls = [
      site.links.artifact,
      site.links.version,
      new URL("docs/nested/page.html", site.links.artifact).href,
      asset.url,
    ];
    const openedBefore = await Promise.all(publicUrls.map(async (url) => (await fetch(url)).status));
    expect(openedBefore).toEqual([200, 200, 200, 200]);

    await restart("disabled", null);

    const openedAfter = await Promise.all(publicUrls.map(async (url) => ({
      status: (await fetch(url)).status,
      url,
    })));
    expect(openedAfter).toEqual(publicUrls.map((url) => ({status: 401, url})));
    const tree = await fetch(`${server.baseUrl}/api/v1/public/tree`);
    expect(treeSchema.parse(await tree.json()).artifacts).toEqual([]);
    const stored = await fetch(`${server.baseUrl}/api/v1/artifacts/${site.artifact.id}`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(artifactSchema.parse(await stored.json()).artifact.accessSetting).toBe("public_link");

    expect(await errorOf(await commitOverHttp(server, installation, {
      accessSetting: "public_link",
      name: "Refused public",
    }))).toEqual({...refusal, status: 403});
    const defaulted = await commitOverHttp(server, installation, {name: "Defaulted"});
    expect(defaulted.status).toBe(201);
    expect(artifactSchema.parse(await defaulted.json()).artifact.accessSetting)
      .toBe("account_required");

    await restart("allowed", null);
    const restored = await Promise.all(publicUrls.map(async (url) => (await fetch(url)).status));
    expect(restored).toEqual([200, 200, 200, 200]);
  });

  test("AUTH-006-F: MCP, staged HTTP commits, access changes, and member sessions cannot bypass disabled public links, while making links private still works", async () => {
    server = await startTestServer(installation, {browserAccess: noLogin});
    const planned = await createStagedUpload(server, installation, "index.html", [pageFile]);
    await uploadEveryStagedFile(installation, planned.body, [pageFile]);
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "auth-006-f-public",
      {accessSetting: "public_link", kind: "new_artifact", name: "Shared before"},
    );
    expect(published.response.status).toBe(201);
    const privateArtifact = mcpPublishSchema.parse((await commitOverMcp(server, installation, {
      accessSetting: "account_required",
      name: "Private before",
    })).structured).artifact;

    await restart("disabled", "localhost");

    const mcpCreate = await commitOverMcp(server, installation, {
      accessSetting: "public_link",
      name: "Refused over MCP",
    });
    expect({error: mcpErrorSchema.parse(mcpCreate.structured).error, isError: mcpCreate.isError})
      .toEqual({error: refusal, isError: true});
    const mcpDefault = await commitOverMcp(server, installation, {name: "MCP default"});
    expect(mcpPublishSchema.parse(mcpDefault.structured).artifact.accessSetting)
      .toBe("account_required");

    const mcpVisibility = await callMcpTool(server, installation.apiToken, "artifact_set_visibility", {
      accessSetting: "public_link",
      artifactId: privateArtifact.id,
      expectedCurrentVersionId: privateArtifact.currentVersionId,
      idempotencyKey: "auth-006-f-mcp-visibility",
    });
    expect({error: mcpErrorSchema.parse(mcpVisibility.structured).error, isError: mcpVisibility.isError})
      .toEqual({error: refusal, isError: true});
    expect(await errorOf(await changeAccess(server, installation, privateArtifact, "public_link")))
      .toEqual({...refusal, status: 403});

    const anonymous = await fetchVersion(server, published.body.links.version);
    expect(anonymous.status).toBe(401);
    const issued = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/content-sessions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(issued.status).toBe(201);
    const exchange = await fetchVersion(server, bootstrapSchema.parse(await issued.json()).bootstrapUrl);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const memberRead = await fetchVersion(server, published.body.links.version, "GET", {Cookie: cookie});
    expect({
      body: await memberRead.text(),
      cacheControl: memberRead.headers.get("cache-control"),
      status: memberRead.status,
    }).toEqual({body: page, cacheControl: "private, no-store", status: 200});

    const madePrivate = await changeAccess(
      server,
      installation,
      published.body.artifact,
      "account_required",
    );
    expect(madePrivate.status).toBe(200);
    expect(artifactSchema.parse(await madePrivate.json()).artifact.accessSetting)
      .toBe("account_required");
  });
});
