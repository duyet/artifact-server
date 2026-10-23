import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {
  assetListingSchema,
  assetSchema,
  committedAssetSchema,
  putAssetBytes,
  sha256,
} from "../support/assets.js";

const protocolVersion = "2026-07-28";
const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});
const mcpPlanSchema = z.object({
  commit: z.object({mcpTool: z.literal("asset_commit_upload"), uploadId: z.string()}),
  file: z.object({
    authorization: z.object({
      credential: z.literal("reuse_the_mcp_bearer_credential"),
      scheme: z.literal("Bearer"),
    }),
    method: z.literal("PUT"),
    size: z.number(),
    uploadUrl: z.url(),
  }),
  uploadId: z.string(),
});
const toolErrorSchema = z.object({error: z.object({code: z.string()})});

const csv = new TextEncoder().encode("day,views\n2026-10-01,3\n");

describe("asset store MCP tools", () => {
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

  async function publish(name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "public_link",
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: `frk-020-publish-${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
    })).body;
  }

  async function uploadOverMcp(artifactId: string, key: string) {
    const planned = await callTool("asset_create_upload", {
      artifactId,
      mediaType: "text/csv",
      name: "views.csv",
      sha256: sha256(csv),
      size: csv.byteLength,
    });
    expect(planned.isError).not.toBe(true);
    const plan = mcpPlanSchema.parse(planned.structuredContent);
    expect((await putAssetBytes(plan.file.uploadUrl, installation.apiToken, csv)).status)
      .toBe(200);
    return callTool("asset_commit_upload", {
      artifactId,
      idempotencyKey: key,
      uploadId: plan.commit.uploadId,
    });
  }

  test("FRK-020-B: MCP plans, commits, lists, copies, and deletes assets through the same store as REST", async () => {
    const source = await publish("Source page");
    const target = await publish("Target page");

    const committed = await uploadOverMcp(source.artifact.id, "frk-020-commit-views");
    expect(committed.isError).not.toBe(true);
    const asset = committedAssetSchema.parse(committed.structuredContent);
    expect(asset).toMatchObject({
      asset: {mediaType: "text/csv", name: "views.csv", size: csv.byteLength},
      replayed: false,
    });
    const served = await fetch(asset.asset.url);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(new TextDecoder().decode(csv));

    const listed = await callTool("asset_list", {artifactId: source.artifact.id});
    expect(assetListingSchema.parse(listed.structuredContent)).toMatchObject({
      assets: [{id: asset.asset.id}],
      usage: {assetCount: 1, byteCount: csv.byteLength},
    });

    // A copy is a new row in the target over the same stored bytes.
    const copied = await callTool("asset_copy", {
      artifactId: target.artifact.id,
      idempotencyKey: "frk-020-copy-views",
      sourceArtifactId: source.artifact.id,
      sourceAssetId: asset.asset.id,
    });
    expect(copied.isError).not.toBe(true);
    const copy = committedAssetSchema.parse(copied.structuredContent).asset;
    expect(copy.id).not.toBe(asset.asset.id);
    expect(copy.sha256).toBe(asset.asset.sha256);
    expect(await (await fetch(copy.url)).text()).toBe(new TextDecoder().decode(csv));
    const replayedCopy = await callTool("asset_copy", {
      artifactId: target.artifact.id,
      idempotencyKey: "frk-020-copy-views",
      sourceArtifactId: source.artifact.id,
      sourceAssetId: asset.asset.id,
    });
    expect(committedAssetSchema.parse(replayedCopy.structuredContent))
      .toMatchObject({asset: {id: copy.id}, replayed: true});

    // Deleting the original leaves the copy serving.
    const deleted = await callTool("asset_delete", {
      artifactId: source.artifact.id,
      assetId: asset.asset.id,
    });
    expect(deleted.isError).not.toBe(true);
    expect(z.object({asset: assetSchema}).parse(deleted.structuredContent).asset.id)
      .toBe(asset.asset.id);
    expect((await fetch(asset.asset.url)).status).toBe(404);
    expect((await fetch(copy.url)).status).toBe(200);
  });

  test("FRK-020-F: MCP refuses unknown fields, an HTML type, a missing source asset, and a caller that may not publish", async () => {
    const page = await publish("Page");

    const extraField = await callTool("asset_list", {artifactId: page.artifact.id, path: "x"});
    expect(extraField.isError).toBe(true);

    const html = await callTool("asset_create_upload", {
      artifactId: page.artifact.id,
      mediaType: "text/html",
      name: "index.html",
      sha256: sha256(csv),
      size: csv.byteLength,
    });
    expect(html.isError).toBe(true);
    expect(toolErrorSchema.parse(html.structuredContent).error.code)
      .toBe("ASSET_TYPE_UNSUPPORTED");

    const missing = await callTool("asset_copy", {
      artifactId: page.artifact.id,
      idempotencyKey: "frk-020-copy-missing",
      sourceArtifactId: page.artifact.id,
      sourceAssetId: "ast_00000000-0000-4000-8000-000000000000",
    });
    expect(toolErrorSchema.parse(missing.structuredContent).error.code)
      .toBe("ASSET_NOT_FOUND");

    const cookies = await signInAdministrator(server, installation);
    const reader = await issueApiKey(server, cookies, ["artifact:read"], "Reader");
    const refused = await callTool("asset_create_upload", {
      artifactId: page.artifact.id,
      mediaType: "text/csv",
      name: "views.csv",
      sha256: sha256(csv),
      size: csv.byteLength,
    }, reader);
    expect(toolErrorSchema.parse(refused.structuredContent).error.code)
      .toBe("AUTHORIZATION_DENIED");
    const readable = await callTool("asset_list", {artifactId: page.artifact.id}, reader);
    expect(readable.isError).not.toBe(true);
  });

  async function callTool(
    name: string,
    toolArguments: Readonly<Record<string, number | string>>,
    token = installation.apiToken,
  ) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
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
    return toolResultSchema.parse(await response.json()).result;
  }
});
