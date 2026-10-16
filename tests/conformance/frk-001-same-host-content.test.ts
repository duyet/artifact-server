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
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const mcpProtocolVersion = "2026-07-28";
const indexHtml =
  '<!doctype html><link rel="stylesheet" href="./assets/a.css"><title>Same-host site</title>';
const stylesheet = "body { color: rebeccapurple; }";
const nestedHtml = "<!doctype html><title>Nested page</title>";
const spaShell = "<!doctype html><title>SPA shell</title>";

const previewLeaseSchema = z.object({
  baseUrl: z.url(),
  expiresAt: z.string(),
  versionId: z.string(),
});
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const artifactDetailsSchema = z.object({
  current: z.object({links: z.object({version: z.url()})}),
});

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function siteFiles(entry: string): readonly TestSiteFile[] {
  return [
    {bytes: utf8(entry), mediaType: "text/html; charset=utf-8", path: "index.html"},
    {
      bytes: utf8(stylesheet),
      mediaType: "text/css; charset=utf-8",
      path: "assets/a.css",
    },
    {
      bytes: utf8(nestedHtml),
      mediaType: "text/html; charset=utf-8",
      path: "docs/nested/page.html",
    },
  ];
}

async function publishSite(
  server: RunningTestServer,
  installation: TestInstallation,
  input: {
    readonly accessSetting: "account_required" | "public_link";
    readonly entry?: string;
    readonly name: string;
    readonly routingMode?: "spa" | "static";
  },
): Promise<PublishResponse> {
  const files = siteFiles(input.entry ?? indexHtml);
  const planned = await createStagedUpload(
    server,
    installation,
    "index.html",
    files,
    undefined,
    input.routingMode,
  );
  const uploads = await uploadEveryStagedFile(installation, planned.body, files);
  expect(uploads.map((upload) => upload.status)).toEqual([200, 200, 200]);
  const published = await commitStagedUpload(
    installation,
    planned.body,
    `frk-001-${input.name}`,
    {accessSetting: input.accessSetting, kind: "new_artifact", name: input.name},
  );
  expect(published.response.status).toBe(201);
  return published.body;
}

function apiPost(
  installation: TestInstallation,
  url: string,
): Promise<Response> {
  return fetch(url, {
    headers: {Authorization: `Bearer ${installation.apiToken}`},
    method: "POST",
  });
}

describe("same-host content in path mode", () => {
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

  test("FRK-001-B: a public multi-file artifact, its SPA fallback, and a Review lease are served under /v/ on the application origin", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Same-host public site",
    });
    const token = site.version.contentToken;
    expect(site.links.version).toBe(`${server.baseUrl}/v/${token}/`);

    const entry = await fetch(site.links.version);
    expect(entry.status).toBe(200);
    expect(entry.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await entry.text()).toBe(indexHtml);

    const css = await fetch(`${server.baseUrl}/v/${token}/assets/a.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe(stylesheet);

    const nested = await fetch(
      `${server.baseUrl}/v/${token}/docs/nested/page.html`,
    );
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe(nestedHtml);

    const missingSlash = await fetch(`${server.baseUrl}/v/${token}?tab=1`, {
      redirect: "manual",
    });
    expect(missingSlash.status).toBe(308);
    expect(missingSlash.headers.get("location")).toBe(`/v/${token}/?tab=1`);

    const spa = await publishSite(server, installation, {
      accessSetting: "public_link",
      entry: spaShell,
      name: "Same-host SPA",
      routingMode: "spa",
    });
    const navigation = await fetchVersion(
      server,
      `${server.baseUrl}/v/${spa.version.contentToken}/settings/profile`,
      "GET",
      {
        Accept: "text/html",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
      },
    );
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toBe(spaShell);

    const priv = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Same-host private site",
    });
    const leaseResponse = await apiPost(
      installation,
      `${server.baseUrl}/api/v1/artifacts/${priv.artifact.id}/versions/${priv.version.id}/preview-leases?projectId=${priv.artifact.projectId}`,
    );
    expect(leaseResponse.status).toBe(201);
    const lease = previewLeaseSchema.parse(await leaseResponse.json());
    expect(lease.baseUrl.startsWith(`${server.baseUrl}/v/review-`)).toBe(true);
    expect(new URL(lease.baseUrl).pathname).toMatch(
      /^\/v\/review-[a-z0-9_-]{56}\/$/u,
    );
    const leased = await fetch(lease.baseUrl);
    expect(leased.status).toBe(200);
    expect(leased.headers.get("access-control-allow-origin")).toBe("*");
    expect(await leased.text()).toBe(indexHtml);
    const leasedCss = await fetch(new URL("assets/a.css", lease.baseUrl));
    expect(leasedCss.status).toBe(200);
    expect(await leasedCss.text()).toBe(stylesheet);
  });

  test("FRK-001-F: unknown tokens 404, private versions are refused, cookie sessions are unavailable, and application routes are unchanged", async () => {
    const priv = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Same-host private",
    });
    const pub = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Same-host public",
    });

    const missingPaths = [
      `/v/${"0".repeat(36)}/`,
      `/v/${"0".repeat(36)}/assets/a.css`,
      "/v/short/",
      "/v/",
      "/v",
    ];
    const missing = await Promise.all(missingPaths.map(async (missingPath) => {
      const response = await fetch(`${server.baseUrl}${missingPath}`, {
        redirect: "manual",
      });
      await response.arrayBuffer();
      return [missingPath, response.status];
    }));
    expect(missing).toEqual(missingPaths.map((missingPath) => [missingPath, 404]));

    const refused = await fetch(priv.links.version);
    expect(refused.status).toBe(401);
    expect(errorBodySchema.parse(await refused.json()).error.code)
      .toBe("CONTENT_NOT_PUBLIC");

    const sessionEndpoints = [
      `/api/v1/artifacts/${priv.artifact.id}/content-sessions`,
      `/api/v1/artifacts/${priv.artifact.id}/versions/${priv.version.id}/content-sessions`,
      `/api/v1/artifacts/${priv.artifact.id}/live-sessions`,
    ];
    const sessionAttempts = await Promise.all(
      sessionEndpoints.map(async (endpoint) => {
        const anonymous = await fetch(`${server.baseUrl}${endpoint}`, {
          method: "POST",
        });
        await anonymous.arrayBuffer();
        const authenticated = await apiPost(
          installation,
          `${server.baseUrl}${endpoint}`,
        );
        return {
          anonymous: anonymous.status,
          endpoint,
          error: errorBodySchema.parse(await authenticated.json()).error,
          status: authenticated.status,
        };
      }),
    );
    expect(sessionAttempts).toEqual(sessionEndpoints.map((endpoint) => ({
      anonymous: 401,
      endpoint,
      error: {
        code: "CAPABILITY_UNAVAILABLE",
        message: "Private artifact content opens in Review on this deployment.",
      },
      status: 501,
    })));

    const bootstrap = await fetch(
      `${priv.links.version}?__artifact_bootstrap=${"a".repeat(43)}`,
    );
    expect(bootstrap.status).toBe(501);
    expect(errorBodySchema.parse(await bootstrap.json()).error.code)
      .toBe("CAPABILITY_UNAVAILABLE");
    expect(bootstrap.headers.get("set-cookie")).toBeNull();

    expect((await fetch(`${server.baseUrl}/api/v1/session`)).status).toBe(401);
    expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200);
    const routeMiss = await fetch(`${server.baseUrl}/not-a-route`);
    expect(routeMiss.status).toBe(404);
    expect(errorBodySchema.parse(await routeMiss.json()).error.code)
      .toBe("NOT_FOUND");

    const details = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${pub.artifact.id}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(artifactDetailsSchema.parse(await details.json()).current.links.version)
      .toBe(`${server.baseUrl}/v/${pub.version.contentToken}/`);

    const client = new Client(
      {name: "frk-001-path-mode-client", version: "1"},
      {versionNegotiation: {mode: {pin: mcpProtocolVersion}}},
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
          authProvider: {token: async () => installation.apiToken},
        }),
      );
      const privateOpen = await client.callTool({
        arguments: {artifactId: priv.artifact.id, versionId: null},
        name: "artifact_open",
      });
      expect(privateOpen.isError).toBe(true);
      expect(privateOpen.structuredContent).toEqual({
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: "Private artifact content opens in Review on this deployment.",
        },
      });
      const publicOpen = await client.callTool({
        arguments: {artifactId: pub.artifact.id, versionId: pub.version.id},
        name: "artifact_open",
      });
      expect(publicOpen.isError).not.toBe(true);
      expect(publicOpen.structuredContent).toMatchObject({
        browserUrl: `${server.baseUrl}/v/${pub.version.contentToken}/`,
      });
    } finally {
      await client.close();
    }
  });
});

describe("host mode", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("keeps the upstream per-version host URL shape and the id-based artifact link", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Host-mode public site",
    });
    expect(site.links.version).toBe(
      `http://${site.version.contentToken}.localhost:${server.port}/`,
    );
    expect(site.links.artifact).toBe(
      `${server.baseUrl}/artifacts/${site.artifact.id}`,
    );
  });
});

describe("Review frame content security policy", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | undefined;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(path.join(tmpdir(), "frk-001-web-assets-"));
    await writeFile(path.join(webAssetsRoot, "review-frame.html"), "<!doctype html>");
  });

  afterEach(async () => {
    await server?.stop();
    await rm(webAssetsRoot, {force: true, recursive: true});
    await removeTestInstallation(installation);
  });

  async function frameCsp(contentDomain: string | null): Promise<string | null> {
    server = await startTestServer(installation, {contentDomain, webAssetsRoot});
    const response = await fetch(`${server.baseUrl}/review-frame`);
    expect(response.status).toBe(200);
    return response.headers.get("content-security-policy");
  }

  test("allows only the path-scoped /v/ source in path mode", async () => {
    const csp = await frameCsp(null);
    const origin = `http://127.0.0.1:${server?.port}`;
    expect(csp).toBe([
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline' ${origin}/v/`,
      `style-src 'self' 'unsafe-inline' ${origin}/v/`,
      "img-src 'self' * data: blob:",
      "font-src * data:",
      "media-src * data: blob:",
      `connect-src ${origin}/v/`,
      "frame-ancestors 'self'",
    ].join("; "));
  });

  test("keeps the wildcard content-host sources with a content domain", async () => {
    const sources = "http://*.localhost:* https://*.localhost";
    expect(await frameCsp("localhost")).toBe([
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline' ${sources}`,
      `style-src 'self' 'unsafe-inline' ${sources}`,
      "img-src 'self' * data: blob:",
      "font-src * data:",
      "media-src * data: blob:",
      `connect-src ${sources}`,
      "frame-ancestors 'self'",
    ].join("; "));
  });
});
